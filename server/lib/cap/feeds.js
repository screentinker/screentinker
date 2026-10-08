'use strict';

/*
 * CAP emergency feeds: a workspace subscribes to a public alert feed (a weather service, a civil
 * protection agency), and while an alert in it matches the feed's filters, every screen in the
 * feed's scope shows it instead of its playlist — a generated alert card (lib/cap/card.js), or a
 * playlist the operator chose.
 *
 * THE RULES, and why:
 *   - Live = status Actual, not cancelled or superseded (a later Update/Cancel naming it in
 *     <references>), effective (or sent) has passed, and expires has not (no expires: 24 h after
 *     sent). Filters (minimum severity, event names, area terms) are applied when asked, never
 *     baked into stored rows, so editing a feed takes effect at once.
 *   - ⚠️ A FEED THAT CANNOT BE FETCHED KEEPS WHAT IT HAD. A warning must not disappear from every
 *     screen because the agency's server is slow; the alerts already seen stay live until their own
 *     expiry. Only a successful poll can say an alert has left the feed.
 *   - A screen covered by a live head office emergency alert (lib/corporate/emergency-live.js)
 *     shows that instead: the payload builder asks head office first.
 *   - The card is an ordinary widget row (widget_type 'cap_alert', hidden from the library), so
 *     every player that renders widgets renders it, with no player change. Its updated_at is the
 *     widget revision, bumped whenever the live set changes, which is what makes players reload.
 *
 * Feeds are refused in a mesh-replicated workspace (as head office emergency scopes are): these
 * tables are not replicated, so a replica's screens would never see the alert.
 */

const crypto = require('crypto');
const { parseFeed, alertKey, referenceKey, SEVERITY_RANK, severityOf } = require('./parse');

function dbOf() { return require('../../db/database').db; }

const MIN_POLL = 60, MAX_POLL = 3600, DEFAULT_POLL = 120;
const DEFAULT_TTL_SEC = 24 * 3600;
const MAX_LINKED_DOCS = 25;
const SCOPE_KINDS = new Set(['workspace', 'group', 'device']);
const TICK_MS = 15 * 1000;

let io = null;
let timer = null;
const polling = new Set();      // feed ids with a poll in flight
const liveSig = new Map();      // feed id -> signature of its live alert set ('' = none)
const liveInfo = new Map();     // feed id -> Map(alert key -> summary), for raised/cleared events
let restoring = false;          // start(): re-deriving what was live is not news
let clock = () => Math.floor(Date.now() / 1000);
let testFetcher = null;   // in-process tests only (_setFetcher); never set by a request

/* ============================== input ============================== */

function normaliseInput(body, existing = null) {
  const b = body || {};
  const out = {};
  if (b.name !== undefined || !existing) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return { error: 'name required' };
    out.name = name;
  }
  if (b.url !== undefined || !existing) {
    const { checkHttpUrl } = require('../data-sources/http');
    const e = checkHttpUrl(b.url, 'Feed URL');
    if (e) return { error: e };
    out.url = String(b.url).trim();
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.poll_sec !== undefined) {
    const n = parseInt(b.poll_sec, 10);
    if (!Number.isFinite(n) || n < MIN_POLL || n > MAX_POLL) return { error: `poll_sec must be ${MIN_POLL}–${MAX_POLL}` };
    out.poll_sec = n;
  }
  if (b.min_severity !== undefined) {
    if (!(b.min_severity in SEVERITY_RANK)) return { error: `min_severity must be one of: ${Object.keys(SEVERITY_RANK).join(', ')}` };
    out.min_severity = b.min_severity;
  }
  if (b.events !== undefined) {
    const list = (Array.isArray(b.events) ? b.events : String(b.events || '').split(/[,\n]/))
      .map((s) => String(s).trim().slice(0, 120)).filter(Boolean).slice(0, 50);
    out.events = list.length ? JSON.stringify(list) : null;
  }
  if (b.area_match !== undefined) {
    const v = String(b.area_match || '').trim().slice(0, 1000);
    out.area_match = v || null;
  }
  if (b.language !== undefined) {
    const v = String(b.language || '').trim().slice(0, 20);
    if (v && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v)) return { error: 'language must be a code such as en or en-US' };
    out.language = v || 'en';
  }
  if (b.playlist_id !== undefined) out.playlist_id = b.playlist_id || null;
  return { fields: out };
}

