'use strict';

/*
 * 3.0: TV-safe copies of tall videos (docs/tv-safe-video.md).
 *
 * WHY. A Samsung Tizen signage TV decodes video on a hardware decoder sized for 1920x1080. A
 * portrait clip encoded 1080x1920 is taller than that decoder will open, so on a landscape-mounted
 * TV the HTML5 <video> shows black, and on a portrait-mounted one AVPlay fails to prepare it. No
 * player-side trick fixes a stream the decoder refuses, so the server makes a copy the decoder
 * accepts, and the player picks the one that matches how the screen is mounted:
 *
 *   rot_cw   the video turned 90° clockwise into a landscape frame (transpose=1). A screen set to
 *            'portrait' rotates its content 90° clockwise inside the panel (tizen/js/app.js
 *            orientEl, the same convention as lib/wall-geometry.js), so this copy is already the
 *            picture that panel shows, and it plays with NO rotation at all.
 *   rot_ccw  the same for 'portrait-flipped' (270° clockwise = 90° counter-clockwise, transpose=2).
 *   fit      the video scaled to fit inside 1920x1080, upright, for a landscape-mounted screen. Not
 *            padded: the item's own fit setting (cover / contain / fill) still decides cropping,
 *            exactly as it does for a portrait photo.
 *
 * CPU IS THE COST, SO EVERY COPY HAS TO BE NEEDED (the operator's rule, and the shape of this file):
 *   - only tall videos (height > width after the display matrix), never one marked pre-rotated;
 *   - only for a screen whose player declares playback.video_variants (Tizen today; another player
 *     opts in by declaring it), and only the ONE kind that screen's orientation calls for — a
 *     workspace with no such screen never encodes a frame;
 *   - lazily: when such a screen is sent content that lacks its copy (ws/deviceSocket.js), plus at
 *     upload when the workspace already has such a screen;
 *   - gently: one job at a time (configurable), `nice -n 19`, `-threads 2`, x264 `veryfast`,
 *     paused while the host is busy (CPU over the threshold for the last minute), optionally only
 *     inside an "HH-HH" window, and on a hosted instance within a per-organization monthly allowance
 *     of encoded source minutes. A hardware H.264 encoder is used when one is found AND passes a
 *     one-frame test encode; any failure falls back to libx264.
 *
 * THE QUEUE IS THE TABLE. A copy is a content_video_variants row: queued -> running -> ready |
 * failed | denied. A restart turns 'running' back into 'queued', so nothing is lost or doubled, and
 * the dashboard reads the same rows to say "preparing / ready / failed".
 *
 * Files are local to this server (contentDir, `stv_<content>_<kind>_<random>.mp4`), served by
 * GET /api/content/:id/variant/:kind with the same player gate as the original. They are not
 * counted in the storage allowance, exactly like thumbnails (getUserStorageMB sums content.file_size
 * only), are never exported (a cache — the new server makes its own), and are removed with their
 * row; an orphan sweep catches every delete path that does not know about them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { db } = require('../db/database');
const config = require('../config');

const KINDS = ['rot_cw', 'rot_ccw', 'fit'];
const FILTER = { rot_cw: 'transpose=1,', rot_ccw: 'transpose=2,', fit: '' };
const FILE_RE = /^stv_[A-Za-z0-9-]+_(rot_cw|rot_ccw|fit)_[a-f0-9]{8}\.mp4$/;
const CAPABILITY = 'playback.video_variants';

// Stream types that are never a file this server holds bytes for.
const LIVE_MIMES = new Set(['video/youtube', 'video/hls', 'video/rtsp', 'video/hdmi-in']);

/** Which copy a screen mounted this way plays. */
function kindForOrientation(o) {
  if (o === 'portrait') return 'rot_cw';
  if (o === 'portrait-flipped') return 'rot_ccw';
  return 'fit';
}

/** A video whose own bytes are taller than they are wide (display dimensions, #170). */
function isTallVideo(row) {
  if (!row || !row.filepath || row.remote_url) return false;
  const mime = String(row.mime_type || '');
  if (!mime.startsWith('video/') || LIVE_MIMES.has(mime)) return false;
  if (Number(row.video_prerotated) === 1) return false;
  const w = Number(row.width), h = Number(row.height);
  return w > 0 && h > 0 && h > w;
}

