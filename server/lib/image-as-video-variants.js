'use strict';

/*
 * High-resolution stills for Android's native video plane.
 *
 * WHY. On some Android boxes the UI layer is limited to 1080p even though the display is 4K.
 * The native video plane can reach the panel's full resolution, so this module makes a short H.264
 * clip from a still and lets the player show it there instead of scaling the image in the UI.
 *
 * HOW, CHEAPLY AND SAFELY. ./still-video encodes the clip with our own still-picture H.264 encoder
 * (no ffmpeg, no GPL code), fitted to 3840x2160 at most, in a separate process at the lowest CPU
 * priority with a heap cap and a timeout. A failed or killed conversion marks the row failed; it never
 * reaches the server process. One conversion runs at a time.
 *
 * ONLY MAKE A COPY WHEN IT CAN HELP:
 *   - the source is a local image larger than FHD on either axis and no larger than 8192px per axis;
 *   - the device declares playback.image_as_video_variants, has a native video plane and a display
 *     larger than FHD; its UI render surface is smaller than the source or its size is unreported;
 *     the item is full-screen, landscape and outside a wall or transition;
 *   - queue lazily when a qualifying image is sent to such a device; a workspace with no use for
 *     the plane spends no encoding time.
 *
 * THE QUEUE IS THE TABLE. Each content_image_as_video_variants row moves queued -> running ->
 * ready | failed. Its source file and revision bind the output to the image it was made from, so a
 * replaced image never plays an old clip. A hosted encode also consumes the shared monthly video
 * variant allowance (one second per image); an allowance refusal can be queued again next month.
 *
 * Files are local cache entries, downloaded by Android into its revision-keyed client cache and
 * served by GET /api/content/:id/image-as-video. They are not organization data and can be rebuilt
 * from the source image; while a copy is missing or unavailable, the player keeps the original.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const config = require('../config');
const videoVariants = require('./video-variants');

const CAPABILITY = 'playback.image_as_video_variants';
const FILE_RE = /^saiv_[a-f0-9]{20}_[a-f0-9]{12}\.mp4$/;
const MAX_SOURCE_DIMENSION = 8192;
const IMAGE_CLIP_DURATION_SEC = 1;
const ENCODER_REVISION = 6; // 6: own still encoder, fitted to 3840x2160 (5 and earlier: ffmpeg x264 at source size)
const jobs = new Set();
const running = new Map();
let timer = null;
let timerAt = 0;
let started = false;
let pushFn = null;
let encodeFn = null;

// ---------------------------------------------------------------- eligibility and revision

/** Only local, decodable stills that exceed FHD and remain within the encoder's dimension limit. */
function isEligibleImage(content) {
  const width = Number(content && content.width);
  const height = Number(content && content.height);
  return !!content && /^image\//i.test(String(content.mime_type || '')) &&
    !!content.filepath && !content.remote_url &&
    (width > 1920 || height > 1080) &&
    width <= MAX_SOURCE_DIMENSION && height <= MAX_SOURCE_DIMENSION;
}

function sourceRevision(content) {
  // Bump when encoding output changes so existing cache rows are regenerated from the same source.
  return Number(content.updated_at || content.created_at || 0) * 100 + ENCODER_REVISION;
}

function removeFile(filename) {
  if (!filename) return;
  const name = path.basename(filename);
  if (!FILE_RE.test(name) && !/^saiv_[a-f0-9]{20}_[a-f0-9]{12}\.part\.mp4$/.test(name)) return;
  try { fs.unlinkSync(path.join(config.contentDir, name)); } catch (_) { /* already removed */ }
}

function rowFor(contentId) {
  return db.prepare('SELECT * FROM content_image_as_video_variants WHERE content_id = ?').get(contentId) || null;
}

// ---------------------------------------------------------------- queue rows and payload

/**
 * Ensure an eligible source has a current variant. A denied job waits until the next month, while
 * a changed source revision gets a fresh row and a newly encoded file.
 */
