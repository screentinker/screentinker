'use strict';

// #148 patch2 — booted end-to-end: the session-settle debounce absorbs a device opening
// duplicate/rapid sockets. Covers the LIVENESS safeguard (critical), storm convergence during
// the warm-up window, and that single-session still works for a legitimate move.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ioClient = require('socket.io-client');
const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT;
let base;
const DATA_DIR = path.join(os.tmpdir(), 'st-storm-' + crypto.randomBytes(4).toString('hex'));
let proc;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    base = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-storm.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', SESSION_SETTLE_WINDOW_MS: '2500' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const connected = async () => (await (await fetch(base + '/api/status')).json()).devices_connected;

function provision() {
  return new Promise((resolve) => {
    const s = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => s.emit('device:register', { pairing_code: String(crypto.randomInt(100000, 1000000)) }));
    s.on('device:registered', (d) => resolve({ sock: s, id: d.device_id, token: d.device_token }));
    setTimeout(() => resolve(null), 3000);
  });
}
// Reconnect an existing device on a fresh socket; resolve with whether it was ACCEPTED
// (device:registered) or soft-refused (device:throttled reason).
function reconnect(deviceId, token) {
  return new Promise((resolve) => {
    const s = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false; const finish = (r) => { if (!done) { done = true; resolve({ sock: s, ...r }); } };
    s.on('connect', () => s.emit('device:register', { device_id: deviceId, device_token: token, device_info: {} }));
    s.on('device:registered', () => finish({ accepted: true }));
    s.on('device:throttled', (d) => finish({ accepted: false, reason: d.reason }));
    s.on('device:auth-error', (d) => finish({ accepted: false, reason: 'auth:' + d.error }));
    setTimeout(() => finish({ accepted: false, reason: 'timeout' }), 3000);
  });
}

test('LIVENESS (critical): live incumbent holds; DEAD incumbent is replaced (never stranded)', async () => {
  const p = await provision(); assert.ok(p, 'provisioned'); p.sock.close(); await sleep(150);

  const b = await reconnect(p.id, p.token);         // socket B -> accepted, becomes the live incumbent
  assert.equal(b.accepted, true, 'B accepted as incumbent');
  await sleep(150);

  const c = await reconnect(p.id, p.token);         // socket C, rapid duplicate, incumbent B alive
  assert.equal(c.accepted, false, 'C is soft-refused while B is alive');
  assert.equal(c.reason, 'session_settle', 'C refused specifically by the session-settle debounce');
  assert.equal(b.sock.connected, true, 'incumbent B is kept');

  // LIVENESS SAFEGUARD: kill the incumbent, then a new socket MUST be accepted (not stranded).
  try { b.sock.io.engine.transport.ws.terminate(); } catch { b.sock.close(); }
  await sleep(600);                                  // let the server drop B from the namespace
  const d = await reconnect(p.id, p.token);         // socket D, incumbent now dead
  assert.equal(d.accepted, true, 'D accepted after the incumbent died — device NOT stranded offline');
  d.sock.close();
});

test('STORM converges to ONE connection during warm-up, stays online, not quarantined', async () => {
  const p = await provision(); assert.ok(p); p.sock.close(); await sleep(150);
  // 6 sockets opened ~together for the same device_id — the storm. (Server is <30s old =
  // inside the reconnect-throttle warm-up, the exact gap this closes.)
  const results = await Promise.all(Array.from({ length: 6 }, () => reconnect(p.id, p.token)));
  const accepted = results.filter(r => r.accepted);
  const settled = results.filter(r => r.reason === 'session_settle');
  assert.equal(accepted.length, 1, 'exactly ONE socket accepted — converged, no evict<->reconnect loop');
  assert.ok(settled.length >= 4, `duplicates soft-refused via session-settle (got ${settled.length})`);
  assert.ok(results.every(r => r.reason !== 'quarantined'), 'a paired device is NEVER quarantined by the debounce');
  await sleep(200);
  assert.ok((await connected()) >= 1, 'device stays ONLINE on the one connection');
  results.forEach(r => { try { r.sock.close(); } catch { /* */ } });
});

test('single-session intact: a legitimate move (after the window) cleanly replaces the socket', async () => {
  const p = await provision(); assert.ok(p); p.sock.close(); await sleep(150);
  const first = await reconnect(p.id, p.token);
  assert.equal(first.accepted, true);
  await sleep(2700);                                 // past the 2500ms settle window
  const moved = await reconnect(p.id, p.token);      // a genuine move to a new socket
  assert.equal(moved.accepted, true, 'a new connection past the window is accepted (single-session replace)');
  await sleep(300);
  assert.equal(first.sock.connected, false, 'the old socket was evicted (single-session enforced)');
  moved.sock.close();
});