/** The kind this device needs, or null when its player does not use copies. */
function kindForDevice(device) {
  if (!device) return null;
  let supports = false;
  try { supports = require('./player-capabilities').supports(device, CAPABILITY); } catch (_) { supports = false; }
  if (!supports) return null;
  // A wall member plays landscape whatever its own orientation says (the wall geometry owns the turn,
  // and tizen/js/app.js sets the player landscape on a wall), so it needs the upright copy.
  return device.wall_id ? 'fit' : kindForOrientation(device.orientation);
}

/** Every kind the screens of one workspace would play. Empty = encode nothing. */
function workspaceNeeds(workspaceId) {
  const kinds = new Set();
  if (!workspaceId) return kinds;
  let rows = [];
  try {
    rows = db.prepare(`SELECT orientation, wall_id, capabilities, platform, client_type, android_version
                         FROM devices WHERE workspace_id = ? AND capabilities LIKE ?`).all(workspaceId, `%${CAPABILITY}%`);
  } catch (_) { return kinds; }
  for (const d of rows) { const k = kindForDevice(d); if (k) kinds.add(k); }
  return kinds;
}

// ---------------------------------------------------------------- settings

/*
 * Platform settings (Platform → System), each with an environment default for a self-hoster who
 * configures by env. A persisted value wins once an admin has saved one.
 */
function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : dflt;
}
function envDefaults() {
  return {
    enabled: process.env.VIDEO_VARIANTS_ENABLED === undefined ? true : !/^(0|false|no|off)$/i.test(process.env.VIDEO_VARIANTS_ENABLED),
    window: String(process.env.VIDEO_VARIANTS_WINDOW || ''),
    concurrency: intEnv('VIDEO_VARIANTS_CONCURRENCY', 1),
    max_cpu: intEnv('VIDEO_VARIANTS_MAX_CPU', 70),
    // Hosted gets an allowance by default; a self-hoster's own CPU is theirs (0 = no cap).
    org_monthly_minutes: intEnv('VIDEO_VARIANTS_ORG_MONTHLY_MINUTES', config.selfHosted ? 0 : 600),
    hwaccel: String(process.env.VIDEO_VARIANTS_HWACCEL || 'auto').toLowerCase(),
  };
}

/** "22-6" -> {start:22,end:6}; "" -> null (any time). Invalid -> false. */
function parseWindow(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return null;
  const m = /^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/.exec(v);
  if (!m) return false;
  const start = Number(m[1]), end = Number(m[2]);
  if (start > 23 || end > 24) return false;
  return { start, end: end % 24 };
}

/** Whether `date` (server local time) is inside the window. start == end means all day. */
function inWindow(win, date) {
  if (!win) return true;
  const h = date.getHours();
  if (win.start === win.end) return true;
  return win.start < win.end ? (h >= win.start && h < win.end) : (h >= win.start || h < win.end);
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

function getSettings() {
  const env = envDefaults();
  const app = require('./app-settings');
  const win = app.get('video_variants_window', env.window);
  return {
    enabled: app.getBool('video_variants_enabled', env.enabled),
    window: parseWindow(win) === false ? '' : String(win || ''),
    concurrency: clampInt(app.get('video_variants_concurrency', env.concurrency), 1, 4, 1),
    max_cpu: clampInt(app.get('video_variants_max_cpu', env.max_cpu), 10, 100, 70),
    org_monthly_minutes: clampInt(app.get('video_variants_org_monthly_minutes', env.org_monthly_minutes), 0, 1e6, 0),
    hwaccel: env.hwaccel,
  };
}

/** Validate + persist a partial settings object. Returns {settings} or {error}. */
function saveSettings(input) {
  const app = require('./app-settings');
  const b = input || {};
  if (b.window !== undefined && parseWindow(b.window) === false) return { error: 'Time window must look like 22-6 (hours, 0-23), or be empty for any time.' };
  if (b.enabled !== undefined) app.setBool('video_variants_enabled', !!b.enabled);
  if (b.window !== undefined) app.set('video_variants_window', String(b.window || '').trim());
  if (b.concurrency !== undefined) app.set('video_variants_concurrency', clampInt(b.concurrency, 1, 4, 1));
  if (b.max_cpu !== undefined) app.set('video_variants_max_cpu', clampInt(b.max_cpu, 10, 100, 70));
  if (b.org_monthly_minutes !== undefined) app.set('video_variants_org_monthly_minutes', clampInt(b.org_monthly_minutes, 0, 1e6, 0));
  schedule(0);
  return { settings: getSettings() };
}

// ---------------------------------------------------------------- monthly allowance

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function orgOf(workspaceId) {
  try { const w = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId); return (w && w.organization_id) || null; }
  catch (_) { return null; }
}
function usedSeconds(orgId, month) {
  try { const r = db.prepare('SELECT seconds FROM video_variant_usage WHERE organization_id = ? AND month = ?').get(orgId, month); return r ? r.seconds : 0; }
  catch (_) { return 0; }
}
function addUsage(orgId, month, seconds) {
  if (!orgId || !(seconds > 0)) return;
  db.prepare(`INSERT INTO video_variant_usage (organization_id, month, seconds) VALUES (?, ?, ?)
              ON CONFLICT(organization_id, month) DO UPDATE SET seconds = seconds + excluded.seconds`).run(orgId, month, seconds);
}
/** True when this organization may encode `seconds` more this month. */
function withinAllowance(workspaceId, seconds, settings, date) {
  const cap = settings.org_monthly_minutes;
  if (!(cap > 0)) return true;
  const org = orgOf(workspaceId) || `ws:${workspaceId || ''}`;
  return usedSeconds(org, monthKey(date)) + Math.max(0, Number(seconds) || 0) <= cap * 60;
}

