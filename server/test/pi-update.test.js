'use strict';

/*
 * Native Raspberry Pi self-update: lib/deb-cache.js (which package, what hash) and
 * routes/pi-update.js (/api/pi/update/check + /download/pi), the latter against a real server.
 *
 * What is worth pinning, in order of how much it would hurt:
 *   1. the advertised sha256 is the hash of the bytes /download/pi actually serves — the Pi verifies
 *      it before dpkg, so a mismatch is a fleet that downloads, rejects, and retries forever;
 *   2. the kill switches (global + per-device) are honoured server-side, as for Android;
 *   3. a test build dropped next to a release is NOT offered to every Pi.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-piupd-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;           // for the in-process deb-cache tests below
// ⚠️ Hermetic: without this the in-repo fallback (<repo>/native/dist) is searched, and a developer who
// has run pi/packaging/build-deb.sh gets a "package hosted" result where the test expects none.
process.env.PI_DIST_DIR = path.join(DATA_DIR, 'no-repo-dist');
// The spawned server also resolves the Windows installer (lib/win-cache.js); keep that hermetic too.
process.env.WIN_DIST_DIR = path.join(DATA_DIR, 'no-repo-dist');
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const debCache = require('../lib/deb-cache');
const { freePort } = require('./helpers/free-port');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------ pure

test('pickNewest orders by version, not by listing order or mtime', () => {
  const r = debCache.pickNewest([
    'screentinker-pi_1.9.0_all.deb', 'screentinker-pi_1.10.0_all.deb', 'screentinker-pi_1.2.3_all.deb',
    'README', 'screentinker-pi_1.11.0_arm64.deb', 'other_2.0.0_all.deb', 'screentinker-pi_bogus_all.deb',
  ]);
  assert.deepEqual(r, { name: 'screentinker-pi_1.10.0_all.deb', version: '1.10.0' }, '1.10 > 1.9 numerically; wrong arch / name ignored');
  assert.equal(debCache.pickNewest([]), null);
  assert.equal(debCache.pickNewest(['nothing.txt']), null);
});

test('⚠️ a release beats any prerelease — a test build is never offered to the whole fleet', () => {
  const r = debCache.pickNewest(['screentinker-pi_1.2.0_all.deb', 'screentinker-pi_1.3.0~beta1_all.deb']);
  assert.equal(r.version, '1.2.0');
  // Only a directory with no release at all serves a prerelease, and Debian `~` is normalised.
  assert.deepEqual(debCache.pickNewest(['screentinker-pi_1.3.0~beta2_all.deb', 'screentinker-pi_1.3.0~beta10_all.deb']),
    { name: 'screentinker-pi_1.3.0~beta10_all.deb', version: '1.3.0-beta10' });
});

test('deb-cache resolves DATA_DIR, hashes the file once, and never advertises a stale hash', async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, 'screentinker-pi_3.0.0_all.deb');
  fs.writeFileSync(f, Buffer.from('first build'));
  debCache.refresh();
  assert.equal(debCache.get().exists, true);
  const first = await debCache.ready();
  assert.equal(first.sha256, crypto.createHash('sha256').update('first build').digest('hex'));
  assert.equal(first.version, '3.0.0');
  assert.equal(first.filename, 'screentinker-pi_3.0.0_all.deb');

  // Replaced in place with different bytes (and size): the old hash must not survive the refresh.
  fs.writeFileSync(f, Buffer.from('second build, longer'));
  const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
  const mid = debCache.refresh();
  assert.equal(mid.sha256, null, 'exists-but-unhashed until the new hash lands');
  const second = await debCache.ready();
  assert.equal(second.sha256, crypto.createHash('sha256').update('second build, longer').digest('hex'));

  fs.unlinkSync(f);
  assert.equal(debCache.refresh().exists, false);
});

// ------------------------------------------------------------------------------ HTTP, real server

const SRV_DIR = path.join(os.tmpdir(), 'st-piupd-srv-' + crypto.randomBytes(4).toString('hex'));
const DEB_BYTES = crypto.randomBytes(4096);
let proc, BASE;

before(async () => {
  fs.mkdirSync(SRV_DIR, { recursive: true });
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-pi_1.1.0_all.deb'), DEB_BYTES);
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-pi_1.0.0_all.deb'), Buffer.from('older'));
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-pi_1.2.0~rc1_all.deb'), Buffer.from('test build'));
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: SRV_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', OTA_APK_REFRESH_MS: '300',
      // These tests pin the offer itself; health-checked waves are covered by ota-rollout.test.js.
      OTA_STAGED_ROLLOUT: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* booting */ }
    await sleep(150);
  }
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const check = async (q) => (await fetch(`${BASE}/api/pi/update/check?${q}`)).json();

