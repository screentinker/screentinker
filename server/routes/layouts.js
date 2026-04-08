const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// List layouts (user's + templates)
router.get('/', (req, res) => {
  const showTemplates = req.query.templates === 'true';
  const isAdmin = req.user.role === 'superadmin';

  let layouts;
  if (showTemplates) {
    layouts = db.prepare('SELECT * FROM layouts WHERE is_template = 1 ORDER BY template_category, name').all();
  } else {
    layouts = db.prepare(
      `SELECT * FROM layouts WHERE (user_id = ? OR is_template = 1) ${isAdmin ? 'OR 1=1' : ''} ORDER BY is_template DESC, created_at DESC`
    ).all(req.user.id);
  }

  // Attach zones to each layout
  const zonesStmt = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order');
  layouts.forEach(l => { l.zones = zonesStmt.all(l.id); });

  res.json(layouts);
});

// Get layout with zones
router.get('/:id', (req, res) => {
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) return res.status(404).json({ error: 'Layout not found' });

  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
  res.json(layout);
});

// Create layout
router.post('/', (req, res) => {
  const { name, width, height, zones } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO layouts (id, user_id, name, width, height) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, name, width || 1920, height || 1080);

  // Create zones if provided
  if (zones && Array.isArray(zones)) {
    const stmt = db.prepare(`
      INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    zones.forEach((z, i) => {
      stmt.run(uuidv4(), id, z.name || `Zone ${i + 1}`, z.x_percent || 0, z.y_percent || 0,
        z.width_percent || 100, z.height_percent || 100, z.z_index || 0,
        z.zone_type || 'content', z.fit_mode || 'cover', z.background_color || '#000000', i);
    });
  }

  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(id);
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(id);
  res.status(201).json(layout);
});

// Update layout
router.put('/:id', (req, res) => {
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) return res.status(404).json({ error: 'Layout not found' });
  if (layout.is_template && !['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Cannot edit templates' });

  const { name, width, height } = req.body;
  if (name) db.prepare('UPDATE layouts SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(name, req.params.id);
  if (width) db.prepare('UPDATE layouts SET width = ? WHERE id = ?').run(width, req.params.id);
  if (height) db.prepare('UPDATE layouts SET height = ? WHERE id = ?').run(height, req.params.id);

  const updated = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  updated.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(req.params.id);
  res.json(updated);
});

// Delete layout
router.delete('/:id', (req, res) => {
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) return res.status(404).json({ error: 'Layout not found' });
  if (layout.is_template && !['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Cannot delete templates' });

  db.prepare('DELETE FROM layouts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Add zone to layout
router.post('/:id/zones', (req, res) => {
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) return res.status(404).json({ error: 'Layout not found' });

  const { name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color } = req.body;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM layout_zones WHERE layout_id = ?').get(req.params.id).m || 0;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, name || 'New Zone', x_percent || 0, y_percent || 0,
    width_percent || 50, height_percent || 50, z_index || 0,
    zone_type || 'content', fit_mode || 'cover', background_color || '#000000', maxOrder + 1);

  db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);

  const zone = db.prepare('SELECT * FROM layout_zones WHERE id = ?').get(id);
  res.status(201).json(zone);
});

// Update zone
router.put('/:id/zones/:zoneId', (req, res) => {
  const zone = db.prepare('SELECT * FROM layout_zones WHERE id = ? AND layout_id = ?').get(req.params.zoneId, req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const fields = ['name', 'x_percent', 'y_percent', 'width_percent', 'height_percent', 'z_index', 'zone_type', 'fit_mode', 'background_color', 'sort_order'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });

  if (updates.length > 0) {
    values.push(req.params.zoneId);
    db.prepare(`UPDATE layout_zones SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  }

  const updated = db.prepare('SELECT * FROM layout_zones WHERE id = ?').get(req.params.zoneId);
  res.json(updated);
});

// Delete zone
router.delete('/:id/zones/:zoneId', (req, res) => {
  db.prepare('DELETE FROM layout_zones WHERE id = ? AND layout_id = ?').run(req.params.zoneId, req.params.id);
  db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Duplicate layout (for using templates)
router.post('/:id/duplicate', (req, res) => {
  const source = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Layout not found' });

  const newId = uuidv4();
  const name = req.body.name || `${source.name} (Copy)`;

  db.prepare('INSERT INTO layouts (id, user_id, name, width, height) VALUES (?, ?, ?, ?, ?)')
    .run(newId, req.user.id, name, source.width, source.height);

  // Copy zones
  const zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ?').all(req.params.id);
  const stmt = db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  zones.forEach(z => {
    stmt.run(uuidv4(), newId, z.name, z.x_percent, z.y_percent, z.width_percent, z.height_percent,
      z.z_index, z.zone_type, z.fit_mode, z.background_color, z.sort_order);
  });

  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(newId);
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(newId);
  res.status(201).json(layout);
});

// Assign layout to device
router.put('/device/:deviceId', (req, res) => {
  const { layout_id } = req.body;
  db.prepare("UPDATE devices SET layout_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(layout_id || null, req.params.deviceId);
  res.json({ success: true });
});

module.exports = router;