// ---------------------------------------------------------------- the queue rows

const rowsOf = (contentId) => db.prepare('SELECT * FROM content_video_variants WHERE content_id = ?').all(contentId);

function removeFile(name) {
  if (!name || !FILE_RE.test(path.basename(name))) return;
  try { fs.unlinkSync(path.join(config.contentDir, path.basename(name))); } catch (_) { /* already gone */ }
}

/*
 * Make sure `kind` exists or is on its way for this content row. Cheap when it already is (one
 * indexed read), so the payload path may call it for every tall item it sends. Returns the row's
 * state after the call: 'ready' | 'queued' | 'running' | 'failed' | 'denied' | null (not eligible).
 */
function ensure(content, kind, { now = new Date() } = {}) {
  if (!isTallVideo(content) || !KINDS.includes(kind)) return null;
  const source = path.basename(content.filepath);
  const cur = db.prepare('SELECT * FROM content_video_variants WHERE content_id = ? AND kind = ?').get(content.id, kind);
  if (cur && cur.source_file === source) {
    // A copy refused for the allowance gets another chance in a new month; a failed encode does not
    // retry itself (it would fail again, at full CPU, forever) — the dashboard's Retry does that.
    if (cur.status === 'denied' && monthKey(new Date(cur.updated_at * 1000)) !== monthKey(now)) {
      db.prepare("UPDATE content_video_variants SET status = 'queued', error = NULL, updated_at = strftime('%s','now') WHERE content_id = ? AND kind = ? AND status = 'denied'").run(content.id, kind);
      schedule(0);
      return 'queued';
    }
    return cur.status;
  }
  // Absent, or made from bytes this row no longer has: (re)queue, and drop the stale copy.
  if (cur && cur.filepath) removeFile(cur.filepath);
  db.prepare(`INSERT INTO content_video_variants (content_id, kind, workspace_id, source_file, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'queued', strftime('%s','now'), strftime('%s','now'))
              ON CONFLICT(content_id, kind) DO UPDATE SET source_file = excluded.source_file, workspace_id = excluded.workspace_id,
                status = 'queued', filepath = NULL, file_size = NULL, width = NULL, height = NULL, error = NULL,
                attempts = 0, encoder = NULL, encode_ms = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at`)
    .run(content.id, kind, content.workspace_id || null, source);
  schedule(0);
  return 'queued';
}

/** At upload: queue whatever the workspace's screens already need. */
function onContentIngested(content) {
  try {
    if (!isTallVideo(content)) return;
    for (const k of workspaceNeeds(content.workspace_id)) ensure(content, k);
  } catch (e) { console.warn(`[video-variants] ingest queue failed: ${e.message}`); }
}

/** Retry a content row's failed/denied copies (dashboard button). Returns how many were re-queued. */
function retry(contentId) {
  const r = db.prepare("UPDATE content_video_variants SET status = 'queued', error = NULL, attempts = 0, updated_at = strftime('%s','now') WHERE content_id = ? AND status IN ('failed','denied')").run(contentId);
  if (r.changes) schedule(0);
  return r.changes;
}

