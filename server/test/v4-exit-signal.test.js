// Exit-signal contract v1 — manner-of-death annotation on Offline. Server-side proof: the socket
// device:exit handler + the beacon POST endpoint set offline_reason; the Offline transition resolves
// crashed/clean_exit (kept) vs silent (no signal); clear-on-online prevents stale mislabels; honesty
// (client-sent 'silent'/garbage rejected). Client emit paths are proven in Phase 3 per platform.
const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ioClient = require('../node_modules/socket.io-client');
const liveness = require('../lib/liveness');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== UNIT: honesty by construction (sanitizeExitReason) =====
test('sanitizeExitReason: only crashed/clean_exit accepted; silent + unknown REJECTED (-> server silent)', () => {
  assert.equal(liveness.sanitizeExitReason('crashed', 'boom').reason, 'crashed');
  assert.equal(liveness.sanitizeExitReason('clean_exit', null).reason, 'clean_exit');
  assert.equal(liveness.sanitizeExitReason('silent'), null);          // server-inferred only — never from a client
  assert.equal(liveness.sanitizeExitReason('exploded'), null);        // never fabricate an unknown category
  assert.equal(liveness.sanitizeExitReason(''), null);
  assert.equal(liveness.sanitizeExitReason('crashed', 'x'.repeat(500)).detail.length, 200); // capped
  assert.equal(liveness.sanitizeExitReason('crashed', '   ').detail, null);                  // blank -> null
});

// ===== E2E =====
const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-exit-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-exit.log');
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
const registerOn = (s, msg) => new Promise((res, rej) => { s.once('device:registered', d => res(d)); s.emit('device:register', msg); setTimeout(() => rej(new Error('reg timeout')), 5000); });
const pair = (code) => fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code, name: 't' }) });
const row = async (id) => (await (await fetch(`${BASE}/api/devices/${id}`, { headers: { Authorization: 'Bearer ' + JWT } })).json());
async function provisionPaired(code, ident = {}) {
  const s = connect(); await new Promise(r => s.on('connect', r));
  const reg = await registerOn(s, { pairing_code: code, fingerprint: 'fp' + code, device_info: {}, ...ident });
  await pair(code); await sleep(150);
  return { s, id: reg.device_id, token: reg.device_token };
}

// (4 devices — the SELF_HOSTED plan caps at 5; offline devices still count.)

test('crashed: device:exit sets offline_reason, and it SURVIVES the Offline transition (COALESCE)', async () => {
  const d = await provisionPaired('810001', { client_type: 'apk', contract_version: 'v4' });
  d.s.emit('device:exit', { reason: 'crashed', detail: 'NullPointerException: boom' });
  await sleep(250);
  assert.equal((await row(d.id)).offline_reason, 'crashed', 'set immediately on device:exit');
  d.s.close(); await sleep(5800); // OFFLINE_DEBOUNCE_MS=5000
  const r = await row(d.id);
  assert.equal(r.status, 'offline'); assert.equal(r.offline_reason, 'crashed', 'kept through Offline (not overwritten by silent)');
});

test('clean_exit + clear-on-online: reason set, then CLEARED on re-register (no stale mislabel)', async () => {
  const d = await provisionPaired('810002', { client_type: 'wgt', contract_version: 'v4' });
  d.s.emit('device:exit', { reason: 'clean_exit', detail: 'onDestroy' }); await sleep(250);
  assert.equal((await row(d.id)).offline_reason, 'clean_exit');
  d.s.close(); await sleep(300);
  const s2 = connect(); await new Promise(r => s2.on('connect', r)); // reconnect = fresh session
  await registerOn(s2, { device_id: d.id, device_token: d.token, fingerprint: 'fp810002', device_info: {}, client_type: 'wgt', contract_version: 'v4' });
  await sleep(200);
  assert.equal((await row(d.id)).offline_reason, null, 'cleared on (re)online — a later death starts fresh');
  s2.close();
});

test('silent + honesty: client-sent silent/garbage REJECTED, then Offline-with-no-signal -> server silent', async () => {
  const d = await provisionPaired('810003', { client_type: 'apk', contract_version: 'v4' }); // also the old-client / no-signal case
  d.s.emit('device:exit', { reason: 'silent' });   // client must NOT be able to assert silent
  d.s.emit('device:exit', { reason: 'kaboom' });    // unknown -> rejected, never fabricated
  await sleep(300);
  assert.equal((await row(d.id)).offline_reason, null, 'neither client value was accepted');
  d.s.close(); await sleep(5800);
  const r = await row(d.id);
  assert.equal(r.status, 'offline'); assert.equal(r.offline_reason, 'silent', 'server infers silent on Offline (correct)');
});

test('beacon endpoint: valid token sets reason; bad token is a silent 204 no-op', async () => {
  const d = await provisionPaired('810004', { client_type: 'player', contract_version: 'v4' });
  const post = (body) => fetch(BASE + '/api/device/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let res = await post({ device_id: d.id, device_token: 'WRONG', reason: 'crashed' });
  assert.equal(res.status, 204);
  assert.equal((await row(d.id)).offline_reason, null, 'bad token did NOT set a reason (no oracle, no write)');
  res = await post({ device_id: d.id, device_token: d.token, reason: 'clean_exit', detail: 'pagehide' });
  assert.equal(res.status, 204); await sleep(150);
  assert.equal((await row(d.id)).offline_reason, 'clean_exit', 'valid-token beacon set the reason');
  d.s.close();
});
