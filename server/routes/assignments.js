const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Mark playlist as draft (called after any item mutation)
function markDraft(playlistId) {
  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
}

// Check device ownership for device-scoped routes
function checkDeviceAccess(req, res, paramName = 'deviceId') {
  const device = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(req.params[paramName]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return false; }
  if (!['admin','superadmin'].includes(req.user.role) && device.user_id && device.user_id !== req.user.id) {
    res.status(403).json({ error: 'Access denied' }); return false;
  }
  return true;
}

// Ensure device has a playlist; auto-create one if missing
function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(deviceId);
  if (device?.playlist_id) return device.playlist_id;

  const deviceRow = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId);
  const playlistId = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, name, is_auto_generated) VALUES (?, ?, ?, 1)')
    .run(playlistId, userId, `${deviceRow?.name || 'Display'} playlist`);
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Standard item query with joined content/widget info
const ITEM_SELECT = `
  SELECT pi.id, pi.playlist_id, pi.content_id, pi.widget_id, pi.sort_order, pi.duration_sec,
         pi.created_at, pi.updated_at,
         COALESCE(c.filename, w.name) as filename,
         c.mime_type, c.filepath, c.thumbnail_path,
         c.duration_sec as content_duration, c.file_size, c.remote_url,
         w.name as widget_name, w.widget_type, w.config as widget_config
  FROM playlist_items pi
  LEFT JOIN content c ON pi.content_id = c.id
  LEFT JOIN widgets w ON pi.widget_id = w.id
`;

// Get assignments (playlist items) for a device
router.get('/device/:deviceId', (req, res) => {
  if (!checkDeviceAccess(req, res)) return;
  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const items = db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
});

// Add content or widget to device playlist
router.post('/device/:deviceId', (req, res) => {
  if (!checkDeviceAccess(req, res)) return;
  const { content_id, widget_id, zone_id, duration_sec = 10, sort_order } = req.body;

  if (!content_id && !widget_id) return res.status(400).json({ error: 'content_id or widget_id required' });

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

  const playlistId = ensureDevicePlaylist(req.params.deviceId, req.user.id);

  let order = sort_order;
  if (order === undefined || order === null) {
    const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
      .get(playlistId);
    order = (max.max_order || 0) + 1;
  }

  try {
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?)
    `).run(playlistId, content_id || null, widget_id || null, order, duration_sec);

    markDraft(playlistId);

    const item = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(result.lastInsertRowid);
    res.status(201).json(item);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Content already in playlist' });
    }
    throw err;
  }
});

// Update playlist item
router.put('/:id', (req, res) => {
  const item = db.prepare('SELECT pi.*, p.user_id FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id WHERE pi.id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!['admin','superadmin'].includes(req.user.role) && item.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { sort_order, duration_sec, zone_id } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (duration_sec !== undefined) { updates.push('duration_sec = ?'); values.push(duration_sec); }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    markDraft(item.playlist_id);
  }

  const updated = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(req.params.id);
  res.json(updated);
});

// Delete playlist item
router.delete('/:id', (req, res) => {
  const item = db.prepare('SELECT pi.*, p.user_id FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id WHERE pi.id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!['admin','superadmin'].includes(req.user.role) && item.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.id);
  markDraft(item.playlist_id);

  res.json({ success: true, content_id: item.content_id });
});

// Reorder items for a device's playlist
router.post('/device/:deviceId/reorder', (req, res) => {
  if (!checkDeviceAccess(req, res)) return;
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, device.playlist_id);
    });
  });
  transaction();

  markDraft(device.playlist_id);

  const items = db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
});

// Copy playlist from one device to another
router.post('/device/:deviceId/copy-to/:targetDeviceId', (req, res) => {
  if (!checkDeviceAccess(req, res, 'deviceId')) return;
  if (!checkDeviceAccess(req, res, 'targetDeviceId')) return;
  const sourceDevice = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!sourceDevice?.playlist_id) return res.status(404).json({ error: 'Source device has no playlist' });

  const sourceItems = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order')
    .all(sourceDevice.playlist_id);
  if (!sourceItems.length) return res.status(404).json({ error: 'Source playlist is empty' });

  const target = db.prepare('SELECT id, user_id FROM devices WHERE id = ?').get(req.params.targetDeviceId);
  if (!target) return res.status(404).json({ error: 'Target device not found' });

  const targetPlaylistId = ensureDevicePlaylist(req.params.targetDeviceId, target.user_id || req.user.id);

  if (req.body.replace) {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(targetPlaylistId);
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?')
    .get(targetPlaylistId).m || 0;
  const stmt = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?)');

  const transaction = db.transaction(() => {
    sourceItems.forEach((a, i) => {
      stmt.run(targetPlaylistId, a.content_id, a.widget_id, maxOrder + i + 1, a.duration_sec);
    });
  });
  transaction();

  markDraft(targetPlaylistId);
  res.json({ success: true, copied: sourceItems.length });
});

module.exports = router;
