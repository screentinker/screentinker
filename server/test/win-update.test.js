'use strict';

/*
 * Native Windows self-update: routes/win-update.js (/api/win/update/check + /download/win) against a
 * real server, plus the device-less lookup the SYSTEM helper service makes.
 *
 * What is worth pinning, in order of how much it would hurt:
 *   1. the advertised sha256 is the hash of the bytes /download/win serves — the helper refuses an
 *      installer that does not match, so a mismatch is a fleet that downloads and never installs;
 *   2. the helper's lookup (?version= only, no device_id, no token) always gets the hash, and never
 *      trips — or feeds — the OTA breaker;
 *   3. the kill switches still hold, for the player AND for the helper's lookup;
 *   4. a test build dropped next to a release is NOT offered to every PC.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(os.tmpdir(), 'st-winupd-' + crypto.randomBytes(4).toString('hex'));
const SRV_DIR = path.join(ROOT, 'data');
const EMPTY = path.join(ROOT, 'no-repo-dist');
fs.mkdirSync(SRV_DIR, { recursive: true });
fs.mkdirSync(EMPTY, { recursive: true });
process.env.DATA_DIR = SRV_DIR;
// ⚠️ Hermetic: never the real <repo>/native/dist, for either package.
process.env.PI_DIST_DIR = EMPTY;
process.env.WIN_DIST_DIR = EMPTY;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { freePort } = require('./helpers/free-port');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const EXE_BYTES = crypto.randomBytes(8192);
let proc, BASE;

before(async () => {
  fs.writeFileSync(path.join(SRV_DIR, 'ScreenTinker-Setup-1.1.0.exe'), EXE_BYTES);
  fs.writeFileSync(path.join(SRV_DIR, 'ScreenTinker-Setup-1.0.0.exe'), Buffer.from('older'));
  fs.writeFileSync(path.join(SRV_DIR, 'ScreenTinker-Setup-1.2.0~rc1.exe'), Buffer.from('test build'));
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

const check = async (q) => (await fetch(`${BASE}/api/win/update/check?${q}`)).json();
const settled = async (q) => {
  let r;
  for (let i = 0; i < 20; i++) { r = await check(q); if (r.reason !== 'exe-hashing') break; await sleep(150); }
  return r;
};

test('an older PC is offered the newest RELEASE, with the hash and size of the served bytes', async () => {
  const r = await settled('version=1.0.0&device_id=win-older');
  assert.equal(r.update_available, true, JSON.stringify(r));
  assert.equal(r.latest_version, '1.1.0', 'the rc beside it is not what the fleet gets');
  assert.equal(r.current_version, '1.0.0');
  assert.equal(r.download_url, '/download/win');
  assert.equal(r.size, EXE_BYTES.length);
  assert.equal(r.sha256, sha(EXE_BYTES));

  const dl = await fetch(BASE + r.download_url);
  assert.equal(dl.status, 200);
  const body = Buffer.from(await dl.arrayBuffer());
  assert.equal(sha(body), r.sha256, '⚠️ advertised hash must match the served bytes');
  assert.match(dl.headers.get('content-disposition') || '', /filename="ScreenTinker-Setup-1\.1\.0\.exe"/);
  assert.equal(dl.headers.get('x-package-sha256'), r.sha256);
  assert.equal(dl.headers.get('x-package-version'), '1.1.0');
});

test('a player poll (with device_id) gets the breaker answers, and no hash on a non-offer', async () => {
  let r = await check('version=1.1.0&device_id=win-current');
  assert.equal(r.update_available, false); assert.equal(r.reason, 'up-to-date');
  assert.equal(r.sha256, null);
  r = await check('version=2.0.0&device_id=win-newer');
  assert.equal(r.reason, 'client-newer');
  r = await check('device_id=win-noversion');
  assert.equal(r.reason, 'no-version');
});

test('the helper lookup (?version= only) always returns the hash, whatever the version', async () => {
  // Behind: an ordinary "yes, and here is what to verify against".
  let r = await settled('version=1.0.0');
  assert.equal(r.reason, 'package-lookup');
  assert.equal(r.update_available, true);
  assert.equal(r.sha256, sha(EXE_BYTES));
  assert.equal(r.size, EXE_BYTES.length);
  assert.equal(r.latest_version, '1.1.0');
  // ⚠️ Verifying the very version it is about to install: NOT "up-to-date, no hash".
  r = await check('version=1.1.0');
  assert.equal(r.update_available, false);
  assert.equal(r.sha256, sha(EXE_BYTES), 'the helper still needs the hash');
  // No version at all, an unparseable one, a `~` one: still the hash.
  for (const q of ['', 'version=garbage', 'version=1.0.0~rc1']) {
    r = await check(q);
    assert.equal(r.reason, 'package-lookup', q);
    assert.equal(r.sha256, sha(EXE_BYTES), q);
  }
  assert.equal((await check('version=1.0.0~rc1')).update_available, true, '`~` normalised before the comparison');
});

test('⚠️ the helper lookup never trips the breaker, however often it is called', async () => {
  // The rate breaker keys a device-less call on the VERSION; if lookups went through it, a helper
  // retrying would be told rate-backoff and lose the hash mid-install.
  for (let i = 0; i < 40; i++) {
    const r = await check('version=1.0.1');
    assert.equal(r.reason, 'package-lookup', `call ${i}: ${JSON.stringify(r)}`);
    assert.ok(r.sha256);
  }
  // …and did not charge anything to a player polling on that same version.
  const p = await check('version=1.0.1&device_id=win-after-lookups');
  assert.equal(p.update_available, true, JSON.stringify(p));
});

test('the per-device kill switch is honoured for the player poll', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(SRV_DIR, 'db', 'remote_display.db'));
  db.prepare(`INSERT INTO devices (id, pairing_code, status, client_type, platform, ota_enabled)
              VALUES ('win-ota-off', '977101', 'offline', 'win', 'Windows/11 Pro 25H2 (OptiPlex 7010)', 0)`).run();
  db.close();
  const r = await check('version=1.0.0&device_id=win-ota-off');
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'ota_disabled_device');
  assert.equal(r.sha256, null);
});

test('/download lists the native Windows installer and keeps the kiosk script', async () => {
  const html = await (await fetch(BASE + '/download')).text();
  assert.ok(html.includes('id="windows-native"'));
  assert.ok(html.includes('v1.1.0'));
  assert.ok(html.includes('href="/download/win"'));
  assert.ok(html.includes('id="windows"'), 'the kiosk-browser row stays');
});

test('the Pi route is unaffected by the Windows one', async () => {
  const r = await (await fetch(`${BASE}/api/pi/update/check?version=1.0.0&device_id=pi-x`)).json();
  assert.equal(r.reason, 'deb-missing', 'no .deb hosted here, and the .exe is not one');
  assert.equal((await fetch(BASE + '/download/pi')).status, 404);
});

test('with no installer hosted: exe-missing (lookup too) and a 404', async () => {
  for (const f of fs.readdirSync(SRV_DIR)) if (f.endsWith('.exe')) fs.unlinkSync(path.join(SRV_DIR, f));
  let r;
  for (let i = 0; i < 30; i++) { r = await check('version=1.0.0&device_id=win-gone'); if (r.reason === 'exe-missing') break; await sleep(150); }
  assert.equal(r.reason, 'exe-missing');
  const l = await check('version=1.0.0');
  assert.equal(l.reason, 'exe-missing');
  assert.equal(l.sha256, null);
  const dl = await fetch(BASE + '/download/win');
  assert.equal(dl.status, 404);
  assert.match(await dl.text(), /ScreenTinker-Setup/);
});

// ------------------------------------------------------------------------------ in-process

test('the global OTA kill switch refuses the player poll AND the helper lookup', async () => {
  const express = require('express');
  const config = require('../config');
  const winCache = require('../lib/win-cache');
  fs.writeFileSync(path.join(SRV_DIR, 'ScreenTinker-Setup-5.0.0.exe'), Buffer.from('x'));
  winCache.refresh(); await winCache.ready();
  const saved = config.otaEnabled;
  config.otaEnabled = false;
  const app = express();
  require('../routes/win-update')(app, { db: { prepare: () => ({ get: () => null }) }, getBand: () => 'normal' });
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    for (const q of ['version=0.0.1', 'version=0.0.1&device_id=w']) {
      const r = await (await fetch(`http://127.0.0.1:${port}/api/win/update/check?${q}`)).json();
      assert.equal(r.update_available, false, q);
      assert.equal(r.reason, 'ota_disabled_global', q);
      assert.equal(r.sha256, null, q);
    }
  } finally { srv.close(); config.otaEnabled = saved; }
});

test('the lookup holds while the new installer is still being hashed', async () => {
  const express = require('express');
  const fake = { get: () => ({ exists: true, version: '6.0.0', sha256: null, size: 10, path: '/nope', filename: 'ScreenTinker-Setup-6.0.0.exe' }) };
  const { createNativeUpdateRoutes } = require('../routes/native-update');
  const mount = createNativeUpdateRoutes({ kind: 'wintest', cache: fake, label: 'x', contentType: 'application/octet-stream',
    missingReason: 'exe-missing', hashingReason: 'exe-hashing', anonymousLookup: true });
  const app = express();
  mount(app, { db: { prepare: () => ({ get: () => null }) }, getBand: () => 'normal' });
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const r = await (await fetch(`http://127.0.0.1:${port}/api/wintest/update/check?version=5.0.0`)).json();
    assert.equal(r.reason, 'exe-hashing');
    assert.equal(r.update_available, false);
    assert.equal(r.retry_after_seconds, 30);
  } finally { srv.close(); }
});
