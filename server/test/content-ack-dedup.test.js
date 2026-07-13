'use strict';

// #142 step 5 — content-ack dedup. Repeated identical (device_id, content_id, status)
// reports are suppressed within config.contentAckDedupMs; a status change or a report
// after the window passes. Observed via the server log (the handler logs+emits only
// when it does NOT dedup). Unique PORT (3984) to avoid the collision class.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-ack-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-ack-' + crypto.randomBytes(4).toString('hex') + '.log');
const DEDUP_MS = 600;
let proc;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', CONTENT_ACK_DEDUP_MS: String(DEDUP_MS) },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
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
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => resolve(sock));
    sock.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 4000);
  });
}

test('repeated identical content-acks are deduped; window-expiry and status-change pass', async () => {
  const dev = await provision();
  assert.ok(dev, 'device provisioned');
  const sock = await openRegistered(dev);
  const cid = 'cid-' + crypto.randomBytes(3).toString('hex');

  // 5 rapid identical "ready" within the dedup window -> only ONE should log/emit
  for (let i = 0; i < 5; i++) { sock.emit('device:content-ack', { device_id: dev.id, content_id: cid, status: 'ready' }); await sleep(40); }
  // wait past the window, then "ready" again -> passes (a fresh report)
  await sleep(DEDUP_MS + 250);
  sock.emit('device:content-ack', { device_id: dev.id, content_id: cid, status: 'ready' });
  // a status CHANGE has a different key -> passes immediately
  await sleep(60);
  sock.emit('device:content-ack', { device_id: dev.id, content_id: cid, status: 'error' });
  await sleep(400);
  try { sock.close(); } catch { /* */ }

  const log = fs.readFileSync(LOG, 'utf8');
  const ready = (log.match(new RegExp(`content ${cid}: ready`, 'g')) || []).length;
  const err = (log.match(new RegExp(`content ${cid}: error`, 'g')) || []).length;
  assert.equal(ready, 2, 'a burst of identical "ready" collapses to one; a second after the window passes -> 2 total');
  assert.equal(err, 1, 'a status change is not deduped');
});