/** Validate a scope list for a workspace. Returns { rows } or { error }. */
function validateScopes(db, workspaceId, scopes) {
  if (scopes === undefined) return { rows: null };
  if (!Array.isArray(scopes) || !scopes.length) return { error: 'scopes must be a non-empty array of { scope_kind: workspace|group|device, scope_id }' };
  const rows = [];
  const seen = new Set();
  for (const s of scopes) {
    const kind = s && s.scope_kind;
    if (!SCOPE_KINDS.has(kind)) return { error: `invalid scope_kind: ${kind}` };
    const id = kind === 'workspace' ? workspaceId : String((s && s.scope_id) || '');
    if (kind === 'workspace' && s.scope_id && s.scope_id !== workspaceId) return { error: 'a workspace scope must name this workspace' };
    if (kind === 'group' && !db.prepare('SELECT 1 FROM device_groups WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) {
      return { error: `group ${id} is not in this workspace` };
    }
    if (kind === 'device' && !db.prepare('SELECT 1 FROM devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) {
      return { error: `screen ${id} is not in this workspace` };
    }
    const k = `${kind}|${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ scope_kind: kind, scope_id: id });
  }
  return { rows };
}

function setScopes(db, feedId, rows) {
  db.prepare('DELETE FROM cap_feed_scopes WHERE feed_id = ?').run(feedId);
  const ins = db.prepare('INSERT OR IGNORE INTO cap_feed_scopes (feed_id, scope_kind, scope_id) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(feedId, r.scope_kind, r.scope_id);
}

function scopesOf(db, feedId) {
  return db.prepare('SELECT scope_kind, scope_id FROM cap_feed_scopes WHERE feed_id = ? ORDER BY scope_kind, scope_id').all(feedId);
}

/** Every screen a feed reaches. Wall members included: the wall shows the card across itself. */
function devicesInScope(db, feed) {
  const ids = new Set();
  for (const s of scopesOf(db, feed.id)) {
    if (s.scope_kind === 'workspace') {
      for (const r of db.prepare('SELECT id FROM devices WHERE workspace_id = ?').all(feed.workspace_id)) ids.add(r.id);
    } else if (s.scope_kind === 'group') {
      for (const r of db.prepare(`SELECT m.device_id AS id FROM device_group_members m JOIN devices d ON d.id = m.device_id
          WHERE m.group_id = ? AND d.workspace_id = ?`).all(s.scope_id, feed.workspace_id)) ids.add(r.id);
    } else if (s.scope_kind === 'device') {
      if (db.prepare('SELECT 1 FROM devices WHERE id = ? AND workspace_id = ?').get(s.scope_id, feed.workspace_id)) ids.add(s.scope_id);
    }
  }
  return [...ids];
}

function inScope(db, feed, deviceId) {
  return !!db.prepare(`SELECT 1 FROM cap_feed_scopes s WHERE s.feed_id = ? AND (
      s.scope_kind = 'workspace'
      OR (s.scope_kind = 'device' AND s.scope_id = ?)
      OR (s.scope_kind = 'group' AND EXISTS (SELECT 1 FROM device_group_members m WHERE m.group_id = s.scope_id AND m.device_id = ?))
    )`).get(feed.id, deviceId, deviceId);
}

/* ============================== the hidden card widget ============================== */

function ensureWidget(db, feed) {
  if (feed.widget_id && db.prepare('SELECT 1 FROM widgets WHERE id = ?').get(feed.widget_id)) return feed.widget_id;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, 'cap_alert', ?, ?)`)
    .run(id, feed.user_id || null, feed.workspace_id, `Emergency alert: ${feed.name}`.slice(0, 200), JSON.stringify({ feed_id: feed.id }));
  db.prepare('UPDATE cap_feeds SET widget_id = ? WHERE id = ?').run(id, feed.id);
  feed.widget_id = id;
  return id;
}

/** Bump the card's revision so players reload it. Strictly increasing, even within one second. */
function bumpWidget(db, feed) {
  if (!feed.widget_id) return;
  db.prepare("UPDATE widgets SET updated_at = MAX(updated_at + 1, strftime('%s','now')) WHERE id = ?").run(feed.widget_id);
}

/* ============================== which alerts are live ============================== */

function parseEvents(feed) {
  try { const v = JSON.parse(feed.events || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function isLive(a, now) {
  if (!a || a.status !== 'Actual' || a.msgType === 'Cancel') return false;
  const start = Date.parse(a.effective || a.sent || '') / 1000;
  if (Number.isFinite(start) && start > now) return false;
  const sent = Date.parse(a.sent || '') / 1000;
  const end = a.expires ? Date.parse(a.expires) / 1000 : (Number.isFinite(sent) ? sent + DEFAULT_TTL_SEC : NaN);
  if (!Number.isFinite(end)) return false;    // no time at all: nothing says it is current
  return end > now;
}

/** Past its own end (expires, or 24 h after sent). Not-yet-effective is not expired. */
function hasExpired(a, now) {
  const sent = Date.parse((a && a.sent) || '') / 1000;
  const end = a && a.expires ? Date.parse(a.expires) / 1000 : (Number.isFinite(sent) ? sent + DEFAULT_TTL_SEC : NaN);
  return Number.isFinite(end) && end <= now;
}

function matchesFilters(feed, a) {
  if ((SEVERITY_RANK[a.severity] ?? 0) < (SEVERITY_RANK[feed.min_severity] ?? SEVERITY_RANK.Severe)) return false;
  const events = parseEvents(feed).map((e) => e.toLowerCase());
  if (events.length && !events.includes(String(a.event || '').toLowerCase())) return false;
  if (feed.area_match) {
    const terms = String(feed.area_match).split(/[,\n;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const area = String(a.areaDesc || '').toLowerCase();
    const codes = new Set((a.geocodes || []).map((g) => String(g.value).toLowerCase()));
    if (terms.length && !terms.some((t) => area.includes(t) || codes.has(t))) return false;
  }
  return true;
}

/** The feed's live, matching alerts, most severe first, then newest. */
function liveAlerts(db, feed, now = clock()) {
  const rows = db.prepare('SELECT data FROM cap_alerts WHERE feed_id = ? AND in_feed = 1 AND ended = 0').all(feed.id);
  const out = [];
  for (const r of rows) {
    let a; try { a = JSON.parse(r.data); } catch { continue; }
    if (isLive(a, now) && matchesFilters(feed, a)) out.push(a);
  }
  return out.sort((x, y) => (SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]) || String(y.sent).localeCompare(String(x.sent)));
}

/* ============================== polling ============================== */

/**
 * Record one successful fetch. `alerts` is the whole current set the feed reported: anything not in
 * it has left the feed. An Update or Cancel ends every alert its <references> name.
 */
function applyPoll(db, feed, alerts, now = clock()) {
  db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO cap_alerts (feed_id, akey, data, in_feed, ended, first_seen, last_seen)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(feed_id, akey) DO UPDATE SET data = excluded.data, in_feed = 1, last_seen = excluded.last_seen,
        ended = MAX(cap_alerts.ended, excluded.ended)`);
    db.prepare('UPDATE cap_alerts SET in_feed = 0 WHERE feed_id = ?').run(feed.id);
    const ends = new Set();
    for (const a of alerts) {
      if (!a.identifier) continue;
      if (a.msgType === 'Update' || a.msgType === 'Cancel') for (const r of a.references) ends.add(referenceKey(r));
    }
    for (const a of alerts) {
      if (!a.identifier) continue;
      const key = alertKey(a);
      upsert.run(feed.id, key, JSON.stringify(a), a.msgType === 'Cancel' || ends.has(key) ? 1 : 0, now, now);
    }
    if (ends.size) {
      const end = db.prepare('UPDATE cap_alerts SET ended = 1 WHERE feed_id = ? AND akey = ?');
      for (const k of ends) end.run(feed.id, k);
    }
    // Keep a week of history for the dashboard; drop older rows the feed no longer carries.
    db.prepare('DELETE FROM cap_alerts WHERE feed_id = ? AND in_feed = 0 AND last_seen < ?').run(feed.id, now - 7 * 86400);
    db.prepare('UPDATE cap_feeds SET last_polled_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?').run(now, now, feed.id);
  })();
}

/** Fetch and parse a feed (and the CAP documents an index links to). Returns { kind, alerts }. */
async function fetchFeed(feed, { fetcher = testFetcher } = {}) {
  const { fetchText } = require('../data-sources/http');
  const opts = {
    headers: { 'User-Agent': 'ScreenTinker-CAP/1 (digital signage emergency alerts)', Accept: 'application/cap+xml, application/atom+xml, application/geo+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' },
    maxBytes: 4 * 1024 * 1024, timeoutMs: 15000, fetcher,
  };
  const { text } = await fetchText(feed.url, opts);
  const parsed = parseFeed(text, { lang: feed.language || 'en' });
  const alerts = parsed.alerts.slice();
  const links = parsed.links.slice(0, MAX_LINKED_DOCS);
  for (let i = 0; i < links.length; i += 4) {
    const batch = await Promise.all(links.slice(i, i + 4).map(async (u) => {
      try {
        const abs = new URL(u, feed.url).toString();
        const r = await fetchText(abs, { ...opts, maxBytes: 512 * 1024 });
        return parseFeed(r.text, { lang: feed.language || 'en' }).alerts;
      } catch { return []; }   // one unreadable linked document must not lose the rest
    }));
    for (const b of batch) alerts.push(...b);
  }
  return { kind: parsed.kind, alerts, linked: links.length, skipped_links: Math.max(0, parsed.links.length - links.length) };
}

function describeError(e) {
  if (e && e.userMessage) return e.userMessage;
  if (e && e.message && /alert feed|web page|GeoJSON|CAP/.test(e.message)) return e.message;
  return 'The feed could not be reached.';
}

async function pollFeed(db, feed, { fetcher = testFetcher } = {}) {
  if (polling.has(feed.id)) return { skipped: true };
  polling.add(feed.id);
  const now = clock();
  try {
    const r = await fetchFeed(feed, { fetcher });
    applyPoll(db, feed, r.alerts, now);
    refresh(db, feed.id);
    return { ok: true, count: r.alerts.length };
  } catch (e) {
    db.prepare('UPDATE cap_feeds SET last_polled_at = ?, last_error = ? WHERE id = ?').run(now, describeError(e), feed.id);
    refresh(db, feed.id);   // expiry still applies while the feed is down
    return { ok: false, error: describeError(e) };
  } finally {
    polling.delete(feed.id);
  }
}

/* ============================== live state + pushes ============================== */

function pushTo(deviceIds) {
  if (!io || !deviceIds.length) return;
  try {
    const { buildPlaylistPayload } = require('../../ws/deviceSocket');
    const commandQueue = require('../command-queue');
    for (const id of deviceIds) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
  } catch (e) { /* best effort: the next payload build reads the same state */ }
}

/**
 * Re-derive a feed's live set; when it changed, bump the card and push every screen in scope.
 * `extraDevices`: screens that left the scope in the same change (a scope edit) and need their
 * normal payload back. Returns true when something changed.
 */
function refresh(db, feedId, { extraDevices = [], force = false } = {}) {
  const feed = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(feedId);
  const before = liveSig.get(feedId) || '';
  const live = feed && feed.enabled ? liveAlerts(db, feed) : [];
  const sig = live.map((a) => `${alertKey(a)}@${a.sent}`).join('\n');
  if (sig) liveSig.set(feedId, sig); else liveSig.delete(feedId);
  announce(db, feed, feedId, live);
  if (sig === before && !force) { if (extraDevices.length) pushTo(extraDevices); return false; }
  if (feed) bumpWidget(db, feed);
  pushTo([...new Set([...(feed ? devicesInScope(db, feed) : []), ...extraDevices])]);
  return true;
}

/**
 * The alert this screen must show now, or null. Called for every payload build, so the common case
 * (no feed anywhere has a live alert) is one Map.size test.
 */
/*
 * Tell automation (lib/automation/events.js) which alerts went live and which ended, for Zapier-style
 * subscribers. Diffed by alert key, so a re-poll of the same set says nothing, and silent while
 * start() restores the live set after a restart.
 */
function announce(db, feed, feedId, live) {
  const prev = liveInfo.get(feedId) || new Map();
  const next = new Map(live.map((a) => [alertKey(a), {
    alert_id: a.identifier, event: a.event, headline: a.headline, severity: a.severity, area: a.areaDesc, expires: a.expires,
  }]));
  if (next.size) liveInfo.set(feedId, next); else liveInfo.delete(feedId);
  if (restoring || !feed) return;
  let ev;
  try { ev = require('../automation/events'); } catch (_) { return; }
  const base = { feed_id: feed.id, feed_name: feed.name, source: feed.source === 'hook' ? 'hook' : 'feed' };
  for (const [k, v] of next) if (!prev.has(k)) ev.emit(db, feed.workspace_id, 'emergency_raised', { ...base, ...v });
  for (const [k, v] of prev) if (!next.has(k)) ev.emit(db, feed.workspace_id, 'emergency_cleared', { ...base, ...v });
}

/* ============================== push-mode feeds (lib/automation) ============================== */

/*
 * cap_alerts.ended on a push-mode feed:
 *   0  not ended (live, or past its expiry)
 *   1  ended by the SENDER's CAP Cancel / Update — final: CAP identifiers are unique per alert, so
 *      the same identifier again is a retry of something already over
 *   2  ended by a hook clear (endPushed): an "all clear" or a clear by id. ⚠️ RE-RAISABLE: a hook
 *      alert without an id is keyed on a hash of its body, so "Evacuate", the all-clear, then the
 *      same "Evacuate" is the same key — and has to show again, not answer "no change" for a week.
 * A polled feed (applyPoll) only ever writes 0 and 1, and keeps its MAX rule.
 */
const ENDED_FINAL = 1;
const ENDED_CLEARED = 2;

/**
 * Add or update alerts on a push-mode feed. Idempotent on sender + identifier: the same alert sent
 * twice while it is live is one row and one raise, and an Update / Cancel ends every alert its
 * references name. Unlike applyPoll, alerts not mentioned are left alone — a push is one message,
 * not the whole current set. An alert sent again after a hook cleared it, or after it expired, is
 * raised again.
 * Returns { raised: [keys that went live], ended: [keys that went from live to ended] }.
 */
function applyPush(db, feed, alerts, now = clock()) {
  const raised = [];
  const ended = [];
  db.transaction(() => {
    const get = db.prepare('SELECT ended, data FROM cap_alerts WHERE feed_id = ? AND akey = ?');
    const upsert = db.prepare(`INSERT INTO cap_alerts (feed_id, akey, data, in_feed, ended, first_seen, last_seen)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(feed_id, akey) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen,
        ended = CASE WHEN excluded.ended = ${ENDED_FINAL} THEN ${ENDED_FINAL}
                     WHEN cap_alerts.ended = ${ENDED_CLEARED} THEN 0
                     ELSE cap_alerts.ended END`);
    const endOne = db.prepare(`UPDATE cap_alerts SET ended = ${ENDED_FINAL}, last_seen = ? WHERE feed_id = ? AND akey = ? AND ended = 0`);
    for (const a of alerts) {
      if (!a || !a.identifier) continue;
      const refs = (a.msgType === 'Update' || a.msgType === 'Cancel') ? (a.references || []).map(referenceKey) : [];
      for (const k of refs) if (endOne.run(now, feed.id, k).changes) ended.push(k);
      const key = alertKey(a);
      const prior = get.get(feed.id, key);
      const isEnd = a.msgType === 'Cancel';
      upsert.run(feed.id, key, JSON.stringify(a), isEnd ? ENDED_FINAL : 0, now, now);
      if (isEnd) { if (prior && !prior.ended) ended.push(key); continue; }
      let priorExpired = false;
      if (prior && !prior.ended) { try { priorExpired = hasExpired(JSON.parse(prior.data), now); } catch { priorExpired = false; } }
      if (!prior || prior.ended === ENDED_CLEARED || priorExpired) raised.push(key);
    }
    db.prepare('DELETE FROM cap_alerts WHERE feed_id = ? AND ended != 0 AND last_seen < ?').run(feed.id, now - 7 * 86400);
  })();
  return { raised, ended };
}

/** End alerts on a push-mode feed (a hook clear, so re-raisable): the named keys, or every live one when `keys` is null. */
function endPushed(db, feed, keys = null, now = clock()) {
  const rows = keys
    ? keys.map((k) => ({ akey: k }))
    : db.prepare('SELECT akey FROM cap_alerts WHERE feed_id = ? AND ended = 0').all(feed.id);
  const endOne = db.prepare(`UPDATE cap_alerts SET ended = ${ENDED_CLEARED}, last_seen = ? WHERE feed_id = ? AND akey = ? AND ended = 0`);
  const ended = [];
  for (const r of rows) if (endOne.run(now, feed.id, r.akey).changes) ended.push(r.akey);
  return ended;
}

function overrideFor(db, deviceId) {
  if (!liveSig.size) return null;
  const dev = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!dev || !dev.workspace_id) return null;
  let best = null;
  for (const feedId of liveSig.keys()) {
    const feed = db.prepare('SELECT * FROM cap_feeds WHERE id = ? AND workspace_id = ? AND enabled = 1').get(feedId, dev.workspace_id);
    if (!feed || !inScope(db, feed, deviceId)) continue;
    const alerts = liveAlerts(db, feed);
    if (!alerts.length) continue;
    const rank = SEVERITY_RANK[alerts[0].severity] || 0;
    if (!best || rank > best.rank) best = { feed, alerts, rank };
  }
  return best ? { feed: best.feed, alerts: best.alerts } : null;
}

/**
 * The payload item that shows the card.
 *
 * `interrupt: true` is the "show this now" flag, and this is the ONLY item that carries it
 * (ws/deviceSocket.js strips it from anything else). Raising an alert replaces the screen's playlist
 * with this card, which removes the item on screen — exactly the case every player's #157 deferral
 * holds back "until the current item finishes", so the card used to appear up to 60 s late. A player
 * that sees the SET of interrupt items change (an alert raised, cleared, or a different feed taking
 * over) swaps immediately instead; an ordinary edit still defers. Head office "activate now"
 * alerts (lib/corporate/emergency-live.js) flag their items the same way. See
 * docs/player-parity.md, "Emergency alerts cut in".
 */
function cardItem(feed) {
  return {
    content_id: null, widget_id: feed.widget_id, child_playlist_id: null, zone_id: null, sort_order: 0,
    duration_sec: 60, muted: 1, filename: null, mime_type: null, remote_url: null,
    widget_name: `Emergency alert: ${feed.name}`, widget_type: 'cap_alert', widget_config: null, widget_rev: null,
    interrupt: true,
  };
}

function tick(db) {
  const now = clock();
  let feeds;
  try { feeds = db.prepare('SELECT * FROM cap_feeds WHERE enabled = 1').all(); } catch { return; }
  for (const f of feeds) {
    // A hook-owned feed (lib/automation) is pushed to, never fetched.
    if (f.source && f.source !== 'poll') continue;
    if (!f.last_polled_at || f.last_polled_at + (f.poll_sec || DEFAULT_POLL) <= now) {
      pollFeed(db, f).catch((e) => console.warn(`[cap] poll ${f.id} failed: ${e && e.message}`));
    }
  }
  // Expiry with nobody polling: a live set can shrink on the clock alone.
  for (const id of [...liveSig.keys()]) { try { refresh(db, id); } catch (_) { /* next tick */ } }
}

function start(ioRef) {
  io = ioRef || null;
  if (timer) return;
  const db = dbOf();
  // Restore what was live before a restart, so screens do not drop an alert while the first poll runs.
  restoring = true;
  try { for (const f of db.prepare('SELECT id FROM cap_feeds WHERE enabled = 1').all()) refresh(db, f.id); } catch (_) { /* tables absent */ }
  finally { restoring = false; }
  timer = setInterval(() => { try { tick(db); } catch (e) { console.warn(`[cap] tick: ${e && e.message}`); } }, TICK_MS);
  if (timer.unref) timer.unref();
}

function _setClock(fn) { clock = fn || (() => Math.floor(Date.now() / 1000)); }
function _reset() { liveSig.clear(); liveInfo.clear(); polling.clear(); }
function _setFetcher(fn) { testFetcher = fn || null; }
function _setIo(ref) { io = ref || null; }

module.exports = {
  normaliseInput, validateScopes, setScopes, scopesOf, devicesInScope, inScope,
  ensureWidget, liveAlerts, applyPoll, applyPush, endPushed, fetchFeed, pollFeed, refresh, overrideFor, cardItem, describeError,
  isLive, matchesFilters, start, tick, severityOf, MIN_POLL, MAX_POLL, DEFAULT_POLL,
  now: () => clock(),
  _setClock, _reset, _setFetcher, _setIo,
};
