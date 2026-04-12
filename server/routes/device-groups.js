const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

const VALID_COLOR = /^#[0-9A-Fa-f]{6}$/;
const ALLOWED_COMMANDS = ['screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown'];

// Verify group belongs to the authenticated user
function requireGroupOwnership(req, res, next) {
  const group = db.prepare('SELECT * FROM device_groups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!group) return res.status(404).json({ error: 'group not found' });
  req.group = group;
  next();
}

// List groups
router.get('/', (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, COUNT(dgm.device_id) as device_count
    FROM device_groups g
    LEFT JOIN device_group_members dgm ON g.id = dgm.group_id
    WHERE g.user_id = ?
    GROUP BY g.id
    ORDER BY g.name ASC
  `).all(req.user.id);
  res.json(groups);
});

// Create group
router.post('/', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (color && !VALID_COLOR.test(color)) return res.status(400).json({ error: 'invalid color format, use #RRGGBB' });
  const id = uuidv4();
  db.prepare('INSERT INTO device_groups (id, user_id, name, color) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, name, color || '#3B82F6');
  res.status(201).json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id));
});

// Update group
router.put('/:id', requireGroupOwnership, (req, res) => {
  const { name, color } = req.body;
  if (color && !VALID_COLOR.test(color)) return res.status(400).json({ error: 'invalid color format, use #RRGGBB' });
  if (name) db.prepare('UPDATE device_groups SET name = ? WHERE id = ?').run(name, req.params.id);
  if (color) db.prepare('UPDATE device_groups SET color = ? WHERE id = ?').run(color, req.params.id);
  res.json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(req.params.id));
});

// Delete group
router.delete('/:id', requireGroupOwnership, (req, res) => {
  db.prepare('DELETE FROM device_groups WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Get devices in a group
router.get('/:id/devices', requireGroupOwnership, (req, res) => {
  const devices = db.prepare(`
    SELECT d.* FROM devices d
    JOIN device_group_members dgm ON d.id = dgm.device_id
    WHERE dgm.group_id = ?
    ORDER BY d.name ASC
  `).all(req.params.id);
  res.json(devices);
});

// Add device to group
router.post('/:id/devices', requireGroupOwnership, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    db.prepare('INSERT OR IGNORE INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(device_id, req.params.id);
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Remove device from group
router.delete('/:id/devices/:deviceId', requireGroupOwnership, (req, res) => {
  db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id = ?').run(req.params.deviceId, req.params.id);
  res.json({ success: true });
});

// Ensure a device has a playlist; auto-create one if missing
function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id, name FROM devices WHERE id = ?').get(deviceId);
  if (device?.playlist_id) return device.playlist_id;
  const playlistId = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, name, is_auto_generated) VALUES (?, ?, ?, 1)')
    .run(playlistId, userId, `${device?.name || 'Display'} playlist`);
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Push playlist update to a device
function pushPlaylistToDevice(req, deviceId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const deviceNs = io.of('/device');
    deviceNs.to(deviceId).emit('device:playlist-update', buildPlaylistPayload(deviceId));
  } catch (e) { /* silent */ }
}

// Bulk assign content to all devices in a group (adds to each device's playlist)
router.post('/:id/assign-content', requireGroupOwnership, (req, res) => {
  const { content_id, duration_sec } = req.body;
  if (!content_id) return res.status(400).json({ error: 'content_id required' });

  // Verify content belongs to the user
  const content = db.prepare('SELECT id FROM content WHERE id = ? AND user_id = ?').get(content_id, req.user.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const members = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(req.params.id);

  const transaction = db.transaction(() => {
    for (const m of members) {
      const playlistId = ensureDevicePlaylist(m.device_id, req.user.id);
      const max = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM playlist_items WHERE playlist_id = ?').get(playlistId);
      db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)')
        .run(playlistId, content_id, max.next, duration_sec || 10);
      db.prepare("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
    }
  });
  transaction();

  for (const m of members) pushPlaylistToDevice(req, m.device_id);
  res.json({ success: true, devices_updated: members.length });
});

// Assign an existing playlist to all devices in a group
router.post('/:id/assign-playlist', requireGroupOwnership, (req, res) => {
  const { playlist_id } = req.body;
  if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });

  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlist_id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const members = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(req.params.id);

  const stmt = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
  const transaction = db.transaction(() => {
    for (const m of members) stmt.run(playlist_id, m.device_id);
  });
  transaction();

  for (const m of members) pushPlaylistToDevice(req, m.device_id);
  res.json({ success: true, devices_updated: members.length });
});

// Send command to all devices in a group
router.post('/:id/command', requireGroupOwnership, (req, res) => {
  const { type, payload } = req.body;
  if (!type) return res.status(400).json({ error: 'command type required' });
  if (!ALLOWED_COMMANDS.includes(type)) return res.status(400).json({ error: 'invalid command type' });

  const devices = db.prepare(`
    SELECT d.id, d.name, d.status FROM devices d
    JOIN device_group_members dgm ON d.id = dgm.device_id
    WHERE dgm.group_id = ?
  `).all(req.params.id);

  const deviceNs = req.app.get('io').of('/device');
  const results = [];

  for (const device of devices) {
    const room = deviceNs.adapter.rooms.get(device.id);
    if (room && room.size > 0) {
      deviceNs.to(device.id).emit('device:command', { type, payload: payload || {} });
      results.push({ device_id: device.id, name: device.name, status: 'sent' });
    } else {
      results.push({ device_id: device.id, name: device.name, status: 'offline' });
    }
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const offline = results.filter(r => r.status === 'offline').length;
  console.log(`Group command '${type}' sent to group '${req.group.name}': ${sent} sent, ${offline} offline`);
  res.json({ success: true, sent, offline, total: devices.length, results });
});

module.exports = router;
