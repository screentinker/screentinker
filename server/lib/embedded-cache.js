'use strict';

/*
 * Disk-backed ETag cache for the embedded renderer.
 *
 * E-ink displays refresh rarely (seconds to minutes). Serving the same PNG on every
 * request wastes CPU and battery. This module:
 *
 *   1. Computes a deterministic cache key for (device, content, profile).
 *   2. Serves from a disk cache on hits.
 *   3. Stores rendered output after misses.
 *   4. Supports HTTP ETag / 304 Not Modified so a device can skip SPI writes entirely.
 *
 * Cache eviction: in-memory LRU map of (cacheKey -> {filePath, size, atime}).
 * Budget: MAX_ENTRIES=500 or MAX_BYTES=200MB, whichever triggers first.
 * Eviction runs at module load (clearing leftover files from a previous boot) and
 * whenever a new entry would exceed budget.
 *
 * ⚠️ Cache files are keyed by SHA-256 hash — no user-controlled filename component.
 * ⚠️ The cache is WRITE-THROUGH: a miss renders + stores, then serves from the buffer.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const MAX_ENTRIES = 500;
const MAX_BYTES   = 200 * 1024 * 1024; // 200 MB

function cacheDir() {
  return process.env.EMBEDDED_CACHE_DIR ||
    path.join(__dirname, '..', 'data', 'embedded-cache');
}

// In-memory LRU map: cacheKey -> { filePath, size, atime }
// Map preserves insertion order; oldest entries are evicted first.
const lru = new Map();
let totalBytes = 0;
let initialized = false;

function cacheFilePath(key) {
  return path.join(cacheDir(), key + '.bin');
}

/**
 * Compute a deterministic cache key.
 *
 * @param {string} deviceId
 * @param {string} itemId          Playlist item id
 * @param {number} itemUpdatedAt   Unix seconds — advances when content is replaced
 * @param {object} profile         Validated screen_profile object
 * @returns {string}  64-char hex SHA-256
 */
function cacheKey(deviceId, itemId, itemUpdatedAt, profile) {
  const payload = JSON.stringify([
    deviceId,
    itemId,
    itemUpdatedAt,
    profile.width,
    profile.height,
    profile.rotation,
    profile.colorDepth,
    profile.dither,
    profile.outputFormat,
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Wrap a key in RFC 7232 strong ETag quotes. */
function toETag(key) { return `"${key}"`; }

/** Strip outer quotes from an ETag value from a request header. */
function fromETag(etag) {
  if (!etag) return null;
  return etag.replace(/^"|"$/g, '');
}

// ─── Eviction ──────────────────────────────────────────────────────────────────

function evictIfNeeded() {
  while (lru.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    // First entry = oldest (Map preserves insertion order)
    const [oldestKey, entry] = lru.entries().next().value;
    lru.delete(oldestKey);
    totalBytes -= entry.size;
    try { fs.unlinkSync(entry.filePath); } catch { /* already gone */ }
  }
}

// ─── Initialization ────────────────────────────────────────────────────────────

function init() {
  if (initialized) return;
  initialized = true;

  const dir = cacheDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }

  let files;
  try { files = fs.readdirSync(dir); } catch { return; }

  const entries = [];
  for (const f of files) {
    if (!f.endsWith('.bin')) continue;
    const key = f.slice(0, -4);
    const fp  = path.join(dir, f);
    try {
      const stat = fs.statSync(fp);
      entries.push({ key, filePath: fp, size: stat.size, atime: stat.atimeMs });
    } catch { /* skip */ }
  }

  // Sort oldest-first so Map insertion order matches LRU order
  entries.sort((a, b) => a.atime - b.atime);
  for (const e of entries) {
    lru.set(e.key, { filePath: e.filePath, size: e.size, atime: e.atime });
    totalBytes += e.size;
  }
  evictIfNeeded();
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a rendered image by key.
 * @returns {{ hit: true, buffer: Buffer, etag: string } | { hit: false }}
 */
function get(key) {
  init();
  const entry = lru.get(key);
  if (!entry) return { hit: false };

  let buffer;
  try {
    buffer = fs.readFileSync(entry.filePath);
  } catch {
    // File vanished from disk — drop from LRU
    lru.delete(key);
    totalBytes -= entry.size;
    return { hit: false };
  }

  // Promote to MRU position
  lru.delete(key);
  lru.set(key, entry);

  return { hit: true, buffer, etag: toETag(key) };
}

/**
 * Store a rendered buffer under key.
 * Non-fatal on write failure — caller still has the buffer in memory.
 */
function set(key, buffer) {
  init();
  const dir = cacheDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }

  const filePath = cacheFilePath(key);
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    console.warn('[embedded-cache] write failed:', e.message);
    return;
  }

  const size = buffer.length;
  if (lru.has(key)) {
    totalBytes -= lru.get(key).size;
    lru.delete(key);
  }
  lru.set(key, { filePath, size, atime: Date.now() });
  totalBytes += size;
  evictIfNeeded();
}

/**
 * Return true when the incoming If-None-Match header matches the current key
 * and a 304 Not Modified should be sent.
 */
function isNotModified(key, ifNoneMatch) {
  if (!ifNoneMatch) return false;
  return fromETag(ifNoneMatch) === key;
}

/** Invalidate a single cache entry (e.g. after a playlist change). */
function invalidate(key) {
  init();
  const entry = lru.get(key);
  if (!entry) return;
  lru.delete(key);
  totalBytes -= entry.size;
  try { fs.unlinkSync(entry.filePath); } catch { /* already gone */ }
}

module.exports = { cacheKey, toETag, isNotModified, get, set, invalidate };
