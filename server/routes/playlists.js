const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');

// Re-probe video duration with ffprobe if content.duration_sec is missing
async function probeAndUpdateDuration(content) {
  if (content.duration_sec) return content.duration_sec;
  if (!content.mime_type || !content.mime_type.startsWith('video/')) return null;
  if (!content.filepath) return null;
  try {
    const { execFile } = require('child_process');
    const fullPath = path.join(config.contentDir, content.filepath);
    const probe = await new Promise((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', fullPath
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    const info = JSON.parse(probe);
    if (info.format?.duration) {
      const dur = parseFloat(info.format.duration);
      db.prepare('UPDATE content SET duration_sec = ? WHERE id = ?').run(dur, content.id);
      return dur;
    }
  } catch (e) {
    console.warn('ffprobe re-probe failed for', content.id, e.message);
  }
  return null;
}

// Verify playlist belongs to the authenticated user
function requirePlaylistOwnership(req, res, next) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'playlist not found' });
  req.playlist = playlist;
  next();
}

// List playlists
router.get('/', (req, res) => {
  const playlists = db.prepare(`
    SELECT p.*, COUNT(DISTINCT pi.id) as item_count, COUNT(DISTINCT d.id) as display_count
    FROM playlists p
    LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
    LEFT JOIN devices d ON d.playlist_id = p.id
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY p.name ASC
  `).all(req.user.id);
  res.json(playlists);
});

// Create playlist
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, name, description) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, name.trim(), (description || '').trim());
  res.status(201).json(db.prepare(`
    SELECT p.*, 0 as item_count, 0 as display_count FROM playlists p WHERE p.id = ?
  `).get(id));
});

// Get single playlist with items
router.get('/:id', requirePlaylistOwnership, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  const displayCount = db.prepare('SELECT COUNT(*) as count FROM devices WHERE playlist_id = ?').get(req.params.id).count;
  res.json({ ...req.playlist, items, item_count: items.length, display_count: displayCount });
});

// Update playlist
router.put('/:id', requirePlaylistOwnership, (req, res) => {
  const { name, description } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    updates.push('name = ?');
    values.push(name.trim());
  }
  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description.trim());
  }
  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id));
});

// Delete playlist
router.delete('/:id', requirePlaylistOwnership, (req, res) => {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Playlist Items ---

// List items
router.get('/:id/items', requirePlaylistOwnership, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json(items);
});

// Add item
router.post('/:id/items', requirePlaylistOwnership, async (req, res) => {
  try {
    const { content_id, widget_id, sort_order } = req.body;
    let { duration_sec } = req.body;

    if (!content_id && !widget_id) return res.status(400).json({ error: 'content_id or widget_id required' });
    if (duration_sec !== undefined && duration_sec !== null && (typeof duration_sec !== 'number' || duration_sec < 1)) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
    }

    // Validate content ownership; use content's native duration as default for videos
    if (content_id) {
      const content = db.prepare('SELECT id, user_id, duration_sec, mime_type, filepath FROM content WHERE id = ?').get(content_id);
      if (!content) return res.status(404).json({ error: 'Content not found' });
      if (!['admin', 'superadmin'].includes(req.user.role) && content.user_id && content.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Content not owned by you' });
      }
      if (duration_sec === undefined || duration_sec === null) {
        // Use stored duration, or re-probe if missing (backfills content table too)
        const contentDur = await probeAndUpdateDuration(content);
        if (contentDur) duration_sec = Math.ceil(contentDur);
      }
    }
    if (duration_sec === undefined || duration_sec === null) duration_sec = 10;
    if (widget_id) {
      const widget = db.prepare('SELECT id FROM widgets WHERE id = ?').get(widget_id);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
    }

    // Auto-increment sort_order if not specified
    let order = sort_order;
    if (order === undefined || order === null) {
      const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
        .get(req.params.id);
      order = (max.max_order || 0) + 1;
    }

    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, content_id || null, widget_id || null, order, duration_sec);

    // Touch playlist updated_at
    db.prepare("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);

    const item = db.prepare(`
      SELECT pi.*,
             COALESCE(c.filename, w.name) as filename,
             c.mime_type, c.filepath, c.thumbnail_path,
             c.duration_sec as content_duration, c.file_size, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config
      FROM playlist_items pi
      LEFT JOIN content c ON pi.content_id = c.id
      LEFT JOIN widgets w ON pi.widget_id = w.id
      WHERE pi.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(item);
  } catch (err) {
    console.error('Failed to add playlist item:', err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// Update item
router.put('/:id/items/:itemId', requirePlaylistOwnership, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  const { sort_order, duration_sec } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (duration_sec !== undefined) {
    if (typeof duration_sec !== 'number' || duration_sec < 1) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
    }
    updates.push('duration_sec = ?');
    values.push(duration_sec);
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.itemId);
    db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    db.prepare("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  }

  const updated = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.id = ?
  `).get(req.params.itemId);
  res.json(updated);
});

// Delete item
router.delete('/:id/items/:itemId', requirePlaylistOwnership, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.itemId);
  db.prepare("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Reorder items
router.post('/:id/items/reorder', requirePlaylistOwnership, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, req.params.id);
    });
  });
  transaction();

  db.prepare("UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);

  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json(items);
});

// Assign playlist to a device
router.post('/:id/assign', requirePlaylistOwnership, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  const device = db.prepare('SELECT id, user_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!['admin', 'superadmin'].includes(req.user.role) && device.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Device not owned by you' });
  }

  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(req.params.id, device_id);

  // Push update to device
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      io.of('/device').to(device_id).emit('device:playlist-update', buildPlaylistPayload(device_id));
    }
  } catch (e) { /* silent */ }

  res.json({ success: true });
});

module.exports = router;
