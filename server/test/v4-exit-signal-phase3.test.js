// Exit-signal PHASE 3 — proof. (A) socket/#148/liveness safety; (B) per-category classification with
// NOTHING misclassified. The JS-client handlers are proven by EXECUTING THE REAL SOURCE blocks (sliced
// out of index.html / app.js) against shimmed window/navigator/socket and firing synthetic death events.
const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ioClient = require('../node_modules/socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- harness: run a real client exit-block against shims, capturing what it sends ----
// The block is delimited in-source by @exit-signal-slice:start / :end markers (NOT fixed line
// numbers) so edits above the block don't silently shift the slice. Fails loudly if absent.
const SLICE_START = '@exit-signal-slice:start';
const SLICE_END = '@exit-signal-slice:end';
function sliceExitBlock(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => l.includes(SLICE_START));
  const end = lines.findIndex(l => l.includes(SLICE_END));
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`exit-signal slice markers missing/out-of-order in ${file} (want ${SLICE_START} .. ${SLICE_END})`);
  }
  return lines.slice(start + 1, end).join('\n');   // code strictly between the markers
}
function harness(file) {
  const src = sliceExitBlock(file);
  const beacons = [], socketSends = [], handlers = {};
  const windowShim = { addEventListener: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, location: { origin: 'http://srv' } };
  const navShim = { sendBeacon: (url, blob) => { beacons.push({ url, ...JSON.parse(blob.__body) }); return true; } };
  class BlobShim { constructor(parts, o) { this.__body = parts[0]; this.type = o && o.type; } }
  const socketShim = { connected: true, emit: (ev, payload) => { socketSends.push({ ev, ...payload }); } };
  const config = { deviceId: 'D1', deviceToken: 'T1', serverUrl: 'http://srv' };   // /player reads config.*
  const fn = new Function('window', 'navigator', 'Blob', 'fetch', 'config', 'deviceId', 'deviceToken', 'serverUrl', 'socket', 'JSON', src);
  fn(windowShim, navShim, BlobShim, () => Promise.resolve(), config, 'D1', 'T1', 'http://srv', socketShim, JSON);
  return { beacons, socketSends, fire: (ev, e) => (handlers[ev] || []).forEach(f => f(e)), handlers };
}
const WINDOW = 'window-target'; // sentinel for ev.target === window (real error event on window)

// ============ PART B — /player classification (real source, marker-delimited) ============
const PLAYER = path.join(__dirname, '../player/index.html');
test('B/player CRASH: uncaught error + unhandledrejection -> crashed (via sendBeacon, NOT the socket)', () => {
  let h = harness(PLAYER); h.fire('error', { error: { message: 'boom' }, target: undefined });
  assert.equal(h.beacons.length, 1); assert.equal(h.beacons[0].reason, 'crashed');
  assert.equal(h.socketSends.length, 0, '/player uses the beacon channel only — no send over the dying socket');
  h = harness(PLAYER); h.fire('unhandledrejection', { reason: { message: 'rej' } });
  assert.equal(h.beacons[0].reason, 'crashed');
});
test('B/player NO-MISCLASSIFY: a RESOURCE load error (img/script) is NOT a crash', () => {
  const h = harness(PLAYER); h.fire('error', { target: { src: 'https://x/img.png' } });
  assert.equal(h.beacons.length, 0, 'resource error must not emit crashed');
});
test('B/player CLEAN-CLOSE: pagehide(persisted=false) -> clean_exit', () => {
  const h = harness(PLAYER); h.fire('pagehide', { persisted: false });
  assert.equal(h.beacons[0].reason, 'clean_exit');
});
test('B/player BACKGROUNDING: pagehide(persisted=true) bfcache suspend -> NO exit (not a death)', () => {
  const h = harness(PLAYER); h.fire('pagehide', { persisted: true });
  assert.equal(h.beacons.length, 0, 'a suspend must NOT emit clean_exit');
  assert.equal((h.handlers['visibilitychange'] || []).length, 0, 'exit block wires NO visibilitychange -> hidden never emits exit');
});
test('B/player IDEMPOTENT: crash then pagehide -> only crashed (crash not relabelled clean_exit)', () => {
  const h = harness(PLAYER); h.fire('error', { error: { message: 'boom' } }); h.fire('pagehide', { persisted: false });
  assert.equal(h.beacons.length, 1); assert.equal(h.beacons[0].reason, 'crashed');
});

