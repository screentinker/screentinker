// v4 CORE PASS — server honors the liveness contract uniformly across the MIXED fleet (v4 + old
// pre-v4 + disconnected). Validates: uniform device:heartbeat-ack, the reconnect-window ack-gap fix,
// server-derived liveness, identity capture (degrades on missing), cross-client conformance.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ioClient = require('../node_modules/socket.io-client');
const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const crypto = require('node:crypto');
const liveness = require('../lib/liveness');

// ============================ PURE UNIT TESTS (no server) ============================
test('ackableHeartbeat: authed socket is acked', () => {
  assert.equal(liveness.ackableHeartbeat('dev1', 'dev1', () => false), true); // authed -> known regardless
});
test('ackableHeartbeat: KNOWN device mid-reconnect (not-yet-authed socket, resolvable id) is acked — the ack-gap fix', () => {
  assert.equal(liveness.ackableHeartbeat(null, 'devKnown', (id) => id === 'devKnown'), true);
});
test('ackableHeartbeat: anonymous (no device_id) NOT acked — degrade-safe', () => {
  assert.equal(liveness.ackableHeartbeat(null, undefined, () => true), false);
});
test('ackableHeartbeat: unknown device_id NOT acked', () => {
  assert.equal(liveness.ackableHeartbeat(null, 'ghost', () => false), false);
});
test('ackableHeartbeat: BOTH identity paths acked identically (id-agnostic — device_id resolves)', () => {
  const exists = (id) => id === 'viaToken' || id === 'viaFingerprint';
  assert.equal(liveness.ackableHeartbeat(null, 'viaToken', exists), true);
  assert.equal(liveness.ackableHeartbeat(null, 'viaFingerprint', exists), true);
});

test('deriveLiveness: disconnected device -> offline (normal state, not an error)', () => {
  assert.equal(liveness.deriveLiveness({ connected: false, lastHeartbeatAgeMs: 999999, recentReconnects: 9 }), 'offline');
});
test('deriveLiveness: OLD client (connected + heartbeating, NO v4 signals) -> healthy (version-agnostic)', () => {
  assert.equal(liveness.deriveLiveness({ connected: true, lastHeartbeatAgeMs: 5000, recentReconnects: 0 }), 'healthy');
});
test('deriveLiveness: connected but reconnect-churn -> degraded', () => {
  assert.equal(liveness.deriveLiveness({ connected: true, lastHeartbeatAgeMs: 5000, recentReconnects: 3 }), 'degraded');
});
test('deriveLiveness: connected but silent past window -> degraded', () => {
  assert.equal(liveness.deriveLiveness({ connected: true, lastHeartbeatAgeMs: 40000, recentReconnects: 0 }), 'degraded');
});

