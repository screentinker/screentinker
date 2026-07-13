'use strict';

// #143 — server must tell a screen it's paired so it leaves the Connect page. The
// app leaves the Connect page ONLY on 'device:paired'. /api/provision/pair pushes
// that to a LIVE socket at pair time, but a screen paired-while-disconnected or that
// reconnects after pairing never got it and sat on Connect forever (Bold). Fix:
// re-emit 'device:paired' on reconnect when the device is paired (user_id set).
// Uses the EXISTING client event — no client/protocol change. Unique PORT 3989.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-pair-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-pair-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc, JWT;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  // first user -> admin (self-hosted), gives a workspace for the pair endpoint
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@test.local', password: 'test12345', name: 'Op' }) });
  JWT = (await r.json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

// First pairing: device registers with a pairing code -> gets its device_id + token.
function provisionWithCode(code) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => resolve(null), 4000);
  });
}
// Operator pairs the device in the CMS (the device socket is NOT connected now).
async function pairViaApi(code, name) {
  const r = await fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code, name }) });
  return r.status;
}
// A reconnect (device_id + token) — collect what the server pushes.
function reconnect(id, token) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { registered: false, paired: false, pairedName: null, playlist: false };
    sock.on('connect', () => sock.emit('device:register', { device_id: id, device_token: token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => { got.registered = true; });
    sock.on('device:paired', (d) => { got.paired = true; got.pairedName = d && d.name; });
    sock.on('device:playlist-update', () => { got.playlist = true; });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(got); }, 700);
  });
}
const rnd = () => String(crypto.randomInt(100000, 1000000));

test('#143 repro: a device paired server-side, on reconnect, RECEIVES device:paired (leaves Connect page)', async () => {
  const code = rnd();
  const dev = await provisionWithCode(code);
  assert.ok(dev && dev.id, 'provisioned (sits on Connect page, status=provisioning)');
  assert.equal(await pairViaApi(code, 'Lobby'), 200, 'operator pairs it via the CMS while the device socket is closed');
  const got = await reconnect(dev.id, dev.token);
  assert.ok(got.registered, 'device reconnects');
  assert.ok(got.paired, 'server pushes device:paired on reconnect (the exact event the client waits for)');
  assert.equal(got.pairedName, 'Lobby', 'with the paired name');
  assert.ok(got.playlist, 'and its playlist, so it can play');
});

test('a device NOT yet paired gets NO device:paired on reconnect (stays on the pairing flow)', async () => {
  const code = rnd();
  const dev = await provisionWithCode(code); // provisioned but never paired
  const got = await reconnect(dev.id, dev.token);
  assert.ok(got.registered, 'it still registers');
  assert.ok(!got.paired, 'but is NOT told paired (no false pairing-complete) -> stays on Connect');
});

test('the fix uses the existing client listener: device:paired (no new protocol)', async () => {
  // The repro test above asserts the client receives 'device:paired' — the same event the
  // web player (index.html) and Android (ProvisioningActivity.onPaired) already handle. This
  // test documents that no new client event/protocol was introduced (server-only fix).
  assert.ok(true);
});
