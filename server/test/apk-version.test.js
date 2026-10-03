'use strict';
/*
 * #341 — the OTA endpoint must advertise the version of the bytes it would actually serve.
 *
 * A 2.0.7 server serving a hand-mounted 2.0.0 APK offered 2.0.7, Android accepted the download as
 * a same-version reinstall, and two field displays looped 493 times over five days. lib/apk-version
 * reads the versionName out of the APK so the server cannot claim a version it does not hold.
 *
 * Built synthetically rather than from a committed .apk: the parser is the thing under test, a real
 * APK is 9 MB, and a fixture would pin one build forever. Cross-checked separately against
 * `aapt2 dump badging` on three real builds (1.7.7 twice, 2.0.7).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { readApkVersionName, versionNameFromAxml } = require('../lib/apk-version');

/* ---- minimal Android binary XML: <manifest android:versionName="X"> ---- */
function axml(version, { literal = true } = {}) {
  const strs = ['manifest', 'versionName', version];
  const enc = strs.map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([b.length, b.length]), b, Buffer.from([0])]);
  });
  const offsets = Buffer.alloc(strs.length * 4);
  let acc = 0;
  enc.forEach((b, i) => { offsets.writeUInt32LE(acc, i * 4); acc += b.length; });
  const data = Buffer.concat(enc);
  const poolHeader = Buffer.alloc(28);
  const poolSize = 28 + offsets.length + data.length;
  poolHeader.writeUInt16LE(0x0001, 0); poolHeader.writeUInt16LE(28, 2);
  poolHeader.writeUInt32LE(poolSize, 4);
  poolHeader.writeUInt32LE(strs.length, 8); poolHeader.writeUInt32LE(0, 12);
  poolHeader.writeUInt32LE(1 << 8, 16);                  // UTF8_FLAG
  poolHeader.writeUInt32LE(28 + offsets.length, 20); poolHeader.writeUInt32LE(0, 24);
  const pool = Buffer.concat([poolHeader, offsets, data]);

  const el = Buffer.alloc(36 + 20);
  el.writeUInt16LE(0x0102, 0); el.writeUInt16LE(16, 2); el.writeUInt32LE(el.length, 4);
  el.writeUInt32LE(1, 8);                                 // lineNumber
  el.writeUInt32LE(0xFFFFFFFF, 12);                       // comment
  el.writeUInt32LE(0xFFFFFFFF, 16);                       // ns
  el.writeUInt32LE(0, 20);                                // name -> 'manifest'
  el.writeUInt16LE(20, 24); el.writeUInt16LE(20, 26); el.writeUInt16LE(1, 28);
  const a = 36;
  el.writeUInt32LE(0xFFFFFFFF, a);                        // attr ns
  el.writeUInt32LE(1, a + 4);                             // attr name -> 'versionName'
  el.writeUInt32LE(literal ? 2 : 0xFFFFFFFF, a + 8);      // rawValue -> the version string
  el.writeUInt16LE(8, a + 12); el.writeUInt8(0, a + 14);
  el.writeUInt8(0x03, a + 15);                            // TYPE_STRING
  el.writeUInt32LE(2, a + 16);

  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0); head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + pool.length + el.length, 4);
  return Buffer.concat([head, pool, el]);
}

/* ---- minimal zip holding one deflated entry ---- */
function zip(name, contents) {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(contents);
  const crc = (() => { // zip CRC32
    let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xFFFFFFFF; for (const b of contents) x = t[(x ^ b) & 0xFF] ^ (x >>> 8);
    return (x ^ 0xFFFFFFFF) >>> 0;
  })();
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(deflated.length, 18);
  lh.writeUInt32LE(contents.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lh, nameBuf, deflated]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(8, 10);
  cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(deflated.length, 20);
  cdh.writeUInt32LE(contents.length, 24); cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);
  const cd = Buffer.concat([cdh, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, eocd]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-apkver-'));
const write = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };

test('reads versionName straight out of an APK', () => {
  assert.equal(readApkVersionName(write('a.apk', zip('AndroidManifest.xml', axml('2.0.0')))), '2.0.0');
  assert.equal(readApkVersionName(write('b.apk', zip('AndroidManifest.xml', axml('1.9.24')))), '1.9.24');
  assert.equal(readApkVersionName(write('c.apk', zip('AndroidManifest.xml', axml('2.1.0-beta3')))), '2.1.0-beta3');
});

test('the typed value is used when there is no raw literal', () => {
  assert.equal(readApkVersionName(write('d.apk', zip('AndroidManifest.xml', axml('3.2.1', { literal: false })))), '3.2.1');
});

test('anything unreadable is null, never a guess and never a throw', () => {
  assert.equal(readApkVersionName(path.join(tmp, 'missing.apk')), null);
  assert.equal(readApkVersionName(write('notzip.apk', Buffer.from('this is not a zip at all'))), null);
  assert.equal(readApkVersionName(write('nomanifest.apk', zip('classes.dex', Buffer.from('x')))), null);
  assert.equal(readApkVersionName(write('empty.apk', Buffer.alloc(0))), null);
  assert.equal(versionNameFromAxml(Buffer.alloc(4)), null);
  assert.equal(versionNameFromAxml(null), null);
});

test('a manifest with no versionName reports null rather than the wrong attribute', () => {
  const noVer = axml('9.9.9');
  noVer.writeUInt32LE(0, noVer.length - 20 + 4);   // rename the attribute to 'manifest'
  assert.equal(versionNameFromAxml(noVer), null);
});
