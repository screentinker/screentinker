'use strict';

// #73: shared content-ingest core. Extracted from routes/content.js POST / so the agency
// upload (routes/agency.js) produces BYTE-IDENTICAL first-class content (same thumbnail/
// dimensions/duration/insert) - an agency asset is indistinguishable from a dashboard
// upload. routes/content.js POST / is now a thin caller; behavior is unchanged (its
// existing tests are the regression guard).

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
const { sanitizeString } = require('../middleware/sanitize');

// Multer takes file.originalname from the multipart header, bypassing sanitizeBody, so
// HTML-escape here (renders as text in every UI sink). .normalize('NFC') first: macOS
// sends NFD-decomposed names; Linux/renderers expect NFC. Single point - every filename
// storage site flows through here.
function safeFilename(name) {
  return sanitizeString((name || '').normalize('NFC'));
}

// Process a multer-uploaded file (thumbnail + dimensions + duration) and insert a content
// row. Returns the content row. Throws on a hard failure (the caller maps to 500);
// thumbnail/metadata failures are best-effort (logged, non-fatal) exactly as before.
async function ingestUploadedFile({ file, userId, workspaceId, folderId = null }) {
  const id = uuidv4();
  const filepath = file.filename;
  let width = null, height = null, durationSec = null, thumbnailPath = null;

  try {
    if (file.mimetype.startsWith('image/')) {
      const sharp = require('sharp');
      const metadata = await sharp(file.path).metadata();
      width = metadata.width;
      height = metadata.height;
      thumbnailPath = `thumb_${filepath}`;
      await sharp(file.path)
        .resize(config.thumbnailWidth)
        .jpeg({ quality: 70 })
        .toFile(path.join(config.contentDir, thumbnailPath));
    } else if (file.mimetype.startsWith('video/')) {
      try {
        const { execFileSync } = require('child_process');
        const probe = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file.path],
          { timeout: 15000 }
        ).toString();
        const info = JSON.parse(probe);
        if (info.format?.duration) durationSec = parseFloat(info.format.duration);
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        if (videoStream) {
          width = videoStream.width;
          height = videoStream.height;
        }
        thumbnailPath = `thumb_${filepath.replace(/\.[^.]+$/, '.jpg')}`;
        try {
          execFileSync('ffmpeg', ['-y', '-i', file.path, '-ss', '2', '-vframes', '1', '-vf', `scale=${config.thumbnailWidth}:-1`, path.join(config.contentDir, thumbnailPath)],
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
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec, thumbnail_path, width, height, folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, workspaceId, safeFilename(file.originalname), filepath, file.mimetype, file.size, durationSec, thumbnailPath, width, height, folderId || null);

  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}

module.exports = { ingestUploadedFile, safeFilename };
