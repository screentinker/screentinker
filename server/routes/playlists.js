const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
// Phase 2.2k: workspace-aware access. requirePlaylistOwnership is replaced
// by read/write helpers gated on the playlist's workspace_id.
const { accessContext } = require('../lib/tenancy');

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

// Phase 2.2k: workspace-aware playlist access. Returns the playlist row (with
// req.playlistCtx populated) or sends 403/404. requireWrite=false for reads.
function loadPlaylistAccess(req, res, requireWrite) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) { res.status(404).json({ error: 'playlist not found' }); return null; }
  if (!playlist.workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(playlist.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  req.playlist = playlist;
  req.playlistCtx = ctx;
  return playlist;
}

function requirePlaylistRead(req, res, next) {
  if (!loadPlaylistAccess(req, res, false)) return;
  next();
}

function requirePlaylistWrite(req, res, next) {
  if (!loadPlaylistAccess(req, res, true)) return;
  next();
}

// Build the snapshot item list for a playlist (denormalized for device payload)
function buildSnapshotItems(playlistId) {
  const items = db.prepare(`
    SELECT pi.id AS _iid, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
  // #74/#75: attach per-item schedule blocks (the player honours these in its own
  // local time via the shared evaluator). An item with zero blocks gets no
  // `schedules` field -> always on. Additive: old players ignore the field. _iid is
  // only used here to fetch blocks and is then dropped (snapshot stays id-free).
  for (const it of items) {
    const blocks = schedulesForItem(it._iid);
    if (blocks.length) it.schedules = blocks;
    delete it._iid;
  }
  return items;
}

// Map an item's schedule rows into the evaluator's block shape.
function schedulesForItem(itemId) {
  return db.prepare(
    'SELECT active_days, start_time, end_time, start_date, end_date FROM playlist_item_schedules WHERE playlist_item_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(itemId).map(r => ({
    days: String(r.active_days || '').split(',').filter(s => s !== '').map(Number),
    start: r.start_time,
    end: r.end_time,
    start_date: r.start_date || null,
    end_date: r.end_date || null,
  }));
}

// Mark playlist as draft (called after item mutations from the playlist detail UI)
function markDraft(playlistId) {
  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
}

// Push playlist update to all devices using this playlist
function pushToDevices(playlistId, req) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    const devices = db.prepare('SELECT id FROM devices WHERE playlist_id = ?').all(playlistId);
    for (const d of devices) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }
}

// Phase 2.2k: list scoped to caller's current workspace. No platform_admin
// bypass - cross-workspace view comes from switch-workspace, matching the
// precedent established across all other migrated routes.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const playlists = db.prepare(`
    SELECT p.*, COUNT(DISTINCT pi.id) as item_count, COUNT(DISTINCT d.id) as display_count
    FROM playlists p
    LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
    LEFT JOIN devices d ON d.playlist_id = p.id
    WHERE p.workspace_id = ?
    GROUP BY p.id
    ORDER BY p.name ASC
  `).all(req.workspaceId);
  res.json(playlists);
});

// Phase 2.2k: create stamps workspace_id from req.workspaceId. Viewer-deny
// gate so workspace_viewers cannot create playlists in their workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name.trim(), (description || '').trim());
  res.status(201).json(db.prepare(`
    SELECT p.*, 0 as item_count, 0 as display_count FROM playlists p WHERE p.id = ?
  `).get(id));
});

// Get single playlist with items
router.get('/:id', requirePlaylistRead, (req, res) => {
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
router.put('/:id', requirePlaylistWrite, (req, res) => {
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

// Publish playlist — snapshot current items and push to devices
router.post('/:id/publish', requirePlaylistWrite, (req, res) => {
  // Snapshot shape (no pi.id) is intentional — published_snapshot is consumed
  // by devices and stored as JSON; row IDs there would be misleading.
  const snapshotItems = buildSnapshotItems(req.params.id);
  db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(snapshotItems), req.params.id);
  pushToDevices(req.params.id, req);
  // UI response shape must include pi.id so the post-publish render can wire
  // per-row delete/duration listeners. TODO: refactor to share this SELECT
  // with GET /:id (also duplicated in /discard and POST /:id/items/reorder).
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
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items });
});

// Discard draft — revert playlist_items to match published_snapshot
router.post('/:id/discard', requirePlaylistWrite, (req, res) => {
  const playlist = req.playlist;
  if (!playlist.published_snapshot) {
    return res.status(400).json({ error: 'No published version to revert to' });
  }
  if (playlist.status === 'published') {
    return res.status(400).json({ error: 'Playlist has no unpublished changes' });
  }

  let publishedItems;
  try { publishedItems = JSON.parse(playlist.published_snapshot); } catch (e) {
    return res.status(500).json({ error: 'Corrupt published snapshot' });
  }

  const transaction = db.transaction(() => {
    // Clear current draft items
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(req.params.id);
    // Re-insert from snapshot, skipping items whose content/widget was deleted
    const insert = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?, ?)');
    for (const item of publishedItems) {
      try {
        insert.run(req.params.id, item.content_id || null, item.widget_id || null, item.zone_id || null, item.sort_order, item.duration_sec);
      } catch (e) {
        if (e.message.includes('FOREIGN KEY')) {
          console.warn(`Discard: skipping snapshot item (content_id=${item.content_id}, widget_id=${item.widget_id}) — referenced entity was deleted`);
          continue;
        }
        throw e;
      }
    }
    db.prepare("UPDATE playlists SET status = 'published', updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  });
  transaction();

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
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items });
});

// Delete playlist
router.delete('/:id', requirePlaylistWrite, (req, res) => {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Playlist Items ---

// List items
router.get('/:id/items', requirePlaylistRead, (req, res) => {
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
  for (const it of items) it.schedules = schedulesForItem(it.id); // #74/#75: editor needs the blocks
  res.json(items);
});

// --- Per-item schedule blocks (#74 dayparting + #75 expiry) ---
// Same permission as editing items (requirePlaylistWrite). Block shape mirrors the
// evaluator: { days:[0-6], start:"HH:MM", end:"HH:MM"|"24:00", start_date, end_date }.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return 'each block must be an object';
    if (!Array.isArray(b.days) || b.days.length === 0 || !b.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return 'days must be a non-empty array of integers 0-6';
    if (!TIME_RE.test(b.start)) return 'start must be HH:MM (00:00-23:59)';
    if (!(TIME_RE.test(b.end) || b.end === '24:00')) return 'end must be HH:MM or 24:00';
    for (const k of ['start_date', 'end_date']) if (b[k] != null && !DATE_RE.test(b[k])) return `${k} must be YYYY-MM-DD or null`;
  }
  return null;
}
function itemInPlaylist(itemId, playlistId) {
  return db.prepare('SELECT id FROM playlist_items WHERE id = ? AND playlist_id = ?').get(itemId, playlistId);
}

router.get('/:id/items/:itemId/schedules', requirePlaylistRead, (req, res) => {
  const item = itemInPlaylist(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(schedulesForItem(item.id));
});

// Replace an item's schedule blocks wholesale ([] = no schedule = always on).
router.put('/:id/items/:itemId/schedules', requirePlaylistWrite, (req, res) => {
  const item = itemInPlaylist(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const blocks = req.body.blocks;
  const err = validateBlocks(blocks);
  if (err) return res.status(400).json({ error: err });
  const ins = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?').run(item.id);
    blocks.forEach((b, i) => ins.run(uuidv4(), item.id, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i));
  })();
  markDraft(req.params.id); // schedule changes affect playback -> draft until re-published
  res.json(schedulesForItem(item.id));
});

// Phase 2.2k: add item closes 2 pre-existing cross-tenant leaks:
//   1. Content gate: today checks content.user_id == caller. A workspace_admin
//      who owns content in another workspace could push it into a playlist
//      in this workspace. Now: content must be in playlist's workspace (or
//      be a platform-template, workspace_id IS NULL).
//   2. Widget gate: today checks ONLY existence - any user could attach any
//      widget UUID to a playlist they could reach. Now: widget must be in
//      playlist's workspace (or be a platform-template).
router.post('/:id/items', requirePlaylistWrite, async (req, res) => {
  try {
    const { content_id, widget_id, sort_order } = req.body;
    let { duration_sec } = req.body;

    if (!content_id && !widget_id) return res.status(400).json({ error: 'content_id or widget_id required' });
    if (duration_sec !== undefined && duration_sec !== null && (typeof duration_sec !== 'number' || duration_sec < 1)) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
    }

    if (content_id) {
      const content = db.prepare('SELECT id, workspace_id, duration_sec, mime_type, filepath FROM content WHERE id = ?').get(content_id);
      if (!content) return res.status(404).json({ error: 'Content not found' });
      if (content.workspace_id && content.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Content is not in this playlist\'s workspace' });
      }
      if (duration_sec === undefined || duration_sec === null) {
        const contentDur = await probeAndUpdateDuration(content);
        if (contentDur) duration_sec = Math.ceil(contentDur);
      }
    }
    if (duration_sec === undefined || duration_sec === null) duration_sec = 10;
    if (widget_id) {
      const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
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

    // Mark as draft (items changed since last publish)
    markDraft(req.params.id);

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
router.put('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
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
    markDraft(req.params.id);
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
router.delete('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.itemId);
  markDraft(req.params.id);
  res.json({ success: true });
});

// Reorder items
router.post('/:id/items/reorder', requirePlaylistWrite, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, req.params.id);
    });
  });
  transaction();

  markDraft(req.params.id);

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

// Assign playlist to a device. Phase 2.2k: closes a pre-existing cross-tenant
// leak. Today checks device.user_id only; a caller with reach into a foreign
// workspace could assign their own playlist to a device in that workspace
// (or vice versa). Now: device must be in the playlist's workspace.
router.post('/:id/assign', requirePlaylistWrite, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.workspace_id !== req.playlist.workspace_id) {
    return res.status(403).json({ error: 'Device is not in this playlist\'s workspace' });
  }

  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(req.params.id, device_id);

  // Push update to device
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), device_id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }

  res.json({ success: true });
});

module.exports = router;
