'use strict';

/*
 * A crafted bundle must not stall the event loop or pile up memory.
 *
 * ⚠️ The inliner runs on the main thread for every tenant. Its old regexes rescanned to the end of
 * the document from every unclosed `<link `, `<style>` or `url(`, so a 1MB index.html of `<link `
 * repeated was minutes of blocked loop; the entry was read up to 128MB and not charged to the 8MB
 * budget; the public /bundle route re-inlined on every poll; and the preview store had no cap.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const bi = require('../lib/bundle-inline');
const previews = require('../lib/bundle-preview-store');

/* Minimal STORED zip writer (same as test/bundle-inline.test.js). */
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const raw = Buffer.from(data);
    const nb = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(raw) >>> 0 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += lh.length + nb.length + raw.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-inline-dos-'));
const write = (entries) => {
  const p = path.join(TMP, crypto.randomBytes(6).toString('hex') + '.zip');
  fs.writeFileSync(p, zip(entries));
  return p;
};
const MB = 1024 * 1024;
const fill = (unit, bytes) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

for (const [label, unit] of [['<link ', '<link '], ['<img src="', '<img src="'], ['<style>', '<style>'], ['<link href="a.css" ', '<link href="a.css" ']]) {
  test(`⚠️ a 1MB entry of unclosed ${JSON.stringify(label)} inlines in well under a second`, async () => {
    const p = write({ 'index.html': fill(unit, MB) });
    const t = process.hrtime.bigint();
    const out = await bi.inlineBundle(p, 'index.html');
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.equal(out.html.length, MB, 'nothing to inline, so the document is unchanged');
    assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`);
  });
}

test('⚠️ a 1MB stylesheet of unclosed url( / @import is linear too', async () => {
  for (const unit of ['url(', 'url("a', '@import a ', 'url(a.png ']) {
    const p = write({
      'index.html': '<!doctype html><link rel="stylesheet" href="a.css"><style>' + fill(unit, MB / 2) + '</style>',
      'a.css': fill(unit, MB),
    });
    const t = process.hrtime.bigint();
    await bi.inlineBundle(p, 'index.html');
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1000, `${JSON.stringify(unit)} took ${ms.toFixed(0)}ms`);
  }
});

test('many real references still inline, by position, in linear time', async () => {
  // 20k <img> tags all pointing at one small file: each replace used to copy the whole document.
  const tags = '<img src="a.png">'.repeat(20000);
  const p = write({ 'index.html': '<!doctype html>' + tags, 'a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const t = process.hrtime.bigint();
  const out = await bi.inlineBundle(p, 'index.html');
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(out.inlined, 20000);
  assert.equal((out.html.match(/src="data:image\/png;base64,/g) || []).length, 20000);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms`);
});

test('⚠️ an entry page over MAX_ENTRY_BYTES is refused with a 413', async () => {
  const p = write({ 'index.html': '<!doctype html>' + 'x'.repeat(bi.MAX_ENTRY_BYTES) });
  await assert.rejects(() => bi.inlineBundle(p, 'index.html'), (e) => e instanceof bi.InlineTooLargeError && e.status === 413);
});

test('the entry page is charged to the inline budget', async () => {
  const p = write({
    'index.html': '<!doctype html><img src="a.png">' + ' '.repeat(600 * 1024),
    'a.png': Buffer.alloc(500 * 1024, 1),
  });
  // 600KB entry + 500KB image > 1MB: refused now; the image alone would have fit before.
  await assert.rejects(() => bi.inlineBundle(p, 'index.html', { maxBytes: MB }), (e) => e.status === 413);
  const ok = await bi.inlineBundle(p, 'index.html', { maxBytes: 2 * MB });
  assert.ok(ok.bytes >= 1100 * 1024, 'bytes counts the entry too');
});

test('replacement text with $& is inserted literally (positional splice, not String.replace patterns)', async () => {
  const p = write({ 'index.html': '<!doctype html><link rel="stylesheet" href="a.css">', 'a.css': '.a::after{content:"$&$1"}' });
  const out = await bi.inlineBundle(p, 'index.html');
  assert.match(out.html, /content:"\$&\$1"/);
});

test('inlineBundleCached: a repeat is a cache hit; a rewritten archive is not', async () => {
  bi._clearCache();
  const p = write({ 'index.html': '<!doctype html><p>one</p>' });
  const a = await bi.inlineBundleCached(p, 'index.html');
  const b = await bi.inlineBundleCached(p, 'index.html');
  assert.equal(a, b, 'the second call should be served from the cache');
  const [c1, c2] = await Promise.all([bi.inlineBundleCached(p, 'other.html').catch((e) => e), bi.inlineBundleCached(p, 'other.html').catch((e) => e)]);
  assert.equal(c1, c2, 'concurrent misses share one inline');
  fs.writeFileSync(p, zip({ 'index.html': '<!doctype html><p>two, longer</p>' }));
  const d = await bi.inlineBundleCached(p, 'index.html');
  assert.match(d.html, /two, longer/, 'a new archive is never served stale');
});

test('inlineBundleCached: bounded by entry count', async () => {
  bi._clearCache();
  for (let i = 0; i < bi.CACHE_MAX_ENTRIES + 10; i++) await bi.inlineBundleCached(write({ 'index.html': '<p>' + i }), 'index.html');
  assert.equal(bi._cacheStats().entries, bi.CACHE_MAX_ENTRIES);
  bi._clearCache();
});

test('preview store: bounded by count and by total size, oldest out first', () => {
  const first = previews.put('c-first', 'x');
  for (let i = 0; i < previews.MAX_ENTRIES + 5; i++) previews.put('c' + i, 'y');
  assert.ok(previews._stats().entries <= previews.MAX_ENTRIES);
  assert.equal(previews.get(first, 'c-first'), null, 'the oldest preview was evicted');

  const big = 'z'.repeat(Math.floor(previews.MAX_TOTAL_CHARS / 3));
  const tokens = Array.from({ length: 4 }, (_, i) => previews.put('big' + i, big));
  assert.ok(previews._stats().chars <= previews.MAX_TOTAL_CHARS);
  assert.equal(previews.get(tokens[0], 'big0'), null, 'oldest big preview evicted');
  assert.equal(previews.get(tokens[3], 'big3'), big, 'the newest is kept');
});
