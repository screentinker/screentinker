'use strict';

/*
 * Audience counting (docs/audience-counting.md): how many people looked at a screen, and for how long.
 *
 * ⚠️ PRIVACY IS THE PRODUCT, AND IT IS ENFORCED HERE, NOT ONLY ON THE PLAYER.
 *
 * Detection runs on the screen. No image, frame, face crop, embedding or identifier ever leaves it —
 * and this server is built so that it could not accept one if a player tried: the only thing the
 * ingest path stores is a fixed set of small INTEGERS per time bucket. A record with any field this
 * file does not name, or any value that is not a bounded integer, is dropped whole. There is no
 * free-text field, no blob column and no array of unbounded length anywhere in the table.
 *
 * Off by default, at three levels, all of which must be on:
 *   1. the ORGANIZATION allows it (an org owner/admin, audience_org_settings.allowed),
 *   2. the SCREEN, or a group it belongs to, has it enabled (again an org admin),
 *   3. the player declared it can (capability 'audience.camera') and, on Android, holds the
 *      camera permission.
 * A device can never switch it on for itself: buckets from a screen that is not enabled are acked
 * (so its queue drains) and thrown away.
 *
 * What a bucket says, per screen, per minute, per item on screen:
 *   present_max        most people in view at once
 *   present_avg_x100   average people in view, x100 (an integer: 1.25 people = 125)
 *   arrivals           people who came into view
 *   impressions        of those, people who LOOKED at the screen for at least min_dwell_ms
 *   dwell[6]           how long each look lasted: <2s, 2-5s, 5-15s, 15-30s, 30-60s, 60s+
 */

const { db } = require('../db/database');

