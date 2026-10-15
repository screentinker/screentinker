'use strict';

/*
 * 3.0.1 preview refresh, end to end: a web player that stays on its pairing screen while the
 * operator pairs it from the dashboard is asked for ONE screenshot shortly afterwards, with no
 * dashboard asking — so the screen cards stop showing the pairing code under "Playing". A player
 * that declares it cannot take screenshots is never asked. A push that does not change what the
 * screen shows (here: the local API switched on and off) costs nothing; new content does.
 *
 * Real server process, real sockets; the settle time is shortened through the environment.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, proc, JWT;
const DATA_DIR = path.join(os.tmpdir(), 'st-preview-refresh-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => String(crypto.randomInt(100000, 1000000));
const socks = [];

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', PREVIEW_REFRESH_SETTLE_MS: '400', PREVIEW_REFRESH_MIN_GAP_MS: '1000' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@test.local', password: 'test12345', name: 'Op' }) });
  JWT = (await r.json()).token;
});
after(() => {
  for (const s of socks) { try { s.close(); } catch { /* */ } }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(LOG, { force: true }); } catch { /* */ }
});

// A player showing its pairing code, its socket kept open (the web player in a browser tab).
function playerOnPairingScreen(code, capabilities) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    socks.push(sock);
    const got = { paired: 0, shotRequests: [] };
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code, capabilities, device_info: { app_version: 'test' } }));
    sock.on('device:paired', () => { got.paired++; });
    sock.on('device:screenshot-request', () => { got.shotRequests.push(Date.now()); });
    sock.on('device:registered', () => resolve({ sock, got }));
    setTimeout(() => reject(new Error('player did not register')), 5000);
  });
}
async function pairViaApi(code, name) {
  const r = await fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code, name }) });
  return r.status;
}
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return fn();
}

test('a player paired while it shows its pairing code is asked for one fresh screenshot, unprompted', async () => {
  const code = rnd();
  const { got } = await playerOnPairingScreen(code, ['playback.image', 'playback.video', 'remote.screenshot']);
  assert.equal(got.shotRequests.length, 0, 'nobody has asked yet');
  const pairedAt = Date.now();
  assert.equal(await pairViaApi(code, 'Lobby'), 200);
  assert.ok(await waitFor(() => got.paired > 0, 3000), 'the player is told it is paired');
  assert.ok(await waitFor(() => got.shotRequests.length > 0, 5000), 'and, a moment later, asked for a screenshot (no dashboard involved)');
  assert.ok(got.shotRequests[0] - pairedAt >= 300, 'not at once: the player gets time to draw its content first');
  await sleep(1500);
  assert.equal(got.shotRequests.length, 1, 'exactly one ask');
});

test('a player that declares no screenshot capability is never asked', async () => {
  const code = rnd();
  const { got } = await playerOnPairingScreen(code, ['playback.image', 'playback.video']);
  assert.equal(await pairViaApi(code, 'Kitchen'), 200);
  assert.ok(await waitFor(() => got.paired > 0, 3000));
  await sleep(2500);
  assert.equal(got.shotRequests.length, 0);
});

const api = (p, method, body) => fetch(BASE + p, { method, headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('re-pushes of the same picture cost no screenshot; new content does (the real payload builder)', async () => {
  const code = rnd();
  const { got } = await playerOnPairingScreen(code, ['playback.image', 'playback.widget', 'remote.screenshot']);
  const updates = [];
  got.updates = updates;
  socks.at(-1).on('device:playlist-update', (p) => updates.push(p));
  assert.equal(await pairViaApi(code, 'Hall'), 200);
  assert.ok(await waitFor(() => got.shotRequests.length === 1, 5000), 'the pairing ask');
  const list = await (await api('/api/devices', 'GET')).json();
  const dev = list.find((d) => d.name === 'Hall');
  assert.ok(dev, 'paired device listed');

  // The first push after pairing may differ from the provisioning payload; let it settle past the gap.
  let r = await api(`/api/devices/${dev.id}/local-api-secret`, 'POST', {});
  assert.equal(r.status, 200, await r.text());
  r = await api(`/api/devices/${dev.id}/local-api`, 'POST', { enabled: true });
  assert.equal(r.status, 200, await r.text());
  await sleep(2500);
  const n = got.shotRequests.length;
  const pushesBefore = updates.length;
  // Two more pushes that change only the local API door: nothing on the screen changes.
  r = await api(`/api/devices/${dev.id}/local-api`, 'POST', { enabled: false });
  assert.equal(r.status, 200);
  r = await api(`/api/devices/${dev.id}/local-api`, 'POST', { enabled: true });
  assert.equal(r.status, 200);
  assert.ok(await waitFor(() => updates.length >= pushesBefore + 2, 3000), 'both pushes were delivered');
  await sleep(2500);
  assert.equal(got.shotRequests.length, n, 'same picture, no screenshot');

  // New content on the screen: asked again.
  const w = await (await api('/api/widgets', 'POST', { widget_type: 'text', name: 'Hello', config: { html: '<p>Hello</p>' } })).json();
  assert.ok(w && w.id, JSON.stringify(w));
  r = await api(`/api/assignments/device/${dev.id}`, 'POST', { widget_id: w.id });
  const item = await r.json();
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(item));
  const plId = item.playlist_id || (await (await api(`/api/devices/${dev.id}`, 'GET')).json()).playlist_id;
  assert.ok(plId, 'the edit landed in a playlist draft');
  await sleep(300);
  assert.equal(got.shotRequests.length, n, 'a draft edit is not on screen yet');
  r = await api(`/api/playlists/${plId}/publish`, 'POST', {});
  assert.equal(r.status, 200, await r.text());
  assert.ok(await waitFor(() => got.shotRequests.length === n + 1, 5000), 'a changed payload is followed up');
});
