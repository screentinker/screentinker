const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// List devices for current user (admins see all)
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const devices = db.prepare(`
    SELECT d.*,
      t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
      t.ram_free_mb, t.ram_total_mb, t.wifi_ssid, t.wifi_rssi, t.uptime_seconds,
      t.cpu_usage,
      s.filepath as screenshot_path, s.captured_at as screenshot_at,
      u.email as owner_email, u.name as owner_name
    FROM devices d
    LEFT JOIN users u ON d.user_id = u.id
    LEFT JOIN (
      SELECT dt.* FROM device_telemetry dt
      INNER JOIN (SELECT device_id, MAX(reported_at) as max_at FROM device_telemetry GROUP BY device_id) latest
      ON dt.device_id = latest.device_id AND dt.reported_at = latest.max_at
    ) t ON d.id = t.device_id
    LEFT JOIN (
      SELECT sc.* FROM screenshots sc
      INNER JOIN (SELECT device_id, MAX(captured_at) as max_at FROM screenshots GROUP BY device_id) latest
      ON sc.device_id = latest.device_id AND sc.captured_at = latest.max_at
    ) s ON d.id = s.device_id
    ${isAdmin ? 'WHERE d.user_id IS NOT NULL' : 'WHERE d.user_id IS NOT NULL AND (d.user_id = ? OR d.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?))'}
    ORDER BY d.created_at ASC
    LIMIT ? OFFSET ?
  `).all(...(isAdmin ? [] : [req.user.id, req.user.id]), Math.min(parseInt(req.query.limit) || 100, 500), parseInt(req.query.offset) || 0);
  res.json(devices);
});

// List unclaimed provisioning devices (admin only)
router.get('/unassigned', (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const devices = db.prepare(`
    SELECT id, pairing_code, status, ip_address, android_version, app_version,
      screen_width, screen_height, created_at, last_heartbeat
    FROM devices WHERE user_id IS NULL
    ORDER BY created_at DESC
  `).all();
  res.json(devices);
});

// Get single device with telemetry history
router.get('/:id', (req, res) => {
  const device = db.prepare('SELECT d.*, u.email as owner_email, u.name as owner_name FROM devices d LEFT JOIN users u ON d.user_id = u.id WHERE d.id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Check access: admin, owner, or team member
  if (!['admin','superadmin'].includes(req.user.role) && device.user_id !== req.user.id) {
    const teamAccess = device.team_id ? db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(device.team_id, req.user.id) : null;
    if (!teamAccess) return res.status(403).json({ error: 'Access denied' });
    device._teamRole = teamAccess.role; // Pass team role for frontend to check
  }

  const telemetry = db.prepare(
    'SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 20'
  ).all(req.params.id);

  const screenshot = db.prepare(
    'SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1'
  ).get(req.params.id);

  // Get playlist items and status if device has an assigned playlist
  let assignments = [];
  let playlist_status = null;
  let playlist_has_published = false;
  if (device.playlist_id) {
    assignments = db.prepare(`
      SELECT pi.id, pi.content_id, pi.widget_id, pi.sort_order, pi.duration_sec,
             pi.created_at, pi.updated_at,
             COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.thumbnail_path,
             c.duration_sec as content_duration, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config
      FROM playlist_items pi
      LEFT JOIN content c ON pi.content_id = c.id
      LEFT JOIN widgets w ON pi.widget_id = w.id
      WHERE pi.playlist_id = ?
      ORDER BY pi.sort_order ASC
    `).all(device.playlist_id);
    const pl = db.prepare('SELECT status, published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (pl) {
      playlist_status = pl.status;
      playlist_has_published = pl.published_snapshot !== null;
    }
  }

  // Uptime timeline: get status change events for last 24 hours
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  let statusLog = [];
  try {
    statusLog = db.prepare(
      'SELECT status, timestamp FROM device_status_log WHERE device_id = ? AND timestamp > ? ORDER BY timestamp ASC'
    ).all(req.params.id, dayAgo);
  } catch (_) {}

  // Also get telemetry timestamps as heartbeat proof (fills gaps between status events)
  const uptimeData = db.prepare(
    'SELECT reported_at FROM device_telemetry WHERE device_id = ? AND reported_at > ? ORDER BY reported_at ASC'
  ).all(req.params.id, dayAgo).map(r => r.reported_at);

  res.json({ ...device, telemetry, screenshot, assignments, playlist_status, playlist_has_published, uptimeData, statusLog });
});

// Helper: check device ownership
function checkDeviceOwnership(req, res) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!['admin','superadmin'].includes(req.user.role) && device.user_id && device.user_id !== req.user.id) {
    // Check team membership
    const teamAccess = device.team_id ? db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(device.team_id, req.user.id) : null;
    if (!teamAccess || teamAccess.role === 'viewer') {
      res.status(403).json({ error: 'Access denied' }); return null;
    }
  }
  return device;
}

// Update device
router.put('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const { name, notes, timezone, orientation, default_content_id } = req.body;
  // Whitelist allowed fields to prevent SQL injection via field names
  const ALLOWED_FIELDS = ['name', 'notes', 'timezone', 'orientation', 'default_content_id'];
  const updates = [];
  const values = [];
  Object.entries({ name, notes, timezone, orientation, default_content_id }).forEach(([key, val]) => {
    if (val !== undefined && ALLOWED_FIELDS.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  });
  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE devices SET ${updates.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete device
router.delete('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  // Clean up related data (playlist is NOT deleted — may be shared with other devices)
  db.prepare('DELETE FROM schedules WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM screenshots WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM device_telemetry WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM video_wall_devices WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);

  // Notify dashboard in real-time
  const io = req.app.get('io');
  if (io) {
    io.of('/dashboard').emit('dashboard:device-removed', { device_id: req.params.id });
  }

  res.json({ success: true });
});

module.exports = router;
