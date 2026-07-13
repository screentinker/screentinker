// CORE targeted fix — the isPlaylistRefresh gate + identity change-detection close the A-bucket:
// A1 (WAL write amplification from a sync identity UPDATE on every ~45-60s refresh) and
// A2 (benign refreshes inflating recentReconnects -> healthy devices shown "Degraded").
const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const crypto = require('node:crypto');
// in-process DB dir for the heartbeat-service unit tests (isolated from the spawned e2e server)
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-rg-unit-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ioClient = require('../node_modules/socket.io-client');
const liveness = require('../lib/liveness');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= UNIT: change-detection (A1) =================
test('identityChanged: never-stored (null) -> write', () => {
  assert.equal(liveness.identityChanged(null, { client_type: 'wgt' }), true);
});
test('identityChanged: identical -> NO write (steady-state reconnect)', () => {
  const i = { client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' };
  assert.equal(liveness.identityChanged({ ...i }, i), false);
});
test('identityChanged: a real change (new client_version after OTA) -> write', () => {
  const cur = { client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' };
  assert.equal(liveness.identityChanged(cur, { ...cur, client_version: '1.9.3' }), true);
});

// ================= UNIT: churn logic (A2) via the real heartbeat service =================
const heartbeat = require('../services/heartbeat');
test('A2 flapping: a genuinely-flapping device (3 reconnects in window) -> degraded (not over-corrected)', () => {
  const id = 'flap-' + crypto.randomBytes(3).toString('hex');
  heartbeat.recordReconnect(id, 1000); heartbeat.recordReconnect(id, 2000); heartbeat.recordReconnect(id, 3000);
  assert.equal(heartbeat.recentReconnects(id, 3000), 3);
  assert.equal(liveness.deriveLiveness({ connected: true, lastHeartbeatAgeMs: 5000, recentReconnects: 3 }), 'degraded');
});
test('A2 healthy: a device with NO recorded reconnects (refreshes gated) -> 0 -> healthy', () => {
  const id = 'ok-' + crypto.randomBytes(3).toString('hex');
  assert.equal(heartbeat.recentReconnects(id, 1000), 0);
  assert.equal(liveness.deriveLiveness({ connected: true, lastHeartbeatAgeMs: 5000, recentReconnects: 0 }), 'healthy');
});
test('A2 window: reconnects older than 60s drop out (a past flap does not stay Degraded forever)', () => {
  const id = 'win-' + crypto.randomBytes(3).toString('hex');
  heartbeat.recordReconnect(id, 1000); heartbeat.recordReconnect(id, 2000); heartbeat.recordReconnect(id, 3000);
  assert.equal(heartbeat.recentReconnects(id, 3000), 3);   // in-window -> degraded
  assert.equal(heartbeat.recentReconnects(id, 70000), 0);  // 67s later -> expired -> healthy again
});

// ================= E2E: the shared !isPlaylistRefresh gate + change-detection =================
const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-rg-e2e-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-rg-e2e.log');
let proc, JWT;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false; for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('boot fail:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  JWT = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@t.local', password: 'test12345', name: 'Op' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const connect = () => ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
const registerOn = (sock, msg) => new Promise((res, rej) => { sock.once('device:registered', d => res(d)); sock.emit('device:register', msg); setTimeout(() => rej(new Error('reg timeout')), 4000); });
const deviceRow = async (id) => (await (await fetch(`${BASE}/api/devices/${id}`, { headers: { Authorization: 'Bearer ' + JWT } })).json());
const pair = (code, name) => fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code, name }) });

test('A1 GATE: a same-socket REFRESH does NOT rewrite identity (nor count churn — shared gate)', async () => {
  const sock = connect(); await new Promise(r => sock.on('connect', r));
  const reg = await registerOn(sock, { pairing_code: '910910', fingerprint: 'fp-rg', device_info: {}, client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' });
  await pair('910910', 'rg');
  assert.equal((await deviceRow(reg.device_id)).client_type, 'wgt');
  // SAME socket re-register (a playlist refresh) carrying a DIFFERENT identity -> MUST be ignored (gated).
  await registerOn(sock, { device_id: reg.device_id, device_token: reg.device_token, device_info: {}, client_type: 'CHANGED-ON-REFRESH', client_version: '9.9.9', platform: 'x', contract_version: 'v9' });
  await sleep(200);
  assert.equal((await deviceRow(reg.device_id)).client_type, 'wgt', 'a refresh must NOT rewrite identity — the !isPlaylistRefresh gate skips recordReconnect + persistIdentity together');
  sock.close();
});

test('A1 change-detect: a GENUINE reconnect writes identity when it CHANGED (e.g. an OTA bump)', async () => {
  const s1 = connect(); await new Promise(r => s1.on('connect', r));
  const reg = await registerOn(s1, { pairing_code: '920920', fingerprint: 'fp-cd', device_info: {}, client_type: 'apk', client_version: '2.0.0', platform: 'Android 11', contract_version: 'v4' });
  await pair('920920', 'cd'); s1.close(); await sleep(300);
  const s2 = connect(); await new Promise(r => s2.on('connect', r)); // NEW socket -> genuine reconnect
  await registerOn(s2, { device_id: reg.device_id, device_token: reg.device_token, device_info: {}, client_type: 'apk', client_version: '2.1.0', platform: 'Android 11', contract_version: 'v4' });
  await sleep(200);
  assert.equal((await deviceRow(reg.device_id)).client_version, '2.1.0', 'a genuine reconnect with a CHANGED identity writes it');
  s2.close();
});

test('KEYSTONES unaffected: the shared uniform ack still fires (L3) and pre-auth grants nothing (L4)', async () => {
  const s = connect(); await new Promise(r => s.on('connect', r));
  const reg = await registerOn(s, { pairing_code: '930930', fingerprint: 'fp-ka', device_info: {}, client_type: 'wgt', contract_version: 'v4' });
  const acked = await new Promise((res) => { let d = false; s.once('device:heartbeat-ack', () => { if (!d) { d = true; res(true); } }); s.emit('device:heartbeat', { device_id: reg.device_id, telemetry: {} }); setTimeout(() => { if (!d) res(false); }, 1000); });
  assert.equal(acked, true, 'uniform ack path untouched by the gate fix');
  s.close();
});