const DWELL_LABELS = ['<2s', '2-5s', '5-15s', '15-30s', '30-60s', '60s+'];
// Midpoints for an AVERAGE dwell estimate from the histogram (the 60s+ bucket is counted as 90s).
const DWELL_MID_SEC = [1, 3.5, 10, 22.5, 45, 90];
const ITEM_KINDS = new Set(['content', 'widget', 'none']);
const BUCKET_KEYS = new Set(['id', 'start', 'seconds', 'item_kind', 'item_id', 'playlist_id',
  'present_max', 'present_avg_x100', 'arrivals', 'impressions', 'dwell']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;
const MAX_BATCH = 200;
const MAX_AGE_SEC = 35 * 86400;          // an offline screen keeps its buckets; a month and a bit is plenty

const DEFAULTS = Object.freeze({ allowed: false, show_indicator: true, fps: 2, min_dwell_ms: 1000, retention_days: 90 });
const LIMITS = Object.freeze({ fps: [1, 5], min_dwell_ms: [500, 10000], retention_days: [1, 730] });

/* ============================== settings ============================== */

function orgSettings(orgId) {
  const r = orgId ? db.prepare('SELECT * FROM audience_org_settings WHERE organization_id = ?').get(orgId) : null;
  if (!r) return { ...DEFAULTS };
  return {
    allowed: !!r.allowed,
    show_indicator: !!r.show_indicator,
    fps: r.fps,
    min_dwell_ms: r.min_dwell_ms,
    retention_days: r.retention_days,
  };
}

const clampInt = (v, [lo, hi]) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** Validate a settings PATCH. Returns { next } or { error }. */
function mergeOrgSettings(orgId, body) {
  const cur = orgSettings(orgId);
  const b = body || {};
  const next = { ...cur };
  if (b.allowed !== undefined) {
    if (typeof b.allowed !== 'boolean') return { error: 'allowed must be true or false' };
    next.allowed = b.allowed;
  }
  if (b.show_indicator !== undefined) {
    if (typeof b.show_indicator !== 'boolean') return { error: 'show_indicator must be true or false' };
    next.show_indicator = b.show_indicator;
  }
  for (const k of ['fps', 'min_dwell_ms', 'retention_days']) {
    if (b[k] === undefined) continue;
    const v = clampInt(b[k], LIMITS[k]);
    if (v === null) return { error: `${k} must be a whole number from ${LIMITS[k][0]} to ${LIMITS[k][1]}` };
    next[k] = v;
  }
  return { next };
}

function saveOrgSettings(orgId, s) {
  db.prepare(`INSERT INTO audience_org_settings (organization_id, allowed, show_indicator, fps, min_dwell_ms, retention_days, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(organization_id) DO UPDATE SET allowed = excluded.allowed, show_indicator = excluded.show_indicator,
      fps = excluded.fps, min_dwell_ms = excluded.min_dwell_ms, retention_days = excluded.retention_days, updated_at = excluded.updated_at`)
    .run(orgId, s.allowed ? 1 : 0, s.show_indicator ? 1 : 0, s.fps, s.min_dwell_ms, s.retention_days);
}

function orgOfDevice(deviceId) {
  const r = db.prepare('SELECT d.workspace_id, w.organization_id FROM devices d LEFT JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?').get(deviceId);
  return r || null;
}

/** Is counting switched on for this screen — directly or through any group it is in? (Org switch aside.) */
function screenEnabled(deviceId) {
  const r = db.prepare(`SELECT
      (SELECT audience_enabled FROM devices WHERE id = ?) AS direct,
      (SELECT COUNT(*) FROM device_group_members m JOIN device_groups g ON g.id = m.group_id
        WHERE m.device_id = ? AND g.audience_enabled = 1) AS via_group`).get(deviceId, deviceId);
  return !!(r && (r.direct === 1 || r.via_group > 0));
}

/**
 * What the player is told, on every playlist payload. null = off, which the player must treat as
 * "stop the camera now", exactly as it treats an absent power schedule. A screen learns it is off
 * the same way it learned it was on, so switching it off cannot be lost by a missed command.
 */
function payloadConfig(deviceId) {
  try {
    const o = orgOfDevice(deviceId);
    if (!o || !o.organization_id) return null;
    const s = orgSettings(o.organization_id);
    if (!s.allowed || !screenEnabled(deviceId)) return null;
    return { enabled: true, fps: s.fps, min_dwell_ms: s.min_dwell_ms, bucket_sec: 60, show_indicator: s.show_indicator };
  } catch (e) {
    // Fail OFF. A broken lookup must never be the reason a camera starts.
    if (!/no such (table|column)/i.test(e.message)) console.warn(`[audience] config for ${deviceId} failed: ${e.message}`);
    return null;
  }
}

/* ============================== ingest ============================== */

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * One bucket, validated. Returns a row or null. STRICT: every key must be one we name, every number a
 * bounded integer. Nothing is coerced — "3" is not 3 — so a player bug cannot smuggle text through.
 */
function validateBucket(r, nowS) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  for (const k of Object.keys(r)) if (!BUCKET_KEYS.has(k)) return null;   // anything else, image-like or not, refuses the record
  if (!isInt(r.seconds, 60, 3600) || r.seconds % 60 !== 0) return null;
  if (!isInt(r.start, nowS - MAX_AGE_SEC, nowS + 120) || r.start % 60 !== 0) return null;
  if (r.start + r.seconds > nowS + 120) return null;                         // a bucket that has not finished yet
  if (!ITEM_KINDS.has(r.item_kind)) return null;
  const itemId = r.item_kind === 'none' ? null : r.item_id;
  if (r.item_kind !== 'none' && (typeof itemId !== 'string' || !ID_RE.test(itemId))) return null;
  if (r.playlist_id !== undefined && r.playlist_id !== null && (typeof r.playlist_id !== 'string' || !ID_RE.test(r.playlist_id))) return null;
  if (!isInt(r.present_max, 0, 100)) return null;
  if (!isInt(r.present_avg_x100, 0, 10000) || r.present_avg_x100 > r.present_max * 100) return null;
  if (!isInt(r.arrivals, 0, 5000)) return null;
  if (!isInt(r.impressions, 0, 5000) || r.impressions > r.arrivals) return null;
  if (!Array.isArray(r.dwell) || r.dwell.length !== DWELL_LABELS.length) return null;
  if (!r.dwell.every((n) => isInt(n, 0, 5000))) return null;
  if (r.dwell.reduce((a, b) => a + b, 0) > 5000) return null;
  return {
    start: r.start, seconds: r.seconds, item_kind: r.item_kind, item_id: itemId,
    playlist_id: r.playlist_id || null,
    present_max: r.present_max, present_avg_x100: r.present_avg_x100,
    arrivals: r.arrivals, impressions: r.impressions, dwell: r.dwell,
  };
}

