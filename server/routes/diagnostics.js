'use strict';

/*
 * Server diagnostics for a platform operator — the data we used to ask a customer to fetch over SSH.
 *
 * ⚠️ WHY THIS EXISTS. Diagnosing a slow install meant emailing someone a shell script, talking them
 * through finding a PID, and asking them to run it as root on their production box. That is a bad
 * step in a support conversation and a worse one in a security review, and it fails outright for
 * anyone who cannot get a terminal on the host. Everything here was already being recorded — the
 * loop-lag history has been written every second since the table existed and was surfaced nowhere —
 * so this is mostly a matter of showing what the server already knows.
 *
 * ⚠️ WHAT IT DELIBERATELY DOES NOT RETURN. Counts, byte-sizes, timings, function names, file paths.
 * No playlist content, no media, no device tokens, no credentials, no operator text. The shape
 * report is COUNT(*) and LENGTH() only; the profile is V8 sample data. Anything that would be
 * awkward in a support ticket does not belong in an endpoint whose whole purpose is being pasted
 * into one.
 *
 * ⚠️ PLATFORM ADMIN ONLY, and that is a stronger gate than it looks. A workspace owner is not an
 * operator of the host: table row counts across every tenant, and a CPU profile naming this
 * deployment's code paths, are the platform's business and not a customer's. requirePlatformAdmin
 * is applied per route rather than router-wide so a future addition cannot inherit a weaker gate by
 * being added in the wrong place.
 */

const express = require('express');
const fs = require('fs');
const inspector = require('inspector');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const { requirePlatformAdmin } = require('../middleware/auth');
const { logActivity, getClientIp } = require('../services/activity');
const loopLag = require('../services/loop-lag');

/* ------------------------------------------------------------------ instance shape */

/**
 * Row counts for every table that EXISTS, discovered from sqlite_master rather than listed.
 *
 * ⚠️ DISCOVERED, NOT HARDCODED. A hand-written table list is wrong the moment it meets an install
 * on a different schema version — which is exactly the case this endpoint is for. Writing the list
 * out by hand already cost us one round trip with a customer: `item_schedules` and `zone_assignments`
 * do not exist; the real names are `playlist_item_schedules` and `assignments`.
 */
function tableCounts() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  const out = [];
  for (const { name } of tables) {
    // The name comes from sqlite_master, not from a request, and is quoted regardless.
    try { out.push({ table: name, rows: db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c }); }
    catch (_) { /* a view or a table mid-migration: skip rather than fail the report */ }
  }
  return out.sort((a, b) => b.rows - a.rows);
}

/** One number, guarded — a missing table on an older schema must not empty the whole report. */
function one(sql, fallback = null) {
  try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : fallback; }
  catch (_) { return fallback; }
}
function row(sql) {
  try { return db.prepare(sql).get() || null; } catch (_) { return null; }
}

router.get('/shape', requirePlatformAdmin, (req, res) => {
  const pageBytes = one('SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()', 0);
  let walBytes = 0;
  try { walBytes = fs.statSync(`${config.dbPath}-wal`).size; } catch (_) { /* no WAL right now */ }

  res.json({
    db: { path_bytes: pageBytes, wal_bytes: walBytes, sqlite: one('SELECT sqlite_version() AS v', '?') },
    tables: tableCounts(),
    /*
     * The register path builds and serialises a payload per device, so these are its cost drivers —
     * the numbers that decide whether this install is a normal one or an outlier.
     */
    devices: row("SELECT COUNT(*) AS total, SUM(status='online') AS online, COUNT(DISTINCT playlist_id) AS distinct_playlists FROM devices"),
    playlists: row('SELECT COUNT(*) AS published, MAX(LENGTH(published_snapshot)) AS max_snapshot_bytes, CAST(AVG(LENGTH(published_snapshot)) AS INT) AS avg_snapshot_bytes FROM playlists WHERE published_snapshot IS NOT NULL'),
    assigned_playlists: row('SELECT COUNT(*) AS n, MAX(LENGTH(published_snapshot)) AS max_snapshot_bytes FROM playlists WHERE id IN (SELECT DISTINCT playlist_id FROM devices WHERE playlist_id IS NOT NULL)'),
    items_per_playlist: row('SELECT MAX(n) AS max_items, CAST(AVG(n) AS INT) AS avg_items FROM (SELECT COUNT(*) AS n FROM playlist_items GROUP BY playlist_id)'),
    widgets: row('SELECT COUNT(*) AS n, MAX(LENGTH(config)) AS max_config_bytes FROM widgets'),
    workspaces: one('SELECT COUNT(*) AS n FROM workspaces', null),
    /* History tables grow forever and are the usual home of a slow query. */
    play_logs: row('SELECT COUNT(*) AS total, SUM(ended_at IS NULL) AS still_open, MIN(started_at) AS oldest_epoch FROM play_logs'),
    play_log_indexes: (() => {
      try { return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='play_logs'").all().map((r) => r.name); }
      catch (_) { return []; }
    })(),
  });
});

/* ------------------------------------------------------------------ loop lag history */

/*
 * ⚠️ THE TABLE THAT WAS ALREADY THERE. services/loop-lag writes a row every second and nothing ever
 * read it back. Reconstructing "when did this start, and what does it do through the day" by hand
 * from a live endpoint took an afternoon; the answer was in the database the whole time. The daily
 * trend is the one that matters — a step change on a date turns "why is this server slow" into
 * "what happened on the 14th", which is a question somebody can actually answer.
 */
router.get('/lag', requirePlatformAdmin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (_) { return []; } };

  res.json({
    live: loopLag.getLag(),
    span: row('SELECT MIN(sampled_at) AS first_sample, MAX(sampled_at) AS last_sample, COUNT(*) AS samples FROM event_loop_lag'),
    daily: q(
      `SELECT date(sampled_at,'unixepoch') AS day, COUNT(*) AS samples,
              CAST(AVG(p50_ms) AS INT) AS avg_p50, CAST(AVG(p99_ms) AS INT) AS avg_p99,
              CAST(MAX(max_ms) AS INT) AS worst, SUM(band <> 'normal') AS not_normal
         FROM event_loop_lag WHERE sampled_at > strftime('%s','now') - ? * 86400
        GROUP BY day ORDER BY day DESC`, days),
    worst_hours: q(
      `SELECT date(sampled_at,'unixepoch') AS day, strftime('%H',sampled_at,'unixepoch') AS hour,
              COUNT(*) AS samples, CAST(AVG(p50_ms) AS INT) AS avg_p50,
              CAST(AVG(p99_ms) AS INT) AS avg_p99, CAST(MAX(max_ms) AS INT) AS worst
         FROM event_loop_lag WHERE sampled_at > strftime('%s','now') - ? * 86400
        GROUP BY day, hour ORDER BY avg_p99 DESC LIMIT 12`, days),
  });
});

