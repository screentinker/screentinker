// #161: the device-owner QR provisioning endpoint returns the AOSP provisioning payload (DPC
// component + APK download URL + signing-cert checksum), a rendered QR, and the ADB one-liner; and
// it is auth-gated. Boots a real server (same harness style as the other socket tests).
const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-doqr-' + crypto.randomBytes(4).toString('hex'));
let proc, JWT;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-doqr.log'), 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false; for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch {} await sleep(250); }
  if (!up) throw new Error('boot fail');
  JWT = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@t.local', password: 'test12345', name: 'Op' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch {} });

test('device-owner-qr requires auth', async () => {
  const r = await fetch(BASE + '/api/provision/device-owner-qr');
  assert.equal(r.status, 401, 'unauthenticated request is rejected');
});

test('device-owner-qr returns the provisioning payload + QR + adb one-liner', async () => {
  const r = await fetch(BASE + '/api/provision/device-owner-qr', { headers: { Authorization: 'Bearer ' + JWT } });
  assert.equal(r.status, 200);
  const b = await r.json();

  assert.equal(b.component, 'com.remotedisplay.player/.admin.STDeviceAdminReceiver');
  assert.match(b.adb_command, /^adb shell dpm set-device-owner com\.remotedisplay\.player\/\.admin\.STDeviceAdminReceiver$/);
  assert.match(b.apk_url, /\/download\/apk$/, 'APK url points at the download route');
  assert.ok(b.signature_checksum && b.signature_checksum.length > 20, 'a signing-cert checksum is present');
  // URL-safe base64, no padding.
  assert.doesNotMatch(b.signature_checksum, /[+/=]/, 'checksum is URL-safe base64 without padding');

  const p = b.payload;
  assert.equal(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'], b.component);
  assert.equal(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'], b.apk_url);
  assert.equal(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'], b.signature_checksum);
  assert.equal(p['android.app.extra.PROVISIONING_SKIP_ENCRYPTION'], true);

  assert.match(b.qr_data_url, /^data:image\/png;base64,/, 'QR rendered as a PNG data-url');
});