/** Delete one content row's copies (files and rows). */
function removeFor(contentId) {
  for (const r of rowsOf(contentId)) removeFile(r.filepath);
  db.prepare('DELETE FROM content_video_variants WHERE content_id = ?').run(contentId);
}

/*
 * Rows and files whose content is gone. Content can leave by many doors (library delete, workspace and
 * account deletion, retention sweeps, mesh purges); the row usually goes with a trigger, and this
 * catches whatever it missed, then the file.
 */
function sweepOrphans() {
  let removed = 0;
  // Rows first. The delete trigger covers most paths, but a one-time table rebuild (the tenant
  // cascade migration rebuilds content) drops triggers until the next boot recreates them.
  try { db.prepare('DELETE FROM content_video_variants WHERE content_id NOT IN (SELECT id FROM content)').run(); } catch (_) { /* */ }
  let names = [];
  try { names = fs.readdirSync(config.contentDir).filter((n) => FILE_RE.test(n) || /^stv_.*\.part\.mp4$/.test(n)); } catch (_) { return 0; }
  if (!names.length) return 0;
  const known = new Set(db.prepare('SELECT filepath FROM content_video_variants WHERE filepath IS NOT NULL').all().map((r) => r.filepath));
  const busy = new Set([...running.values()].map((j) => path.basename(j.tmp)));
  for (const n of names) {
    if (known.has(n) || busy.has(n)) continue;
    try { fs.unlinkSync(path.join(config.contentDir, n)); removed++; } catch (_) { /* best effort */ }
  }
  return removed;
}

/*
 * What the payload gives a player, for one content row and the device's needed kind. Ready copies
 * are listed by kind with their revision (the player builds /api/content/:id/variant/:kind?rev=…);
 * `state` explains a missing one so the player can say something true.
 */
function variantsForPayload(contentId, neededKind) {
  const out = { variants: null, state: null, reason: null };
  let rows = [];
  try { rows = rowsOf(contentId); } catch (_) { return out; }
  for (const r of rows) {
    if (r.status === 'ready' && r.filepath) {
      out.variants = out.variants || {};
      out.variants[r.kind] = r.updated_at;
    }
  }
  if (neededKind && !(out.variants && out.variants[neededKind])) {
    const r = rows.find((x) => x.kind === neededKind);
    if (r && (r.status === 'queued' || r.status === 'running')) {
      const s = getSettings();
      if (!s.enabled) { out.state = 'unavailable'; out.reason = 'disabled'; }
      else if (tools && tools.ffmpeg === false) { out.state = 'unavailable'; out.reason = 'no_ffmpeg'; }
      else out.state = 'preparing';
    } else if (r) {
      out.state = 'unavailable';
      out.reason = r.status === 'denied' ? 'allowance' : 'failed';
    } else if (!getSettings().enabled) {
      out.state = 'unavailable';
      out.reason = 'disabled';
    }
  }
  return out;
}

// ---------------------------------------------------------------- the worker

const running = new Map();   // `${content_id}:${kind}` -> { contentId, kind, startedAt, filename, tmp }
const jobs = new Set();       // in-flight job promises (tests await them)
let timer = null;
let timerAt = 0;
let deferred = null;          // why the queue is waiting: 'window' | 'cpu' | 'disabled' | 'no_ffmpeg' | null
let cpuBase = null;           // { idle, total, at } — taken when nothing of ours is encoding
let tools = null;             // { ffmpeg: bool } from lib/media-tools, cached once known
let encoderPick = null;       // { name, pre, post, args } once probed
let niceOk = null;
let started = false;
let pushFn = null;            // (deviceIds) -> void, set by start(io)
let lastDone = null;          // { content_id, kind, status, at }

// Test seams.
let clock = () => new Date();
let readCpu = () => require('./host-stats').cpuTimes();
let runEncode = null;          // replaced in tests: async (job) -> { width, height, encoder }
const CPU_WINDOW_MS = 60 * 1000;

function schedule(ms) {
  if (!started) return;
  const at = Date.now() + ms;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => { timer = null; tick().catch((e) => console.warn(`[video-variants] ${e.message}`)); }, ms);
  if (timer.unref) timer.unref();
}

