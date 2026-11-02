'use strict';

/*
 * SSSP3/Orsay paints HTML video and images at encoded/intrinsic pixel size and
 * ignores client scale (CSS object-fit, transform, width/height, canvas).
 * Fit is therefore a same-asset rendition whose encoded WxH already match the
 * zone: contain letterboxes, cover crops, fill stretches. SAR is forced 1:1.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FIT_RE = /^(.+)\.(contain|cover|fill)-(\d+)x(\d+)(\.[A-Za-z0-9]{1,8})$/;
const MAX_EDGE = 1920;
const MIN_EDGE = 2;

function parseFitName(name) {
  const base = path.basename(String(name || ''));
  const m = FIT_RE.exec(base);
  if (!m) return null;
  const width = Number(m[3]);
  const height = Number(m[4]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_EDGE || height < MIN_EDGE || width > MAX_EDGE || height > MAX_EDGE) return null;
  if (width % 2 || height % 2) return null;
  const outputExt = m[5].toLowerCase();
  // SVG cannot safely be delivered as a rendered SVG after ffmpeg has rasterized
  // it. The client requests `source.svg.fit-WxH.png`; retain `.svg` as the
  // source name and use PNG for the generated response.
  const svgSource = /\.svg$/i.test(m[1]);
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

function isVideo(ext) {
  return ext === '.mp4' || ext === '.mov' || ext === '.m4v';
}

function isImage(ext) {
  return ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp' || ext === '.svg';
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code, sig) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(sig ? `ffmpeg stopped (${sig})` : (err.trim().split('\n').pop() || `ffmpeg exit ${code}`)));
    });
  });
}

function videoArgs(src, dest, spec) {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', src,
    '-an',
    '-vf', vf(spec.fit, spec.width, spec.height),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-profile:v', 'baseline', '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
    '-movflags', '+faststart',
    dest,
  ];
}

function imageArgs(src, dest, spec) {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', src,
    '-frames:v', '1',
    '-vf', vf(spec.fit, spec.width, spec.height),
    dest,
  ];
}

const inflight = new Map();

async function ensureRendition(contentDir, requestedName, opts = {}) {
  const spec = parseFitName(requestedName);
  if (!spec) return null;
  if (!isVideo(spec.sourceExt) && !isImage(spec.sourceExt)) return null;
  const dir = path.resolve(contentDir);
  const dest = path.join(dir, spec.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const src = path.join(dir, spec.original);
  if (!fs.existsSync(src)) return null;
  const existing = inflight.get(dest);
  if (existing) return existing;
  const work = (async () => {
    const tmp = dest.replace(/(\.[A-Za-z0-9]{1,8})$/, '.tmp-' + process.pid + '-' + Date.now() + '$1');
    try {
      const args = isVideo(spec.sourceExt) ? videoArgs(src, tmp, spec) : imageArgs(src, tmp, spec);
      await runFfmpeg(args, opts.timeoutMs || (isVideo(spec.ext) ? 180000 : 30000));
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 32) throw new Error('empty fit rendition');
      fs.renameSync(tmp, dest);
      return dest;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    } finally {
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
  if (!job) return false;
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
  }).catch(() => {
    res.removeHeader('Cache-Control');
    res.status(404).type('application/json').json({ error: 'Not found' });
  });
  return true;
}

module.exports = {
  parseFitName,
  vf,
  ensureRendition,
  tryServe,
  FIT_RE,
};