test('an older Pi is offered the newest RELEASE, with the hash and size of the served bytes', async () => {
  let r;
  for (let i = 0; i < 20; i++) { r = await check('version=1.0.0&device_id=pi-older'); if (r.reason !== 'deb-hashing') break; await sleep(150); }
  assert.equal(r.update_available, true, JSON.stringify(r));
  assert.equal(r.latest_version, '1.1.0', 'the rc beside it is not what the fleet gets');
  assert.equal(r.current_version, '1.0.0');
  assert.equal(r.download_url, '/download/pi');
  assert.equal(r.size, DEB_BYTES.length);
  assert.equal(r.sha256, crypto.createHash('sha256').update(DEB_BYTES).digest('hex'));

  const dl = await fetch(BASE + r.download_url);
  assert.equal(dl.status, 200);
  const body = Buffer.from(await dl.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), r.sha256, '⚠️ advertised hash must match the served bytes');
  assert.match(dl.headers.get('content-disposition') || '', /screentinker-pi_1\.1\.0_all\.deb/);
  assert.equal(dl.headers.get('x-package-sha256'), r.sha256);
});

test('an up-to-date or newer Pi is offered nothing, and a missing version is refused', async () => {
  let r = await check('version=1.1.0&device_id=pi-current');
  assert.equal(r.update_available, false); assert.equal(r.reason, 'up-to-date');
  assert.equal(r.sha256, null, 'no hash on a non-offer');
  r = await check('version=2.0.0&device_id=pi-newer');
  assert.equal(r.update_available, false); assert.equal(r.reason, 'client-newer');
  r = await check('device_id=pi-noversion');
  assert.equal(r.update_available, false); assert.equal(r.reason, 'no-version');
});

test('⚠️ the root helper lookup (?version= only) gets the hash, even for the version it is installing', async () => {
  // native/packaging/linux/st-helper install-deb verifies a screentinker-pi .deb against THIS answer
  // before running it as root; the package name alone proves nothing.
  const want = crypto.createHash('sha256').update(DEB_BYTES).digest('hex');
  for (const q of ['version=0.0.0&forced=1', 'version=1.1.0', 'version=1.0.0']) {
    const r = await check(q);
    assert.equal(r.reason, 'package-lookup', q + ' ' + JSON.stringify(r));
    assert.equal(r.sha256, want, q);
  }
  for (let i = 0; i < 30; i++) {
    assert.equal((await check('version=1.0.1')).reason, 'package-lookup', 'a retrying helper never trips the breaker');
  }
});

test('the per-device kill switch is honoured server-side', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(SRV_DIR, 'db', 'remote_display.db'));
  db.prepare(`INSERT INTO devices (id, pairing_code, status, client_type, platform, ota_enabled)
              VALUES ('pi-ota-off', '977001', 'offline', 'pi', 'Linux/Debian 12 (Raspberry Pi 4 Model B)', 0)`).run();
  db.close();
  const r = await check('version=1.0.0&device_id=pi-ota-off');
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'ota_disabled_device');
});

test('/download lists the native Pi package with its version', async () => {
  const html = await (await fetch(BASE + '/download')).text();
  assert.ok(html.includes('id="raspberry-pi-native"'));
  assert.ok(html.includes('v1.1.0'), 'the version the check advertises');
  assert.ok(html.includes('href="/download/pi"'));
});

test('with no package hosted: deb-missing and a 404, not an offer of nothing', async () => {
  for (const f of fs.readdirSync(SRV_DIR)) if (f.endsWith('.deb')) fs.unlinkSync(path.join(SRV_DIR, f));
  let r;
  for (let i = 0; i < 30; i++) { r = await check('version=1.0.0&device_id=pi-gone'); if (r.reason === 'deb-missing') break; await sleep(150); }
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'deb-missing');
  assert.equal((await fetch(BASE + '/download/pi')).status, 404);
});

// ------------------------------------------------------------------------------ global switch, in-process

test('the global OTA kill switch refuses before anything else', async () => {
  const express = require('express');
  const config = require('../config');
  const saved = config.otaEnabled;
  config.otaEnabled = false;
  const app = express();
  require('../routes/pi-update')(app, { db: { prepare: () => ({ get: () => null }) }, getBand: () => 'normal' });
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const r = await (await fetch(`http://127.0.0.1:${port}/api/pi/update/check?version=0.0.1`)).json();
    assert.equal(r.update_available, false);
    assert.equal(r.reason, 'ota_disabled_global');
  } finally { srv.close(); config.otaEnabled = saved; }
});
