const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Get current user's white-label config
router.get('/', (req, res) => {
  let wl = db.prepare('SELECT * FROM white_labels WHERE user_id = ?').get(req.user.id);
  if (!wl) {
    // Return default branding
    wl = { brand_name: 'ScreenTinker', primary_color: '#3B82F6', secondary_color: '#1E293B', bg_color: '#111827', hide_branding: 0 };
  }
  res.json(wl);
});

// Get branding by domain (public, for white-label domains)
router.get('/domain/:domain', (req, res) => {
  const wl = db.prepare('SELECT * FROM white_labels WHERE custom_domain = ?').get(req.params.domain);
  if (!wl) return res.json({ brand_name: 'ScreenTinker', primary_color: '#3B82F6' });
  res.json(wl);
});

// Create or update white-label config
router.post('/', (req, res) => {
  const { brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color,
          custom_domain, custom_css, hide_branding } = req.body;

  let wl = db.prepare('SELECT * FROM white_labels WHERE user_id = ?').get(req.user.id);

  if (wl) {
    const fields = { brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color, custom_domain, custom_css, hide_branding };
    const updates = [];
    const values = [];
    Object.entries(fields).forEach(([k, v]) => {
      if (v !== undefined) { updates.push(`${k} = ?`); values.push(v); }
    });
    if (updates.length) {
      updates.push("updated_at = strftime('%s','now')");
      values.push(req.user.id);
      db.prepare(`UPDATE white_labels SET ${updates.join(', ')} WHERE user_id = ?`).run(...values);
    }
  } else {
    const id = uuidv4();
    db.prepare(`INSERT INTO white_labels (id, user_id, brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color, custom_domain, custom_css, hide_branding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, req.user.id, brand_name || 'ScreenTinker', logo_url || null, favicon_url || null,
      primary_color || '#3B82F6', secondary_color || '#1E293B', bg_color || '#111827',
      custom_domain || null, custom_css || null, hide_branding ? 1 : 0);
  }

  res.json(db.prepare('SELECT * FROM white_labels WHERE user_id = ?').get(req.user.id));
});

module.exports = router;