/** The CPU gate. True = go; a number = wait that many ms and look again. */
function cpuGate(settings) {
  const now = readCpu();
  if (!cpuBase || now.at - cpuBase.at > 10 * CPU_WINDOW_MS) { cpuBase = now; return CPU_WINDOW_MS; }
  const age = now.at - cpuBase.at;
  if (age < CPU_WINDOW_MS) return CPU_WINDOW_MS - age;
  const pct = require('./host-stats').pctBetween(cpuBase, now);
  cpuBase = now;
  if (pct != null && pct > settings.max_cpu) return CPU_WINDOW_MS;
  return true;
}

async function tick() {
  const s = getSettings();
  if (!s.enabled) { deferred = 'disabled'; return; }
  if (running.size >= s.concurrency) return;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM content_video_variants v JOIN content c ON c.id = v.content_id WHERE v.status = 'queued'").get().n;
  if (!pending) { deferred = null; cpuBase = null; return; }
  if (!inWindow(parseWindow(s.window) || null, clock())) { deferred = 'window'; schedule(5 * 60 * 1000); return; }
  if (!tools || tools.ffmpeg !== true) {
    const t = runEncode ? { ffmpeg: true } : await require('./media-tools').mediaToolStatus();
    if (t.conclusive !== false || t.ffmpeg) tools = { ffmpeg: !!t.ffmpeg };
    if (!t.ffmpeg) { deferred = 'no_ffmpeg'; schedule(10 * 60 * 1000); return; }
  }
  const gate = cpuGate(s);
  if (gate !== true) { deferred = 'cpu'; schedule(gate); return; }
  deferred = null;

  const busyKeys = [...running.keys()];
  const job = db.prepare("SELECT v.*, c.filepath AS c_filepath, c.mime_type, c.width AS c_width, c.height AS c_height, c.duration_sec, c.remote_url, c.video_prerotated, c.id AS c_id, c.workspace_id AS c_ws, c.storage_profile_id FROM content_video_variants v JOIN content c ON c.id = v.content_id WHERE v.status = 'queued' ORDER BY v.created_at, v.content_id LIMIT 20").all()
    .find((r) => !busyKeys.includes(`${r.content_id}:${r.kind}`));
  if (!job) return;
  const content = { id: job.c_id, filepath: job.c_filepath, mime_type: job.mime_type, width: job.c_width, height: job.c_height, remote_url: job.remote_url, video_prerotated: job.video_prerotated, workspace_id: job.c_ws, duration_sec: job.duration_sec, storage_profile_id: job.storage_profile_id };
  if (!isTallVideo(content) || path.basename(content.filepath) !== job.source_file) {
    // The row changed under the queue (replaced, marked pre-rotated): this job describes nothing.
    db.prepare('DELETE FROM content_video_variants WHERE content_id = ? AND kind = ? AND status = ?').run(job.content_id, job.kind, 'queued');
    schedule(0);
    return;
  }
  const at = clock();
  if (!withinAllowance(content.workspace_id, content.duration_sec, s, at)) {
    // Stamped with the clock that judged the allowance, not SQLite's: ensure() compares this stamp's
    // MONTH with its own clock to decide whether the copy gets another chance, so the two must agree.
    // With strftime('now') a test clock in one month against a wall clock in the next re-queued the
    // copy at once (it failed every day from 2026-11-01).
    db.prepare("UPDATE content_video_variants SET status = 'denied', error = 'monthly allowance reached', updated_at = ? WHERE content_id = ? AND kind = ?").run(Math.floor(at.getTime() / 1000), job.content_id, job.kind);
    pushFor(content);
    schedule(0);
    return;
  }
  db.prepare("UPDATE content_video_variants SET status = 'running', attempts = attempts + 1, updated_at = strftime('%s','now') WHERE content_id = ? AND kind = ?").run(job.content_id, job.kind);
  const filename = `stv_${content.id}_${job.kind}_${crypto.randomBytes(4).toString('hex')}.mp4`;
  const entry = { contentId: content.id, kind: job.kind, startedAt: Date.now(), filename, tmp: path.join(config.contentDir, filename.replace(/\.mp4$/, '.part.mp4')), sourceFile: job.source_file };
  running.set(`${content.id}:${job.kind}`, entry);
  cpuBase = null;
  // Another slot may be free (concurrency > 1); it still has to pass the CPU gate on its own.
  schedule(1000);
  const p = runJob(entry, content).finally(() => {
    running.delete(`${content.id}:${job.kind}`);
    jobs.delete(p);
    cpuBase = null;
    schedule(0);
  });
  jobs.add(p);
}

