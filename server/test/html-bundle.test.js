'use strict';

/*
 * The HTML-bundle validator: what it accepts, and every reason it refuses.
 *
 * ⚠️ REAL ZIPS, BUILT BYTE BY BYTE. A validator tested against a mocked archive tests the mock.
 * These build actual central directories — including the malformed and hostile shapes, which no zip
 * tool will produce for you — and hand them to the real reader. The builder is the only way to
 * write a test for "an entry whose name is ..\..\etc\passwd" or "an entry flagged as a symlink",
 * because you cannot create either with `zip`.
 *
 * ⚠️ AND THE CAPS THESE ASSERT ARE A POLICY FILTER, NOT ENFORCEMENT. Sizes in a central directory
 * are a claim by whoever built the archive. Anything that actually inflates has to count real bytes
 * as they arrive; see the note at the top of lib/html-bundle.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const bundle = require('../lib/html-bundle');

/* ------------------------------------------------------------------ a zip builder we control */

const DOS_TIME = 0;
const DOS_DATE = 0x2100; // 1996-01-01; the date is irrelevant here and a fixed one keeps bytes stable

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * Build a zip. Each entry: { name, data, method, flags, externalAttrs, sizes }
 * `sizes: {compressed, uncompressed}` overrides what the CENTRAL DIRECTORY claims, which is how a
 * declared compression bomb is written without producing one.
 */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data == null ? '' : e.data);
    const method = e.method == null ? 0 : e.method;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const compressed = e.sizes && e.sizes.compressed != null ? e.sizes.compressed : body.length;
    const uncompressed = e.sizes && e.sizes.uncompressed != null ? e.sizes.uncompressed : raw.length;
    const flags = e.flags == null ? 0x800 : e.flags;   // 0x800 = names are UTF-8

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);     // made by unix, so externalFileAttributes is a unix mode
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed, 20);
    ch.writeUInt32LE(uncompressed, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // ⚠️ `>>> 0`: a unix mode shifted into the high 16 bits overflows int32 and comes back NEGATIVE,
    // which writeUInt32LE refuses. The same shift appears in the symlink case below.
    ch.writeUInt32LE(e.externalAttrs == null ? ((0o100644 << 16) >>> 0) : e.externalAttrs, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bundle-'));
function writeZip(entries) {
  const p = path.join(TMP, crypto.randomBytes(6).toString('hex') + '.zip');
  fs.writeFileSync(p, buildZip(entries));
  return p;
}
const HTML = '<!doctype html><title>x</title><h1>hello</h1>';

/** Assert validateBundle rejects, and that the message says why. */
async function refuses(entries, re) {
  await assert.rejects(() => bundle.validateBundle(writeZip(entries)), (err) => {
    assert.equal(err.name, 'BundleError', `expected a BundleError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.status, 400);
    assert.match(err.message, re);
    return true;
  });
}

/* ================================================================== the happy paths */

test('a plain zip with index.html at the root is a bundle', async () => {
  const p = writeZip([
    { name: 'index.html', data: HTML },
    { name: 'css/app.css', data: 'body{margin:0}', method: 8 },
    { name: 'img/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  const r = await bundle.validateBundle(p);
  assert.equal(r.entryPoint, 'index.html');
  assert.equal(r.flavour, 'zip');
  assert.equal(r.entries, 3);
  assert.ok(r.files.includes('css/app.css'), 'the file list should be normalised names');
});

test('a .wgt takes its entry point from config.xml, not from index.html', async () => {
  /*
   * Both are present and they disagree. The declared one wins — that is the difference between
   * "we support .wgt" and "we support zips that happen to be named .wgt".
   */
  const p = writeZip([
    { name: 'config.xml', data: '<?xml version="1.0"?><widget xmlns="http://www.w3.org/ns/widgets"><content src="start.html"/></widget>' },
    { name: 'start.html', data: HTML },
    { name: 'index.html', data: '<!doctype html>not this one' },
  ]);
  const r = await bundle.validateBundle(p);
  assert.equal(r.entryPoint, 'start.html');
  assert.equal(r.flavour, 'wgt');
});

test('a config.xml with no <content> falls back to index.html', async () => {
  const p = writeZip([
    { name: 'config.xml', data: '<?xml version="1.0"?><widget><name>x</name></widget>' },
    { name: 'index.html', data: HTML },
  ]);
  const r = await bundle.validateBundle(p);
  assert.equal(r.entryPoint, 'index.html');
  assert.equal(r.flavour, 'wgt', 'the container is still a widget package');
});

test('deflated entries are read, and one entry can be pulled back out', async () => {
  const p = writeZip([
    { name: 'index.html', data: HTML, method: 8 },
    { name: 'data/app.js', data: 'console.log(1)', method: 8 },
  ]);
  await bundle.validateBundle(p);
  const buf = await bundle.readBundleEntry(p, 'data/app.js');
  assert.equal(buf.toString(), 'console.log(1)');
  assert.equal(await bundle.readBundleEntry(p, 'nope.js'), null);
  assert.equal(await bundle.readBundleEntry(p, '../escape'), null, 'a traversing name must not resolve');
});

/* ================================================================== the refusals */

test('⚠️ zip slip is refused, after separators are normalised', async () => {
  await refuses([{ name: 'index.html', data: HTML }, { name: '../../etc/passwd', data: 'x' }], /unsafe path/);
  // ⚠️ The backslash form. Normalising FIRST is what catches this; a check on the raw name lets it
  // through, and then a Windows-built archive escapes on a player that splits on backslash.
  await refuses([{ name: 'index.html', data: HTML }, { name: '..\\..\\etc\\passwd', data: 'x' }], /unsafe path/);
  await refuses([{ name: 'index.html', data: HTML }, { name: '/etc/passwd', data: 'x' }], /unsafe path/);
  await refuses([{ name: 'index.html', data: HTML }, { name: 'C:\\windows\\x', data: 'x' }], /unsafe path/);
});

test('⚠️ a symlink entry is refused — the escape a name check cannot see', async () => {
  await refuses([
    { name: 'index.html', data: HTML },
    { name: 'link', data: '/etc/passwd', externalAttrs: (0o120777 << 16) >>> 0 },
  ], /symlink/);
});

test('⚠️ a declared compression bomb is refused', async () => {
  // The archive is tiny; the central directory CLAIMS a gigabyte. That is exactly the shape a bomb
  // announces, and the cheapest possible moment to refuse it.
  await refuses([
    { name: 'index.html', data: HTML },
    { name: 'bomb.bin', data: 'x', sizes: { compressed: 1024, uncompressed: 1024 * 1024 * 1024 } },
  ], /compression ratio|unpacks to more than/);
});

test('an encrypted entry is refused', async () => {
  await refuses([{ name: 'index.html', data: HTML, flags: 0x800 | 0x1 }], /encrypted/);
});

test('an unsupported compression method is refused by number', async () => {
  await refuses([{ name: 'index.html', data: HTML, method: 12 }], /unsupported compression method \(12\)/);
});

test('duplicate entry names are refused, so a second hidden index.html cannot ride along', async () => {
  await refuses([{ name: 'index.html', data: HTML }, { name: 'index.html', data: 'other' }], /two entries named/);
});

test('a non-UTF8 name is refused rather than guessed at', async () => {
  await refuses([
    { name: 'index.html', data: HTML },
    { name: 'caf\u00e9.html', data: 'x', flags: 0 },   // high bytes, UTF-8 flag deliberately cleared
  ], /non-UTF8 name/);
});

test('an archive with no entry point is refused, and says what was expected', async () => {
  await refuses([{ name: 'readme.txt', data: 'hi' }], /no entry point/);
});

test('⚠️ a config.xml pointing at a file the bundle does not ship is refused, not fallen back on', async () => {
  await refuses([
    { name: 'config.xml', data: '<widget><content src="missing.html"/></widget>' },
    { name: 'index.html', data: HTML },
  ], /does not contain/);
});

test('a config.xml declaring a traversing start file is refused', async () => {
  await refuses([
    { name: 'config.xml', data: '<widget><content src="../../../etc/passwd"/></widget>' },
    { name: 'index.html', data: HTML },
  ], /unsafe start file/);
});

test('too many entries is refused', async () => {
  const many = [{ name: 'index.html', data: HTML }];
  for (let i = 0; i < bundle.MAX_ENTRIES + 1; i++) many.push({ name: `f${i}.txt`, data: 'x' });
  await refuses(many, /more than \d+ entries/);
});

test('a path deeper than the limit is refused', async () => {
  const deep = new Array(20).fill('d').join('/') + '/x.png';
  await refuses([{ name: 'index.html', data: HTML }, { name: deep, data: 'x' }], /unsafe path/);
});

test('something that is not a zip at all is refused cleanly', async () => {
  const p = path.join(TMP, 'notazip.zip');
  fs.writeFileSync(p, Buffer.from('this is just text, at some length, but no central directory'));
  await assert.rejects(() => bundle.validateBundle(p), /Not a readable zip archive/);
});

test('an empty file is refused before the zip reader ever sees it', async () => {
  const p = path.join(TMP, 'empty.zip');
  fs.writeFileSync(p, Buffer.alloc(0));
  await assert.rejects(() => bundle.validateBundle(p), /empty/);
});

test('the bundle mime matches nothing the media routing looks for', () => {
  /*
   * mime_type is the routing key everywhere — the ?type= buckets, the thumbnail backfill, every
   * player's dispatch chain. If this string ever started with image/ or video/ it would be routed
   * as media by code that has no idea bundles exist.
   */
  assert.ok(!bundle.BUNDLE_MIME.startsWith('image/'));
  assert.ok(!bundle.BUNDLE_MIME.startsWith('video/'));
  assert.match(bundle.BUNDLE_MIME, /^application\//);
});
