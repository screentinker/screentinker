'use strict';

/*
 * lib/ipk-cache.js publishes, at /webos/version.json, the version of the .ipk it then serves at
 * /webos/<file>. Those two used to be unrelated: the version was this server's package.json and the
 * file was the first candidate that existed. On prod a 2.5.1 ScreenTinker.ipk left in the data dir
 * was served under "3.1.2", so every panel that self-updated downloaded a package older than the
 * one it ran. The version is now read out of the file, the newest candidate is served, and a file
 * carrying the other build's app id is never served under this name.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ipk = require('../lib/ipk-cache');

// A minimal .ipk: an `ar` of debian-binary + control.tar.gz + data.tar.gz, in the two spellings the
// two packagers write — GNU ar (build-ipk.sh fallback: "name/" members, ./control in the tar) and
// ares-package (plain names, control at the tar root).
function tarEntry(name, body) {
  const data = Buffer.from(body);
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function arMember(name, body, gnu) {
  const h = Buffer.alloc(60, ' ');
  h.write(gnu ? name + '/' : name, 0);
  h.write(gnu ? '0' : '1700000000', 16); h.write('0', 28); h.write('0', 34); h.write('644', 40);
  h.write(String(body.length), 48); h.write('`\n', 58);
  return Buffer.concat([h, body, body.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
}
function makeIpk(id, version, { gnu = true } = {}) {
  const control = `Package: ${id}\nVersion: ${version}\nArchitecture: all\n`;
  const ctar = zlib.gzipSync(Buffer.concat([tarEntry(gnu ? './control' : 'control', control), Buffer.alloc(1024)]));
  const dtar = zlib.gzipSync(Buffer.concat([tarEntry(`usr/palm/applications/${id}/appinfo.json`, '{}'), Buffer.alloc(1024)]));
  return Buffer.concat([Buffer.from('!<arch>\n'), arMember('debian-binary', Buffer.from('2.0\n'), gnu),
    arMember('control.tar.gz', ctar, gnu), arMember('data.tar.gz', dtar, gnu)]);
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st-ipk-')); }

test('readIpk reads the app id and version out of both packagers\' archives', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'gnu.ipk'), makeIpk('com.screentinker.player', '3.1.2', { gnu: true }));
  fs.writeFileSync(path.join(dir, 'ares.ipk'), makeIpk('com.lg.app.signage', '3.0.3', { gnu: false }));
  fs.writeFileSync(path.join(dir, 'junk.ipk'), 'not an archive at all');
  assert.deepEqual(ipk.readIpk(path.join(dir, 'gnu.ipk')), { id: 'com.screentinker.player', version: '3.1.2' });
  assert.deepEqual(ipk.readIpk(path.join(dir, 'ares.ipk')), { id: 'com.lg.app.signage', version: '3.0.3' });
  assert.equal(ipk.readIpk(path.join(dir, 'junk.ipk')), null);
  assert.equal(ipk.readIpk(path.join(dir, 'missing.ipk')), null);
});

test('the newest candidate is served, and version.json says what is inside it', () => {
  const dir = tmpdir();
  const stale = path.join(dir, 'data', 'ScreenTinker.ipk');
  const current = path.join(dir, 'root', 'ScreenTinker.ipk');
  fs.mkdirSync(path.dirname(stale)); fs.mkdirSync(path.dirname(current));
  fs.writeFileSync(stale, makeIpk('com.screentinker.player', '2.5.1'));
  fs.writeFileSync(current, makeIpk('com.screentinker.player', '3.1.2'));
  // The data-dir copy is listed first (it used to win outright). It is 2.5.1; the root is 3.1.2.
  const chosen = ipk.resolveAmong([stale, current], 'com.screentinker.player');
  assert.equal(chosen.path, current, 'the stale operator copy loses to the newer release file');
  assert.equal(chosen.version, '3.1.2');
  const v = ipk.versionJson(chosen, { exists: false });
  assert.equal(v.version, '3.1.2', 'the version a panel is told is the version it will download');
  assert.equal(v.available, true);
  // When the operator copy IS the newest (a pinned newer build), it still wins, as before.
  fs.writeFileSync(stale, makeIpk('com.screentinker.player', '3.2.0'));
  assert.equal(ipk.resolveAmong([stale, current], 'com.screentinker.player').path, stale);
  // A tie goes to the earlier candidate (the operator's mount), as before.
  fs.writeFileSync(stale, makeIpk('com.screentinker.player', '3.1.2'));
  assert.equal(ipk.resolveAmong([stale, current], 'com.screentinker.player').path, stale);
});

test('a file with the other build\'s app id is never served under this name', () => {
  const dir = tmpdir();
  const wrong = path.join(dir, 'com.lg.app.signage.ipk');
  // ScreenTinker.ipk renamed/copied over the Local build: a panel in Local mode refuses it.
  fs.writeFileSync(wrong, makeIpk('com.screentinker.player', '3.1.2'));
  const warn = console.warn; const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    const chosen = ipk.resolveAmong([wrong], 'com.lg.app.signage', 'com.lg.app.signage.ipk');
    assert.equal(chosen.exists, false, 'nothing is served rather than a package the panel refuses');
    assert.ok(warned.some((m) => /com\.screentinker\.player/.test(m)), 'and the operator is told why');
  } finally { console.warn = warn; }
});

test('a file that is not readable as an .ipk is still served, under the server version, when it is all there is', () => {
  const dir = tmpdir();
  const opaque = path.join(dir, 'ScreenTinker.ipk');
  fs.writeFileSync(opaque, 'opaque bytes');
  const chosen = ipk.resolveAmong([opaque], 'com.screentinker.player');
  assert.equal(chosen.path, opaque);
  assert.equal(chosen.version, require('../package.json').version);
});

test('compareVersions is numeric per component, like the shell\'s newer()', () => {
  assert.ok(ipk.compareVersions('3.0.10', '3.0.9') > 0);
  assert.ok(ipk.compareVersions('2.5.1', '3.1.2') < 0);
  assert.equal(ipk.compareVersions('3.1.2', '3.1.2'), 0);
});
