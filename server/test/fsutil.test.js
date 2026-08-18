'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyFileBytes } = require('../lib/fsutil');

/*
 * These guard the copy used for pre-migration database snapshots. WHY it is not fs.copyFileSync is
 * exFAT, and that reasoning lives in lib/fsutil.js. What these check is the part that could still
 * go wrong once the reason is accepted: that the replacement is a faithful copy, including across
 * the 1MB chunk boundary its loop uses. A snapshot that is silently truncated is worse than no
 * snapshot, because the migration proceeds believing it has a backup.
 */

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fsutil-')); }

test('copies a file byte-for-byte, including non-ASCII bytes', () => {
  const dir = tmp();
  const src = path.join(dir, 'a.bin');
  const dest = path.join(dir, 'b.bin');
  const data = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x41, 0x0a, 0xc3, 0xbf]);
  fs.writeFileSync(src, data);
  assert.strictEqual(copyFileBytes(src, dest), data.length);
  assert.deepStrictEqual(fs.readFileSync(dest), data);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copies a file larger than one chunk', () => {
  const dir = tmp();
  const src = path.join(dir, 'big.bin');
  const dest = path.join(dir, 'big-copy.bin');
  // 2.5MB: two full 1MB reads plus a partial one, so an off-by-one in the loop shows up here
  // rather than on a player, at boot, in a database backup.
  const data = Buffer.alloc(2621440);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(src, data);
  assert.strictEqual(copyFileBytes(src, dest), data.length);
  assert.strictEqual(fs.readFileSync(dest).equals(data), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('overwrites an existing destination completely', () => {
  // 'w' truncates. If it did not, copying a short file over a longer one would leave a tail of the
  // old contents behind - and the old contents here would be a previous database snapshot.
  const dir = tmp();
  const src = path.join(dir, 'short.bin');
  const dest = path.join(dir, 'long.bin');
  fs.writeFileSync(src, 'short');
  fs.writeFileSync(dest, 'a very much longer previous file');
  copyFileBytes(src, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'short');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty file copies as empty rather than failing', () => {
  const dir = tmp();
  const src = path.join(dir, 'empty.bin');
  const dest = path.join(dir, 'empty-copy.bin');
  fs.writeFileSync(src, '');
  assert.strictEqual(copyFileBytes(src, dest), 0);
  assert.strictEqual(fs.statSync(dest).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing source throws rather than leaving an empty destination behind', () => {
  // The caller treats a thrown error as "do not migrate". Creating the destination first and then
  // failing would leave a zero-byte file that looks like a snapshot.
  const dir = tmp();
  const dest = path.join(dir, 'out.bin');
  assert.throws(() => copyFileBytes(path.join(dir, 'nope.bin'), dest));
  assert.strictEqual(fs.existsSync(dest), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the copy carries the source permissions across', () => {
  // ⚠️ REGRESSION GUARD. The first version of copyFileBytes dropped the chmod entirely, because
  // chmod is exactly what made fs.copyFileSync fail on exFAT. The copy then landed at the default
  // 0666 & ~umask: a 0600 database snapshot came out 0664, making the whole database group- and
  // world-readable on every install. Removing a permission check to fix a permission error is not
  // a fix.
  const dir = tmp();
  const src = path.join(dir, 'db.sqlite');
  const dest = path.join(dir, 'snapshot.db');
  fs.writeFileSync(src, 'SQLite format 3\0payload');
  fs.chmodSync(src, 0o600);

  copyFileBytes(src, dest);

  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.strictEqual(mode(dest), 0o600,
    `snapshot should be 0600 like its source, was 0${mode(dest).toString(8)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a filesystem that refuses chmod still gets its bytes', () => {
  // The exFAT case, which is the whole reason this function exists rather than fs.copyFileSync.
  // The bytes are written before the mode is attempted, so a refusal must not fail the copy.
  const dir = tmp();
  const src = path.join(dir, 'a.bin');
  const dest = path.join(dir, 'b.bin');
  const data = Buffer.from('bytes that must survive a chmod refusal');
  fs.writeFileSync(src, data);

  const realFchmod = fs.fchmodSync;
  fs.fchmodSync = () => { const e = new Error('EPERM: operation not permitted, fchmod'); e.code = 'EPERM'; throw e; };
  try {
    assert.doesNotThrow(() => copyFileBytes(src, dest), 'a refused chmod must not fail the copy');
    assert.deepStrictEqual(fs.readFileSync(dest), data);
  } finally {
    fs.fchmodSync = realFchmod;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
