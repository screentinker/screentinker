'use strict';
// Media proxy — GET /media/proxy/:itemId
//
// Threat model (see also server/lib/ssrf-guard.js):
//  * NOT an open proxy. The caller never supplies a URL — we look the item up server-side and fetch
//    its stored content.remote_url. The only fetchable targets are URLs a customer already put in a
//    playlist, so bandwidth-theft / abuse-laundering (using our box to fetch arbitrary public URLs)
//    is eliminated by construction. The SSRF guard then handles the residual case: a customer who
//    sets a hostile remote_url pointing at our internal network.
//  * We serve upstream bytes SAME-ORIGIN (so a WebGL transition can read them), which means anything
//    we serve executes in the ScreenTinker origin. Content-Type from upstream is a lie we never trust:
//    we sniff magic bytes, refuse anything that isn't a real image/video, serve the SNIFFED type with
//    X-Content-Type-Options: nosniff and Content-Security-Policy: sandbox. That kills text/html -> XSS.
//  * Size is capped on the STREAM (bytes actually received), not Content-Length (absent or lying);
//    we abort mid-transfer at the ceiling. The socket is pinned to the vetted IP (anti-rebinding) with
//    SNI/cert validation still against the original hostname. Redirects are re-vetted every hop.
//  * Single-flight per cache key: 50 panels advancing to the same cold asset => 1 upstream fetch.

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const config = require('../config');
const { assertSafeUrl, pinnedLookup, SsrfError } = require('../lib/ssrf-guard');

const router = express.Router();

const MAX_BYTES = parseInt(process.env.MEDIA_PROXY_MAX_BYTES, 10) || 128 * 1024 * 1024; // per-item ceiling; abort the stream past this
const MAX_REDIRECTS = 4;
const IDLE_TIMEOUT_MS = 20000;                // no-progress socket timeout
const SNIFF_BYTES = 32;                       // enough for every magic below
const CACHE_DIR = path.join(config.dataDir, 'proxy-cache'); // NOT under contentDir (never statically served)
const CACHE_CAP_BYTES = parseInt(process.env.MEDIA_PROXY_CACHE_CAP_BYTES, 10) || 2 * 1024 * 1024 * 1024; // TOTAL cache cap
const TTL_MS = parseInt(process.env.MEDIA_PROXY_TTL_MS, 10) || 5 * 60 * 1000; // revalidate upstream past this age
// A full disk on a signage box is a cross-tenant outage — refuse to write when free space is below this.
function freeFloorBytes() { return parseInt(process.env.MEDIA_PROXY_FREE_FLOOR_BYTES, 10) || 1024 * 1024 * 1024; }
function freeSpace() { try { const s = fs.statfsSync(CACHE_DIR); return s.bavail * s.bsize; } catch (e) { return Infinity; } }

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* fall through; writes will surface errors */ }

// A media-layer failure that is the upstream's fault (not an SSRF block).
class MediaError extends Error { constructor(msg) { super(msg); this.name = 'MediaError'; } }

const dataFile = (key) => path.join(CACHE_DIR, key + '.bin');
const metaFile = (key) => path.join(CACHE_DIR, key + '.json');

// ---- magic-byte sniff: return a real image/video mime, or null (=> reject) ----
function sniffMedia(buf) {
  if (buf.length < 2) return null;
  const b = buf;
  const a4 = b.length >= 4 ? b.toString('latin1', 0, 4) : '';
  // images
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (a4 === 'GIF8') return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  if (a4 === 'RIFF' && b.length >= 12 && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // ISO-BMFF (mp4/avif/heic): '....ftyp<brand>'
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    return 'video/mp4'; // isom, mp42, mp41, dash, etc.
  }
  // videos
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'video/webm'; // EBML (webm/mkv)
  if (a4 === 'OggS') return 'video/ogg';
  return null;
}

const ALLOWED_PREFIX = /^(image|video)\//;

