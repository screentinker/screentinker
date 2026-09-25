const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// Phase 2.2g: scope reports to the caller's current workspace.
// No platform_admin bypass - cross-workspace reporting comes from
// switch-workspace, not a magic role-based "see all" path. This matches
// the precedent set in devices.js.
function getWorkspaceDeviceFilter(req) {
  if (!req.workspaceId) return { sql: ' AND 1=0', params: [] }; // no workspace -> empty result
  return { sql: ' AND d.workspace_id = ?', params: [req.workspaceId] };
}

function getWorkspaceDeviceSubquery(req) {
  if (!req.workspaceId) return { sql: ' AND device_id IN (SELECT id FROM devices WHERE 1=0)', params: [] };
  return { sql: ' AND device_id IN (SELECT id FROM devices WHERE workspace_id = ?)', params: [req.workspaceId] };
}

// Query play logs
router.get('/plays', (req, res) => {
  const { device_id, content_id, start, end, limit: lim } = req.query;
  const scope = getWorkspaceDeviceFilter(req);
  let sql = `SELECT pl.*, d.name as device_name
    FROM play_logs pl
    JOIN devices d ON pl.device_id = d.id
    WHERE 1=1${scope.sql}`;
  const params = [...scope.params];

  if (device_id) { sql += ' AND pl.device_id = ?'; params.push(device_id); }
  if (content_id) { sql += ' AND pl.content_id = ?'; params.push(content_id); }
  if (start) { sql += ' AND pl.started_at >= ?'; params.push(Math.floor(new Date(start).getTime() / 1000)); }
  if (end) { sql += ' AND pl.started_at <= ?'; params.push(Math.floor(new Date(end).getTime() / 1000)); }

  sql += ' ORDER BY pl.started_at DESC LIMIT ?';
  params.push(parseInt(lim) || 500);

  res.json(db.prepare(sql).all(...params));
});

/*
 * Parse a `start`/`end` query parameter into an epoch second.
 *
 * ⚠️ THIS REPLACED `new Date(end + 'T23:59:59')`, WHICH RETURNED NOTHING FOR A VALID DATETIME.
 *
 * The old line assumed `end` was a bare `YYYY-MM-DD` and glued a time onto it to mean "the whole of
 * that day". Hand it a full ISO timestamp — which is what a client library, a script, or an AI agent
 * calling the documented API naturally sends — and the concatenation produced
 * `2026-09-25T15:53:06.947ZT23:59:59`, an Invalid Date, `NaN`, and a WHERE clause that matched no
 * rows. The endpoint then answered 200 with `[]`: not an error, just "nothing played", which is a
 * plausible enough answer that nobody questions it. Found when an agent asked for a week of uptime
 * and was told, convincingly, that every screen had been dark.
 *
 * Now: a date-only value still means the whole of that day (the original intent, preserved because
 * the dashboard sends dates and `end=2026-09-25` must keep including the 25th). A datetime is taken
 * as given. Anything unparseable is a 400 rather than a silent empty result — an explicit refusal is
 * the one answer a caller can act on.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseRangeParam(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return { ok: true, epoch: null };
  const raw = String(value).trim();
  /*
   * ⚠️ `Z`, BECAUSE THE TWO ENDS WERE IN DIFFERENT TIME ZONES.
   *
   * `new Date('2026-09-25')` is UTC midnight, but `new Date('2026-09-25T23:59:59')` — no offset — is
   * LOCAL. So a start and an end given as the same kind of date resolved into different zones, and
   * the window was skewed by the server's UTC offset. It has never shown up here because prod and
   * alpha both run UTC, where the two happen to agree; a self-hosted instance in Chicago has been
   * getting a five-hour skew on every report. No change where it is deployed, a fix where it is not.
   */
  const text = (endOfDay && DATE_ONLY.test(raw)) ? `${raw}T23:59:59.999Z` : raw;
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) return { ok: false, epoch: null };
  return { ok: true, epoch: Math.floor(ms / 1000) };
}

/* Resolve both ends, or send the 400. Returns null when it has already answered. */
function resolveRange(req, res, { defaultStart, defaultEnd }) {
  const start = parseRangeParam(req.query.start);
  const end = parseRangeParam(req.query.end, { endOfDay: true });
  if (!start.ok || !end.ok) {
    res.status(400).json({
      error: `Invalid ${!start.ok ? 'start' : 'end'} date. Use YYYY-MM-DD or a full ISO 8601 timestamp.`,
    });
    return null;
  }
  return {
    startEpoch: start.epoch === null ? defaultStart() : start.epoch,
    endEpoch: end.epoch === null ? defaultEnd() : end.epoch,
  };
}

