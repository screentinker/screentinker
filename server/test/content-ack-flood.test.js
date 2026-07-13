'use strict';

// #143 integration — a device cycling DIFFERENT content ids at high rate (the case
// dedup misses) is rate-limited; an under-budget device passes every ack. Observed
// via the server log: passing acks log `Device <id> content <cid>: ready`; over-
// budget drops are silent except ONE `[content-ack] shedding device <id>` line.
// Normal band (default lag thresholds), unique PORT 3985.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-flood-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-flood-' + crypto.randomBytes(4).toString('hex') + '.log');
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
      CONTENT_ACK_MAX_PER_WINDOW: '5', CONTENT_ACK_RATE_WINDOW_MS: '10000', CONTENT_ACK_DEDUP_MS: '50',
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
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
const linesFor = (id, needle) => fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.includes(id) && l.includes(needle)).length;

test('#143: cycling 4 different content ids at high rate is rate-limited (dedup misses it)', async () => {
  const dev = await provision();
  assert.ok(dev, 'provisioned');
  const sock = await openRegistered(dev);
  const ids = ['a', 'b', 'c', 'd'];
  // 15 acks, ~100ms apart -> each id repeats every ~400ms (> 50ms dedup) so dedup
  // never fires; budget is 5/10s, so only 5 pass and the rest are shed.
  for (let i = 0; i < 15; i++) { sock.emit('device:content-ack', { device_id: dev.id, content_id: ids[i % 4], status: 'ready' }); await sleep(100); }
  await sleep(400);
  try { sock.close(); } catch { /* */ }

  const passed = linesFor(dev.id, 'content ');     // `Device <id> content <cid>: ready`
  const shedStart = linesFor(dev.id, 'shedding device');
  assert.equal(passed, 5, `exactly the budget (5) passed/logged, got ${passed}`);
  assert.ok(shedStart >= 1, 'a single shed-start line was logged when flood control engaged');
  assert.ok(shedStart === 1, `shed-start logged ONCE per window (no per-drop flood), got ${shedStart}`);
});

test('a device under budget has every ack processed', async () => {
  const dev = await provision();
  const sock = await openRegistered(dev);
  for (const id of ['p', 'q', 'r', 's']) { sock.emit('device:content-ack', { device_id: dev.id, content_id: id, status: 'ready' }); await sleep(60); }
  await sleep(300);
  try { sock.close(); } catch { /* */ }
  assert.equal(linesFor(dev.id, 'content '), 4, 'all 4 under-budget acks processed');
  assert.equal(linesFor(dev.id, 'shedding device'), 0, 'no shedding for an under-budget device');
});
