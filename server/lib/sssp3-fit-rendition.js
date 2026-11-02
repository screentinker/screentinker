'use strict';

/*
 * SSSP3/Orsay paints HTML video and images at encoded/intrinsic pixel size and
 * ignores client scale (CSS object-fit, transform, width/height, canvas).
 * Fit is therefore a same-asset rendition whose encoded WxH already match the
 * zone: contain letterboxes, cover crops, fill stretches. SAR is forced 1:1.
 *
 * The route serving these renditions is public for the same reason
 * /uploads/content is public: unauthenticated signage players fetch media by
 * immutable filename. It does not grant access to any source a caller could
 * not already request from that public media mount. This module nevertheless
 * treats both names and on-disk files as hostile: no traversal, symlinks,
 * non-regular files, output-controlled paths, shells, or ffmpeg networking.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FIT_RE = /^(.+)\.(contain|cover|fill)-(\d+)x(\d+)(\.[A-Za-z0-9]{1,8})$/;
const MAX_EDGE = 1920;
const MAX_PIXELS = 1920 * 1080;
const MIN_EDGE = 2;
const MAX_CONCURRENT_RENDITIONS = 2;
const RASTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

class RenditionBusyError extends Error {
  constructor() {
    super('SSSP3 rendition capacity is busy');
    this.name = 'RenditionBusyError';
  }
}

function parseFitName(name) {
  const base = path.basename(String(name || ''));
  const m = FIT_RE.exec(base);
  if (!m) return null;
  const width = Number(m[3]);
  const height = Number(m[4]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_EDGE || height < MIN_EDGE || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) return null;
  if (width % 2 || height % 2) return null;
  const outputExt = m[5].toLowerCase();
  // SVG cannot safely be delivered as a rendered SVG after ffmpeg has rasterized
  // it. The client requests `source.svg.fit-WxH.png`; retain `.svg` as the
  // source name and permit only known raster output formats.
  const svgSource = /\.svg$/i.test(m[1]);
  if (svgSource && !RASTER_EXTENSIONS.has(outputExt)) return null;
  return {
    original: svgSource ? m[1] : m[1] + m[5],
    sourceExt: svgSource ? '.svg' : outputExt,
    fit: m[2],
    width,
    height,
    ext: outputExt,
    name: base,
  };
}

function vf(fit, width, height) {
  if (fit === 'fill') {
    return `scale=${width}:${height}:force_original_aspect_ratio=disable,setsar=1,format=yuv420p`;
  }
  if (fit === 'contain') {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p`;
}

function isVideo(ext) { return VIDEO_EXTENSIONS.has(ext); }
function isImage(ext) { return RASTER_EXTENSIONS.has(ext) || ext === '.svg'; }

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let timedOut = false;
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code, sig) => {
      clearTimeout(t);
      if (code === 0 && !timedOut) return resolve();
      if (timedOut) return reject(new Error('ffmpeg timed out'));
      return reject(new Error(sig ? `ffmpeg stopped (${sig})` : (err.trim().split('\n').pop() || `ffmpeg exit ${code}`)));
    });
  });
}

function commonArgs(src) {
  // No shell is used. Restrict protocol handling too: an uploaded SVG or media
  // container must never make the server fetch a URL while producing a fit copy.
  return ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', src];
}

function videoArgs(src, dest, spec) {
  return commonArgs(src).concat([
    '-an', '-vf', vf(spec.fit, spec.width, spec.height),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', dest,
  ]);
}

function imageArgs(src, dest, spec) {
  return commonArgs(src).concat(['-frames:v', '1', '-vf', vf(spec.fit, spec.width, spec.height), dest]);
}

function realRegularFile(file, root) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  let real;
  try { real = fs.realpathSync(file); } catch (_) { return null; }
  return real === root || real.startsWith(root + path.sep) ? real : null;
}

function existingRendition(file, root) {
  const real = realRegularFile(file, root);
  if (!real) return null;
  try { return fs.statSync(real).size > 0 ? real : null; } catch (_) { return null; }
}

const inflight = new Map();

async function ensureRendition(contentDir, requestedName, opts = {}) {
  const spec = parseFitName(requestedName);
  if (!spec || (!isVideo(spec.sourceExt) && !isImage(spec.sourceExt))) return null;
  let dir;
  try { dir = fs.realpathSync(path.resolve(contentDir)); } catch (_) { return null; }
  const dest = path.join(dir, spec.name);
  const cached = existingRendition(dest, dir);
  if (cached) return cached;
  const src = realRegularFile(path.join(dir, spec.original), dir);
  if (!src) return null;
  const existing = inflight.get(dest);
  if (existing) return existing;
  if (inflight.size >= (opts.maxConcurrent || MAX_CONCURRENT_RENDITIONS)) throw new RenditionBusyError();

  const work = (async () => {
    let temporaryDirectory = null;
    try {
      temporaryDirectory = fs.mkdtempSync(path.join(dir, '.sssp3-fit-'));
      const tmp = path.join(temporaryDirectory, 'rendition' + spec.ext);
      const args = isVideo(spec.sourceExt) ? videoArgs(src, tmp, spec) : imageArgs(src, tmp, spec);
      await runFfmpeg(args, opts.timeoutMs || (isVideo(spec.sourceExt) ? 180000 : 30000));
      const rendered = realRegularFile(tmp, fs.realpathSync(temporaryDirectory));
      if (!rendered || fs.statSync(rendered).size < 32) throw new Error('empty fit rendition');
      // rename replaces an existing derived file rather than following it, so a
      // pre-existing symlink cannot redirect the ffmpeg output outside contentDir.
      fs.renameSync(rendered, dest);
      const result = existingRendition(dest, dir);
      if (!result) throw new Error('unsafe fit rendition output');
      return result;
    } finally {
      if (temporaryDirectory) {
        try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch (_) {}
      }
      inflight.delete(dest);
    }
  })();
  inflight.set(dest, work);
  return work;
}

function tryServe(req, res, contentDir, harden) {
  const spec = parseFitName(path.basename(req.path || ''));
  if (!spec) return false;
  const job = ensureRendition(contentDir, spec.name);
  Promise.resolve(job).then((file) => {
    if (!file || !fs.existsSync(file)) {
      res.removeHeader('Cache-Control');
      return res.status(404).type('application/json').json({ error: 'Not found' });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    if (harden) harden(res, file);
    return res.sendFile(file);
  }).catch((error) => {
    res.removeHeader('Cache-Control');
    if (error instanceof RenditionBusyError) {
      res.setHeader('Retry-After', '5');
      return res.status(503).type('application/json').json({ error: 'Rendition capacity is busy; retry shortly' });
    }
    return res.status(404).type('application/json').json({ error: 'Not found' });
  });
  return true;
}

module.exports = {
  parseFitName,
  vf,
  ensureRendition,
  tryServe,
  FIT_RE,
  RenditionBusyError,
  MAX_CONCURRENT_RENDITIONS,
};