let _ins = null;
function insertStmt() {
  if (!_ins) {
    _ins = db.prepare(`INSERT OR IGNORE INTO audience_buckets (device_id, workspace_id, bucket_start, bucket_sec, item_kind, item_id,
        playlist_id, present_max, present_avg_x100, arrivals, impressions, d0, d1, d2, d3, d4, d5)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }
  return _ins;
}

/**
 * device:audience from an AUTHENTICATED device. Returns { ids, written, refused }.
 * Every well-formed client id is acked — stored, already stored, malformed, or refused because the
 * screen is not enabled — because a record the server will never take must not wedge the queue.
 */
function ingest(deviceId, data, nowS = Math.floor(Date.now() / 1000)) {
  const list = Array.isArray(data && data.buckets) ? data.buckets.slice(0, MAX_BATCH) : [];
  const ids = [];
  for (const r of list) if (r && typeof r.id === 'string' && CLIENT_ID_RE.test(r.id)) ids.push(r.id);
  if (!list.length) return { ids, written: 0, refused: 0 };

  // ⚠️ The DEVICE never decides. Counting must be on for this screen right now, by the org's own
  // settings, or nothing it sends is kept.
  if (!payloadConfig(deviceId)) return { ids, written: 0, refused: list.length };

  const o = orgOfDevice(deviceId);
  const ws = o && o.workspace_id;
  /*
   * In the screen's ORGANIZATION, not only its workspace: a head-office playlist (corporate) and an
   * automation playlist override both put another workspace's items on this screen (tagged
   * __origin_ws in the payload), and those are exactly the items whose audience is asked about.
   * Another organization's ids are still refused, so a screen cannot pin counts on a stranger's content.
   */
  const org = o && o.organization_id;
  const inOrg = (table, extra = '') => db.prepare(`SELECT 1 FROM ${table} t WHERE t.id = ? AND (t.workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?)${extra})`).pluck();
  const contentQ = inOrg('content');
  const widgetQ = inOrg('widgets', ' OR t.workspace_id IS NULL');
  const playlistQ = inOrg('playlists');
  const contentIn = { get: (id) => contentQ.get(id, org) };
  const widgetIn = { get: (id) => widgetQ.get(id, org) };
  const playlistIn = { get: (id) => playlistQ.get(id, org) };
  // A player that does not know its playlist (Android today) is attributed the one this screen is
  // resolved to NOW — right for buckets from the last few minutes, which is almost all of them.
  let currentPlaylist = null;
  try { currentPlaylist = require('./resolve-device-playlist').resolveDevicePlaylistId(deviceId) || null; } catch (_) { currentPlaylist = null; }
  let written = 0;
  let refused = 0;
  const tx = db.transaction(() => {
    for (const raw of list) {
      if (!raw || typeof raw.id !== 'string' || !CLIENT_ID_RE.test(raw.id)) { refused++; continue; }
      const b = validateBucket(raw, nowS);
      if (!b) { refused++; continue; }
      // Attribution is kept only for an item in THIS workspace; otherwise a screen could pin its
      // counts on another tenant's content id. The counts themselves are still the screen's.
      let kind = b.item_kind;
      let item = b.item_id;
      if (kind === 'content' && !contentIn.get(item, ws)) { kind = 'none'; item = null; }
      if (kind === 'widget' && !widgetIn.get(item, ws)) { kind = 'none'; item = null; }
      const claimed = raw.playlist_id === undefined ? currentPlaylist : b.playlist_id;
      const pl = claimed && playlistIn.get(claimed, ws) ? claimed : null;
      written += insertStmt().run(deviceId, ws, b.start, b.seconds, kind, item, pl,
        b.present_max, b.present_avg_x100, b.arrivals, b.impressions, ...b.dwell).changes;
    }
  });
  tx();
  return { ids, written, refused };
}

/* ============================== reports ============================== */

const avgDwellSql = `(${DWELL_MID_SEC.map((m, i) => `SUM(d${i}) * ${m}`).join(' + ')}) * 1.0 / NULLIF(${DWELL_MID_SEC.map((_, i) => `SUM(d${i})`).join(' + ')}, 0)`;
const metricsSql = `SUM(arrivals) AS arrivals, SUM(impressions) AS impressions, MAX(present_max) AS peak_present,
  ${avgDwellSql} AS avg_dwell_sec, ${DWELL_MID_SEC.map((_, i) => `SUM(d${i}) AS d${i}`).join(', ')},
  SUM(present_avg_x100 * bucket_sec) / 100.0 AS person_seconds, SUM(bucket_sec) AS observed_sec`;

function shapeMetrics(r) {
  const n = (v) => Number(v) || 0;
  return {
    arrivals: n(r.arrivals), impressions: n(r.impressions), peak_present: n(r.peak_present),
    avg_dwell_sec: r.avg_dwell_sec == null ? 0 : Math.round(r.avg_dwell_sec * 10) / 10,
    dwell: DWELL_LABELS.map((label, i) => ({ label, count: n(r[`d${i}`]) })),
    // Average people in view across the minutes counted.
    avg_present: n(r.observed_sec) ? Math.round((n(r.person_seconds) / n(r.observed_sec)) * 100) / 100 : 0,
    observed_minutes: Math.round(n(r.observed_sec) / 60),
  };
}

/**
 * The Audience report for one workspace. `tzOffsetMin` shifts hour-of-day and days into the viewer's
 * time zone (as Date.getTimezoneOffset() reports it: minutes BEHIND UTC, so UTC-5 is 300).
 */
function report(workspaceId, { start, end, deviceId = null, tzOffsetMin = 0 }) {
  const empty = { overall: shapeMetrics({}), by_item: [], by_device: [], by_playlist: [], by_hour: [], by_day: [] };
  if (!workspaceId) return empty;
  const shift = -Math.trunc(tzOffsetMin) * 60;   // seconds to ADD to UTC for local time
  const where = 'ab.workspace_id = ? AND ab.bucket_start >= ? AND ab.bucket_start <= ?' + (deviceId ? ' AND ab.device_id = ?' : '');
  const p = [workspaceId, start, end, ...(deviceId ? [deviceId] : [])];

  const overall = shapeMetrics(db.prepare(`SELECT ${metricsSql} FROM audience_buckets ab WHERE ${where}`).get(...p) || {});
  const byItem = db.prepare(`SELECT ab.item_kind, ab.item_id, COALESCE(c.filename, w.name) AS item_name, ${metricsSql}
      FROM audience_buckets ab
      LEFT JOIN content c ON ab.item_kind = 'content' AND c.id = ab.item_id
      LEFT JOIN widgets w ON ab.item_kind = 'widget' AND w.id = ab.item_id
      WHERE ${where} GROUP BY ab.item_kind, ab.item_id ORDER BY impressions DESC LIMIT 200`).all(...p);
  // Proof-of-play beside the counts: impressions per play is the number a buyer asks for.
  const plays = db.prepare(`SELECT content_id, COUNT(*) AS plays FROM play_logs
      WHERE workspace_id = ? AND started_at >= ? AND started_at <= ?${deviceId ? ' AND device_id = ?' : ''} GROUP BY content_id`).all(...p);
  const playsBy = new Map(plays.map((r) => [r.content_id, r.plays]));
  const byDevice = db.prepare(`SELECT ab.device_id, d.name AS device_name, ${metricsSql}
      FROM audience_buckets ab LEFT JOIN devices d ON d.id = ab.device_id
      WHERE ${where} GROUP BY ab.device_id ORDER BY impressions DESC`).all(...p);
  const byPlaylist = db.prepare(`SELECT ab.playlist_id, pl.name AS playlist_name, ${metricsSql}
      FROM audience_buckets ab LEFT JOIN playlists pl ON pl.id = ab.playlist_id
      WHERE ${where} AND ab.playlist_id IS NOT NULL GROUP BY ab.playlist_id ORDER BY impressions DESC`).all(...p);
  const byHour = db.prepare(`SELECT CAST(strftime('%H', ab.bucket_start + ?, 'unixepoch') AS INTEGER) AS hour, ${metricsSql}
      FROM audience_buckets ab WHERE ${where} GROUP BY hour ORDER BY hour`).all(shift, ...p);
  const byDay = db.prepare(`SELECT date(ab.bucket_start + ?, 'unixepoch') AS day, ${metricsSql}
      FROM audience_buckets ab WHERE ${where} GROUP BY day ORDER BY day`).all(shift, ...p);

  return {
    overall,
    by_item: byItem.map((r) => {
      const m = shapeMetrics(r);
      const pl = r.item_id ? (playsBy.get(r.item_id) || 0) : 0;
      return { item_kind: r.item_kind, item_id: r.item_id || null, item_name: r.item_name || null, plays: pl,
        impressions_per_play: pl ? Math.round((m.impressions / pl) * 100) / 100 : null, ...m };
    }),
    by_device: byDevice.map((r) => ({ device_id: r.device_id, device_name: r.device_name || null, ...shapeMetrics(r) })),
    by_playlist: byPlaylist.map((r) => ({ playlist_id: r.playlist_id, playlist_name: r.playlist_name || null, ...shapeMetrics(r) })),
    by_hour: Array.from({ length: 24 }, (_, h) => {
      const r = byHour.find((x) => x.hour === h);
      return { hour: h, ...(r ? shapeMetrics(r) : shapeMetrics({})) };
    }),
    by_day: byDay.map((r) => ({ day: r.day, ...shapeMetrics(r) })),
  };
}

/** Per-minute rows for CSV export. Numbers and names only — nothing else exists to export. */
function exportRows(workspaceId, { start, end, deviceId = null }) {
  if (!workspaceId) return [];
  const where = 'ab.workspace_id = ? AND ab.bucket_start >= ? AND ab.bucket_start <= ?' + (deviceId ? ' AND ab.device_id = ?' : '');
  const p = [workspaceId, start, end, ...(deviceId ? [deviceId] : [])];
  return db.prepare(`SELECT ab.bucket_start, ab.bucket_sec, ab.device_id, d.name AS device_name, ab.item_kind,
        NULLIF(ab.item_id, '') AS item_id, COALESCE(c.filename, w.name) AS item_name, ab.playlist_id,
        ab.present_max, ab.present_avg_x100, ab.arrivals, ab.impressions, ab.d0, ab.d1, ab.d2, ab.d3, ab.d4, ab.d5
      FROM audience_buckets ab
      LEFT JOIN devices d ON d.id = ab.device_id
      LEFT JOIN content c ON ab.item_kind = 'content' AND c.id = ab.item_id
      LEFT JOIN widgets w ON ab.item_kind = 'widget' AND w.id = ab.item_id
      WHERE ${where} ORDER BY ab.bucket_start, ab.device_id LIMIT 500000`).all(...p);
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Spreadsheet formula injection: a name starting with = + - @ would be evaluated on open.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const head = ['minute_utc', 'bucket_sec', 'device_id', 'device_name', 'item_kind', 'item_id', 'item_name', 'playlist_id',
    'people_max', 'people_avg', 'arrivals', 'impressions', ...DWELL_LABELS.map((l) => `dwell_${l}`)];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([new Date(r.bucket_start * 1000).toISOString(), r.bucket_sec, r.device_id, r.device_name, r.item_kind, r.item_id,
      r.item_name, r.playlist_id, r.present_max, (r.present_avg_x100 / 100).toFixed(2), r.arrivals, r.impressions,
      r.d0, r.d1, r.d2, r.d3, r.d4, r.d5].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/* ============================== retention ============================== */

/** Delete buckets past their organization's retention (default 90 days). Returns rows deleted. */
function purgeExpired(limit = 5000, nowS = Math.floor(Date.now() / 1000)) {
  return db.prepare(`DELETE FROM audience_buckets WHERE rowid IN (
      SELECT ab.rowid FROM audience_buckets ab
        LEFT JOIN workspaces w ON w.id = ab.workspace_id
        LEFT JOIN audience_org_settings s ON s.organization_id = w.organization_id
       WHERE ab.bucket_start < ? - COALESCE(s.retention_days, ?) * 86400
       LIMIT ?)`).run(nowS, DEFAULTS.retention_days, limit).changes;
}

/** The screens whose payload depends on an org's settings, a group, or one device — to push after a change. */
function devicesForOrg(orgId) {
  return db.prepare('SELECT d.id FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = ?').pluck().all(orgId);
}
function devicesForGroup(groupId) {
  return db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').pluck().all(groupId);
}

module.exports = {
  DEFAULTS, LIMITS, DWELL_LABELS,
  orgSettings, mergeOrgSettings, saveOrgSettings, screenEnabled, payloadConfig,
  validateBucket, ingest, report, exportRows, toCsv, purgeExpired, devicesForOrg, devicesForGroup,
};