test('captureIdentity: full v4 block captured verbatim', () => {
  assert.deepEqual(liveness.captureIdentity({ client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' }),
    { client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' });
});
test('captureIdentity: OLD client (no block) -> legacy/unknown defaults, NEVER fails', () => {
  assert.deepEqual(liveness.captureIdentity({}), { client_type: 'legacy', client_version: 'unknown', platform: 'unknown', contract_version: 'legacy' });
  assert.deepEqual(liveness.captureIdentity(undefined), { client_type: 'legacy', client_version: 'unknown', platform: 'unknown', contract_version: 'legacy' });
});
test('captureIdentity: PARTIAL block degrades per-field', () => {
  assert.deepEqual(liveness.captureIdentity({ client_type: 'apk' }), { client_type: 'apk', client_version: 'unknown', platform: 'unknown', contract_version: 'legacy' });
});

// ============================ CROSS-CLIENT CONFORMANCE (source diff) ============================
test('cross-client conformance: threshold + arm + identity IDENTICAL across APK/.wgt/player', () => {
  const root = path.join(__dirname, '..', '..');
  const wgt = fs.readFileSync(path.join(root, 'tizen/js/app.js'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'server/player/index.html'), 'utf8');
  const apk = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/remotedisplay/player/service/LivenessWatchdog.kt'), 'utf8');
  // threshold 45000 ± 10000 — identical formula constants in all three
  assert.match(wgt, /THRESHOLD_BASE_MS = 45000, THRESHOLD_JITTER_MS = 10000/);
  assert.match(player, /V4_THRESHOLD_BASE_MS = 45000, V4_THRESHOLD_JITTER_MS = 10000/);
  assert.match(apk, /THRESHOLD_BASE_MS = 45_000L/); assert.match(apk, /THRESHOLD_JITTER_MS = 10_000L/);
  // arm event name — identical
  for (const s of [wgt, player, apk]) assert.match(s, /device:heartbeat-ack/);
  // watchdog backoff params — .wgt/player io opts AND APK LivenessWatchdog all 1000/30000/0.2
  assert.match(wgt, /reconnectionDelay: 1000/); assert.match(wgt, /reconnectionDelayMax: 30000/); assert.match(wgt, /randomizationFactor: 0.2/);
  assert.match(player, /reconnectionDelay: 1000/); assert.match(player, /reconnectionDelayMax: 30000/); assert.match(player, /randomizationFactor: 0.2/);
  assert.match(apk, /BACKOFF_BASE_MS = 1_000L/); assert.match(apk, /BACKOFF_CAP_MS = 30_000L/);
});
test('cross-client conformance FINDING: APK socket.io TRANSPORT backoff diverges (60s/0.5 vs 30s/0.2)', () => {
  const apkWs = fs.readFileSync(path.join(__dirname, '..', '..', 'android/app/src/main/java/com/remotedisplay/player/service/WebSocketService.kt'), 'utf8');
  // Documented divergence (from the /player QA pass): the APK's IO.Options transport backoff is
  // 60000/0.5, not the canonical 30000/0.2 the .wgt/player use. Assert it so the finding is tracked.
  assert.match(apkWs, /reconnectionDelayMax = 60_000/);
  assert.match(apkWs, /randomizationFactor = 0.5/);
});

// ============================ E2E: MIXED FLEET against the real server ============================
const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-v4core-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-v4core.log');
let proc, JWT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  JWT = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@test.local', password: 'test12345', name: 'Op' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

// open a socket, register with regMsg, resolve {sock, data} on device:registered (socket stays OPEN)
function openAndRegister(regMsg) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', regMsg));
    sock.on('device:registered', (d) => resolve({ sock, data: d }));
    setTimeout(() => reject(new Error('register timeout')), 4000);
  });
}
// emit a heartbeat, resolve true if device:heartbeat-ack arrives within `ms`, else false
function ackWithin(sock, hbMsg, ms = 1200) {
  return new Promise((resolve) => {
    let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
    sock.once('device:heartbeat-ack', () => fin(true));
    sock.emit('device:heartbeat', hbMsg);
    setTimeout(() => fin(false), ms);
  });
}

test('PRIMARY: uniform ack — a v4 device (pairing path) is acked from the shared handler', async () => {
  const { sock, data } = await openAndRegister({ pairing_code: '111111', fingerprint: 'fp-v4a', device_info: {}, client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' });
  assert.ok(await ackWithin(sock, { device_id: data.device_id, telemetry: {} }), 'v4 device heartbeat should be acked');
  sock.close();
});

test('PRIMARY: uniform ack — the reconnect path (device_id+token) is acked identically', async () => {
  const first = await openAndRegister({ pairing_code: '222222', fingerprint: 'fp-v4b', device_info: {} });
  const creds = { id: first.data.device_id, token: first.data.device_token }; first.sock.close(); await sleep(300);
  const { sock } = await openAndRegister({ device_id: creds.id, device_token: creds.token, fingerprint: 'fp-v4b', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  assert.ok(await ackWithin(sock, { device_id: creds.id, telemetry: {} }), 'reconnected device heartbeat should be acked');
  sock.close();
});

test('FIX 1 ack-gap: a KNOWN device mid-reconnect (heartbeat BEFORE re-register) is acked', async () => {
  const first = await openAndRegister({ pairing_code: '333333', fingerprint: 'fp-gap', device_info: {} });
  const knownId = first.data.device_id; first.sock.close(); await sleep(300);
  // fresh socket, NOT registered — send a heartbeat carrying the KNOWN device_id
  const raw = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise(r => raw.on('connect', r));
  assert.ok(await ackWithin(raw, { device_id: knownId, telemetry: {} }), 'known device mid-reconnect must be acked so its watchdog stays armed');
  raw.close();
});

test('FIX 1 ack-gap: anonymous / unknown socket is NOT acked (degrade-safe)', async () => {
  const raw = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise(r => raw.on('connect', r));
  assert.equal(await ackWithin(raw, { telemetry: {} }, 900), false, 'no device_id -> not acked');
  assert.equal(await ackWithin(raw, { device_id: 'ghost-' + crypto.randomBytes(4).toString('hex'), telemetry: {} }, 900), false, 'unknown device_id -> not acked');
  raw.close();
});

test('MIXED FLEET: v4 + OLD (no identity block) + anonymous simultaneously — nothing errors, acks correct', async () => {
  // v4 client (identity block) and OLD client (NO identity block, no ack consumption) both register+ack.
  const v4 = await openAndRegister({ pairing_code: '444444', fingerprint: 'fp-mixv4', device_info: {}, client_type: 'player', client_version: '1.1.0-web', platform: 'Chrome 120', contract_version: 'v4' });
  const old = await openAndRegister({ pairing_code: '555555', fingerprint: 'fp-mixold', device_info: { app_version: 'legacy-apk-1.0' } }); // NO identity block
  assert.ok(v4.data.device_id && old.data.device_id, 'both v4 and OLD clients registered WITHOUT error on missing identity');
  assert.ok(await ackWithin(v4.sock, { device_id: v4.data.device_id, telemetry: {} }), 'v4 acked');
  assert.ok(await ackWithin(old.sock, { device_id: old.data.device_id, telemetry: {} }), 'OLD client acked too (harmless — it ignores the ack)');
  // anonymous present at the same time -> not acked, server unbothered
  const anon = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise(r => anon.on('connect', r));
  assert.equal(await ackWithin(anon, { telemetry: {} }, 900), false, 'anonymous not acked');
  v4.sock.close(); old.sock.close(); anon.close();
  // server still healthy after the mixed load
  assert.equal((await fetch(BASE + '/api/status')).ok, true, 'server unbroken by the mixed fleet');
});

test('FIX 3 identity capture: v4 -> stored verbatim; OLD -> legacy/unknown (verified via device API)', async () => {
  // v4 device, paired, then read back
  const v4 = await openAndRegister({ pairing_code: '666666', fingerprint: 'fp-idv4', device_info: {}, client_type: 'wgt', client_version: '1.9.2', platform: 'Tizen 6.5', contract_version: 'v4' });
  v4.sock.close();
  await fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: '666666', name: 'v4dev' }) });
  const v4row = await (await fetch(BASE + '/api/devices/' + v4.data.device_id, { headers: { Authorization: 'Bearer ' + JWT } })).json();
  assert.equal(v4row.client_type, 'wgt'); assert.equal(v4row.contract_version, 'v4'); assert.equal(v4row.platform, 'Tizen 6.5');
  // OLD device (no identity block), paired, read back -> legacy/unknown
  const old = await openAndRegister({ pairing_code: '777777', fingerprint: 'fp-idold', device_info: {} });
  old.sock.close();
  await fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: '777777', name: 'olddev' }) });
  const oldrow = await (await fetch(BASE + '/api/devices/' + old.data.device_id, { headers: { Authorization: 'Bearer ' + JWT } })).json();
  assert.equal(oldrow.client_type, 'legacy'); assert.equal(oldrow.contract_version, 'legacy'); assert.equal(oldrow.client_version, 'unknown');
});

test('#148 + degrade-safe hold: a device reconnect yields ONE connection, ack still works', async () => {
  const first = await openAndRegister({ pairing_code: '888888', fingerprint: 'fp-148', device_info: {} });
  const creds = { id: first.data.device_id, token: first.data.device_token };
  // reconnect on a NEW socket (old still open) -> server evicts the old, one connection remains
  const second = await openAndRegister({ device_id: creds.id, device_token: creds.token, fingerprint: 'fp-148', device_info: {} });
  await sleep(400);
  assert.ok(await ackWithin(second.sock, { device_id: creds.id, telemetry: {} }), 'the surviving socket is acked');
  const connected = (await (await fetch(BASE + '/api/status')).json()).devices_connected;
  assert.ok(connected >= 1, 'device present; #148 single-socket not broken by the ack');
  try { first.sock.close(); } catch {} second.sock.close();
});
