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

let delivering = false;
async function deliverDue(db = dbOf(), { limit = 50 } = {}) {
  if (delivering) return { skipped: true };
  delivering = true;
  const out = { ok: 0, retry: 0, failed: 0, gone: 0 };
  try {
    const due = db.prepare("SELECT * FROM automation_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT ?").all(now(), limit);
    for (const d of due) {
      try { out[await attempt(db, d)]++; } catch (e) { console.warn(`[automation] delivery ${d.id}: ${e && e.message}`); }
    }
  } finally { delivering = false; }
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

module.exports = { EVENTS, emit, recent, sample, present, sign, deliverDue, deviceStateTick, tick, start, prune, _setClock, _setSender };
