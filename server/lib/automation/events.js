'use strict';

/*
 * Automation events: what Zapier (and Make, n8n, anything that takes a webhook) can be told about.
 *
 * Every event is written to automation_events first, then queued once per matching REST-hook
 * subscription (automation_deliveries, unique per subscription + event). Delivery is a separate
 * tick, so an event raised inside a request never waits on someone else's server, and a receiver
 * that is down gets retried with backoff instead of losing the event.
 *
 * ⚠️ RULES, and why:
 *   - Target URLs are https, public addresses only, no redirects (lib/ssrf-guard): a subscription is
 *     created with an API token, and a token must not be a way to make this server probe its LAN.
 *   - Each delivery is signed: X-ScreenTinker-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">
 *     with the subscription's own secret, so a receiver can tell our calls from anyone else's.
 *   - HTTP 410 from the receiver means "this hook is gone" (Zapier's REST-hook contract): the
 *     subscription is deleted, not retried. Other failures retry at 1, 5, 30 and 120 minutes, then
 *     the delivery is marked failed and kept for the log.
 *   - Screen online/offline is derived here from devices.status changes (one row per screen in
 *     automation_device_state), only for workspaces that have a subscription to it, so a fleet with
 *     no Zapier pays one SELECT per tick.
 */

const crypto = require('crypto');

function dbOf() { return require('../../db/database').db; }

const EVENTS = Object.freeze([
  'device_offline', 'device_online',
  'emergency_raised', 'emergency_cleared',
  'content_approved', 'playlist_published',
]);
const BACKOFF_MIN = [1, 5, 30, 120];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const TICK_MS = 15 * 1000;
const KEEP_EVENTS_SEC = 7 * 86400;

let timer = null;
let clock = () => Math.floor(Date.now() / 1000);
let sendOverride = null;   // in-process tests only

const now = () => clock();

/** Record an event and queue it for every subscriber. Never throws into the caller's request. */
function emit(db, workspaceId, type, data = {}) {
  if (!workspaceId || !EVENTS.includes(type)) return null;
  try {
    db = db || dbOf();
    const t = now();
    const id = db.prepare('INSERT INTO automation_events (workspace_id, type, data, created_at) VALUES (?, ?, ?, ?)')
      .run(workspaceId, type, JSON.stringify(data || {}), t).lastInsertRowid;
    const subs = db.prepare('SELECT id FROM automation_subscriptions WHERE workspace_id = ? AND event = ?').all(workspaceId, type);
    const q = db.prepare(`INSERT OR IGNORE INTO automation_deliveries (subscription_id, event_id, attempts, next_at, status, created_at)
      VALUES (?, ?, 0, ?, 'pending', ?)`);
    for (const s of subs) q.run(s.id, id, t, t);
    return Number(id);
  } catch (e) {
    console.warn(`[automation] emit ${type} failed: ${e && e.message}`);
    return null;
  }
}

/** The JSON a subscriber receives, and what the polling endpoint returns. */
function present(row) {
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return { id: String(row.id), event: row.type, occurred_at: new Date(row.created_at * 1000).toISOString(), workspace_id: row.workspace_id, ...data };
}

/** Recent events of one type, newest first — Zapier's polling fallback dedupes on `id`. */
function recent(db, workspaceId, type, limit = 50) {
  const n = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
  const rows = type
    ? db.prepare('SELECT * FROM automation_events WHERE workspace_id = ? AND type = ? ORDER BY id DESC LIMIT ?').all(workspaceId, type, n)
    : db.prepare('SELECT * FROM automation_events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?').all(workspaceId, n);
  return rows.map(present);
}

/** A representative event for Zapier's "test this trigger" step when nothing has happened yet. */
function sample(type, workspaceId) {
  const base = { id: '0', event: type, occurred_at: new Date(now() * 1000).toISOString(), workspace_id: workspaceId, sample: true };
  if (type === 'device_offline' || type === 'device_online') return { ...base, device_id: 'sample-device', device_name: 'Lobby screen', status: type === 'device_offline' ? 'offline' : 'online' };
  if (type === 'emergency_raised' || type === 'emergency_cleared') return { ...base, feed_name: 'Building alerts', source: 'hook', alert_id: 'sample-1', event: 'Fire alarm', headline: 'Evacuate the building', severity: 'Extreme' };
  if (type === 'content_approved') return { ...base, resource_type: 'content', resource_id: 'sample', name: 'Spring menu' };
  return { ...base, playlist_id: 'sample', playlist_name: 'Lobby loop' };
}

/* ============================== signing + delivery ============================== */

function sign(secret, t, body) {
  return crypto.createHmac('sha256', String(secret)).update(`${t}.${body}`).digest('hex');
}

