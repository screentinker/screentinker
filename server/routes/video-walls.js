const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// List walls
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const walls = db.prepare(
    `SELECT * FROM video_walls ${isAdmin ? '' : 'WHERE user_id = ?'} ORDER BY created_at DESC`
  ).all(...(isAdmin ? [] : [req.user.id]));

  // Attach devices to each wall
  const devStmt = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd
    JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `);
  walls.forEach(w => { w.devices = devStmt.all(w.id); });

  res.json(walls);
});

// Helper: check wall ownership
function checkWallAccess(req, res) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(req.params.id);
  if (!wall) { res.status(404).json({ error: 'Wall not found' }); return null; }
  if (!['admin','superadmin'].includes(req.user.role) && wall.user_id !== req.user.id) { res.status(403).json({ error: 'Access denied' }); return null; }
  return wall;
}

// Get wall with devices
router.get('/:id', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;

  wall.devices = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd
    JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `).all(wall.id);

  res.json(wall);
});

// Create wall
router.post('/', (req, res) => {
  const { name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, screen_w_mm, screen_h_mm } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO video_walls (id, user_id, name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, screen_w_mm, screen_h_mm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, name, grid_cols || 2, grid_rows || 2,
    bezel_h_mm || 0, bezel_v_mm || 0, screen_w_mm || 400, screen_h_mm || 225);

  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(id);
  wall.devices = [];
  res.status(201).json(wall);
});

// Update wall
router.put('/:id', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;

  const fields = ['name', 'grid_cols', 'grid_rows', 'bezel_h_mm', 'bezel_v_mm',
    'screen_w_mm', 'screen_h_mm', 'sync_mode', 'leader_device_id', 'content_id'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE video_walls SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(req.params.id);
  updated.devices = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
  `).all(req.params.id);

  res.json(updated);
});

// Delete wall
router.delete('/:id', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;
  db.prepare("UPDATE devices SET wall_id = NULL WHERE wall_id = ?").run(req.params.id);
  db.prepare('DELETE FROM video_walls WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Set device grid positions
router.put('/:id/devices', (req, res) => {
  const { devices } = req.body;
  if (!Array.isArray(devices)) return res.status(400).json({ error: 'devices array required' });

  const wall = checkWallAccess(req, res);
  if (!wall) return;

  // Clear existing
  db.prepare('DELETE FROM video_wall_devices WHERE wall_id = ?').run(req.params.id);
  db.prepare("UPDATE devices SET wall_id = NULL WHERE wall_id = ?").run(req.params.id);

  // Add new positions
  const stmt = db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row, rotation) VALUES (?, ?, ?, ?, ?)');
  const updateDevice = db.prepare("UPDATE devices SET wall_id = ? WHERE id = ?");

  const transaction = db.transaction(() => {
    devices.forEach(d => {
      stmt.run(req.params.id, d.device_id, d.grid_col, d.grid_row, d.rotation || 0);
      updateDevice.run(req.params.id, d.device_id);
    });
    // Set first device as leader if none set
    if (!wall.leader_device_id && devices.length > 0) {
      const leader = devices.find(d => d.grid_col === 0 && d.grid_row === 0) || devices[0];
      db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(leader.device_id, req.params.id);
    }
  });
  transaction();

  const updated = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(req.params.id);
  updated.devices = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
  `).all(req.params.id);

  res.json(updated);
});

// Set wall content
router.put('/:id/content', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;
  const { content_id } = req.body;
  db.prepare("UPDATE video_walls SET content_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(content_id || null, req.params.id);
  res.json({ success: true });
});

// Get wall config for a specific device (used by Android app)
router.get('/:id/device-config/:deviceId', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;

  const position = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?')
    .get(req.params.id, req.params.deviceId);
  if (!position) return res.status(404).json({ error: 'Device not in this wall' });

  // Calculate crop region
  const totalW = wall.grid_cols * wall.screen_w_mm + (wall.grid_cols - 1) * wall.bezel_h_mm;
  const totalH = wall.grid_rows * wall.screen_h_mm + (wall.grid_rows - 1) * wall.bezel_v_mm;

  const cropX = (position.grid_col * (wall.screen_w_mm + wall.bezel_h_mm)) / totalW;
  const cropY = (position.grid_row * (wall.screen_h_mm + wall.bezel_v_mm)) / totalH;
  const cropW = wall.screen_w_mm / totalW;
  const cropH = wall.screen_h_mm / totalH;

  res.json({
    wall_id: wall.id,
    grid_cols: wall.grid_cols,
    grid_rows: wall.grid_rows,
    grid_col: position.grid_col,
    grid_row: position.grid_row,
    rotation: position.rotation,
    crop: { x: cropX, y: cropY, width: cropW, height: cropH },
    content_id: wall.content_id,
    sync_mode: wall.sync_mode,
    is_leader: wall.leader_device_id === req.params.deviceId,
  });
});

module.exports = router;
