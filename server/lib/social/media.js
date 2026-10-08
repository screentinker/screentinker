'use strict';

/*
 * Post images and avatars, cached on this server so screens never fetch from a social network.
 *
 * A file is named by sha256 of its source URL's cache key (cacheKey below) and kept only if its BYTES are an image (JPEG, PNG,
 * GIF, WebP or AVIF) — whatever the Content-Type said. That is what makes serving it safe: a CDN
 * answer that turned out to be HTML, or a "media URL" pointing at an internal page, is never
 * stored, and the guarded fetcher (lib/social/http.js getMedia) refuses private addresses anyway.
 *
 * Unreferenced files are swept by gc() — a post that leaves the wall takes its images with it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

function dir() {
  const config = require('../../config');
  const d = path.join(config.dataDir, 'social-media');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** The image type of these bytes, or null. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(avif|avis)$/.test(buf.slice(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

const hashOf = (url) => crypto.createHash('sha256').update(String(url)).digest('hex');

/*
 * Meta's CDNs (Instagram, Facebook) sign every image URL with query parameters that rotate on each
 * API answer (oh=, oe=, _nc_…): the same picture comes back under a new URL every fetch. Keyed on
 * the full URL, each refresh would download every image again and give the post new media hashes,
 * so the wall would redraw for nothing. On those hosts the path alone names the image.
 */
const SIGNED_CDN_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
function cacheKey(url) {
  let u;
  try { u = new URL(String(url)); } catch { return String(url); }
  if (!SIGNED_CDN_RE.test(u.hostname)) return String(url);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
}

/**
 * Cache one image. Returns its hash, or null if it could not be fetched or is not an image.
 * `fetcher` is lib/social/http.js getMedia (injectable for tests).
 */
async function cache(db, url, fetcher = require('./http').getMedia) {
  if (!url || typeof url !== 'string' || url.length > 2048) return null;
  const hash = hashOf(cacheKey(url));
  const have = db.prepare('SELECT hash FROM social_media WHERE hash = ?').get(hash);
  if (have && fs.existsSync(path.join(dir(), hash))) return hash;
  try {
    const r = await fetcher(url, { maxBytes: MAX_BYTES });
    if (r.status !== 200) return null;
    const mime = sniff(r.body);
    if (!mime) return null;
    const tmp = path.join(dir(), `${hash}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, r.body);
    fs.renameSync(tmp, path.join(dir(), hash));
    db.prepare('INSERT OR REPLACE INTO social_media (hash, url, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash, url, mime, r.body.length, Math.floor(Date.now() / 1000));
    return hash;
  } catch (e) {
    return null;
  }
}

/** { mime, file } for a cached image, or null. */
function lookup(db, hash) {
  if (!HASH_RE.test(String(hash || ''))) return null;
  const row = db.prepare('SELECT mime FROM social_media WHERE hash = ?').get(hash);
  if (!row) return null;
  const file = path.join(dir(), hash);
  return fs.existsSync(file) ? { mime: row.mime, file } : null;
}

/** Remove images no post refers to any more. Returns how many were removed. */
function gc(db) {
  const used = new Set();
  for (const p of db.prepare("SELECT author_avatar, media FROM social_posts").all()) {
    if (p.author_avatar) used.add(p.author_avatar);
    try { for (const h of JSON.parse(p.media || '[]')) used.add(h); } catch (_) { /* */ }
  }
  let n = 0;
  for (const r of db.prepare('SELECT hash FROM social_media').all()) {
    if (used.has(r.hash)) continue;
    db.prepare('DELETE FROM social_media WHERE hash = ?').run(r.hash);
    try { fs.unlinkSync(path.join(dir(), r.hash)); } catch (_) { /* already gone */ }
    n++;
  }
  return n;
}

module.exports = { sniff, cache, lookup, gc, hashOf, cacheKey, HASH_RE, MAX_BYTES };
