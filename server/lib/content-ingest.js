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
const { videoDisplayDims, imageDisplayDims } = require('./media-orientation');
const { finalizeUpload } = require('./upload-sniff');

// Multer takes file.originalname from the multipart header, bypassing sanitizeBody, so
// HTML-escape here (renders as text in every UI sink). .normalize('NFC') first: macOS
// sends NFD-decomposed names; Linux/renderers expect NFC. Single point - every filename
// storage site flows through here.
function safeFilename(name) {
  return sanitizeString((name || '').normalize('NFC'));
}

/*
 * Everything we can learn from the BYTES: thumbnail, display dimensions, duration.
 *
 * Extracted so PUT /api/content/:id/replace derives them the same way an upload does. It used
 * to carry its own shorter copy that handled images only — so replacing a video wiped the row's
 * duration, dimensions and thumbnail, and replacing a portrait photo re-introduced the EXIF
 * orientation bug (#170) that the ingest path fixes with imageDisplayDims + .rotate(). A second
 * copy of this logic is a second place for it to rot; there is now one.
 *
 * Best-effort by contract: a missing ffprobe or a decode failure yields nulls and a warning, never
 * a throw — the file itself is already stored and is worth more than its metadata.
 *
 * @returns {{width:number|null, height:number|null, durationSec:number|null, thumbnailPath:string|null}}
 */
async function deriveMediaMetadata(sourcePath, filepath, mime) {
  let width = null, height = null, durationSec = null, thumbnailPath = null;
  try {
    // SVG is deliberately NOT rasterised: it is already its own thumbnail. (It also used to be
    // the one format kept away from sharp, because rasterising went through librsvg — where the
    // outstanding libvips CVEs live. Nothing rasterises it now either.)
    if (mime === 'image/svg+xml') {
      thumbnailPath = filepath;
    } else if (mime.startsWith('image/')) {
      const imageOps = require('./image-ops');
      const thumbName = `thumb_${filepath}`;
      // Measure and thumbnail from ONE decode. Asking separately costs two, and a decode is the
      // single most expensive thing on this path (~1s for a 12MP photo — unlike sharp, whose
      // .metadata() only read the header). #170: rotation is implicit, the decoder auto-orients,
      // so the recorded dimensions and the thumbnail agree without an explicit rotate.
      const metadata = await imageOps.measureAndThumbnail(
        sourcePath, path.join(config.contentDir, thumbName), config.thumbnailWidth, 70);
      // #170: honor EXIF orientation so a portrait photo isn't stored as landscape. The decoder
      // applies it and reports orientation 1, so this is a no-op pass-through today — kept so the
      // rule lives in one place regardless of which decoder is underneath.
      ({ width, height } = imageDisplayDims(metadata));
      // Assign thumbnailPath only if the write actually succeeded: naming it unconditionally used
      // to store a phantom thumbnail_path for a file that was never created, which the UI then
      // requests forever as a broken image. The dimensions above survive that failure on purpose —
      // they are independently useful, and losing them would letterbox the asset wrongly.
      if (metadata.thumbnailWritten) thumbnailPath = thumbName;
      else console.warn(`Thumbnail write failed for ${filepath}: ${metadata.thumbnailError}`);
    } else if (mime.startsWith('video/')) {
      try {
        // execFile, NOT execFileSync. These two spawns each carry a 15s timeout, and run
        // synchronously they block the event loop for their whole duration — nothing else on
        // the server runs, including heartbeats and socket traffic. That was survivable while
        // the only caller was a human-initiated upload; it stopped being survivable the moment
        // a boot-time sweep started walking a whole library of them unattended, which is the
        // #240 failure mode exactly (blocked loop -> missed heartbeats -> panels marked
        // offline -> reconnect churn) arriving from our own maintenance.
        //
        // deriveMediaMetadata is already async and both callers already await it, so awaiting
        // the subprocess instead of blocking on it is invisible to them.
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const { stdout: probe } = await execFileAsync('ffprobe',
          ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', sourcePath],
          { timeout: 15000 }
        );
        const info = JSON.parse(probe);
        if (info.format?.duration) durationSec = parseFloat(info.format.duration);
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        if (videoStream) {
          // #170: honor the rotation/Display-Matrix so a portrait video isn't stored landscape.
          // (ffmpeg auto-rotates the thumbnail below by default, so only the dims need fixing.)
          ({ width, height } = videoDisplayDims(videoStream));
        }
        // Same phantom-path discipline as the image branch above: name it only once the
        // file exists, so a failed encode cannot leave the row claiming a thumbnail.
        const thumbName = `thumb_${filepath.replace(/\.[^.]+$/, '.jpg')}`;
        try {
          await execFileAsync('ffmpeg',
            ['-y', '-i', sourcePath, '-ss', '2', '-vframes', '1', '-vf', `scale=${config.thumbnailWidth}:-1`, path.join(config.contentDir, thumbName)],
            { timeout: 15000 }
          );
          thumbnailPath = thumbName;
        } catch { thumbnailPath = null; }
      } catch (e) {
        console.warn('ffprobe failed:', e.message);
      }
    }
  } catch (e) {
    console.warn('Thumbnail/metadata generation failed:', e.message);
  }
  return { width, height, durationSec, thumbnailPath };
}

// Process a multer-uploaded file (thumbnail + dimensions + duration) and insert a content
// row. Returns the content row. Throws on a hard failure (the caller maps to 500);
// thumbnail/metadata failures are best-effort (logged, non-fatal) exactly as before.
async function ingestUploadedFile({ file, userId, workspaceId, folderId = null }) {
  const id = uuidv4();
  // Content-derived extension + mime. Throws UnsupportedUploadError (and removes the temp
  // file) when the bytes are not a supported media type; the caller maps that to a 400.
  const { filepath, mime } = finalizeUpload(file);
  const { width, height, durationSec, thumbnailPath } = await deriveMediaMetadata(file.path, filepath, mime);

  db.prepare(`
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec, thumbnail_path, width, height, folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, workspaceId, safeFilename(file.originalname), filepath, mime, file.size, durationSec, thumbnailPath, width, height, folderId || null);

  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}

module.exports = { ingestUploadedFile, safeFilename, deriveMediaMetadata };