async function runJob(entry, content) {
  const t0 = Date.now();
  let result = null, error = null;
  try {
    const src = await sourcePath(content);
    if (!src) throw new Error('the original file is not on this server');
    fs.mkdirSync(config.contentDir, { recursive: true });
    result = await (runEncode || encodeWithFfmpeg)({ src, out: entry.tmp, kind: entry.kind, durationSec: Number(content.duration_sec) || 0 });
    fs.renameSync(entry.tmp, path.join(config.contentDir, entry.filename));
  } catch (e) {
    error = e;
    try { fs.unlinkSync(entry.tmp); } catch (_) { /* never written */ }
  }
  const ms = Date.now() - t0;
  if (error) {
    db.prepare("UPDATE content_video_variants SET status = 'failed', error = ?, encode_ms = ?, updated_at = strftime('%s','now') WHERE content_id = ? AND kind = ? AND status = 'running'")
      .run(String(error.message || error).slice(0, 300), ms, entry.contentId, entry.kind);
    console.warn(`[video-variants] ${entry.kind} copy of ${entry.contentId} failed: ${error.message || error}`);
    lastDone = { content_id: entry.contentId, kind: entry.kind, status: 'failed', at: Date.now() };
    pushFor(content);
    return;
  }
  let size = null;
  try { size = fs.statSync(path.join(config.contentDir, entry.filename)).size; } catch (_) { /* */ }
  // Only if the row still wants THIS copy: a replace or delete during the encode leaves nothing.
  const r = db.prepare(`UPDATE content_video_variants SET status = 'ready', filepath = ?, file_size = ?, width = ?, height = ?,
                          encoder = ?, encode_ms = ?, error = NULL, updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
                        WHERE content_id = ? AND kind = ? AND status = 'running' AND source_file = ?`)
    .run(entry.filename, size, result && result.width || null, result && result.height || null, result && result.encoder || null, ms, entry.contentId, entry.kind, entry.sourceFile);
  if (!r.changes) { removeFile(entry.filename); return; }
  try { addUsage(orgOf(content.workspace_id) || `ws:${content.workspace_id || ''}`, monthKey(clock()), Number(content.duration_sec) || 0); } catch (_) { /* accounting must not lose the copy */ }
  lastDone = { content_id: entry.contentId, kind: entry.kind, status: 'ready', at: Date.now() };
  pushFor(content);
}

/** A local path to the original, fetching it from the workspace's storage backend if needed. */
async function sourcePath(content) {
  const local = path.join(config.contentDir, path.basename(content.filepath));
  if (fs.existsSync(local)) return local;
  try {
    const full = db.prepare('SELECT * FROM content WHERE id = ?').get(content.id);
    return full ? await require('./storage/locations').ensureLocalFile(full, 'asset') : null;
  } catch (_) { return null; }
}