async function send(url, body, headers) {
  if (sendOverride) return sendOverride({ url, body, headers });
  const { guardedRequest } = require('../ssrf-guard');
  try {
    const res = await guardedRequest(url, {
      method: 'POST', body, timeoutMs: 10000, maxBytes: 64 * 1024, responseType: 'text', maxRedirects: 0, accept2xx: true,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ScreenTinker-Automation/1', ...headers },
    });
    return { status: res.statusCode };
  } catch (e) {
    const sc = e && (e.statusCode || Number((String(e.message).match(/\b([45]\d\d)\b/) || [])[1]));
    if (sc) return { status: sc };
    return { status: 0, error: e && /timed out|timeout/i.test(e.message || '') ? 'The receiver did not answer in time.' : 'The receiver could not be reached.' };
  }
}

/** One delivery attempt. Returns 'ok' | 'retry' | 'failed' | 'gone'. */
async function attempt(db, d) {
  const sub = db.prepare('SELECT * FROM automation_subscriptions WHERE id = ?').get(d.subscription_id);
  if (!sub) { db.prepare("UPDATE automation_deliveries SET status = 'failed', last_error = 'subscription removed' WHERE id = ?").run(d.id); return 'gone'; }
  const ev = db.prepare('SELECT * FROM automation_events WHERE id = ?').get(d.event_id);
  if (!ev) { db.prepare("UPDATE automation_deliveries SET status = 'failed', last_error = 'event expired' WHERE id = ?").run(d.id); return 'failed'; }
  const body = JSON.stringify(present(ev));
  const t = now();
  const headers = { 'X-ScreenTinker-Event': ev.type, 'X-ScreenTinker-Delivery': String(d.id) };
  let secret = null;
  try { secret = sub.secret_enc ? require('../secretbox').decrypt(sub.secret_enc) : null; } catch { secret = null; }
  if (secret) headers['X-ScreenTinker-Signature'] = `t=${t},v1=${sign(secret, t, body)}`;
  const r = await send(sub.target_url, body, headers);
  const attempts = d.attempts + 1;
  if (r.status >= 200 && r.status < 300) {
    db.prepare("UPDATE automation_deliveries SET status = 'ok', attempts = ?, last_error = NULL WHERE id = ?").run(attempts, d.id);
    db.prepare('UPDATE automation_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(t, sub.id);
    return 'ok';
  }
  if (r.status === 410) {
    // The receiver says the hook no longer exists: unsubscribe, exactly as Zapier expects.
    db.transaction(() => {
      db.prepare("UPDATE automation_deliveries SET status = 'failed', last_error = 'receiver answered 410 Gone; unsubscribed' WHERE subscription_id = ? AND status = 'pending'").run(sub.id);
      db.prepare('DELETE FROM automation_subscriptions WHERE id = ?').run(sub.id);
    })();
    return 'gone';
  }
  const err = r.error || `The receiver answered HTTP ${r.status}.`;
  db.prepare('UPDATE automation_subscriptions SET last_error = ? WHERE id = ?').run(err, sub.id);
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE automation_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, err, d.id);
    return 'failed';
  }
  db.prepare('UPDATE automation_deliveries SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?')
    .run(attempts, t + BACKOFF_MIN[attempts - 1] * 60, err, d.id);
  return 'retry';
}

/*
 * ⚠️ FAIR, CONCURRENT DELIVERY. Deliveries used to go one at a time behind a single lock, 50 a tick,
 * each allowed 10 s: one tenant with 200 dead endpoints held every other tenant's emergency_raised
 * back for minutes. Now:
 *   - up to MAX_CONCURRENT attempts run at once across the server, at most PER_WORKSPACE of them for
 *     one workspace and PER_HOST for one receiving host (a dead host ties up its own slots only);
 *   - one at a time per subscription, oldest first: a receiver sees its events in order, and a 410
 *     on the first stops the rest before they are sent;
 *   - the due list is taken round-robin across workspaces, so a big backlog cannot sit in front of a
 *     small one;
 *   - there is no tick-wide lock: a tick starts what fits and keeps feeding freed slots from its own
 *     list, and the next tick runs beside it. A delivery already in flight is skipped, and each one is
 *     re-read just before it is sent, so two ticks never send the same delivery twice.
 * Retries and backoff are attempt()'s, unchanged.
 */
const MAX_CONCURRENT = 16;
const PER_WORKSPACE = 4;
const PER_HOST = 8;
const inFlight = new Set();              // delivery ids
const wsRunning = new Map();             // workspace id -> attempts in flight
const hostRunning = new Map();           // receiving host -> attempts in flight
const subRunning = new Set();            // subscription ids with an attempt in flight

function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch { return ''; } }
const bump = (m, k, n) => { const v = (m.get(k) || 0) + n; if (v > 0) m.set(k, v); else m.delete(k); };

