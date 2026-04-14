const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const upload = require('../middleware/upload');
const config = require('../config');
const { checkStorageLimit, checkRemoteUrl } = require('../middleware/subscription');

// List content for current user (admins see all)
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const folder = req.query.folder;
  let sql = `SELECT * FROM content ${isAdmin ? 'WHERE 1=1' : 'WHERE (user_id = ? OR user_id IS NULL)'}`;
  const params = isAdmin ? [] : [req.user.id];
  if (folder) { sql += ' AND folder = ?'; params.push(folder); }
  sql += ' ORDER BY folder, created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(req.query.limit) || 100, 500), parseInt(req.query.offset) || 0);
  const content = db.prepare(sql).all(...params);
  res.json(content);
});

// Get folders list
router.get('/folders', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const folders = db.prepare(
    `SELECT folder, COUNT(*) as count FROM content WHERE folder IS NOT NULL ${isAdmin ? '' : 'AND (user_id = ? OR user_id IS NULL)'} GROUP BY folder ORDER BY folder`
  ).all(...(isAdmin ? [] : [req.user.id]));
  res.json(folders);
});

// Upload content
router.post('/', checkStorageLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const id = uuidv4();
    const filepath = req.file.filename;
    let width = null, height = null, durationSec = null, thumbnailPath = null;

    // Try to generate thumbnail, get dimensions, and detect duration
    try {
      if (req.file.mimetype.startsWith('image/')) {
        const sharp = require('sharp');
        const metadata = await sharp(req.file.path).metadata();
        width = metadata.width;
        height = metadata.height;

        // Generate thumbnail
        thumbnailPath = `thumb_${filepath}`;
        await sharp(req.file.path)
          .resize(config.thumbnailWidth)
          .jpeg({ quality: 70 })
          .toFile(path.join(config.contentDir, thumbnailPath));
      } else if (req.file.mimetype.startsWith('video/')) {
        // Extract video duration and dimensions with ffprobe
        try {
          const { execFileSync } = require('child_process');
          // Use execFileSync (not execSync) to prevent shell injection - args are NOT passed through shell
          const probe = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', req.file.path],
            { timeout: 15000 }
          ).toString();
          const info = JSON.parse(probe);
          if (info.format?.duration) durationSec = parseFloat(info.format.duration);
          const videoStream = info.streams?.find(s => s.codec_type === 'video');
          if (videoStream) {
            width = videoStream.width;
            height = videoStream.height;
          }
          // Generate video thumbnail at 2 second mark
          thumbnailPath = `thumb_${filepath.replace(/\.[^.]+$/, '.jpg')}`;
          try {
            execFileSync('ffmpeg', ['-y', '-i', req.file.path, '-ss', '2', '-vframes', '1', '-vf', `scale=${config.thumbnailWidth}:-1`, path.join(config.contentDir, thumbnailPath)],
              { timeout: 15000 }
            );
          } catch { thumbnailPath = null; }
        } catch (e) {
          console.warn('ffprobe failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('Thumbnail/metadata generation failed:', e.message);
    }

    db.prepare(`
      INSERT INTO content (id, user_id, filename, filepath, mime_type, file_size, duration_sec, thumbnail_path, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, req.file.originalname, filepath, req.file.mimetype, req.file.size, durationSec, thumbnailPath, width, height);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Add remote URL content
router.post('/remote', checkRemoteUrl, (req, res) => {
  try {
    const { url, name, mime_type } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    // Validate URL format
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'URL must use http or https' });
      }
      // Block private/internal IPs (SSRF protection)
      const hostname = parsed.hostname.toLowerCase();
      const isPrivate = hostname === 'localhost' || hostname === '0.0.0.0' ||
        hostname.startsWith('127.') || hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') || hostname.startsWith('169.254.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) || // 172.16.0.0 - 172.31.255.255
        hostname.startsWith('fc') || hostname.startsWith('fd') || hostname === '::1' || // IPv6 private
        hostname.endsWith('.local') || hostname.endsWith('.internal');
      if (isPrivate) {
        return res.status(400).json({ error: 'Internal URLs are not allowed' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'remote_content';
    const mimeType = mime_type || (url.match(/\.(mp4|webm|mkv|avi|mov)/i) ? 'video/mp4' : 'image/jpeg');

    db.prepare(`
      INSERT INTO content (id, user_id, filename, filepath, mime_type, file_size, remote_url)
      VALUES (?, ?, ?, '', ?, 0, ?)
    `).run(id, req.user.id, filename, mimeType, url);

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
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    db.prepare(`
      INSERT INTO content (id, user_id, filename, filepath, mime_type, file_size, remote_url, thumbnail_path)
      VALUES (?, ?, ?, '', 'video/youtube', 0, ?, ?)
    `).run(id, req.user.id, filename, embedUrl, thumbnailUrl);

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

// Helper: check content ownership
function checkContentAccess(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  if (!['admin','superadmin'].includes(req.user.role) && content.user_id && content.user_id !== req.user.id) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }
  return content;
}

// Get content metadata
router.get('/:id', (req, res) => {
  const content = checkContentAccess(req, res);
  if (!content) return;
  res.json(content);
});

// Update content metadata
router.put('/:id', (req, res) => {
  const content = checkContentAccess(req, res);
  if (!content) return;

  const { filename, mime_type, remote_url, folder } = req.body;
  const updates = [];
  const values = [];
  if (filename !== undefined) { updates.push('filename = ?'); values.push(filename); }
  if (mime_type !== undefined) { updates.push('mime_type = ?'); values.push(mime_type); }
  if (remote_url !== undefined) { updates.push('remote_url = ?'); values.push(remote_url || null); }
  if (folder !== undefined) { updates.push('folder = ?'); values.push(folder || null); }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE content SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Replace content file
router.put('/:id/replace', upload.single('file'), async (req, res) => {
  const content = checkContentAccess(req, res);
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
  const content = checkContentAccess(req, res);
  if (!content) return;
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  // Prevent path traversal
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Serve thumbnail
router.get('/:id/thumbnail', (req, res) => {
  const content = checkContentAccess(req, res);
  if (!content) return;
  if (!content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Delete content
router.delete('/:id', (req, res) => {
  const content = checkContentAccess(req, res);
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
  const snapshotPlaylists = db.prepare(
    "SELECT id, published_snapshot FROM playlists WHERE published_snapshot LIKE ?"
  ).all(`%${req.params.id}%`);
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
      for (const d of affectedDevices) {
        io.of('/device').to(d.device_id).emit('device:playlist-update', buildPlaylistPayload(d.device_id));
      }
    }
  } catch (e) { /* silent */ }

  res.json({ success: true, affectedDevices: affectedDevices.map(d => d.device_id) });
});

module.exports = router;