// ============ PART B — .wgt classification (real source, marker-delimited) ============
const TIZEN = path.join(__dirname, '../../tizen/js/app.js');
test('B/wgt CRASH: error/rejection -> crashed (socket AND beacon; server dedups)', () => {
  const h = harness(TIZEN); h.fire('error', { error: { message: 'boom' } });
  assert.equal(h.beacons[0].reason, 'crashed');
  assert.equal(h.socketSends[0].reason, 'crashed'); assert.equal(h.socketSends[0].ev, 'device:exit');
});
test('B/wgt NO-MISCLASSIFY: resource error is not a crash', () => {
  const h = harness(TIZEN); h.fire('error', { target: { src: 'x.png' } });
  assert.equal(h.beacons.length, 0); assert.equal(h.socketSends.length, 0);
});
test('B/wgt CLEAN-CLOSE: pagehide(false) -> clean_exit; BACKGROUNDING pagehide(true) -> NO exit', () => {
  let h = harness(TIZEN); h.fire('pagehide', { persisted: false });
  assert.equal(h.beacons[0].reason, 'clean_exit');
  h = harness(TIZEN); h.fire('pagehide', { persisted: true });
  assert.equal(h.beacons.length, 0, 'suspend must NOT emit clean_exit');
  assert.equal((h.handlers['visibilitychange'] || []).length, 0, 'no visibilitychange in the exit block');
});

// ============ PART A — server-side socket / #148 / reconnect-vs-exit safety ============
const PORT = 3975; const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-exit3-' + crypto.randomBytes(4).toString('hex'));
let proc, JWT;
before(async () => {
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-exit3.log'), 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false; for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch {} await sleep(250); }
  if (!up) throw new Error('boot fail');
  JWT = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@t.local', password: 'test12345', name: 'Op' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch {} });
const connect = () => ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
const reg = (s, m) => new Promise((res, rej) => { s.once('device:registered', d => res(d)); s.emit('device:register', m); setTimeout(() => rej(new Error('to')), 5000); });
const pair = (c) => fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: c, name: 't' }) });
const row = async (id) => (await (await fetch(`${BASE}/api/devices/${id}`, { headers: { Authorization: 'Bearer ' + JWT } })).json());
const ackWithin = (s, hb, ms = 1500) => new Promise(r => { let d = false; const f = v => { if (!d) { d = true; r(v); } }; s.once('device:heartbeat-ack', () => f(true)); s.emit('device:heartbeat', hb); setTimeout(() => f(false), ms); });

test('A: crash-emit then teardown -> device goes Offline normally (no orphan/half-open) + reason kept', async () => {
  const s = connect(); await new Promise(r => s.on('connect', r));
  const d = await reg(s, { pairing_code: '820001', fingerprint: 'f1', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  await pair('820001'); await sleep(150);
  s.emit('device:exit', { reason: 'crashed', detail: 'boom' });   // emit AS the socket is about to die
  s.close();                                                       // teardown immediately after
  await sleep(5800);
  const r = await row(d.device_id);
  assert.equal(r.status, 'offline', 'normal offline transition still fired (teardown not disturbed)');
  assert.equal(r.offline_reason, 'crashed');
});

test('A: RECONNECT is NOT an exit, and an exit does not block reconnect — #148 one socket, reason cleared', async () => {
  const s1 = connect(); await new Promise(r => s1.on('connect', r));
  const d = await reg(s1, { pairing_code: '820002', fingerprint: 'f2', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  await pair('820002'); await sleep(150);
  s1.emit('device:exit', { reason: 'crashed' }); await sleep(150);
  assert.equal((await row(d.device_id)).offline_reason, 'crashed');
  s1.close(); await sleep(300);
  // genuine reconnect (new socket) — must NOT emit an exit, and must clear the stale reason
  const s2 = connect(); await new Promise(r => s2.on('connect', r));
  await reg(s2, { device_id: d.device_id, device_token: d.device_token, fingerprint: 'f2', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  await sleep(200);
  assert.equal((await row(d.device_id)).offline_reason, null, 'reconnect cleared the reason (reconnect != exit)');
  assert.equal(await ackWithin(s2, { device_id: d.device_id, telemetry: {} }), true, 'the single reconnected socket is healthy (#148 intact)');
  assert.equal((await row(d.device_id)).status, 'online');
  s2.close();
});

test('A: VIOLENT kill (abrupt drop, NO device:exit) -> silent, never crashed/clean_exit (Bold-critical)', async () => {
  const s = connect(); await new Promise(r => s.on('connect', r));
  const d = await reg(s, { pairing_code: '820003', fingerprint: 'f3', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  await pair('820003'); await sleep(150);
  s.io.engine.close();          // hard transport drop — no clean disconnect, no exit signal (force-stop/power/MDM)
  await sleep(5800);
  const r = await row(d.device_id);
  assert.equal(r.status, 'offline');
  assert.equal(r.offline_reason, 'silent', 'external/violent death reads as silent');
  assert.notEqual(r.offline_reason, 'clean_exit'); assert.notEqual(r.offline_reason, 'crashed');
});
