'use strict';

/*
 * The optional audience-counting add-on for the native players (lib/audience-addon.js,
 * routes/audience-addon.js), against a real server. What would hurt:
 *   1. the advertised sha256 not being the hash of the bytes served — every installer verifies it
 *      (the Windows installer's DownloadTemporaryFile, `screentinker-pi audience-addon install`)
 *      and installs nothing on a mismatch;
 *   2. one platform's zip served for another — compiled modules for the wrong CPU or Python;
 *   3. a test build beside the release being the one everyone gets.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const SRV_DIR = path.join(os.tmpdir(), 'st-audaddon-' + crypto.randomBytes(4).toString('hex'));
const PI = crypto.randomBytes(5000);
const WIN = crypto.randomBytes(3000);
let proc, BASE;

before(async () => {
  fs.mkdirSync(SRV_DIR, { recursive: true });
  const empty = path.join(SRV_DIR, 'no-repo-dist');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-audience_1.1.0_linux-aarch64-cp313.zip'), PI);
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-audience_1.0.0_linux-aarch64-cp313.zip'), Buffer.from('older'));
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-audience_1.2.0~rc1_linux-aarch64-cp313.zip'), Buffer.from('test build'));
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-audience_1.1.0_win-x64-cp312.zip'), WIN);
  // Same CPU, other Python: must never answer for cp313.
  fs.writeFileSync(path.join(SRV_DIR, 'screentinker-audience_9.0.0_linux-aarch64-cp312.zip'), Buffer.from('wrong python'));
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: SRV_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      OTA_APK_REFRESH_MS: '300', AUDIENCE_ADDON_DIST_DIR: empty, PI_DIST_DIR: empty, WIN_DIST_DIR: empty },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* booting */ }
    await sleep(150);
  }
});
after(() => {
  try { proc.kill('SIGKILL'); } catch { /* */ }
  fs.rmSync(SRV_DIR, { recursive: true, force: true });
});

async function meta(platform) {
  let r;
  for (let i = 0; i < 40; i++) {
    r = await (await fetch(`${BASE}/api/audience-addon/${platform}`)).json();
    if (r.reason !== 'hashing') break;
    await sleep(150);
  }
  return r;
}

test('the Pi gets the newest RELEASE for its CPU and Python, with the hash of the served bytes', async () => {
  const m = await meta('linux-aarch64-cp313');
  assert.equal(m.available, true);
  assert.equal(m.version, '1.1.0', 'release beats the rc; the cp312 build is another platform');
  assert.equal(m.sha256, sha(PI));
  assert.equal(m.size, PI.length);
  assert.equal(m.download_url, '/download/audience-addon/linux-aarch64-cp313');
  const r = await fetch(BASE + m.download_url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(sha(body), m.sha256, 'the advertised hash IS the hash of what is served');
});

test('the Windows installer reads the sha256 as plain text', async () => {
  await meta('win-x64-cp312');
  const r = await fetch(`${BASE}/api/audience-addon/win-x64-cp312/sha256`);
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), sha(WIN));
  const z = Buffer.from(await (await fetch(`${BASE}/download/audience-addon/win-x64-cp312`)).arrayBuffer());
  assert.equal(sha(z), sha(WIN));
});

test('nothing hosted, or an unknown platform, is an answer and never a wrong file', async () => {
  const m = await meta('linux-x86_64-cp313');
  assert.deepEqual(m, { available: false, reason: 'not-hosted', platform: 'linux-x86_64-cp313' });
  assert.equal((await fetch(`${BASE}/download/audience-addon/linux-x86_64-cp313`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/audience-addon/linux-x86_64-cp313/sha256`)).status, 404);
  const u = await fetch(`${BASE}/api/audience-addon/linux-aarch64-cp312`);
  assert.equal(u.status, 404);
  assert.equal((await u.json()).reason, 'unknown-platform');
  assert.equal((await fetch(`${BASE}/download/audience-addon/..%2F..%2Fetc`)).status, 404);
});
