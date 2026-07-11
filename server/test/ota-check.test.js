'use strict';

// #144 — HTTP integration: the real /api/update/check endpoint with the breaker wired.
// Proves end-to-end behavior + the device_id passthrough/keying. Rapid requests stay
// within the 60s rate window, so THRESHOLD(3) trips on the 4th. Unique PORT 3991.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-ota-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-ota-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc, LATEST;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const check = async (version, deviceId) => {
  const q = `version=${encodeURIComponent(version)}` + (deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '');
  const r = await fetch(`${BASE}/api/update/check?${q}`);
  return r.json();
};

before(async () => {
  // the breaker only reports update_available when an APK actually exists — give the
  // test server a dummy one (resolveApkPath checks DATA_DIR/ScreenTinker.apk).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'ScreenTinker.apk'), Buffer.alloc(1024, 1));
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  LATEST = (await check('0.0.1')).latest_version;   // an ancient version reads back the server's latest
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a device already on latest gets no offer (up-to-date)', async () => {
  const r = await check(LATEST);
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'up-to-date');
});

test('(a) phantom version (superseded old-core prerelease) -> instant no-offer over HTTP', async () => {
  const r = await check('1.9.1-beta4');
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'superseded-prerelease');
});

test('(b/f) legacy client (no device_id) looping the same version trips the version-keyed breaker', async () => {
  const v = '1.6.0';                       // fresh offerable older version, no device_id
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await check(v));   // rapid, within the 60s window
  assert.ok(results.slice(0, 3).every(r => r.update_available === true), 'first 3 offered');
  assert.equal(results[3].update_available, false, '4th trips');
  assert.equal(results[3].reason, 'rate-backoff');
  assert.ok(results[3].retry_after_seconds >= 1, 'response carries retry_after_seconds');
});

test('(e) device_id looping is throttled per-device; another device on the same version is unaffected', async () => {
  const v = '1.5.0';
  for (let i = 0; i < 3; i++) await check(v, 'devA');
  const aTrip = await check(v, 'devA');                       // devA 4th -> trips
  assert.equal(aTrip.update_available, false, 'devA throttled');
  const bOk = await check(v, 'devB');                         // devB first check -> offered
  assert.equal(bOk.update_available, true, 'devB (same version, different device) unaffected');
});

// #155/#161 self-update kill switch
test('per-device OTA off (devices.ota_enabled=0) -> never offered (reason ota_disabled_device); an enabled device still is', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.prepare('INSERT INTO devices (id, ota_enabled) VALUES (?, 0)').run('ota-off-dev');
  db.prepare('INSERT INTO devices (id, ota_enabled) VALUES (?, 1)').run('ota-on-dev');
  db.close();
  const off = await check('1.4.0', 'ota-off-dev');
  assert.equal(off.update_available, false, 'OTA-disabled device is not offered an update');
  assert.equal(off.reason, 'ota_disabled_device');
  const on = await check('1.4.1', 'ota-on-dev');
  assert.equal(on.update_available, true, 'OTA-enabled device is still offered');
});

test('global OTA off (OTA_ENABLED=false) -> no device is offered (reason ota_disabled_global)', async () => {
  const P2 = 3992;
  const DD2 = path.join(os.tmpdir(), 'st-ota2-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(DD2, { recursive: true });
  fs.writeFileSync(path.join(DD2, 'ScreenTinker.apk'), Buffer.alloc(1024, 1));
  const p2 = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: DD2, SELF_HOSTED: 'true', PORT: String(P2), NODE_ENV: 'test', OTA_ENABLED: 'false' }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${P2}/api/status`); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
    assert.ok(up, 'OTA_ENABLED=false server booted');
    const r = await (await fetch(`http://127.0.0.1:${P2}/api/update/check?version=1.0.0`)).json();
    assert.equal(r.update_available, false, 'global-off: no update offered');
    assert.equal(r.reason, 'ota_disabled_global');
  } finally {
    try { p2.kill('SIGKILL'); } catch { /* */ }
  }
});
