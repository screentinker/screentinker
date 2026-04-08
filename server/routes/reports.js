const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// Helper: scope reports to user's devices
function getUserDeviceFilter(user) {
  if (user.role === 'superadmin') return { sql: '', params: [] };
  return { sql: ' AND d.user_id = ?', params: [user.id] };
}

// Query play logs
router.get('/plays', (req, res) => {
  const { device_id, content_id, start, end, limit: lim } = req.query;
  const scope = getUserDeviceFilter(req.user);
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

// Summary report
router.get('/summary', (req, res) => {
  const { device_id, start, end, group_by } = req.query;
  const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : Math.floor(Date.now() / 1000) - 30 * 86400;
  const endEpoch = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

  let deviceFilter = '';
  const params = [startEpoch, endEpoch];
  // Scope to user's devices (non-admin)
  if (!['admin','superadmin'].includes(req.user.role)) {
    deviceFilter += ' AND device_id IN (SELECT id FROM devices WHERE user_id = ?)';
    params.push(req.user.id);
  }
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

// Export CSV
router.get('/export', (req, res) => {
  const { device_id, start, end } = req.query;
  const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : 0;
  const endEpoch = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

  let sql = `SELECT pl.*, d.name as device_name FROM play_logs pl JOIN devices d ON pl.device_id = d.id WHERE pl.started_at >= ? AND pl.started_at <= ?`;
  const params = [startEpoch, endEpoch];
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

// Device uptime report
router.get('/uptime', (req, res) => {
  const { device_id, start, end } = req.query;
  const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : Math.floor(Date.now() / 1000) - 30 * 86400;
  const endEpoch = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

  let sql = `SELECT dt.device_id, d.name as device_name,
    COUNT(*) as heartbeat_count,
    MIN(dt.reported_at) as first_seen,
    MAX(dt.reported_at) as last_seen
    FROM device_telemetry dt
    JOIN devices d ON dt.device_id = d.id
    WHERE dt.reported_at >= ? AND dt.reported_at <= ?`;
  const params = [startEpoch, endEpoch];
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