function ensure(content, { now = new Date() } = {}) {
  if (!isEligibleImage(content)) return null;
  const sourceFile = path.basename(content.filepath);
  const revision = sourceRevision(content);
  const current = rowFor(content.id);
  if (current && current.source_file === sourceFile && Number(current.source_revision) === revision) {
    if (current.error === 'monthly allowance reached' &&
        videoVariants.monthKey(new Date(Number(current.updated_at) * 1000)) !== videoVariants.monthKey(now)) {
      db.prepare("UPDATE content_image_as_video_variants SET status = 'queued', error = NULL, updated_at = ? WHERE content_id = ? AND status = 'failed'")
        .run(Math.floor(now.getTime() / 1000), content.id);
      schedule(0);
      return 'queued';
    }
    if (current.status === 'ready' &&
        (!current.filepath || !fs.existsSync(path.join(config.contentDir, path.basename(current.filepath))))) {
      db.prepare("UPDATE content_image_as_video_variants SET status = 'queued', filepath = NULL, updated_at = strftime('%s','now') WHERE content_id = ?")
        .run(content.id);
      schedule(0);
      return 'queued';
    }
    return current.status;
  }
  if (current) removeFile(current.filepath);
  db.prepare(`INSERT INTO content_image_as_video_variants
      (content_id, workspace_id, source_file, source_revision, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', strftime('%s','now'), strftime('%s','now'))
      ON CONFLICT(content_id) DO UPDATE SET workspace_id = excluded.workspace_id,
        source_file = excluded.source_file, source_revision = excluded.source_revision,
        status = 'queued', filepath = NULL, file_size = NULL, error = NULL, attempts = 0,
        created_at = excluded.created_at, updated_at = excluded.updated_at`)
    .run(content.id, content.workspace_id || null, sourceFile, revision);
  schedule(0);
  return 'queued';
}

