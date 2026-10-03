'use strict';

/*
 * What a failed payload install leaves behind on a BrightSign.
 *
 * ⚠️ THE INCIDENT THIS EXISTS FOR. The 2.0.0-alpha5 install on a real XT245 ended with VERSION
 * reading the new number, the server running, `.payload-install.log` stopping three lines in, and no
 * `.payload-sha256` recorded. It could not be diagnosed, because every account of the failure lived
 * somewhere unreachable: `installState` is served by a listener bound to localhost (#291,
 * deliberately — it must not answer the LAN), and the on-screen ring buffer is gone at the next
 * reboot. The one artefact a technician can fetch over DWS from a box on a wall in another building
 * contained everything except why it broke.
 *
 * ⚠️ AND THE STATE IT LEAVES IS WORSE THAN A CLEAN FAILURE. The replace loop is not atomic: it
 * removes and renames one top-level entry at a time. Die part way and the tree is a MIXTURE — and
 * that tree boots, because the caller correctly treats a failed update as survivable and starts the
 * server it finds. So the box comes up reporting a version nobody built.
 *
 * These run the real installer against a real temp directory and a real local HTTP server. The
 * failures are induced by making the filesystem refuse, which is the only way to reach the paths
 * that matter.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const installer = require('../../brightsign/server/bs-payload-install.js');

/* ---------------------------------------------------------------- a minimal STORED zip */
function storedZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32 ? zlib.crc32(data) : require('node:zlib').crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cd, end]);
}

const PAYLOAD = storedZip({
  'VERSION': '9.9.9-test\n',
  'server/server.js': 'module.exports = 1;\n',
  'shared/thing.js': 'module.exports = 2;\n',
});
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

async function serve(body) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/server-payload.zip`, close: () => srv.close() };
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bsinstall-'));
  return d;
}
const readLog = (d) => {
  try { return fs.readFileSync(path.join(d, '.payload-install.log'), 'utf8'); } catch (e) { return ''; }
};

/* ================================================================= the happy path, as a control */

test('a clean install records the digest and leaves no mixture marker', async () => {
  const dir = tmpDir();
  const s = await serve(PAYLOAD);
  try {
    const r = await installer.install({ url: s.url, installDir: dir, expectSha256: SHA });
    assert.ok(r.files >= 3);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), '9.9.9-test');
    assert.equal(fs.readFileSync(path.join(dir, '.payload-sha256'), 'utf8').trim(), SHA);
    assert.ok(!fs.existsSync(path.join(dir, '.payload-incomplete')),
      'the mixture marker survived a successful install');
    assert.match(readLog(dir), /installed \d+ files/);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ================================================================= the reason this file exists */

test('⚠️ a checksum mismatch is WRITTEN TO THE LOG, not just thrown', async () => {
  /*
   * Before the fix every throw skipped the log entirely: it simply stopped at the last successful
   * step, and the reason lived in installState (localhost-only) and the ring buffer (gone at the
   * next reboot). This is the artefact a technician can actually fetch.
   */
  const dir = tmpDir();
  const s = await serve(PAYLOAD);
  try {
    await assert.rejects(
      installer.install({ url: s.url, installDir: dir, expectSha256: 'f'.repeat(64) }),
      /checksum mismatch/);
    const log = readLog(dir);
    assert.match(log, /FAILED:/, 'the failure never reached the log');
    assert.match(log, /checksum mismatch/, 'the log does not say what went wrong');
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ a failure while replacing the tree NAMES the entry and marks the tree a mixture', async () => {
  /*
   * The alpha5 shape, induced where it actually happens.
   *
   * ⚠️ THE FIRST VERSION OF THIS TEST WAS VACUOUS and a mutation run said so: it chmod'd the
   * install directory read-only, which made the install fail during DOWNLOAD — long before the
   * replace loop — so the code it was written for never ran, and deleting that code left the test
   * passing. Making renameSync throw is the only way to reach the loop's failure path, because
   * reaching it for real needs a filesystem that misbehaves halfway through.
   */
  const dir = tmpDir();
  const s = await serve(PAYLOAD);
  const realRename = fs.renameSync;
  fs.renameSync = function patched(from, to) {
    if (path.basename(to) === 'shared') throw new Error('EIO: simulated mid-replace failure');
    return realRename.apply(fs, arguments);
  };
  try {
    await assert.rejects(
      installer.install({ url: s.url, installDir: dir, expectSha256: SHA }),
      /simulated mid-replace failure/);

    const log = readLog(dir);
    assert.match(log, /FAILED while replacing "shared"/, 'the log does not name the entry it died on');
    assert.match(log, /MIXTURE of versions/, 'the log does not say the tree is now inconsistent');
    assert.match(log, /FAILED:/, 'the wrapper did not record the failure');

    // ⚠️ And the marker is LEFT BEHIND, which is what the next boot reads.
    assert.ok(fs.existsSync(path.join(dir, '.payload-incomplete')),
      'no mixture marker — the next boot would trust VERSION and keep a half-installed tree');
    // ...and the digest was never recorded, so nothing claims this tree is a known build.
    assert.ok(!fs.existsSync(path.join(dir, '.payload-sha256')),
      'a digest was recorded for a tree that was never fully replaced');
  } finally {
    fs.renameSync = realRename;
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ the log and the marker live OUTSIDE the replaced tree, or they would vanish with it', () => {
  /*
   * The replace iterates the PAYLOAD's top-level entries. Neither dotfile is one of them, which is
   * what lets a post-replace note() land and what lets the marker survive to be read at the next
   * boot. If a payload ever shipped a file with either name, both diagnostics would disappear at
   * exactly the moment they matter — so this asserts the payload does not.
   */
  const names = ['.payload-install.log', '.payload-incomplete', '.payload-sha256'];
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'build-server-zip.sh'), 'utf8');
  for (const n of names) {
    assert.ok(!new RegExp(`(^|[\\s'"/])${n.replace(/\./g, '\\.')}`, 'm').test(src)
      || /exclude/i.test(src),
      `${n} may be shipped inside the payload, which would delete it during the replace`);
  }
});

/* ================================================================= the boot side of it */

test('⚠️ a mixture marker makes the launcher reinstall, whatever VERSION claims', () => {
  /*
   * The half of the fix that turns a silent mixed tree into a self-healing one. differs() must
   * ignore the digest and the version when the marker is present — those are precisely the values
   * a half-finished replace makes untrustworthy.
   */
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'brightsign', 'server', 'bs-server-boot.js'), 'utf8');
  const fn = src.match(/function differs\([\s\S]*?\n\}/);
  assert.ok(fn, 'differs() is gone — the mixture check went with it');
  assert.match(fn[0], /treeIsMixture\(\)/,
    'differs() no longer consults the mixture marker, so a half-installed tree looks current');
  // ...and it is checked FIRST, before the digest can short-circuit it.
  const body = fn[0];
  assert.ok(body.indexOf('treeIsMixture') < body.indexOf('manifest.sha256'),
    'the digest is compared before the mixture check, so a mixed tree with a matching digest is kept');
});