// Summary report
router.get('/summary', (req, res) => {
  const { device_id, group_by } = req.query;
  const range = resolveRange(req, res, {
    defaultStart: () => Math.floor(Date.now() / 1000) - 30 * 86400,
    defaultEnd: () => Math.floor(Date.now() / 1000),
  });
  if (!range) return;
  const { startEpoch, endEpoch } = range;

  // Phase 2.2g: workspace-scope all summary queries, no admin bypass.
  const wsScope = getWorkspaceDeviceSubquery(req);
  let deviceFilter = wsScope.sql;
  const params = [startEpoch, endEpoch, ...wsScope.params];
  if (device_id) { deviceFilter += ' AND device_id = ?'; params.push(device_id); }

  // Overall stats
  const overall = db.prepare(`
    SELECT COUNT(*) as total_plays,
           COALESCE(SUM(duration_sec), 0) as total_duration_sec,
           COUNT(DISTINCT content_id) as unique_content,
           COUNT(DISTINCT device_id) as unique_devices,
           AVG(duration_sec) as avg_duration_sec
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
  `).get(...params);

  // By content
  const byContent = db.prepare(`
    SELECT content_id, content_name, COUNT(*) as plays,
           COALESCE(SUM(duration_sec), 0) as total_seconds,
           SUM(completed) as completed_plays
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
    GROUP BY content_id, content_name
    ORDER BY plays DESC LIMIT 50
  `).all(...params);

  // By device
  const byDevice = db.prepare(`
    SELECT pl.device_id, d.name as device_name, COUNT(*) as plays,
           COALESCE(SUM(pl.duration_sec), 0) as total_seconds
    FROM play_logs pl
    JOIN devices d ON pl.device_id = d.id
    WHERE pl.started_at >= ? AND pl.started_at <= ? ${deviceFilter}
    GROUP BY pl.device_id
    ORDER BY plays DESC
  `).all(...params);

  // By hour of day
  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', started_at, 'unixepoch', 'localtime') AS INTEGER) as hour,
           COUNT(*) as plays
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
    GROUP BY hour ORDER BY hour
  `).all(...params);

  // By day
  const byDay = db.prepare(`
    SELECT date(started_at, 'unixepoch', 'localtime') as day, COUNT(*) as plays,
           COALESCE(SUM(duration_sec), 0) as total_seconds
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
    GROUP BY day ORDER BY day
  `).all(...params);

  res.json({
    period: { start: new Date(startEpoch * 1000).toISOString(), end: new Date(endEpoch * 1000).toISOString() },
    overall: {
      total_plays: overall.total_plays,
      total_hours: Math.round(overall.total_duration_sec / 3600 * 10) / 10,
      unique_content: overall.unique_content,
      unique_devices: overall.unique_devices,
      avg_duration_sec: Math.round(overall.avg_duration_sec || 0),
    },
    by_content: byContent,
    by_device: byDevice,
    by_hour: byHour,
    by_day: byDay,
  });
});

// Export CSV. Phase 2.2g: workspace-scoped. Previously this route had no scope
// filter at all - any authenticated user could export the entire platform's
// play_logs. The added WHERE clause closes that pre-existing cross-tenant leak.
router.get('/export', (req, res) => {
  const { device_id, start, end } = req.query;
  const range = resolveRange(req, res, { defaultStart: () => 0, defaultEnd: () => Math.floor(Date.now() / 1000) });
  if (!range) return;
  const { startEpoch, endEpoch } = range;

  const scope = getWorkspaceDeviceFilter(req);
  let sql = `SELECT pl.*, d.name as device_name FROM play_logs pl JOIN devices d ON pl.device_id = d.id WHERE pl.started_at >= ? AND pl.started_at <= ?${scope.sql}`;
  const params = [startEpoch, endEpoch, ...scope.params];
  if (device_id) { sql += ' AND pl.device_id = ?'; params.push(device_id); }
  sql += ' ORDER BY pl.started_at ASC';

  const rows = db.prepare(sql).all(...params);

  const header = 'Device,Content,Started,Ended,Duration (sec),Completed\n';
  const csv = header + rows.map(r => {
    const started = new Date(r.started_at * 1000).toISOString();
    const ended = r.ended_at ? new Date(r.ended_at * 1000).toISOString() : '';
    return `"${r.device_name}","${r.content_name}","${started}","${ended}",${r.duration_sec || ''},${r.completed ? 'Yes' : 'No'}`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=proof-of-play.csv');
  res.send(csv);
});

// Device uptime report. Phase 2.2g: workspace-scoped. Previously this route
// had no scope filter at all - any authenticated user could see telemetry
// summaries for every device on the platform. The added WHERE clause closes
// that pre-existing cross-tenant leak.
router.get('/uptime', (req, res) => {
  const { device_id } = req.query;
  const range = resolveRange(req, res, {
    defaultStart: () => Math.floor(Date.now() / 1000) - 30 * 86400,
    defaultEnd: () => Math.floor(Date.now() / 1000),
  });
  if (!range) return;
  const { startEpoch, endEpoch } = range;

  const scope = getWorkspaceDeviceFilter(req);
  let sql = `SELECT dt.device_id, d.name as device_name,
    COUNT(*) as heartbeat_count,
    MIN(dt.reported_at) as first_seen,
    MAX(dt.reported_at) as last_seen
    FROM device_telemetry dt
    JOIN devices d ON dt.device_id = d.id
    WHERE dt.reported_at >= ? AND dt.reported_at <= ?${scope.sql}`;
  const params = [startEpoch, endEpoch, ...scope.params];
  if (device_id) { sql += ' AND dt.device_id = ?'; params.push(device_id); }
  sql += ' GROUP BY dt.device_id ORDER BY d.name';

  const uptimeData = db.prepare(sql).all(...params);

  // Estimate uptime: heartbeats are every 15s, so heartbeat_count * 15 / total_period
  const totalPeriod = endEpoch - startEpoch;
  uptimeData.forEach(d => {
    d.estimated_uptime_pct = Math.min(100, Math.round((d.heartbeat_count * 15 / totalPeriod) * 100 * 10) / 10);
  });

  res.json(uptimeData);
});

module.exports = router;
// Exported for tests: the parsing rule is the bug, so it is tested directly.
module.exports.parseRangeParam = parseRangeParam;