/** Screens playing this content get a fresh payload: the copy (or the honest note) arrives now. */
function pushFor(content) {
  if (!pushFn) return;
  try { pushFn(require('./devices-playing').devicesPlayingContent(content.id)); } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------- ffmpeg

function scaleFilter(kind) {
  // Fit inside 1920x1080 without upscaling, even dimensions (yuv420p), no padding.
  return `${FILTER[kind]}scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

/** The ffmpeg argument list for one copy (exported for tests). */
function ffmpegArgs({ src, out, kind, encoder }) {
  const enc = encoder || SOFTWARE;
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-threads', '2',
    ...(enc.pre || []),
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-filter_threads', '1',
    '-vf', scaleFilter(kind) + (enc.post || ',format=yuv420p'),
    ...enc.args,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    // No rotation metadata may survive: the copy IS the turned picture.
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
    '-movflags', '+faststart',
    out,
  ];
}

const SOFTWARE = { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-maxrate', '8M', '-bufsize', '16M', '-threads', '2'] };
const HARDWARE = {
  vaapi: { name: 'h264_vaapi', pre: ['-vaapi_device', '/dev/dri/renderD128'], post: ',format=nv12,hwupload', args: ['-c:v', 'h264_vaapi', '-qp', '23', '-profile:v', 'high'] },
  qsv: { name: 'h264_qsv', post: ',format=nv12', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-profile:v', 'high'] },
  nvenc: { name: 'h264_nvenc', post: ',format=yuv420p', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-profile:v', 'high'] },
};

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let cmd = bin, argv = args;
    if (niceOk && bin === 'ffmpeg') { cmd = 'nice'; argv = ['-n', '19', bin, ...args]; }
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code, sig) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(sig ? `ffmpeg stopped (${sig === 'SIGKILL' ? 'took too long' : sig})` : (err.trim().split('\n').pop() || `ffmpeg exit ${code}`)));
    });
  });
}

function checkNice() {
  if (niceOk !== null) return Promise.resolve(niceOk);
  if (process.platform === 'win32') { niceOk = false; return Promise.resolve(false); }
  return new Promise((resolve) => execFile('nice', ['-n', '19', 'true'], { timeout: 5000 }, (e) => { niceOk = !e; resolve(niceOk); }));
}

/*
 * A hardware encoder, if this host has one that actually works. Listed is not enough (a VAAPI
 * build on a box with no GPU lists h264_vaapi happily), so each candidate must turn one test frame
 * into H.264. VIDEO_VARIANTS_HWACCEL=off skips the probe; =vaapi|qsv|nvenc tries only that one.
 */
async function pickEncoder(pref) {
  if (encoderPick) return encoderPick;
  if (pref === 'off' || pref === 'none' || pref === 'software') { encoderPick = SOFTWARE; return encoderPick; }
  const listed = await new Promise((resolve) => execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 15000 }, (e, out) => resolve(e ? '' : String(out))));
  const order = HARDWARE[pref] ? [pref] : ['nvenc', 'qsv', 'vaapi'];
  for (const k of order) {
    const enc = HARDWARE[k];
    if (!listed.includes(enc.name)) continue;
    if (k === 'vaapi' && !fs.existsSync('/dev/dri/renderD128')) continue;
    const ok = await new Promise((resolve) => execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', ...(enc.pre || []),
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1',
      '-vf', 'format=yuv420p' + (enc.post || ''), ...enc.args, '-f', 'null', '-',
    ], { timeout: 20000 }, (e) => resolve(!e)));
    if (ok) { encoderPick = enc; console.log(`[video-variants] using hardware encoder ${enc.name}`); return enc; }
  }
  encoderPick = SOFTWARE;
  return encoderPick;
}

function probeDims(file) {
  return new Promise((resolve) => execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', file], { timeout: 15000 }, (e, out) => {
    if (e) return resolve({ width: null, height: null });
    try { const s = (JSON.parse(out).streams || [])[0] || {}; resolve({ width: s.width || null, height: s.height || null }); }
    catch (_) { resolve({ width: null, height: null }); }
  }));
}

async function encodeWithFfmpeg({ src, out, kind, durationSec }) {
  await checkNice();
  // Generous: veryfast on two threads at nice 19 on a busy box is still faster than real time for
  // 1080p, but a stalled one must not hold the only slot forever.
  const timeoutMs = Math.min(3 * 3600e3, Math.max(10 * 60e3, (durationSec || 60) * 6000));
  let enc = await pickEncoder(getSettings().hwaccel);
  try {
    await run('ffmpeg', ffmpegArgs({ src, out, kind, encoder: enc }), timeoutMs);
  } catch (e) {
    if (enc === SOFTWARE) throw e;
    // The hardware encoder passed its test frame but not this file: software, and stay there.
    console.warn(`[video-variants] ${enc.name} failed (${e.message}); using libx264 from now on`);
    encoderPick = SOFTWARE;
    enc = SOFTWARE;
    await run('ffmpeg', ffmpegArgs({ src, out, kind, encoder: enc }), timeoutMs);
  }
  const dims = await probeDims(out);
  return { ...dims, encoder: enc.name };
}

// ---------------------------------------------------------------- lifecycle + status

/** Boot: resume interrupted jobs, sweep orphans, start pumping. `push(deviceIds)` re-sends payloads. */
function start({ push = null } = {}) {
  started = true;
  pushFn = push;
  try { db.prepare("UPDATE content_video_variants SET status = 'queued' WHERE status = 'running'").run(); } catch (_) { /* table missing on a partial schema */ }
  try { sweepOrphans(); } catch (_) { /* */ }
  const t = setInterval(() => { try { sweepOrphans(); } catch (_) {} }, 6 * 3600e3);
  if (t.unref) t.unref();
  schedule(30 * 1000);
}

/** For Platform → Overview: queue length, the current job(s), and why it is waiting if it is. */
function stats() {
  const n = (status) => { try { return db.prepare('SELECT COUNT(*) AS n FROM content_video_variants v JOIN content c ON c.id = v.content_id WHERE v.status = ?').get(status).n; } catch (_) { return 0; } };
  const s = getSettings();
  return {
    enabled: s.enabled,
    queued: n('queued'),
    failed: n('failed'),
    denied: n('denied'),
    ready: n('ready'),
    running: [...running.values()].map((j) => {
      let name = null;
      try { const c = db.prepare('SELECT filename FROM content WHERE id = ?').get(j.contentId); name = c && c.filename; } catch (_) {}
      return { content_id: j.contentId, filename: name, kind: j.kind, seconds: Math.round((Date.now() - j.startedAt) / 1000) };
    }),
    waiting: deferred,
    encoder: encoderPick ? encoderPick.name : null,
    last: lastDone,
  };
}

/** One content row's copies, for the content details dialog. */
function describe(content) {
  const tall = isTallVideo(content);
  const rows = rowsOf(content.id).filter((r) => r.source_file === path.basename(content.filepath || ''));
  return {
    tall,
    prerotated: Number(content.video_prerotated) === 1,
    needs: tall ? [...workspaceNeeds(content.workspace_id)] : [],
    copies: rows.map((r) => ({ kind: r.kind, status: r.status, error: r.error, file_size: r.file_size, width: r.width, height: r.height, updated_at: r.updated_at })),
  };
}

/*
 * The payload half (ws/deviceSocket.js, at send time, beside the file-URL stamping). For every
 * uploaded video item: the copies that are ready, by kind; and for a screen that uses copies, a
 * tall item whose copy is missing is queued now (lazy) and marked so the player can say "preparing"
 * instead of showing black. `lazy: false` (the dashboard's "what will this screen show" forecast)
 * reads without queueing anything.
 */
function stampItems(items, device, { lazy = true } = {}) {
  if (!Array.isArray(items) || !items.length) return;
  const needed = kindForDevice(device);
  let stmt = null;
  for (const a of items) {
    if (!a || !a.content_id || !String(a.mime_type || '').startsWith('video/')) continue;
    try {
      stmt = stmt || db.prepare('SELECT id, filepath, mime_type, width, height, remote_url, video_prerotated, workspace_id FROM content WHERE id = ?');
      const c = stmt.get(a.content_id);
      delete a.video_variants; delete a.video_variant_state; delete a.video_variant_reason;
      if (!c || !isTallVideo(c)) continue;
      if (needed && lazy && getSettings().enabled) ensure(c, needed);
      const v = variantsForPayload(c.id, needed);
      if (v.variants) a.video_variants = v.variants;
      if (v.state) { a.video_variant_state = v.state; if (v.reason) a.video_variant_reason = v.reason; }
    } catch (_) { /* a copy is an improvement, never a reason to drop the item */ }
  }
}

function _resetForTest({ clockFn, cpuFn, encodeFn, ffmpeg = true } = {}) {
  if (timer) clearTimeout(timer);
  timer = null; timerAt = 0;
  running.clear();
  deferred = null; cpuBase = null; encoderPick = null; lastDone = null;
  tools = ffmpeg === null ? null : { ffmpeg };
  clock = clockFn || (() => new Date());
  readCpu = cpuFn || (() => require('./host-stats').cpuTimes());
  runEncode = encodeFn || null;
  started = false;
}

module.exports = {
  KINDS, CAPABILITY, FILE_RE,
  kindForOrientation, kindForDevice, isTallVideo, workspaceNeeds,
  ensure, onContentIngested, retry, removeFor, sweepOrphans, variantsForPayload, describe, stampItems,
  getSettings, saveSettings, parseWindow, inWindow, monthKey, withinAllowance,
  ffmpegArgs, scaleFilter, encodeWithFfmpeg,
  start, stats, tick,
  _resetForTest, _running: () => running, _drain: () => Promise.all([...jobs]), _setPush: (fn) => { pushFn = fn; },
};
