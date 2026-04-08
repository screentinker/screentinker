const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// Push playlist update to a connected device via WebSocket
function pushPlaylistToDevice(req, deviceId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    if (!buildPlaylistPayload) return;
    const deviceNs = io.of('/device');
    deviceNs.to(deviceId).emit('device:playlist-update', buildPlaylistPayload(deviceId));
  } catch (e) {
    console.warn('Failed to push playlist update:', e.message);
  }
}

// Check device ownership for device-scoped routes
function checkDeviceAccess(req, res) {
  const device = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return false; }
  if (!['admin','superadmin'].includes(req.user.role) && device.user_id && device.user_id !== req.user.id) {
    res.status(403).json({ error: 'Access denied' }); return false;
  }
  return true;
}

// Get assignments for a device
router.get('/device/:deviceId', (req, res) => {
  if (!checkDeviceAccess(req, res)) return;
  const assignments = db.prepare(`
    SELECT a.*,
           COALESCE(c.filename, w.name) as filename,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM assignments a
    LEFT JOIN content c ON a.content_id = c.id
    LEFT JOIN widgets w ON a.widget_id = w.id
    WHERE a.device_id = ?
    ORDER BY a.sort_order ASC
  `).all(req.params.deviceId);
  res.json(assignments);
});

// Add content or widget to device playlist
router.post('/device/:deviceId', (req, res) => {
  if (!checkDeviceAccess(req, res)) return;
  const { content_id, widget_id, zone_id, duration_sec = 10, sort_order, schedule_start, schedule_end, schedule_days } = req.body;

  if (!content_id && !widget_id) return res.status(400).json({ error: 'content_id or widget_id required' });

  // Validate the referenced item exists AND belongs to the user
  if (content_id) {
    const content = db.prepare('SELECT id, user_id FROM content WHERE id = ?').get(content_id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    if (!['admin','superadmin'].includes(req.user.role) && content.user_id && content.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Content not owned by you' });
    }
  }
  if (widget_id) {
    const widget = db.prepare('SELECT id FROM widgets WHERE id = ?').get(widget_id);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
  }

  // Get max sort order if not specified
  let order = sort_order;
  if (order === undefined || order === null) {
    const max = db.prepare('SELECT MAX(sort_order) as max_order FROM assignments WHERE device_id = ?')
      .get(req.params.deviceId);
    order = (max.max_order || 0) + 1;
  }

  try {
    const result = db.prepare(`
      INSERT INTO assignments (device_id, content_id, widget_id, zone_id, sort_order, duration_sec, schedule_start, schedule_end, schedule_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.deviceId, content_id || null, widget_id || null, zone_id || null, order, duration_sec, schedule_start || null, schedule_end || null, schedule_days || null);

    const assignment = db.prepare(`
      SELECT a.*, c.filename as filename, c.mime_type, c.filepath, c.thumbnail_path, c.duration_sec as content_duration, c.file_size, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config
      FROM assignments a
      LEFT JOIN content c ON a.content_id = c.id
      LEFT JOIN widgets w ON a.widget_id = w.id
      WHERE a.id = ?
    `).get(result.lastInsertRowid);

    pushPlaylistToDevice(req, req.params.deviceId);
    res.status(201).json(assignment);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Content already assigned to this device' });
    }
    throw err;
  }
});

// Update assignment
router.put('/:id', (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const { sort_order, duration_sec, schedule_start, schedule_end, schedule_days, enabled, zone_id } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (duration_sec !== undefined) { updates.push('duration_sec = ?'); values.push(duration_sec); }
  if (schedule_start !== undefined) { updates.push('schedule_start = ?'); values.push(schedule_start); }
  if (schedule_end !== undefined) { updates.push('schedule_end = ?'); values.push(schedule_end); }
  if (schedule_days !== undefined) { updates.push('schedule_days = ?'); values.push(schedule_days); }
  if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled); }
  if (zone_id !== undefined) { updates.push('zone_id = ?'); values.push(zone_id || null); }
  if (req.body.muted !== undefined) { updates.push('muted = ?'); values.push(req.body.muted ? 1 : 0); }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE assignments SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare(`
    SELECT a.*, COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.thumbnail_path, c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM assignments a LEFT JOIN content c ON a.content_id = c.id LEFT JOIN widgets w ON a.widget_id = w.id
    WHERE a.id = ?
  `).get(req.params.id);
  pushPlaylistToDevice(req, assignment.device_id);
  res.json(updated);
});

// Delete assignment
router.delete('/:id', (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  pushPlaylistToDevice(req, assignment.device_id);
  res.json({ success: true, device_id: assignment.device_id, content_id: assignment.content_id });
});

// Reorder assignments for a device
router.post('/device/:deviceId/reorder', (req, res) => {
  const { order } = req.body; // Array of assignment IDs in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of assignment IDs' });

  const updateStmt = db.prepare('UPDATE assignments SET sort_order = ? WHERE id = ? AND device_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((assignmentId, index) => {
      updateStmt.run(index, assignmentId, req.params.deviceId);
    });
  });
  transaction();

  const assignments = db.prepare(`
    SELECT a.*, COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.thumbnail_path, c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM assignments a LEFT JOIN content c ON a.content_id = c.id LEFT JOIN widgets w ON a.widget_id = w.id
    WHERE a.device_id = ?
    ORDER BY a.sort_order ASC
  `).all(req.params.deviceId);
  pushPlaylistToDevice(req, req.params.deviceId);
  res.json(assignments);
});

// Copy playlist from one device to another
router.post('/device/:deviceId/copy-to/:targetDeviceId', (req, res) => {
  const source = db.prepare('SELECT * FROM assignments WHERE device_id = ? AND enabled = 1 ORDER BY sort_order').all(req.params.deviceId);
  if (!source.length) return res.status(404).json({ error: 'Source device has no assignments' });

  const target = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.targetDeviceId);
  if (!target) return res.status(404).json({ error: 'Target device not found' });

  // Clear existing assignments on target if requested
  if (req.body.replace) {
    db.prepare('DELETE FROM assignments WHERE device_id = ?').run(req.params.targetDeviceId);
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM assignments WHERE device_id = ?').get(req.params.targetDeviceId).m || 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO assignments (device_id, content_id, widget_id, zone_id, sort_order, duration_sec, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)');

  const transaction = db.transaction(() => {
    source.forEach((a, i) => {
      stmt.run(req.params.targetDeviceId, a.content_id, a.widget_id, a.zone_id, maxOrder + i + 1, a.duration_sec);
    });
  });
  transaction();

  pushPlaylistToDevice(req, req.params.targetDeviceId);
  res.json({ success: true, copied: source.length });
});

module.exports = router;
