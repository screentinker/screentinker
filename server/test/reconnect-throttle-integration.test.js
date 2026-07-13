'use strict';

// #142 step 3 — REQUIRED GATE TEST + storm + neighbor, over real sockets.
//
// Boots the real server with warm-up ACTIVE (default) so the whole suite runs in
// the cold-start window — the exact "right after a deploy" scenario. Hard ceiling
// and window are tightened so the storm trips quickly without thousands of connects;
// fleet devices stay well under the ceiling.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-thr-int-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-thr-int-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      // warm-up left at default (30s) so the whole test runs in the cold-start window
      RECONNECT_HARD_CEILING: '8',
      RECONNECT_WINDOW_MS: '5000',
      RECONNECT_BASE_MAX: '3',
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

// Provision a brand-new device via a UNIQUE pairing code -> returns {device_id, device_token}.
function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(null); }, 4000);
  });
}

// One genuine reconnect (new socket). Resolves {registered, throttled}.
function reconnect(dev) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => finish({ registered: true, throttled: false }));
    sock.on('device:throttled', () => finish({ registered: false, throttled: true }));
    setTimeout(() => finish({ registered: false, throttled: false }), 1500);
  });
}

test('GATE: full-fleet reconnect right after restart throttles NO healthy device', async () => {
  // 12 distinct devices, each reconnecting twice in quick succession — a deploy-time
  // herd. The loop is transiently busy, but per-device keying means none is flagged.
  const fleet = [];
  for (let i = 0; i < 12; i++) { const d = await provision(); assert.ok(d, 'device provisioned'); fleet.push(d); }

  let registered = 0, throttled = 0;
  // two reconnect rounds across the whole fleet
  for (let round = 0; round < 2; round++) {
    const results = await Promise.all(fleet.map(reconnect));
    for (const r of results) { if (r.registered) registered++; if (r.throttled) throttled++; }
  }
  assert.equal(throttled, 0, 'NO healthy fleet device may be throttled at cold start');
  assert.equal(registered, 24, 'every fleet reconnect registered');
});

test('a single device storming IS throttled (backoff engages)', async () => {
  const dev = await provision();
  assert.ok(dev);
  let registered = 0, throttled = 0;
  // 12 sequential reconnects within the 5s window -> exceeds the hard ceiling (8)
  for (let i = 0; i < 12; i++) {
    const r = await reconnect(dev);
    if (r.registered) registered++;
    if (r.throttled) throttled++;
  }
  assert.ok(throttled >= 1, `storming device must be throttled (got ${throttled} throttle(s))`);
  assert.ok(registered < 12, `not all storm reconnects should succeed (got ${registered}/12)`);
});

test('neighbor isolation: a healthy device is unaffected while another storms', async () => {
  const stormer = await provision();
  const neighbor = await provision();
  assert.ok(stormer && neighbor);
  // storm the stormer hard
  for (let i = 0; i < 12; i++) await reconnect(stormer);
  // neighbor reconnects normally a couple of times -> must still register
  const a = await reconnect(neighbor);
  const b = await reconnect(neighbor);
  assert.ok(a.registered && b.registered, 'neighbor must register normally while another device storms');
  assert.ok(!a.throttled && !b.throttled, 'neighbor must not be throttled by another device');
});