/** Round-robin by workspace, each workspace's own deliveries oldest first. */
function fairOrder(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.ws || '';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const lists = [...by.values()];
  const out = [];
  for (let i = 0; out.length < rows.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

async function deliverDue(db = dbOf(), { limit = 200 } = {}) {
  const out = { ok: 0, retry: 0, failed: 0, gone: 0 };
  const due = db.prepare(`SELECT d.id, d.subscription_id AS sub, s.workspace_id AS ws, s.target_url AS target FROM automation_deliveries d
      LEFT JOIN automation_subscriptions s ON s.id = d.subscription_id
      WHERE d.status = 'pending' AND d.next_at <= ? ORDER BY d.next_at, d.id LIMIT ?`).all(now(), Math.max(limit, 1) * 4);
  const queue = fairOrder(due.filter((d) => !inFlight.has(d.id))).slice(0, limit);
  for (const d of queue) d.host = hostOf(d.target);
  const reread = db.prepare("SELECT * FROM automation_deliveries WHERE id = ? AND status = 'pending' AND next_at <= ?");
  const fits = (d) => inFlight.size < MAX_CONCURRENT && !subRunning.has(d.sub)
    && (wsRunning.get(d.ws || '') || 0) < PER_WORKSPACE && (hostRunning.get(d.host) || 0) < PER_HOST;

  await new Promise((resolve) => {
    let running = 0;
    const pump = () => {
      for (let i = 0; i < queue.length;) {
        const d = queue[i];
        if (inFlight.has(d.id)) { queue.splice(i, 1); continue; }
        if (!fits(d)) { i++; continue; }
        queue.splice(i, 1);
        const row = reread.get(d.id, now());
        if (!row) continue;   // another tick sent it, or it was unsubscribed
        inFlight.add(d.id); subRunning.add(d.sub); bump(wsRunning, d.ws || '', 1); bump(hostRunning, d.host, 1); running++;
        attempt(db, row)
          .then((r) => { out[r]++; })
          .catch((e) => console.warn(`[automation] delivery ${d.id}: ${e && e.message}`))
          .finally(() => {
            inFlight.delete(d.id); subRunning.delete(d.sub); bump(wsRunning, d.ws || '', -1); bump(hostRunning, d.host, -1); running--;
            pump();
          });
      }
      // Nothing of ours running and nothing startable left: what remains is held by another tick's
      // slots, and the next tick picks it up.
      if (!running) resolve();
    };
    pump();
  });
  return out;
}

/* ============================== screen online/offline ============================== */

function deviceStateTick(db = dbOf()) {
  const wss = db.prepare("SELECT DISTINCT workspace_id FROM automation_subscriptions WHERE event IN ('device_offline', 'device_online')").all();
  for (const { workspace_id: ws } of wss) {
    const rows = db.prepare(`SELECT d.id, d.name, d.status, s.status AS seen FROM devices d
      LEFT JOIN automation_device_state s ON s.device_id = d.id WHERE d.workspace_id = ?`).all(ws);
    const put = db.prepare('INSERT INTO automation_device_state (device_id, status) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET status = excluded.status');
    for (const d of rows) {
      const status = d.status === 'online' ? 'online' : 'offline';
      if (d.seen === status) continue;
      put.run(d.id, status);
      // The first sighting of a screen records its state without announcing it: a new subscription
      // must not fire "offline" for every screen that was already off.
      if (d.seen == null) continue;
      emit(db, ws, status === 'online' ? 'device_online' : 'device_offline', { device_id: d.id, device_name: d.name, status });
    }
  }
}

function prune(db = dbOf()) {
  const cutoff = now() - KEEP_EVENTS_SEC;
  db.prepare("DELETE FROM automation_deliveries WHERE status != 'pending' AND created_at < ?").run(cutoff);
  db.prepare('DELETE FROM automation_events WHERE created_at < ? AND id NOT IN (SELECT event_id FROM automation_deliveries)').run(cutoff);
}

async function tick(db = dbOf()) {
  try { deviceStateTick(db); } catch (e) { console.warn(`[automation] device states: ${e && e.message}`); }
  try { require('./overrides').tick(db); } catch (e) { console.warn(`[automation] overrides: ${e && e.message}`); }
  await deliverDue(db);
  try { prune(db); } catch (_) { /* next tick */ }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.warn(`[automation] tick: ${e && e.message}`)); }, TICK_MS);
  if (timer.unref) timer.unref();
}

function _setClock(fn) { clock = fn || (() => Math.floor(Date.now() / 1000)); }
function _setSender(fn) { sendOverride = fn || null; }

module.exports = { EVENTS, emit, recent, sample, present, sign, deliverDue, fairOrder, MAX_CONCURRENT, PER_WORKSPACE, PER_HOST, deviceStateTick, tick, start, prune, _setClock, _setSender };