/** Stamp only eligible full-screen Android items; forecast payloads read state without queueing. */
function stampItems(items, device, { lazy = true } = {}) {
  if (!Array.isArray(items)) return;
  const outputPixels = Number(device && device.screen_width) * Number(device && device.screen_height);
  const renderWidth = Number(device && device.render_width);
  const renderHeight = Number(device && device.render_height);
  const hasRenderSize = Number.isFinite(renderWidth) && renderWidth > 0 &&
    Number.isFinite(renderHeight) && renderHeight > 0;
  const supports = !!device && Number(device.native_video) === 1 &&
    outputPixels > 1920 * 1080 && !device.wall_id &&
    (!device.orientation || device.orientation === 'landscape') &&
    require('./player-capabilities').platformFamily(device) === 'android' &&
    require('./player-capabilities').supports(device, CAPABILITY);
  let select = null;
  for (const item of items) {
    if (!item || !item.content_id || !/^image\//i.test(String(item.mime_type || ''))) continue;
    delete item.image_as_video_revision;
    delete item.image_as_video_state;
    if (!supports || item.zone_id || item.transition || item.transition_id) continue;
    try {
      select = select || db.prepare(`SELECT id, filepath, mime_type, width, height, remote_url, workspace_id,
          updated_at, created_at FROM content WHERE id = ?`);
      const content = select.get(item.content_id);
      if (!isEligibleImage(content)) continue;
      if (hasRenderSize && renderWidth >= Number(content.width) &&
          renderHeight >= Number(content.height)) continue;
      if (lazy) {
        ensure(content);
      } else {
        const existing = rowFor(content.id);
        if (!existing || existing.source_file !== path.basename(content.filepath) ||
            Number(existing.source_revision) !== sourceRevision(content)) continue;
      }
      const row = rowFor(content.id);
      if (!row || row.source_file !== path.basename(content.filepath) ||
          Number(row.source_revision) !== sourceRevision(content)) {
        item.image_as_video_state = 'preparing';
      } else if (row.status === 'ready' && row.filepath &&
          fs.existsSync(path.join(config.contentDir, path.basename(row.filepath)))) {
        item.image_as_video_state = 'ready';
        item.image_as_video_revision = Number(row.updated_at);
      } else {
        item.image_as_video_state = row.status === 'failed' ? 'unavailable' : 'preparing';
      }
    } catch (error) {
      console.warn(`[image-as-video-variants] payload stamp failed for ${item.content_id}: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------- worker and encoding

function schedule(delay = 0) {
  if (!started) return;
  const at = Date.now() + delay;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => {
    timer = null;
    timerAt = 0;
    tick().catch((error) => console.warn(`[image-as-video-variants] queue failed: ${error.message}`));
  }, delay);
  if (timer.unref) timer.unref();
}

/** Run one queued job after rechecking its source and the shared hosted allowance. */
async function tick() {
  if (running.size) return;
  const job = db.prepare(`SELECT r.*, c.filepath AS current_filepath, c.mime_type, c.width, c.height,
      c.remote_url, c.workspace_id AS current_workspace_id, c.updated_at, c.created_at
    FROM content_image_as_video_variants r JOIN content c ON c.id = r.content_id
    WHERE r.status = 'queued' ORDER BY r.created_at, r.content_id LIMIT 1`).get();
  if (!job) return;
  const sourceFile = path.basename(job.current_filepath || '');
  const revision = sourceRevision(job);
  const content = { ...job, filepath: job.current_filepath, workspace_id: job.current_workspace_id };
  if (!isEligibleImage(content) || sourceFile !== job.source_file ||
      revision !== Number(job.source_revision)) {
    db.prepare("DELETE FROM content_image_as_video_variants WHERE content_id = ? AND status = 'queued'")
      .run(job.content_id);
    schedule(0);
    return;
  }
  const allowanceSettings = videoVariants.getSettings();
  const allowanceDate = new Date();
  if (!videoVariants.withinAllowance(content.workspace_id, IMAGE_CLIP_DURATION_SEC, allowanceSettings, allowanceDate)) {
    db.prepare("UPDATE content_image_as_video_variants SET status = 'failed', error = 'monthly allowance reached', updated_at = ? WHERE content_id = ? AND status = 'queued'")
      .run(Math.floor(allowanceDate.getTime() / 1000), job.content_id);
    pushFor(job.content_id);
    schedule(0);
    return;
  }
  db.prepare("UPDATE content_image_as_video_variants SET status = 'running', attempts = attempts + 1, updated_at = strftime('%s','now') WHERE content_id = ? AND status = 'queued'")
    .run(job.content_id);
  const entry = {
    contentId: job.content_id,
    sourceFile: job.source_file,
    sourceRevision: Number(job.source_revision),
    filename: `saiv_${crypto.createHash('sha256').update(job.content_id).digest('hex').slice(0, 20)}_${crypto.randomBytes(6).toString('hex')}.mp4`,
  };
  const temporary = entry.filename.replace(/\.mp4$/, '.part.mp4');
  running.set(job.content_id, temporary);
  const promise = runJob(entry, temporary).finally(() => {
    running.delete(job.content_id);
    jobs.delete(promise);
    schedule(0);
  });
  jobs.add(promise);
}

// The clip fits inside this box (keeping the aspect ratio): the panel resolution these boxes reach on
// their video plane. Larger sources are scaled down, which also keeps the stream inside H.264 Level 5.1,
// the most a TV box's hardware decoder is specified for.
const MAX_OUTPUT = { width: 3840, height: 2160 };
// One intra frame plus "unchanged" frames at 1 fps. The player loops it for as long as the image
// shows, so the length only sets how often it restarts; the extra frames cost a few bytes each.
const CLIP_SECONDS = 60;

function runEncode({ src, out }) {
  return require('./still-video').makeStillVideo({
    src, out, maxWidth: MAX_OUTPUT.width, maxHeight: MAX_OUTPUT.height, seconds: CLIP_SECONDS,
  });
}

/**
 * Encode to a temporary file, then publish only if the queued source revision is still current.
 * The ready-row update and shared-allowance charge commit together.
 */
async function runJob(entry, temporaryName) {
  const output = path.join(config.contentDir, entry.filename);
  const temporary = path.join(config.contentDir, temporaryName);
  try {
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(entry.contentId);
    if (!content) throw new Error('source content was deleted');
    const src = await require('./storage/locations').ensureLocalFile(content, 'asset');
    if (!src) throw new Error('the original image is not available on this server');
    fs.mkdirSync(config.contentDir, { recursive: true });
    await (encodeFn || runEncode)({ src, out: temporary });
    fs.renameSync(temporary, output);
    const size = fs.statSync(output).size;
    const updated = db.transaction(() => {
      const result = db.prepare(`UPDATE content_image_as_video_variants
        SET status = 'ready', filepath = ?, file_size = ?, error = NULL,
            updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
        WHERE content_id = ? AND status = 'running' AND source_file = ? AND source_revision = ?`)
        .run(entry.filename, size, entry.contentId, entry.sourceFile, entry.sourceRevision);
      if (result.changes) videoVariants.chargeUsage(content.workspace_id, IMAGE_CLIP_DURATION_SEC);
      return result;
    })();
    if (!updated.changes) { removeFile(entry.filename); return; }
    console.info(`[image-as-video-variants] ready ${entry.contentId} (${size} bytes)`);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* no partial output */ }
    removeFile(entry.filename);
    db.prepare("UPDATE content_image_as_video_variants SET status = 'failed', error = ?, updated_at = strftime('%s','now') WHERE content_id = ? AND status = 'running'")
      .run(String(error.message || error).slice(0, 300), entry.contentId);
    console.warn(`[image-as-video-variants] ${entry.contentId} failed: ${error.message || error}`);
  }
  pushFor(entry.contentId);
}

function pushFor(contentId) {
  if (!pushFn) return;
  try { pushFn(require('./devices-playing').devicesPlayingContent(contentId)); }
  catch (error) { console.warn(`[image-as-video-variants] playlist push failed: ${error.message}`); }
}

// ---------------------------------------------------------------- serving, cleanup and lifecycle

/** Return only a cache file for the current source revision and, when supplied, requested revision. */
function servePath(content, expectedRevision = null) {
  if (!content || !content.filepath) return null;
  const row = rowFor(content.id);
  if (!row || row.status !== 'ready' ||
      row.source_file !== path.basename(content.filepath) ||
      Number(row.source_revision) !== sourceRevision(content) ||
      (expectedRevision != null && Number(row.updated_at) !== Number(expectedRevision))) return null;
  const name = path.basename(row.filepath || '');
  if (!FILE_RE.test(name)) return null;
  const file = path.resolve(config.contentDir, name);
  return file.startsWith(path.resolve(config.contentDir) + path.sep) && fs.existsSync(file) ? file : null;
}

/** Remove the derived file and queue row; the original image is never touched. */
function removeFor(contentId) {
  const row = rowFor(contentId);
  if (row) removeFile(row.filepath);
  db.prepare('DELETE FROM content_image_as_video_variants WHERE content_id = ?').run(contentId);
}

function sweepOrphans() {
  let names = [];
  try {
    names = fs.readdirSync(config.contentDir)
      .filter((name) => FILE_RE.test(name) || /^saiv_[a-f0-9]{20}_[a-f0-9]{12}\.part\.mp4$/.test(name));
  } catch (_) { return 0; }
  const known = new Set(db.prepare('SELECT filepath FROM content_image_as_video_variants WHERE filepath IS NOT NULL').all()
    .map((row) => row.filepath));
  const active = new Set(running.values());
  let removed = 0;
  for (const name of names) {
    if (known.has(name) || active.has(name)) continue;
    try { fs.unlinkSync(path.join(config.contentDir, name)); removed++; } catch (_) { /* best effort */ }
  }
  return removed;
}

/** Resume interrupted work and periodically remove files whose cache rows no longer exist. */
function start({ push = null } = {}) {
  if (started) return;
  started = true;
  pushFn = push;
  // Rows the earlier ffmpeg-based encoder failed for want of ffmpeg: the encoder no longer needs it.
  db.prepare(`UPDATE content_image_as_video_variants
      SET status = 'queued', error = NULL, attempts = 0, updated_at = strftime('%s','now')
      WHERE status = 'failed' AND error = 'ffmpeg is unavailable on the server'`).run();
  db.prepare("UPDATE content_image_as_video_variants SET status = 'queued' WHERE status = 'running'").run();
  sweepOrphans();
  schedule(0);
  const interval = setInterval(() => {
    try { sweepOrphans(); } catch (error) { console.warn(`[image-as-video-variants] orphan sweep failed: ${error.message}`); }
  }, 6 * 60 * 60 * 1000);
  if (interval.unref) interval.unref();
}

function resetForTest({ encode = null } = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  timerAt = 0;
  started = false;
  pushFn = null;
  encodeFn = encode;
  jobs.clear();
  running.clear();
}

module.exports = {
  CAPABILITY, FILE_RE, MAX_OUTPUT, CLIP_SECONDS, isEligibleImage, ensure, stampItems,
  servePath, removeFor, sweepOrphans, start,
  _resetForTest: resetForTest,
  _tick: tick,
  _drain: () => Promise.all([...jobs]),
};
