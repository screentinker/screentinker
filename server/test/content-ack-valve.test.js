'use strict';

// #143 Step 2 integration — the global loop-lag pressure valve. Lag thresholds are
// forced to 0 so the band is CRITICAL from the first sample; rate budget is set high
// so we isolate the VALVE (not the per-device rate limit). Under critical: content-
// acks are shed (no log/emit), while a reconnect AND an HTTP/dashboard request still
// process, and the valve edge is logged once. Unique PORT 3986.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-valve-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-valve-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      LAG_CRITICAL_MS: '1', LAG_ELEVATED_MS: '1', LAG_SAMPLE_INTERVAL_MS: '150', // tiny thresholds (NOT 0 — config uses `|| default`, 0 is falsy) -> band critical immediately
      CONTENT_ACK_MAX_PER_WINDOW: '1000', CONTENT_ACK_RATE_WINDOW_MS: '10000',   // high, so the VALVE is what sheds
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  await sleep(600); // let the valve open (>=1 sample at 150ms in the critical band)
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => resolve(null), 4000);
  });
}
function openRegistered(dev) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => finish({ sock, registered: true }));
    sock.on('device:auth-error', () => finish({ sock, registered: false }));
    setTimeout(() => finish({ sock, registered: false }), 4000);
  });
}

test('valve OPEN under critical: content-acks are shed, reconnect + HTTP still process', async () => {
  const log0 = fs.readFileSync(LOG, 'utf8');
  assert.ok(/\[shed\] global valve OPEN/.test(log0), 'valve edge logged once on entering critical');

  // 1) content-acks under critical -> shed (no log/emit)
  const dev = await provision();
  const { sock, registered } = await openRegistered(dev);
  assert.ok(registered, 'a device can still register/reconnect under critical (reconnects always processed)');
  for (let i = 0; i < 6; i++) { sock.emit('device:content-ack', { device_id: dev.id, content_id: 'v' + i, status: 'ready' }); await sleep(40); }
  await sleep(300);
  try { sock.close(); } catch { /* */ }
  const contentLines = fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.includes(dev.id) && l.includes('content ')).length;
  assert.equal(contentLines, 0, 'all content-acks shed by the valve under critical (none logged/emitted)');

  // 2) a fresh reconnect still registers (reconnects are never shed)
  const dev2 = await provision();
  const r2 = await openRegistered(dev2);
  assert.ok(r2.registered, 'reconnect processed under critical');
  try { r2.sock.close(); } catch { /* */ }

  // 3) HTTP / dashboard path still serves under critical
  const res = await fetch(BASE + '/api/status');
  assert.equal(res.status, 200, 'HTTP/dashboard requests always processed');
  const body = await res.json();
  assert.equal(body.loop_lag.band, 'critical', 'sanity: band really is critical');
});
