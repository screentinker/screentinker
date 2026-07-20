'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');

// Isolate state BEFORE requiring the app: temp DATA_DIR (throwaway DB + cache) and a tiny size cap.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-media-'));
process.env.DATA_DIR = TMP;
process.env.MEDIA_PROXY_MAX_BYTES = '1024';

const express = require('express');
const media = require('../routes/media');
const { db } = require('../db/database');
const { sniffMedia, consumeToCache, ensureCached, fetchOrRevalidate, isFresh, dataFile, metaFile, readMeta } = media.__test;

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(40)]);
const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(40)]);
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(40)]);
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(40)]);
const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(40)]);
const webm = Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(40)]);
const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]);
const html = Buffer.from('<html><head><title>x</title></head><body>hi</body></html>');
const doctype = Buffer.from('<!DOCTYPE html><html></html>                 ');
const pdf = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(40)]);

test('sniffMedia: real media accepted, everything else rejected (XSS defense)', () => {
  assert.equal(sniffMedia(png), 'image/png');
  assert.equal(sniffMedia(jpeg), 'image/jpeg');
  assert.equal(sniffMedia(gif), 'image/gif');
  assert.equal(sniffMedia(webp), 'image/webp');
  assert.equal(sniffMedia(mp4), 'video/mp4');
  assert.equal(sniffMedia(avif), 'image/avif');
  assert.equal(sniffMedia(webm), 'video/webm');
  assert.equal(sniffMedia(ogg), 'video/ogg');
  assert.equal(sniffMedia(html), null);      // the whole point: HTML never passes
  assert.equal(sniffMedia(doctype), null);
  assert.equal(sniffMedia(pdf), null);
  assert.equal(sniffMedia(Buffer.alloc(0)), null);
  assert.equal(sniffMedia(Buffer.from([0x89])), null);
});

test('consumeToCache: valid image is cached with sniffed type', async () => {
  const key = 'okpng';
  const meta = await consumeToCache(Readable.from([png]), key);
  assert.equal(meta.type, 'image/png');
  assert.equal(meta.size, png.length);
  assert.ok(fs.existsSync(dataFile(key)));
  assert.deepEqual(readMeta(key), meta);
});

test('consumeToCache: HTML body rejected even under the size cap, nothing persisted', async () => {
  const key = 'badhtml';
  await assert.rejects(consumeToCache(Readable.from([Buffer.concat([html, Buffer.alloc(40)])]), key),
    (e) => /unsupported-content/.test(e.message));
  assert.ok(!fs.existsSync(dataFile(key)), 'no cache file for rejected content');
});

test('consumeToCache: stream over the byte cap is aborted (Content-Length not trusted)', async () => {
  const key = 'toobig';
  await assert.rejects(consumeToCache(Readable.from([Buffer.alloc(2048)]), key), // > 1024 cap
    (e) => /too-large/.test(e.message));
  assert.ok(!fs.existsSync(dataFile(key)));
});

test('ensureCached: single-flight collapses concurrent misses to one fetch', async () => {
  let calls = 0;
  const fetcher = (url, key) => { calls++; return new Promise((r) => setImmediate(() => r({ type: 'image/png', size: 1 }))); };
  const key = 'sf-' + crypto.randomBytes(3).toString('hex');
  const [a, b] = await Promise.all([
    ensureCached('http://x/1', key, fetcher),
    ensureCached('http://x/1', key, fetcher),
  ]);
  assert.equal(calls, 1, 'fifty panels -> one upstream fetch');
  assert.deepEqual(a, b);
});

test('route: 400 on malformed content id, 404 on unknown content', async () => {
  const { port, close } = await listen();
  try {
    assert.equal((await get(port, '/media/proxy/bad.id')).status, 400, 'dot is not a valid id char');
    assert.equal((await get(port, '/media/proxy/ghostcontent')).status, 404, 'well-formed but no such content');
  } finally { await close(); }
});

