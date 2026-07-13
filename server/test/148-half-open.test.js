'use strict';

// #148 Items 2 & 3 — booted server:
//  - the server closes a peer that stops responding to pings within pingInterval+pingTimeout
//    (Item 3, the tightened half-open detection), while a peer that keeps ponging survives;
//  - a device whose transport dies ends up OFFLINE with its connection torn down — no
//    offline-but-still-tracked divergence (Item 2 invariant).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('../node_modules/ws');
const ioClient = require('socket.io-client');
const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-ho-' + crypto.randomBytes(4).toString('hex'));
let proc;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-ho.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      PING_INTERVAL: '400', PING_TIMEOUT: '400',            // half-open closed ~800ms
      HEARTBEAT_INTERVAL: '400', HEARTBEAT_TIMEOUT: '800' },  // checker marks offline fast
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const connected = async () => (await (await fetch(BASE + '/api/status')).json()).devices_connected;

test('Item 3: server closes a NON-ponging peer within pingInterval+pingTimeout', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`);
  let open = null, openAt = 0, closeDelay = null;
  ws.on('message', (d) => { const s = d.toString(); if (s[0] === '0') { open = JSON.parse(s.slice(1)); openAt = Date.now(); ws.send('40/device,'); } /* never pong '2' */ });
  ws.on('close', () => { if (openAt) closeDelay = Date.now() - openAt; });
  await sleep(4000);
  assert.ok(open && open.pingInterval === 400 && open.pingTimeout === 400, 'server advertises the tightened ping values to the client');
  assert.ok(closeDelay != null, 'server closed the non-ponging (half-open) peer');
  // Detection time measured from the engine OPEN (excludes boot/connection-setup latency)
  // ~= pingInterval + pingTimeout = 800ms. Bounded, not indefinite.
  assert.ok(closeDelay < 1500, `closed ~${closeDelay}ms after open (bounded ~pingInterval+pingTimeout)`);
});

test('Item 3: a peer that keeps ponging is NOT falsely dropped', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`);
  let closed = false;
  ws.on('message', (d) => { const s = d.toString(); if (s[0] === '0') ws.send('40/device,'); else if (s[0] === '2') ws.send('3'); /* pong */ });
  ws.on('close', () => { closed = true; });
  await sleep(2000);   // > 2× the detect window
  assert.equal(closed, false, 'a healthy, ponging peer stays connected past the detection window');
  try { ws.close(); } catch { /* */ }
});

test('Item 2: a device whose transport dies ends OFFLINE with its connection torn down', async () => {
  const base0 = await connected();
  const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((resolve) => {
    s.on('connect', () => s.emit('device:register', { pairing_code: String(crypto.randomInt(100000, 1000000)) }));
    s.on('device:registered', resolve);
    setTimeout(resolve, 3000);
  });
  await sleep(300);
  assert.ok((await connected()) > base0, 'device is counted as connected after register');
  // Kill the underlying transport abruptly (simulate a silent/half-open drop).
  try { s.io.engine.transport.ws.terminate(); } catch { try { s.io.engine.close(); } catch { /* */ } }
  // Within ping + heartbeat windows the server must reap it: connection torn down.
  let ok = false;
  for (let i = 0; i < 20; i++) { if ((await connected()) <= base0) { ok = true; break; } await sleep(300); }
  assert.ok(ok, 'connection is torn down after the transport dies (no lingering half-open)');
});
