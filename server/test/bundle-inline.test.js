'use strict';

/*
 * Flattening a bundle into one document.
 *
 * ⚠️ THE TESTS THAT MATTER HERE ARE THE ONES ABOUT WHAT IT REFUSES TO DO. Inlining is a lossy
 * transformation: three things a bundle may legitimately do cannot survive it (runtime fetch, media
 * from a data: URI, runtime-built URLs), and each of them fails INVISIBLY — the page renders, and
 * some part of it is simply blank. So the value of this file is less "does the happy path work" and
 * more "does it stop where it said it would, loudly".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { inlineBundle, resolveRef } = require('../lib/bundle-inline');

/* Minimal STORED zip writer — the validator's test has the full one; this only needs happy shapes. */
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-inline-'));
const write = (entries) => {
  const p = path.join(TMP, crypto.randomBytes(6).toString('hex') + '.zip');
  fs.writeFileSync(p, zip(entries));
  return p;
};

test('a stylesheet, a script and an image all end up in one document', async () => {
  const p = write({
    'index.html': '<!doctype html><link rel="stylesheet" href="css/app.css"><script src="js/app.js"></script><img src="img/a.png">',
    'css/app.css': 'body{background:#123}',
    'js/app.js': 'console.log(1)',
    'img/a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  });
  const out = await inlineBundle(p, 'index.html');
  assert.match(out.html, /<style>/, 'the stylesheet should become a <style> block, not a base64 blob');
  assert.match(out.html, /background:#123/);
  assert.match(out.html, /src="data:text\/javascript;base64,/);
  assert.match(out.html, /src="data:image\/png;base64,/);
  assert.ok(!/href="css\/app\.css"/.test(out.html), 'the original relative href survived');
  assert.equal(out.inlined, 3);
});

test('⚠️ a stylesheet is parsed, not blobbed — its own url() must resolve', async () => {
  /*
   * The ordering trap: base64-ing app.css as an opaque data: URI "works" and looks right, and every
   * background-image inside it silently never loads, because a data: stylesheet has no base URL to
   * resolve `url(../img/bg.png)` against. That is why <link rel=stylesheet> takes a different path
   * from every other href.
   */
  const p = write({
    'index.html': '<!doctype html><link rel="stylesheet" href="css/app.css">',
    'css/app.css': '.hero{background:url(../img/bg.png)}',
    'img/bg.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]),
  });
  const out = await inlineBundle(p, 'index.html');
  assert.match(out.html, /url\("data:image\/png;base64,/, 'a url() inside the stylesheet was not resolved');
  assert.ok(!/url\(\.\.\/img\/bg\.png\)/.test(out.html));
});

test('@import chains are followed, and a cycle terminates', async () => {
  const p = write({
    'index.html': '<!doctype html><link rel="stylesheet" href="a.css">',
    'a.css': '@import url("b.css"); .a{color:red}',
    'b.css': '@import "a.css"; .b{color:blue}',   // deliberate cycle
  });
  const out = await inlineBundle(p, 'index.html');
  assert.match(out.html, /\.a\{color:red\}/);
  assert.match(out.html, /\.b\{color:blue\}/);
});

test('⚠️ video is REFUSED rather than inlined, and reported as skipped', async () => {
  // A data: URI cannot serve range requests, so a video inlined this way does not seek and on
  // several of these players does not play at all. Leaving the relative src alone makes it a
  // visible 404 instead of a silent black rectangle.
  const p = write({
    'index.html': '<!doctype html><video src="clip.mp4"></video>',
    'clip.mp4': Buffer.alloc(64, 7),
  });
  const out = await inlineBundle(p, 'index.html');
  assert.match(out.html, /src="clip\.mp4"/, 'the video src should be left as-is');
  assert.ok(out.skipped.includes('clip.mp4'), 'the skip was not reported');
  assert.equal(out.inlined, 0);
});

test('absolute and external references are left alone', async () => {
  const p = write({
    'index.html': '<!doctype html><img src="https://example.com/a.png"><img src="//cdn/x.png">'
      + '<img src="/root.png"><img src="data:image/gif;base64,AA"><a href="#frag">x</a>',
  });
  const out = await inlineBundle(p, 'index.html');
  assert.match(out.html, /https:\/\/example\.com\/a\.png/);
  assert.match(out.html, /"\/\/cdn\/x\.png"/);
  assert.match(out.html, /"\/root\.png"/);
  assert.match(out.html, /"#frag"/);
});

test('⚠️ a reference that climbs out of the archive is never resolved', async () => {
  const p = write({ 'index.html': '<!doctype html><img src="../../../etc/passwd">' });
  const out = await inlineBundle(p, 'index.html');
  assert.match(out.html, /src="\.\.\/\.\.\/\.\.\/etc\/passwd"/, 'it must stay an inert relative URL');
  assert.equal(out.inlined, 0);
  assert.equal(resolveRef('index.html', '../../x'), null);
  assert.equal(resolveRef('deep/dir/page.html', '../img/a.png'), 'deep/img/a.png');
});

test('⚠️ the size cap throws a 413 rather than building a document no player can hold', async () => {
  const big = Buffer.alloc(300 * 1024, 0x41);
  const files = { 'index.html': '<!doctype html>' + Array.from({ length: 8 }, (_, i) => `<img src="i${i}.png">`).join('') };
  for (let i = 0; i < 8; i++) files[`i${i}.png`] = big;
  const p = write(files);
  await assert.rejects(() => inlineBundle(p, 'index.html', { maxBytes: 1024 * 1024 }), (e) => {
    assert.equal(e.status, 413, 'the cap must surface as a 413, not a generic failure');
    assert.match(e.message, /more than 1MB|per-document limit/);
    return true;
  });
});

test('a missing entry point is an error, not an empty page', async () => {
  const p = write({ 'index.html': '<!doctype html>hi' });
  await assert.rejects(() => inlineBundle(p, 'nope.html'), /entry point is missing/);
});
