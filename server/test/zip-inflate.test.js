'use strict';

/*
 * lib/zip-inflate.js inflateToFileCapped: the promise settles only once the WriteStream has
 * CLOSED, so a caller that removes its extract dir right after can never race the file.
 *
 * ⚠️ THE RACE IS FORCED, NOT HOPED FOR. The stream opens its file on the libuv threadpool. Each
 * case first fills every pool thread with a slow pbkdf2, so the open is still queued when the
 * entry's first (oversized) chunk arrives and the failure lands before the file exists. Before the
 * fix the partial file was rm'd, the promise rejected, and the file was created afterwards.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { inflateToFileCapped } = require('../lib/zip-inflate');

const POOL = Number(process.env.UV_THREADPOOL_SIZE) || 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entryOf = (chunks) => ({ stream: () => Readable.from(chunks) });
const erroring = () => ({
  stream: () => new Readable({ read() { this.destroy(new Error('bad deflate')); } }),
});

// Occupy every threadpool thread for a while, so a fs open queued now waits behind them.
function busyPool() {
  return Promise.all(Array.from({ length: POOL }, () => new Promise((r) => {
    crypto.pbkdf2('x', 'y', 200000, 32, 'sha256', r);
  })));
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st-zip-inflate-')); }

test('an entry that overflows before the file is open leaves no file, then or later', async () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 5; i++) {
      const dest = path.join(dir, `big-${i}`);
      const busy = busyPool();
      await assert.rejects(inflateToFileCapped(entryOf([Buffer.alloc(1000)]), dest, 10, null),
        { code: 'ZIP_ENTRY_TOO_LARGE' });
      assert.equal(fs.existsSync(dest), false, 'no file when the promise rejects');
      await busy;
      await sleep(200);
      assert.equal(fs.existsSync(dest), false, 'and none appears afterwards');
    }
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.rmdirSync(dir);   // not recursive: fails if anything was left behind
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a shared budget overrun is cleaned up the same way', async () => {
  const dir = tmp();
  try {
    const dest = path.join(dir, 'f');
    const budget = { remaining: 10 };
    const busy = busyPool();
    await assert.rejects(inflateToFileCapped(entryOf([Buffer.alloc(100)]), dest, 1000, budget),
      { code: 'ZIP_ENTRY_TOO_LARGE' });
    assert.equal(fs.existsSync(dest), false);
    await busy;
    await sleep(200);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt entry (source errors at once) leaves no file, then or later', async () => {
  const dir = tmp();
  try {
    const dest = path.join(dir, 'f');
    const busy = busyPool();
    await assert.rejects(inflateToFileCapped(erroring(), dest, 1000, null), { code: 'ZIP_ENTRY_CORRUPT' });
    assert.equal(fs.existsSync(dest), false);
    await busy;
    await sleep(200);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the caller\'s makeError builds the rejection', async () => {
  const dir = tmp();
  try {
    const dest = path.join(dir, 'f');
    await assert.rejects(inflateToFileCapped(entryOf([Buffer.alloc(100)]), dest, 10, null,
      (kind) => new Error(`custom ${kind}`)), /custom too-large/);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('success resolves only once the file is complete and closed', async () => {
  const dir = tmp();
  try {
    const data = crypto.randomBytes(256 * 1024);
    const dest = path.join(dir, 'ok');
    let closed = false;
    const real = fs.createWriteStream;
    fs.createWriteStream = (...a) => { const w = real(...a); w.on('close', () => { closed = true; }); return w; };
    let n;
    try {
      n = await inflateToFileCapped(entryOf([data.subarray(0, 1000), data.subarray(1000)]), dest, data.length, null);
    } finally { fs.createWriteStream = real; }
    assert.equal(closed, true, 'the WriteStream has closed when the promise resolves');
    assert.equal(n, data.length);
    assert.ok(fs.readFileSync(dest).equals(data), 'the whole entry is on disk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file that already exists is refused (wx), and the promise still settles', async () => {
  const dir = tmp();
  try {
    const dest = path.join(dir, 'f');
    fs.writeFileSync(dest, 'x');
    await assert.rejects(inflateToFileCapped(entryOf([Buffer.from('abc')]), dest, 10, null), { code: 'EEXIST' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
