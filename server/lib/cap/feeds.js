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
  const sig = feed && feed.enabled ? liveAlerts(db, feed).map((a) => `${alertKey(a)}@${a.sent}`).join('\n') : '';
  if (sig) liveSig.set(feedId, sig); else liveSig.delete(feedId);
  if (sig === before && !force) { if (extraDevices.length) pushTo(extraDevices); return false; }
  if (feed) bumpWidget(db, feed);
  pushTo([...new Set([...(feed ? devicesInScope(db, feed) : []), ...extraDevices])]);
  return true;
}

/**
 * The alert this screen must show now, or null. Called for every payload build, so the common case
 * (no feed anywhere has a live alert) is one Map.size test.
 */
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

/** The payload item that shows the card. */
function cardItem(feed) {
  return {
    content_id: null, widget_id: feed.widget_id, child_playlist_id: null, zone_id: null, sort_order: 0,
    duration_sec: 60, muted: 1, filename: null, mime_type: null, remote_url: null,
    widget_name: `Emergency alert: ${feed.name}`, widget_type: 'cap_alert', widget_config: null, widget_rev: null,
  };
}

function tick(db) {
  const now = clock();
  let feeds;
  try { feeds = db.prepare('SELECT * FROM cap_feeds WHERE enabled = 1').all(); } catch { return; }
  for (const f of feeds) {
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
  try { for (const f of db.prepare('SELECT id FROM cap_feeds WHERE enabled = 1').all()) refresh(db, f.id); } catch (_) { /* tables absent */ }
  timer = setInterval(() => { try { tick(db); } catch (e) { console.warn(`[cap] tick: ${e && e.message}`); } }, TICK_MS);
  if (timer.unref) timer.unref();
}

function _setClock(fn) { clock = fn || (() => Math.floor(Date.now() / 1000)); }
function _reset() { liveSig.clear(); polling.clear(); }
function _setFetcher(fn) { testFetcher = fn || null; }
function _setIo(ref) { io = ref || null; }

module.exports = {
  normaliseInput, validateScopes, setScopes, scopesOf, devicesInScope, inScope,
  ensureWidget, liveAlerts, applyPoll, fetchFeed, pollFeed, refresh, overrideFor, cardItem, describeError,
  isLive, matchesFilters, start, tick, severityOf, MIN_POLL, MAX_POLL, DEFAULT_POLL,
  now: () => clock(),
  _setClock, _reset, _setFetcher, _setIo,
};
