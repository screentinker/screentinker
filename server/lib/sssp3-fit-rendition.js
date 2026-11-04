'use strict';

/*
 * SSSP3's native media plane needs files encoded at the zone's pixel size.
 * Only a trusted device payload may approve work. Public HTTP requests can
 * resolve completed rows, but never create rows or start ffmpeg.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { db } = require('../db/database');
const config = require('../config');

const CAPABILITY = 'playback.sssp3_fit_renditions';
const MAX_VARIANTS_PER_CONTENT = 12;
const MAX_CONCURRENT_RENDITIONS = 1;
const MAX_PENDING_RENDITIONS = 256;
const DEFAULT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const FILE_RE = /^ssf_([a-f0-9]{32})(\.(?:mp4|jpg|jpeg|png|webp))$/;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg']);

let running = new Map();
let jobs = new Set();
let activeWorkDirs = new Set();
let timer = null;
let started = false;
let testEncode = null;
let testCacheBytes = null;
let pushFn = null;

function evenPx(value) {
  const n = Math.floor(Number(value) || 0);
  return n >= 2 ? n - (n % 2) : 0;
}

function validGeometry(width, height) {
  return width >= 2 && height >= 2 && width <= 1920 && height <= 1920
    && width * height <= 1920 * 1080 && width % 2 === 0 && height % 2 === 0;
}

function vf(fit, width, height) {
  if (fit === 'fill') return `scale=${width}:${height}:force_original_aspect_ratio=disable,setsar=1,format=yuv420p`;
  if (fit === 'contain') return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p`;
}

function realRegularFile(file, root) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  let real;
  try { real = fs.realpathSync(file); } catch (_) { return null; }
  return real.startsWith(root + path.sep) ? real : null;
}

function outputExtension(sourceExt) {
  if (VIDEO_EXTENSIONS.has(sourceExt)) return '.mp4';
  if (sourceExt === '.svg') return '.png';
  return IMAGE_EXTENSIONS.has(sourceExt) ? sourceExt : null;
}

function rowId(contentId, sourceFile, sourceRevision, fit, width, height) {
  return crypto.createHash('sha256').update([contentId, sourceFile, sourceRevision, fit, width, height].join('\0')).digest('hex').slice(0, 32);
}

function supports(device) {
  try { return require('./player-capabilities').supports(device, CAPABILITY); } catch (_) { return false; }
}

function removeFile(name) {
  if (!name || !FILE_RE.test(path.basename(name))) return;
  try { fs.unlinkSync(path.join(config.contentDir, path.basename(name))); } catch (_) {}
}

function removeFor(contentId) {
  let rows = [];
  try { rows = db.prepare('SELECT filepath FROM sssp3_fit_renditions WHERE content_id = ?').all(contentId); } catch (_) { return; }
  for (const row of rows) removeFile(row.filepath);
  db.prepare('DELETE FROM sssp3_fit_renditions WHERE content_id = ?').run(contentId);
}

function approve(content, spec) {
  const sourceFile = path.basename(String(content.filepath || ''));
  const sourceRevision = Number(content.source_revision || content.updated_at || content.created_at || 0);
  const outputExt = outputExtension(path.extname(sourceFile).toLowerCase());
  if (!sourceFile || !outputExt || !validGeometry(spec.width, spec.height)) return null;
  if (!['contain', 'cover', 'fill'].includes(spec.fit)) return null;

  if (db.prepare('SELECT 1 FROM sssp3_fit_renditions WHERE content_id = ? AND (source_file != ? OR source_revision != ?) LIMIT 1').get(content.id, sourceFile, sourceRevision)) {
    removeFor(content.id);
  }
  const id = rowId(content.id, sourceFile, sourceRevision, spec.fit, spec.width, spec.height);
  let row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE id = ?').get(id);
  if (row) {
    db.prepare("UPDATE sssp3_fit_renditions SET last_used_at = strftime('%s','now') WHERE id = ?").run(id);
    // Eviction is terminal for this source revision. A frequently delivered
    // payload must fall back to the original media, never silently requeue
    // ffmpeg and rebuild the cache in a permanent eviction/requeue loop.
    return db.prepare('SELECT * FROM sssp3_fit_renditions WHERE id = ?').get(id);
  }
  const count = db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions WHERE content_id = ?').get(content.id).n;
  if (count >= MAX_VARIANTS_PER_CONTENT) return null;
  const pending = db.prepare("SELECT count(*) AS n FROM sssp3_fit_renditions WHERE status IN ('queued','running')").get().n;
  if (pending >= MAX_PENDING_RENDITIONS) return null;
  const filename = `ssf_${id}${outputExt}`;
  db.prepare(`INSERT INTO sssp3_fit_renditions
    (id,content_id,workspace_id,source_file,source_revision,fit,width,height,output_ext,status,filepath)
    VALUES (?,?,?,?,?,?,?,?,?,'queued',?)`)
    .run(id, content.id, content.workspace_id, sourceFile, sourceRevision, spec.fit, spec.width, spec.height, outputExt, filename);
  schedule(0);
  return db.prepare('SELECT * FROM sssp3_fit_renditions WHERE id = ?').get(id);
}

function stampItems(items, layout, device, { lazy = true } = {}) {
  if (!lazy || !supports(device) || !Array.isArray(items)) return items;
  const zones = Array.isArray(layout && layout.zones) ? layout.zones : [];
  const multiZone = zones.length >= 2;
  const byId = new Map(zones.filter(Boolean).map((zone) => [zone.id, zone]));
  const lookup = db.prepare('SELECT id,workspace_id,filepath,mime_type,updated_at,created_at FROM content WHERE id = ?');
  for (const item of items) {
    if (!item || !item.content_id || item.remote_url || item.widget_id) continue;
    const mime = String(item.mime_type || '').toLowerCase();
    const video = mime === 'video/mp4';
    const image = /^image\/(?:jpeg|png|webp|svg\+xml)$/.test(mime);
    if ((!video && !image) || (video && !multiZone)) continue;
    const content = lookup.get(item.content_id);
    if (!content || path.basename(content.filepath || '') !== path.basename(item.filepath || '')) continue;
    if (content.workspace_id !== (item.__origin_ws || device.workspace_id)) continue;
    const zone = byId.get(item.zone_id);
    if (video && !zone) continue;
    const width = zone ? evenPx(1920 * Number(zone.width_percent) / 100) : 1920;
    const height = zone ? evenPx(1080 * Number(zone.height_percent) / 100) : 1080;
    const requested = item.fit_mode || (zone && zone.fit_mode) || 'contain';
    const fit = ['contain', 'cover', 'fill'].includes(requested) ? requested : 'contain';
    const row = approve(content, { fit, width, height });
    if (!row) continue;
    item.fill_fit = fit;
    item.fill_width = width;
    item.fill_height = height;
    item.sssp3_rendition_state = row.status;
    if (row.status === 'ready') {
      item.sssp3_rendition_url = `/api/content/${encodeURIComponent(content.id)}/sssp3-fit/${row.id}?rev=${row.updated_at}`;
    }
  }
  return items;
}

function resolveReady(contentId, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  const row = db.prepare("SELECT * FROM sssp3_fit_renditions WHERE id = ? AND content_id = ? AND status = 'ready'").get(id, contentId);
  if (!row || !row.filepath || !FILE_RE.test(row.filepath)) return null;
  const current = db.prepare('SELECT filepath,updated_at,created_at FROM content WHERE id = ?').get(contentId);
  const revision = Number(current && (current.updated_at || current.created_at) || 0);
  if (!current || path.basename(current.filepath || '') !== row.source_file || revision !== row.source_revision) return null;
  let root;
  try { root = fs.realpathSync(config.contentDir); } catch (_) { return null; }
  const file = realRegularFile(path.join(root, row.filepath), root);
  if (!file) return null;
  try { return fs.statSync(file).size === row.file_size && row.file_size > 0 ? file : null; } catch (_) { return null; }
}

function ffmpegArgs(src, tmp, row) {
  const common = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', src];
  if (row.output_ext === '.mp4') return common.concat([
    '-an', '-vf', vf(row.fit, row.width, row.height), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-map_metadata', '-1',
    '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', tmp,
  ]);
  return common.concat(['-frames:v', '1', '-vf', vf(row.fit, row.width, row.height), tmp]);
}

function encode(job) {
  if (testEncode) return testEncode(job);
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ffmpegArgs(job.src, job.tmp, job.row), { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    let timedOut = false;
    child.stderr.on('data', (chunk) => { if (error.length < 4000) error += chunk; });
    const timeout = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, job.row.output_ext === '.mp4' ? 180000 : 30000);
    child.once('error', (err) => { clearTimeout(timeout); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(timedOut ? 'ffmpeg timed out' : (error.trim().split('\n').pop() || `ffmpeg exit ${code}`)));
    });
  });
}

function cacheLimit() {
  if (testCacheBytes != null) return testCacheBytes;
  const configured = Number(process.env.SSSP3_FIT_CACHE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CACHE_BYTES;
}

function makeRoom(bytes, protectedId) {
  let total = Number(db.prepare("SELECT coalesce(sum(file_size),0) AS n FROM sssp3_fit_renditions WHERE status = 'ready'").get().n || 0);
  if (bytes > cacheLimit()) return false;
  const rows = db.prepare("SELECT * FROM sssp3_fit_renditions WHERE status = 'ready' AND id != ? ORDER BY last_used_at ASC,created_at ASC").all(protectedId);
  for (const row of rows) {
    if (total + bytes <= cacheLimit()) break;
    removeFile(row.filepath);
    db.prepare("UPDATE sssp3_fit_renditions SET status = 'evicted',filepath = NULL,file_size = NULL,updated_at = strftime('%s','now') WHERE id = ?").run(row.id);
    total -= Number(row.file_size || 0);
  }
  return total + bytes <= cacheLimit();
}

async function processRow(row) {
  let root;
  try { root = fs.realpathSync(config.contentDir); } catch (_) { throw new Error('content directory unavailable'); }
  const src = realRegularFile(path.join(root, row.source_file), root);
  if (!src) throw new Error('source media is missing or unsafe');
  const workDir = fs.mkdtempSync(path.join(root, '.sssp3-fit-'));
  activeWorkDirs.add(workDir);
  const tmp = path.join(workDir, 'rendition' + row.output_ext);
  try {
    await encode({ row, src, tmp });
    const rendered = realRegularFile(tmp, fs.realpathSync(workDir));
    if (!rendered) throw new Error('renderer produced no regular file');
    const size = fs.statSync(rendered).size;
    if (size < 1) throw new Error('renderer produced an empty file');
    if (!makeRoom(size, row.id)) throw new Error('SSSP3 rendition cache quota exceeded');
    const destination = path.join(root, `ssf_${row.id}${row.output_ext}`);
    fs.renameSync(rendered, destination);
    const committed = db.prepare("UPDATE sssp3_fit_renditions SET status = 'ready',filepath = ?,file_size = ?,error = NULL,updated_at = strftime('%s','now') WHERE id = ? AND status = 'running' AND source_file = ?")
      .run(path.basename(destination), size, row.id, row.source_file);
    if (!committed.changes) removeFile(path.basename(destination));
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    activeWorkDirs.delete(workDir);
  }
}

async function tick() {
  const room = MAX_CONCURRENT_RENDITIONS - running.size;
  if (room <= 0) return;
  const rows = db.prepare("SELECT * FROM sssp3_fit_renditions WHERE status = 'queued' ORDER BY last_used_at DESC,created_at ASC LIMIT ?").all(room);
  for (const row of rows) {
    db.prepare("UPDATE sssp3_fit_renditions SET status = 'running',attempts = attempts + 1,updated_at = strftime('%s','now') WHERE id = ? AND status = 'queued'").run(row.id);
    const job = processRow(row).catch((error) => {
      db.prepare("UPDATE sssp3_fit_renditions SET status = 'failed',filepath = NULL,file_size = NULL,error = ?,updated_at = strftime('%s','now') WHERE id = ?")
        .run(String(error && error.message || error).slice(0, 500), row.id);
    }).finally(() => {
      running.delete(row.id);
      jobs.delete(job);
      if (pushFn) {
        try { pushFn(require('./devices-playing').devicesPlayingContent(row.content_id)); } catch (_) {}
      }
      schedule(0);
    });
    running.set(row.id, job);
    jobs.add(job);
  }
}

function schedule(delay) {
  if (!started || timer) return;
  timer = setTimeout(() => { timer = null; tick().catch((error) => console.warn(`[sssp3-fit] ${error.message}`)); }, delay);
  if (timer.unref) timer.unref();
}

function sweepOrphans() {
  try { db.prepare('DELETE FROM sssp3_fit_renditions WHERE content_id NOT IN (SELECT id FROM content)').run(); } catch (_) {}
  let entries = [];
  try { entries = fs.readdirSync(config.contentDir); } catch (_) { return 0; }
  const files = entries.filter((name) => FILE_RE.test(name));
  const known = new Set(db.prepare('SELECT filepath FROM sssp3_fit_renditions WHERE filepath IS NOT NULL').all().map((row) => row.filepath));
  let removed = 0;
  for (const file of files) if (!known.has(file)) { try { fs.unlinkSync(path.join(config.contentDir, file)); removed++; } catch (_) {} }
  // A killed server cannot run processRow's finally block. Reclaim only our
  // private work directories, and never touch one owned by a live encoder.
  for (const name of entries) {
    if (!name.startsWith('.sssp3-fit-')) continue;
    const dir = path.join(config.contentDir, name);
    if (activeWorkDirs.has(dir)) continue;
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (_) {}
  }
  return removed;
}

function start({ push = null } = {}) {
  if (started) return;
  started = true;
  pushFn = push;
  db.prepare("UPDATE sssp3_fit_renditions SET status = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END,error = CASE WHEN attempts < 2 THEN NULL ELSE 'interrupted repeatedly' END WHERE status = 'running'").run();
  sweepOrphans();
  schedule(0);
  const interval = setInterval(() => { sweepOrphans(); schedule(0); }, 6 * 60 * 60 * 1000);
  if (interval.unref) interval.unref();
}

function stats() {
  return { running: running.size, queued: Number(db.prepare("SELECT count(*) AS n FROM sssp3_fit_renditions WHERE status = 'queued'").get().n || 0) };
}

async function drain() { await Promise.all([...jobs]); }

function resetForTest(options = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  running = new Map();
  jobs = new Set();
  activeWorkDirs = new Set();
  testEncode = options.encodeFn || null;
  testCacheBytes = options.cacheBytes == null ? null : options.cacheBytes;
  pushFn = null;
}

module.exports = {
  CAPABILITY, MAX_VARIANTS_PER_CONTENT, MAX_CONCURRENT_RENDITIONS, MAX_PENDING_RENDITIONS, FILE_RE,
  vf, stampItems, resolveReady, removeFor, sweepOrphans, start, tick, stats,
  _drain: drain, _resetForTest: resetForTest,
};