/* ------------------------------------------------------------------ CPU profile */

/*
 * ⚠️ IN-PROCESS, SO NO DEBUG PORT IS EVER OPENED.
 *
 * The obvious route is the one we were about to put in a customer's hands: SIGUSR1 to open the V8
 * inspector on 9229, attach, capture, and hope somebody remembers to close it. inspector.Session
 * connects to the same profiler from inside this process — same data, no listener, nothing to reach
 * from off-box and nothing left behind if this request dies halfway. A button in an admin page is
 * genuinely safer here than the shell recipe it replaces.
 *
 * ⚠️ ONE AT A TIME. Profiling samples the stack a thousand times a second; two concurrent captures
 * on a server that is already struggling — which is the only kind anyone profiles — is a way to
 * make the incident worse while measuring it.
 */
let profiling = false;
const MAX_SECONDS = 120;

router.post('/cpu-profile', requirePlatformAdmin, async (req, res) => {
  if (profiling) return res.status(409).json({ error: 'A profile is already running' });
  const seconds = Math.min(Math.max(parseInt(req.body?.seconds, 10) || 30, 5), MAX_SECONDS);

  profiling = true;
  const session = new inspector.Session();
  const post = (method, params) => new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
  });

  try {
    session.connect();
    await post('Profiler.enable');
    // 1ms: fine enough to catch a 100ms stall, light enough to run on a live server.
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { profile } = await post('Profiler.stop');

    logActivity(req.user.id, 'admin_cpu_profile', `${seconds}s`, null, getClientIp(req), null);
    res.json({ seconds, top: topSelfTime(profile), profile });
  } catch (e) {
    res.status(500).json({ error: `Profiler failed: ${e.message}` });
  } finally {
    try { session.disconnect(); } catch (_) { /* already gone */ }
    profiling = false;
  }
});

/**
 * Where the loop actually sat, as a table.
 *
 * ⚠️ SELF time, not total. Total time blames whatever is highest up the stack — which is always the
 * event loop or an express handler, and tells you nothing. Self time names the function that was
 * executing when the sample was taken, which is the one to go and read.
 */
function topSelfTime(profile, limit = 15) {
  const byId = new Map((profile.nodes || []).map((n) => [n.id, n]));
  const hits = new Map();
  for (const s of profile.samples || []) hits.set(s, (hits.get(s) || 0) + 1);
  const total = (profile.samples || []).length || 1;

  return [...hits.entries()]
    .map(([id, n]) => {
      const frame = (byId.get(id) || {}).callFrame || {};
      return {
        pct: Math.round((1000 * n) / total) / 10,
        fn: frame.functionName || '(anonymous)',
        at: `${String(frame.url || '').replace(/^file:\/\//, '').split('/').slice(-2).join('/')}:${(frame.lineNumber || 0) + 1}`,
      };
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, limit);
}

module.exports = router;
module.exports._topSelfTime = topSelfTime;
