'use strict';

// #143 — fingerprint-reclaim stuck loop. A device gone by every RUNTIME signal
// (no live socket + stale heartbeat) must be reclaimable; a genuinely-live device
// must still be rejected; the deferral log must not flood. Devices are seeded by
// direct SQLite (mimics the real DB state + avoids the disconnect-debounce window
// leaving a stale liveConn). Unique PORT 3988 (not 3982-3987).

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
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-recl-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-recl-' + crypto.randomBytes(4).toString('hex') + '.log');
const DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
let proc, tdb;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', RECLAIM_SETTLE_SECONDS: '300', RECLAIM_REJECT_LOG_WINDOW_MS: '60000' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  tdb = new Database(DB_PATH); tdb.pragma('busy_timeout = 3000'); tdb.pragma('foreign_keys = OFF');
});
after(() => { try { tdb && tdb.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

// Seed a device + its fingerprint link directly (no socket -> no lingering liveConn).
function seedDevice(fp, { token, heartbeatAgo }) {
  const id = crypto.randomUUID();
  tdb.prepare("INSERT INTO devices (id, status, last_heartbeat, device_token) VALUES (?, 'offline', strftime('%s','now') - ?, ?)").run(id, heartbeatAgo, token);
  tdb.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, id);
  return { id, token };
}
function staleHeartbeat(id, ago) { tdb.prepare("UPDATE devices SET last_heartbeat = strftime('%s','now') - ? WHERE id = ?").run(ago, id); }

function attempt(payload) { // one-shot register; resolves and closes
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { registered: false, newId: null, authError: false, errorMsg: null };
    const finish = () => { try { sock.close(); } catch { /* */ } resolve(got); };
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', (d) => { got.registered = true; got.newId = d.device_id; setTimeout(finish, 150); });
    sock.on('device:auth-error', (e) => { got.authError = true; got.errorMsg = e && e.error; finish(); });
    setTimeout(finish, 4000);
  });
}
function connectLive(payload) { // keeps the socket open (live connection); caller closes
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', () => resolve({ sock, registered: true }));
    sock.on('device:auth-error', () => resolve({ sock, registered: false }));
    setTimeout(() => resolve({ sock, registered: false }), 4000);
  });
}
const rnd = () => String(crypto.randomInt(100000, 1000000));

test('#143 repro: a gone device (no live conn + stale heartbeat) is reclaimable', async () => {
  const fp = 'fp-gone-' + crypto.randomBytes(4).toString('hex');
  const dev = seedDevice(fp, { token: 'tok', heartbeatAgo: 99999 }); // ~27h stale, never connected
  const r = await attempt({ pairing_code: rnd(), fingerprint: fp }); // no device_id -> reclaim path
  assert.ok(r.registered, 'reclaim SUCCEEDS for a gone device');
  assert.equal(r.newId, dev.id, 'it reclaims the SAME device identity');
  assert.ok(!r.authError, 'no rejection');
});

test('no regression: a genuinely live device REJECTS a fingerprint reclaim', async () => {
  const fp = 'fp-live-' + crypto.randomBytes(4).toString('hex');
  const dev = seedDevice(fp, { token: 'tok2', heartbeatAgo: 10 });
  const live = await connectLive({ device_id: dev.id, device_token: 'tok2', device_info: {} });
  assert.ok(live.registered, 'device is live (has a connection)');
  const r = await attempt({ pairing_code: rnd(), fingerprint: fp });
  assert.ok(r.authError && !r.registered, 'reclaim of a LIVE device is rejected (abuse protection intact)');
  try { live.sock.close(); } catch { /* */ }
});

test('clear-on-leave: after disconnect, liveConn is cleared so a (stale) device reclaims', async () => {
  const fp = 'fp-leave-' + crypto.randomBytes(4).toString('hex');
  const dev = seedDevice(fp, { token: 'tok3', heartbeatAgo: 99999 });
  const live = await connectLive({ device_id: dev.id, device_token: 'tok3', device_info: {} });
  assert.ok(live.registered);
  // while live, reclaim is rejected (liveConn present)
  let r = await attempt({ pairing_code: rnd(), fingerprint: fp });
  assert.ok(!r.registered, 'rejected while a live connection exists');
  // leave: close + wait past the 5s offline-debounce so removeConnection runs
  try { live.sock.close(); } catch { /* */ }
  await sleep(6000);
  staleHeartbeat(dev.id, 99999); // the live register bumped last_heartbeat; re-stale it
  r = await attempt({ pairing_code: rnd(), fingerprint: fp });
  assert.ok(r.registered, 'after disconnect cleared liveConn, the gone device reclaims');
});

test('log noise: a retried reclaim logs at most once per device per window', async () => {
  const fp = 'fp-log-' + crypto.randomBytes(4).toString('hex');
  const dev = seedDevice(fp, { token: 'tok4', heartbeatAgo: 5 }); // recent -> reclaim deferred
  const live = await connectLive({ device_id: dev.id, device_token: 'tok4', device_info: {} });
  for (let i = 0; i < 4; i++) { const r = await attempt({ pairing_code: rnd(), fingerprint: fp }); assert.ok(r.authError, 'each retry is deferred'); }
  try { live.sock.close(); } catch { /* */ }
  await sleep(200);
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.includes('reclaim deferred for ' + dev.id)).length;
  assert.ok(lines <= 1, `at most one deferral log per window (got ${lines}); no double-log / per-2s flood`);
});