// ---- outbound fetch: vet URL, pin socket to vetted IP, re-vet each redirect hop.
// Resolves { res } for a 200 stream, or { notModified:true } for a 304 (conditional revalidation).
function resolveWithRedirects(rawUrl, redirectsLeft, validators) {
  return new Promise((resolve, reject) => {
    assertSafeUrl(rawUrl).then(({ url, addresses }) => {
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { 'user-agent': 'ScreenTinker-media-proxy', accept: 'image/*,video/*' };
      if (validators && validators.etag) headers['if-none-match'] = validators.etag;
      if (validators && validators.lastModified) headers['if-modified-since'] = validators.lastModified;
      const req = mod.request(url, {
        method: 'GET',
        lookup: pinnedLookup(addresses),   // connect to the vetted IP only (defeats DNS rebinding)
        servername: url.hostname,          // SNI + cert validation stay against the hostname, not the IP
        headers,
      }, (res) => {
        const sc = res.statusCode;
        if (sc === 304) { res.resume(); return resolve({ notModified: true }); } // still current upstream
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume(); // drain the redirect body
          if (redirectsLeft <= 0) return reject(new MediaError('too-many-redirects'));
          let next;
          try { next = new URL(res.headers.location, url).toString(); }
          catch (e) { return reject(new MediaError('bad-redirect')); }
          return resolveWithRedirects(next, redirectsLeft - 1, validators).then(resolve, reject);
        }
        if (sc !== 200) { res.resume(); return reject(new MediaError('upstream-status-' + sc)); }
        resolve({ res });
      });
      req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new MediaError('timeout')));
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

// ---- consume a vetted 200 stream into the disk cache: sniff on first bytes, cap on the stream ----
function consumeToCache(res, key) {
  return new Promise((resolve, reject) => {
    {
      // Free-space floor: try to reclaim from our own cache first, then refuse rather than fill the disk.
      if (freeSpace() < freeFloorBytes()) {
        evictIfOverCap();
        if (freeSpace() < freeFloorBytes()) { res.destroy(); return reject(new MediaError('disk-full')); }
      }
      const tmp = dataFile(key) + '.tmp-' + crypto.randomBytes(6).toString('hex');
      const out = fs.createWriteStream(tmp);
      let received = 0, head = [], headLen = 0, sniffed = null, aborted = false;
      const abort = (err) => {
        if (aborted) return; aborted = true;
        res.destroy(); out.destroy();
        fs.unlink(tmp, () => {});
        reject(err);
      };
      out.on('error', abort);
      res.on('error', abort);
      const trySniff = (final) => {
        if (sniffed || (!final && headLen < SNIFF_BYTES)) return true;
        sniffed = sniffMedia(Buffer.concat(head));
        if (!sniffed || !ALLOWED_PREFIX.test(sniffed)) { abort(new MediaError('unsupported-content')); return false; }
        head = null; // release
        return true;
      };
      res.on('data', (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_BYTES) return abort(new MediaError('too-large'));
        if (!sniffed) { head.push(chunk); headLen += chunk.length; if (!trySniff(false)) return; }
        if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()); }
      });
      res.on('end', () => {
        if (aborted) return;
        if (!sniffed && !trySniff(true)) return; // tiny file: sniff whatever we got
        out.end(() => {
          try {
            fs.renameSync(tmp, dataFile(key));
            const h = res.headers || {};
            const meta = { type: sniffed, size: received, fetchedAt: Date.now(),
              etag: h.etag || null, lastModified: h['last-modified'] || null };
            fs.writeFileSync(metaFile(key), JSON.stringify(meta));
            evictIfOverCap();
            resolve(meta);
          } catch (e) { fs.unlink(tmp, () => {}); reject(e); }
        });
      });
    }
  });
}

function readMeta(key) {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(key), 'utf8'));
    if (m && ALLOWED_PREFIX.test(m.type) && fs.existsSync(dataFile(key))) return m;
  } catch (e) { /* miss */ }
  return null;
}
function isFresh(meta) { return meta && typeof meta.fetchedAt === 'number' && (Date.now() - meta.fetchedAt) < TTL_MS; }
// upstream unchanged (304) or a revalidation error: keep the bytes, just reset freshness + LRU stamp
function touchMeta(key, meta) {
  meta.fetchedAt = Date.now();
  try { fs.writeFileSync(metaFile(key), JSON.stringify(meta)); const t = new Date(); fs.utimesSync(dataFile(key), t, t); } catch (e) {}
  return meta;
}

