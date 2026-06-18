const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const upload = require('../middleware/upload');
const config = require('../config');
const { checkStorageLimit, checkRemoteUrl } = require('../middleware/subscription');
const { sanitizeString } = require('../middleware/sanitize');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2b: workspace-aware access. Mirrors the pattern from devices.js.
const { accessContext } = require('../lib/tenancy');
// #73: the upload ingest (processing + insert) is now shared with the agency router.
const { ingestUploadedFile } = require('../lib/content-ingest');

// Multer captures file.originalname directly from the multipart filename header,
// bypassing sanitizeBody. Apply the same HTML-escape here so a filename like
// `"><img src=x onerror=alert(1)>.jpg` is stored as `&quot;&gt;&lt;img...` and
// renders as text in every UI sink. Umlauts, spaces, dots, and other unicode are
// preserved - sanitizeString only touches `& < > " '`.
//
// .normalize('NFC') first: macOS clients send NFD-decomposed filenames (an
// umlaut like "u" + combining diaeresis U+0308 instead of the precomposed
// "u-umlaut" U+00FC). Linux + most renderers expect NFC; without this, names
// like "Begrussungsscreens.jpg" arrive with the combining char floating and
// display as mojibake. Single-point fix - every user-facing filename storage
// site (POST /, POST /remote, POST /embed, PUT /:id rename) flows through
// safeFilename, so normalizing here covers all paths.
function safeFilename(name) {
  return sanitizeString((name || '').normalize('NFC'));
}

// SSRF gate for remote_url. Returns null if valid, else { status, error }.
// Used by both POST /remote and PUT /:id so a user can't bypass the check by
// uploading a benign URL and then PUT-updating it to file:///etc/passwd.
function validateRemoteUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: 400, error: 'Invalid URL format' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { status: 400, error: 'URL must use http or https' };
  }
  const hostname = parsed.hostname.toLowerCase();
  const isPrivate = hostname === 'localhost' || hostname === '0.0.0.0' ||
    hostname.startsWith('127.') || hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') || hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    hostname.startsWith('fc') || hostname.startsWith('fd') || hostname === '::1' ||
    hostname.endsWith('.local') || hostname.endsWith('.internal');
  if (isPrivate) return { status: 400, error: 'Internal URLs are not allowed' };
  return null;
}

// List content in the caller's current workspace, plus any platform-template
// rows (workspace_id IS NULL) that are shared with all workspaces.
// Phase 2.2b: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list filter.
// folder_id filter: omit for everything; "root" or "" for root-level only; <uuid> for that folder.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folder = req.query.folder;
  const folderId = req.query.folder_id;
  let sql = 'SELECT * FROM content WHERE (workspace_id = ? OR workspace_id IS NULL)';
  const params = [req.workspaceId];
  if (folder) { sql += ' AND folder = ?'; params.push(folder); }
  if (folderId !== undefined) {
    if (folderId === 'root' || folderId === '') {
      sql += ' AND folder_id IS NULL';
    } else {
      sql += ' AND folder_id = ?';
      params.push(folderId);
    }
  }
  sql += ' ORDER BY folder, created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(req.query.limit) || 100, 500), parseInt(req.query.offset) || 0);
  const content = db.prepare(sql).all(...params);
  res.json(content);
});

// Get folders list for the caller's current workspace.
router.get('/folders', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folders = db.prepare(
    'SELECT folder, COUNT(*) as count FROM content WHERE folder IS NOT NULL AND (workspace_id = ? OR workspace_id IS NULL) GROUP BY folder ORDER BY folder'
  ).all(req.workspaceId);
  res.json(folders);
});

// Upload content
router.post('/', checkStorageLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // #73: shared ingest - identical processing + insert for dashboard and agency uploads.
    const content = await ingestUploadedFile({ file: req.file, userId: req.user.id, workspaceId: req.workspaceId });
    res.status(201).json(content);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Add remote URL content
router.post('/remote', checkRemoteUrl, (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding remote content.' });
    const { url, name, mime_type } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const urlErr = validateRemoteUrl(url);
    if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'remote_content';
    const mimeType = mime_type || (url.match(/\.(mp4|webm|mkv|avi|mov)/i) ? 'video/mp4' : 'image/jpeg');

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url)
      VALUES (?, ?, ?, ?, '', ?, 0, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), mimeType, url);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('Remote URL add error:', err);
    res.status(500).json({ error: 'Failed to add remote URL' });
  }
});

