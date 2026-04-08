const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

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
  const id = uuidv4();
  db.prepare('INSERT INTO device_groups (id, user_id, name, color) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, name, color || '#3B82F6');
  res.status(201).json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id));
});

// Update group
router.put('/:id', (req, res) => {
  const { name, color } = req.body;
  if (name) db.prepare('UPDATE device_groups SET name = ? WHERE id = ? AND user_id = ?').run(name, req.params.id, req.user.id);
  if (color) db.prepare('UPDATE device_groups SET color = ? WHERE id = ? AND user_id = ?').run(color, req.params.id, req.user.id);
  res.json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(req.params.id));
});

// Delete group
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM device_groups WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// Get devices in a group
router.get('/:id/devices', (req, res) => {
  const devices = db.prepare(`
    SELECT d.* FROM devices d
    JOIN device_group_members dgm ON d.id = dgm.device_id
    WHERE dgm.group_id = ?
    ORDER BY d.name ASC
  `).all(req.params.id);
  res.json(devices);
});

// Add device to group
router.post('/:id/devices', (req, res) => {
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
router.delete('/:id/devices/:deviceId', (req, res) => {
  db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id = ?').run(req.params.deviceId, req.params.id);
  res.json({ success: true });
});

// Bulk assign content to all devices in a group
router.post('/:id/assign-content', (req, res) => {
  const { content_id, duration_sec } = req.body;
  if (!content_id) return res.status(400).json({ error: 'content_id required' });

  const devices = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(req.params.id);
  const stmt = db.prepare('INSERT OR IGNORE INTO assignments (device_id, content_id, duration_sec, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM assignments WHERE device_id = ?))');
  const transaction = db.transaction(() => {
    for (const d of devices) {
      stmt.run(d.device_id, content_id, duration_sec || 10, d.device_id);
    }
  });
  transaction();
  res.json({ success: true, devices_updated: devices.length });
});

module.exports = router;