// Miss -> download. Stale hit -> conditional GET: 304 keeps the bytes, 200 replaces them, and a
// revalidation FAILURE serves the stale copy (a signage screen must never blank on a flaky upstream).
function fetchOrRevalidate(remoteUrl, key, existing) {
  const validators = existing && (existing.etag || existing.lastModified)
    ? { etag: existing.etag, lastModified: existing.lastModified } : null;
  return resolveWithRedirects(remoteUrl, MAX_REDIRECTS, validators).then((r) => {
    if (r.notModified && existing) return touchMeta(key, existing);
    return consumeToCache(r.res, key);
  }).catch((err) => {
    if (existing) return touchMeta(key, existing); // stale-while-error
    throw err;
  });
}

const inflight = new Map(); // cache key -> Promise<meta> (single-flight; covers revalidation too)
function ensureCached(remoteUrl, key, fetcher) {
  const hit = readMeta(key);
  if (hit && isFresh(hit)) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const run = fetcher || ((u, k) => fetchOrRevalidate(u, k, hit)); // hit may be a stale copy to revalidate
  const p = run(remoteUrl, key, hit).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// bounded cache: evict oldest (by write time) until under the byte cap
function evictIfOverCap() {
  try {
    const bins = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.bin'));
    const entries = bins.map((f) => {
      const p = path.join(CACHE_DIR, f);
      const s = fs.statSync(p);
      return { p, base: f.slice(0, -4), size: s.size, mtime: s.mtimeMs };
    });
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= CACHE_CAP_BYTES) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (total <= CACHE_CAP_BYTES) break;
      try { fs.unlinkSync(e.p); } catch (x) {}
      fs.unlink(path.join(CACHE_DIR, e.base + '.json'), () => {});
      total -= e.size;
    }
  } catch (e) { /* best-effort */ }
}

function serveFromCache(res, key, meta) {
  res.setHeader('Content-Type', meta.type);              // the SNIFFED type, never upstream's claim
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');   // if ever navigated to directly, no script/plugins
  res.setHeader('Access-Control-Allow-Origin', '*');     // canvas/WebGL needs to read the pixels
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // short client cache so a stale screen self-corrects within ~a minute; server-side TTL handles upstream
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Length', meta.size);
  const t = new Date(); fs.utimes(dataFile(key), t, t, () => {}); // LRU: stamp access time for eviction ordering
  const rs = fs.createReadStream(dataFile(key));
  rs.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  rs.pipe(res);
}

// Keyed on content.id (a TEXT id present in the id-free published_snapshot the player consumes; the
// playlist_items id is not). content OWNS remote_url, so this is the natural lookup and lets multiple
// playlist items that reference the same image share one cache entry. Still not an open proxy: only a
// content row a customer created is fetchable, and the SSRF guard gates the actual remote_url fetch.
router.get('/proxy/:contentId', (req, res) => {
  const contentId = String(req.params.contentId || '');
  if (!contentId || contentId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(contentId)) {
    return res.status(400).end();
  }
  let row;
  try {
    row = db.prepare('SELECT remote_url FROM content WHERE id = ?').get(contentId);
  } catch (e) { return res.status(500).end(); }
  if (!row || !row.remote_url) return res.status(404).end();

  const key = crypto.createHash('sha256').update(String(row.remote_url)).digest('hex');
  ensureCached(row.remote_url, key)
    .then((meta) => serveFromCache(res, key, meta))
    .catch((err) => {
      if (res.headersSent) return res.destroy();
      const code = err instanceof SsrfError ? 403 : (err instanceof MediaError ? 502 : 500);
      res.status(code).end();
    });
});

module.exports = router;
// exported for tests (security-critical internals, exercised without the DB/express layer)
module.exports.__test = { sniffMedia, resolveWithRedirects, consumeToCache, fetchOrRevalidate, ensureCached, readMeta, isFresh, touchMeta, evictIfOverCap, inflight, dataFile, metaFile, CACHE_DIR, MAX_BYTES, TTL_MS };