// Add YouTube content (available to all plans - no storage used)
router.post('/youtube', async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding YouTube content.' });
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Extract YouTube video ID from various URL formats
    const videoId = extractYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    // Fetch video title from YouTube oEmbed if no name provided
    let filename = name;
    if (!filename) {
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          filename = oembed.title;
        }
      } catch {}
    }
    if (!filename) filename = `YouTube: ${videoId}`;

    const id = uuidv4();
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=${videoId}&enablejsapi=1`;
    // thumbnail_path is a REMOTE URL here; the /api/content/:id/thumbnail route proxies
    // remote thumbnails server-side (so this isn't a local-file path). Future option for
    // CDN independence: download the thumbnail at ingest into contentDir + backfill
    // existing rows, then this would store a local filename like image uploads do.
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, thumbnail_path)
      VALUES (?, ?, ?, ?, '', 'video/youtube', 0, ?, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), embedUrl, thumbnailUrl);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('YouTube add error:', err);
    res.status(500).json({ error: 'Failed to add YouTube video' });
  }
});

function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // bare video ID
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Phase 2.2b: workspace-aware access. Mirrors the device check pattern.
// Platform-template content (workspace_id IS NULL) is readable by anyone
// and writable only by platform_admin.
function checkContentRead(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  // Platform-template row: readable by anyone authenticated.
  if (!content.workspace_id) return content;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return content;
}

function checkContentWrite(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  // Platform-template row: only platform_admin may write.
  if (!content.workspace_id) {
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify shared content' }); return null;
    }
    return content;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  // Workspace_viewer is read-only; acting-as (platform_admin or org owner/admin) and editor/admin pass.
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return content;
}

// Get content metadata
router.get('/:id', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  res.json(content);
});

// Update content metadata
router.put('/:id', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;

  const { filename, mime_type, remote_url, folder, folder_id } = req.body;
  const updates = [];
  const values = [];
  if (filename !== undefined) { updates.push('filename = ?'); values.push(safeFilename(filename)); }
  if (mime_type !== undefined) { updates.push('mime_type = ?'); values.push(mime_type); }
  if (remote_url !== undefined) {
    if (remote_url) {
      const urlErr = validateRemoteUrl(remote_url);
      if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
    }
    updates.push('remote_url = ?');
    values.push(remote_url || null);
  }
  if (folder !== undefined) { updates.push('folder = ?'); values.push(folder || null); }
  if (folder_id !== undefined) {
    // Phase 2.2c: target folder must live in the same workspace as the
    // content row being modified. Strict same-workspace check - no
    // platform_admin override, because cross-workspace folder references
    // break the isolation model. To move content across workspaces, switch
    // workspace first.
    if (folder_id) {
      const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folder_id);
      if (!target) return res.status(400).json({ error: 'Invalid folder_id' });
      if (target.workspace_id !== content.workspace_id) {
        return res.status(403).json({ error: 'Cannot move content to a folder in another workspace' });
      }
    }
    updates.push('folder_id = ?');
    values.push(folder_id || null);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE content SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Replace content file
router.put('/:id/replace', upload.single('file'), async (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  // Delete old file
  if (content.filepath) {
    const oldPath = path.join(config.contentDir, content.filepath);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  // Delete old thumbnail
  if (content.thumbnail_path) {
    const oldThumb = path.join(config.contentDir, content.thumbnail_path);
    if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb);
  }

  const filepath = req.file.filename;
  let width = null, height = null, thumbnailPath = null;

  // Generate new thumbnail for images
  try {
    if (req.file.mimetype.startsWith('image/')) {
      const sharp = require('sharp');
      const metadata = await sharp(req.file.path).metadata();
      width = metadata.width;
      height = metadata.height;
      thumbnailPath = `thumb_${filepath}`;
      await sharp(req.file.path).resize(config.thumbnailWidth).jpeg({ quality: 70 })
        .toFile(path.join(config.contentDir, thumbnailPath));
    }
  } catch (e) {
    console.warn('Thumbnail generation failed:', e.message);
  }

  db.prepare(`UPDATE content SET filepath = ?, mime_type = ?, file_size = ?, thumbnail_path = ?, width = ?, height = ? WHERE id = ?`)
    .run(filepath, req.file.mimetype, req.file.size, thumbnailPath, width, height, req.params.id);

  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Serve content file
router.get('/:id/file', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  // Prevent path traversal
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Serve thumbnail
router.get('/:id/thumbnail', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Delete content
router.delete('/:id', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;

  // Delete file from disk (skip for remote URL content)
  if (content.filepath) {
    const filePath = path.join(config.contentDir, content.filepath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  // Delete thumbnail
  if (content.thumbnail_path) {
    const thumbPath = path.join(config.contentDir, content.thumbnail_path);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }

  // Get devices that have this content in their playlist (via playlist_items)
  const affectedDevices = db.prepare(`
    SELECT DISTINCT d.id as device_id FROM devices d
    JOIN playlists p ON d.playlist_id = p.id
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE pi.content_id = ?
  `).all(req.params.id);

  // Scrub published snapshots that reference this content
  // Validate UUID format to prevent LIKE wildcard injection
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid content ID format' });
  // Phase 2.2k: scope snapshot scrubbing by content.workspace_id (was content.user_id).
  // Playlists referencing this content live in the same workspace; user_id-keying missed
  // cross-user playlists in the same workspace once playlists became workspace-scoped.
  const snapshotPlaylists = db.prepare(
    "SELECT id, published_snapshot FROM playlists WHERE workspace_id = ? AND published_snapshot LIKE ?"
  ).all(content.workspace_id, `%${req.params.id}%`);
  for (const pl of snapshotPlaylists) {
    try {
      const items = JSON.parse(pl.published_snapshot);
      const filtered = items.filter(item => item.content_id !== req.params.id);
      if (filtered.length !== items.length) {
        db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
          .run(JSON.stringify(filtered), pl.id);
      }
    } catch (e) { /* corrupt snapshot, skip */ }
  }

  // Delete from DB (cascades to playlist_items via ON DELETE CASCADE)
  db.prepare('DELETE FROM content WHERE id = ?').run(req.params.id);

  // Push updated snapshots to affected devices
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      const deviceNs = io.of('/device');
      for (const d of affectedDevices) {
        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.device_id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* silent */ }

  res.json({ success: true, affectedDevices: affectedDevices.map(d => d.device_id) });
});

module.exports = router;
