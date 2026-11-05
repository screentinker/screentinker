'use strict';

// #146 — reconnect/heartbeat STORM load harness (the connection-hot-path proof).
//
// Boots the real server and drives real websocket churn through the actual register/
// disconnect/heartbeat path. Asserts the five guarantees beta5 must hold under load:
//   (a) the reconnect breaker engages on a flapper and backs it off
//   (b) a reconnecting device's offline status clears cleanly — and STAYS cleared
//       (the false-offline self-reset: a live socket must never be re-marked offline)
//   (c) a normal (non-flapping) reconnect is never throttled and is online immediately
//   (d) status-log writes are batched/coalesced — N flaps != N row inserts
//   (e) loop-lag stays bounded while the fleet churns
//
// Timings are compressed via env so the suite runs in seconds:
//   HEARTBEAT_TIMEOUT=1500 + HEARTBEAT_INTERVAL=500  -> the checker decides liveness
//     within ~2s, so (b)/(c) don't wait on the 45s prod timeout.
//   STATUS_LOG_FLUSH_MS=300                            -> batching is observable fast.
//   RECONNECT_* tightened so a single-device storm trips without thousands of connects
//     while a 12-device fleet herd stays under the ceiling (same shape as the #142 test).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT;   // must be unique across the suite (files run concurrently under `node --test`)
let BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-storm-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-storm-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc, rdb;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      HEARTBEAT_TIMEOUT: '1500', HEARTBEAT_INTERVAL: '500',
      STATUS_LOG_FLUSH_MS: '300',
      RECONNECT_HARD_CEILING: '8', RECONNECT_WINDOW_MS: '5000', RECONNECT_BASE_MAX: '3',
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  // Second connection to the same WAL db; SELECT-only, autocommit so each read sees
  // the server's latest commit. Never writes.
  rdb = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  rdb.pragma('busy_timeout = 3000');
});

after(() => {
  try { rdb && rdb.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
});

const statusOf = (id) => rdb.prepare('SELECT status FROM devices WHERE id = ?').get(id)?.status;
const logCount = (id) => rdb.prepare('SELECT COUNT(*) c FROM device_status_log WHERE device_id = ?').get(id).c;

// Provision a brand-new device via a unique pairing code -> {id, token}.
function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(null); }, 4000);
  });
}

// One genuine reconnect on a fresh socket that CLOSES right after -> {registered, throttled, retryAfterMs}.
function reconnect(dev) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => finish({ registered: true, throttled: false }));
    sock.on('device:throttled', (m) => finish({ registered: false, throttled: true, retryAfterMs: m?.retry_after_ms }));
    setTimeout(() => finish({ registered: false, throttled: false }), 1500);
  });
}

// Genuine reconnect that KEEPS the socket open (and sends NO app-level heartbeats).
function reconnectHold(dev) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => resolve(sock));
    setTimeout(() => resolve(sock), 1500);
  });
}

// (a) breaker engages on a flapper + backs it off ---------------------------------
test('(a) a flapping device trips the reconnect breaker with a backoff', async () => {
  const dev = await provision();
  assert.ok(dev, 'provisioned');
  let throttled = 0, registered = 0, sawBackoff = false;
  for (let i = 0; i < 12; i++) {           // 12 genuine reconnects in the 5s window > ceiling 8
    const r = await reconnect(dev);
    if (r.registered) registered++;
    if (r.throttled) { throttled++; if (r.retryAfterMs > 0) sawBackoff = true; }
  }
  assert.ok(throttled >= 1, `flapper must be throttled (got ${throttled})`);
  assert.ok(sawBackoff, 'throttle must carry a positive backoff (retry_after_ms)');
  assert.ok(registered < 12, `not every flap should register (got ${registered}/12)`);
});

// (b) reconnecting device's offline clears AND stays clear -------------------------
// This is the false-offline self-reset guarantee. We drive the device offline via the
// checker, reconnect, hold the socket open WITHOUT sending heartbeats, and verify it
// stays online across >2x the heartbeat timeout. Pre-fix, the checker re-marks a
// live-but-silent socket offline within ~1.5s (stuck-offline flapping); post-fix the
// live socket short-circuits the checker so it stays cleanly online.
test('(b) a reconnected device clears offline and is NOT re-marked offline while live', async () => {
  const dev = await provision();
  assert.ok(dev);

  // Drive it offline: open then immediately close a socket, let the checker mark it.
  const s0 = await reconnectHold(dev);
  s0.close();
  let offline = false;
  for (let i = 0; i < 12; i++) { await sleep(300); if (statusOf(dev.id) === 'offline') { offline = true; break; } }
  assert.ok(offline, 'device should be marked offline after its socket drops');

  // Reconnect and HOLD the socket open, sending no heartbeats.
  const s1 = await reconnectHold(dev);
  assert.equal(statusOf(dev.id), 'online', 'reconnect clears offline immediately');

  // Stay live for >2x heartbeat timeout (1500ms). Must remain online the whole time.
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    assert.equal(statusOf(dev.id), 'online', `must stay online while the socket is live (tick ${i})`);
  }
  s1.close();
});

// (c) a normal reconnect is never throttled and is online immediately --------------
test('(c) a single normal reconnect is not throttled and clears status at once', async () => {
  const dev = await provision();
  assert.ok(dev);
  // make it offline first so we can see the clear
  const s0 = await reconnectHold(dev); s0.close();
  let offline = false;
  for (let i = 0; i < 12; i++) { await sleep(300); if (statusOf(dev.id) === 'offline') { offline = true; break; } }
  assert.ok(offline, 'device offline before the clean reconnect');

  const r = await reconnect(dev);
  assert.ok(r.registered, 'normal reconnect registers');
  assert.ok(!r.throttled, 'normal reconnect is NOT throttled');
  // status went online on reconnect (reconnect() closes its socket, but the UPDATE
  // to devices.status already happened during register).
  assert.equal(statusOf(dev.id), 'online', 'a normal reconnect clears offline immediately');
});

// (d) status-log writes are batched/coalesced -------------------------------------
test('(d) a flap storm does NOT write one status-log row per transition', async () => {
  const dev = await provision();
  assert.ok(dev);
  const before = logCount(dev.id);
  const FLAPS = 20;
  for (let i = 0; i < FLAPS; i++) { const s = await reconnectHold(dev); s.close(); }
  await sleep(1000);   // let the 300ms flusher settle
  const written = logCount(dev.id) - before;
  assert.ok(written < FLAPS, `batched: ${written} rows for ${FLAPS} flaps must be < ${FLAPS}`);
  assert.ok(written <= 6, `coalesced to net state: expected a handful of rows, got ${written}`);
});

// (e) loop-lag stays bounded under churn ------------------------------------------
test('(e) loop-lag stays bounded while the fleet churns', async () => {
  const fleet = [];
  for (let i = 0; i < 10; i++) { const d = await provision(); if (d) fleet.push(d); }
  assert.ok(fleet.length >= 8, 'fleet provisioned');
  // Two rounds of whole-fleet reconnects concurrently — a churn burst.
  for (let round = 0; round < 2; round++) await Promise.all(fleet.map(reconnect));
  const r = await fetch(BASE + '/api/status');
  const body = await r.json();
  const p99 = body.loop_lag?.p99_ms;
  assert.ok(typeof p99 === 'number', 'status exposes loop_lag.p99_ms');
  // Prod's runaway simmer bounced 300-1145ms with a 4345ms spike; under the bounded
  // churn here it must stay well under that ceiling.
  assert.ok(p99 < 1000, `loop-lag p99 must stay bounded under churn (was ${p99}ms)`);
});