test('route: cache hit serves sniffed type with hardening headers', async () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO content (id, filename, mime_type, remote_url) VALUES ('c1','x.png','image/png','http://example.test/x')").run();
  const key = crypto.createHash('sha256').update('http://example.test/x').digest('hex');
  fs.writeFileSync(dataFile(key), png);
  fs.writeFileSync(metaFile(key), JSON.stringify({ type: 'image/png', size: png.length, fetchedAt: Date.now() }));

  const { port, close } = await listen();
  try {
    const r = await get(port, '/media/proxy/c1');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-security-policy'], 'sandbox');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(r.body.length, png.length);
  } finally { await close(); }
});

test('route: hostile remote_url pointing at loopback is blocked end-to-end (403)', async () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO content (id, filename, mime_type, remote_url) VALUES ('c2','y.png','image/png','http://127.0.0.1:9/x')").run();
  const { port, close } = await listen();
  try {
    const r = await get(port, '/media/proxy/c2');
    assert.equal(r.status, 403, 'SSRF guard refuses the live fetch to a private IP');
  } finally { await close(); }
});

test('consumeToCache: captures ETag/Last-Modified + fetchedAt for revalidation', async () => {
  const key = 'validators';
  const s = Readable.from([png]); s.headers = { etag: '"abc123"', 'last-modified': 'Wed, 21 Oct 2025 07:28:00 GMT' };
  const meta = await consumeToCache(s, key);
  assert.equal(meta.etag, '"abc123"');
  assert.equal(meta.lastModified, 'Wed, 21 Oct 2025 07:28:00 GMT');
  assert.equal(typeof meta.fetchedAt, 'number');
});

test('ensureCached: fresh hit served without refetch, stale hit triggers revalidation', async () => {
  const key = 'freshness';
  fs.writeFileSync(dataFile(key), png);
  let called = 0;
  const fetcher = () => { called++; return Promise.resolve({ type: 'image/png', size: png.length, fetchedAt: Date.now() }); };

  fs.writeFileSync(metaFile(key), JSON.stringify({ type: 'image/png', size: png.length, fetchedAt: Date.now() }));
  assert.equal(isFresh(readMeta(key)), true);
  await ensureCached('http://x/a', key, fetcher);
  assert.equal(called, 0, 'fresh hit does not refetch');

  fs.writeFileSync(metaFile(key), JSON.stringify({ type: 'image/png', size: png.length, fetchedAt: 1 })); // ancient
  assert.equal(isFresh(readMeta(key)), false);
  await ensureCached('http://x/a', key, fetcher);
  assert.equal(called, 1, 'stale hit revalidates');
});

test('fetchOrRevalidate: revalidation failure serves the STALE copy (never blank)', async () => {
  const key = 'stale-serve';
  fs.writeFileSync(dataFile(key), png);
  const existing = { type: 'image/png', size: png.length, fetchedAt: 1, etag: '"x"' };
  fs.writeFileSync(metaFile(key), JSON.stringify(existing));
  // loopback remote_url -> SSRF guard rejects the revalidation fetch -> must fall back to stale bytes
  const meta = await fetchOrRevalidate('http://127.0.0.1:9/x', key, existing);
  assert.equal(meta.type, 'image/png');
  assert.ok(meta.fetchedAt > 1, 'freshness stamp bumped so we do not hammer a down upstream');
});

test('fetchOrRevalidate: hard miss to a blocked host throws (no stale to fall back on)', async () => {
  await assert.rejects(fetchOrRevalidate('http://127.0.0.1:9/x', 'nomiss', null));
});

test('consumeToCache: refuses to write when free space is below the floor (disk-fill guard)', async () => {
  const key = 'diskfull';
  const prev = process.env.MEDIA_PROXY_FREE_FLOOR_BYTES;
  process.env.MEDIA_PROXY_FREE_FLOOR_BYTES = String(Number.MAX_SAFE_INTEGER); // floor above any real free space
  try {
    await assert.rejects(consumeToCache(Readable.from([png]), key), (e) => /disk-full/.test(e.message));
    assert.ok(!fs.existsSync(dataFile(key)));
  } finally {
    if (prev === undefined) delete process.env.MEDIA_PROXY_FREE_FLOOR_BYTES; else process.env.MEDIA_PROXY_FREE_FLOOR_BYTES = prev;
  }
});

// ---- helpers ----
function listen() {
  const app = express();
  app.use('/media', media);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
