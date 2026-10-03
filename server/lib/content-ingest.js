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
const { cleanUserText } = require('../middleware/sanitize');
const { videoDisplayDims, imageDisplayDims } = require('./media-orientation');
const { isSupportUserId } = require('./support-access');
const { digestFile } = require('./content-digest');
const { finalizeUpload } = require('./upload-sniff');
const htmlBundle = require('./html-bundle');
const fs = require('fs');

// Multer takes file.originalname from the multipart header, bypassing sanitizeBody, so it is
// cleaned here instead.
//
// ⚠️ NOT HTML-ESCAPED ANY MORE — see middleware/sanitize.js. Escaping at ingest and again at the
// sink is double encoding, and it compounded on every re-save. Stored as typed; escaped where it
// is rendered. .normalize('NFC') first: macOS sends NFD-decomposed names; Linux/renderers expect
// NFC. Single point - every filename storage site flows through here.
function safeFilename(name) {
  return cleanUserText((name || '').normalize('NFC'));
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
    } else if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      // Audio takes the same branch as video: ffprobe reads its duration the same way, and that
      // number is what lets the slide editor warn when a voiceover outruns the slide it is on.
      // The thumbnail half below simply produces nothing for audio, which is correct.
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
  let { filepath, mime } = finalizeUpload(file);

  /*
   * A zip is only accepted when it is an HTML BUNDLE, and that is decided here rather than in the
   * sniffer because the answer is not in the magic bytes — it is in the central directory. The
   * validator reads that directory and never extracts anything, so nothing attacker-named is
   * written to this disk; on refusal the stored file is removed and the caller gets the reason.
   */
  let bundleEntry = null;
  if (mime === 'application/zip') {
    const stored = path.join(config.contentDir, filepath);
    try {
      const info = await htmlBundle.validateBundle(stored);
      bundleEntry = info.entryPoint;
      mime = htmlBundle.BUNDLE_MIME;
    } catch (err) {
      try { fs.unlinkSync(stored); } catch (e) { /* best effort */ }
      throw err;
    }
  }

  const { width, height, durationSec, thumbnailPath } = await deriveMediaMetadata(file.path, filepath, mime);

  /*
   * ⚠️ byte_digest IS SET HERE TOO, AND THAT IS THE POINT OF THE COLUMN.
   *
   * It was added for mesh content and implemented only in the mesh writer, so every locally
   * uploaded file carried NULL — which made the dedup lookup unable to match anything already in
   * the library. A node would re-download bytes it was already holding, and charge the operator's
   * storage allowance for them. The column's own migration note named five writers that owe it a
   * value; one of them had it.
   *
   * Hashing on ingest costs one streamed read of a file that was just written and is still in page
   * cache. Failure is non-fatal: a NULL digest degrades to "cannot dedup", which is exactly where
   * every existing row already is, so an unreadable file must not lose the upload.
   */
  let digest = null;
  try { digest = await digestFile(path.join(config.contentDir, filepath)); } catch (e) { digest = null; }

  /*
   * ⚠️ content.user_id IS A FOREIGN KEY INTO users, AND A SUPPORT SESSION HAS NO users ROW.
   *
   * Binding `support:<jti>` here threw `FOREIGN KEY constraint failed` — but only at the very
   * END of the upload, after every byte had been received, the file moved into contentDir and the
   * thumbnail rendered. A 47 MB upload on a 2 Mbps link therefore transferred for three minutes
   * and then vanished, leaving the media and its thumbnail orphaned on disk with no row pointing
   * at them. The dashboard reported it only as a failed upload. Observed 2026-09-28.
   *
   * The column is nullable and workspace_id already carries the tenancy, so an upload made during
   * a support session is recorded as belonging to the workspace with no owning account — which is
   * true. It also keeps it out of getUserStorageMB, which sums by user_id: support bytes are not
   * the customer's allowance.
   *
   * ⚠️ The same FK sits on playlists, content_folders, layouts, widgets and schedules, all of
   * which bind req.user.id the same way and are NOT fixed here. See the PR for why.
   */
  const ownerUserId = isSupportUserId(userId) ? null : userId;

  db.prepare(`
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec, thumbnail_path, width, height, folder_id, byte_digest, bundle_entry)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ownerUserId, workspaceId, safeFilename(file.originalname), filepath, mime, file.size, durationSec, thumbnailPath, width, height, folderId || null, digest, bundleEntry);

  try {
    require('./plugins/hooks').emit('content.uploaded', {
      content_id: id,
      workspace_id: workspaceId,
      mime,
    });
  } catch { /* hooks must not fail an upload */ }

  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}

module.exports = { ingestUploadedFile, safeFilename, deriveMediaMetadata };
