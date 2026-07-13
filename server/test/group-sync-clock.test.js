// #group-sync server contract: (1) the heartbeat-ack carries the server clock + echoes the client's
// send time (NTP-style discipline the players use to build a cached offset), and (2) the manual
// "Resync now" route fans a group:resync out to a group's members. Boots a real server + real device
// socket (same harness style as v4-exit-signal-phase3 PART A).
const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ioClient = require('../node_modules/socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-gsync-' + crypto.randomBytes(4).toString('hex'));
let proc, JWT;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-gsync.log'), 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false; for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch {} await sleep(250); }
  if (!up) throw new Error('boot fail');
  JWT = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@t.local', password: 'test12345', name: 'Op' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch {} });

const connect = () => ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
const reg = (s, m) => new Promise((res, rej) => { s.once('device:registered', d => res(d)); s.emit('device:register', m); setTimeout(() => rej(new Error('to')), 5000); });
const pair = (c) => fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: c, name: 't' }) });
const api = (p, method, body) => fetch(BASE + p, { method, headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('heartbeat-ack carries server_ms and echoes client_ms (NTP-style clock discipline)', async () => {
  const s = connect(); await new Promise(r => s.on('connect', r));
  const d = await reg(s, { pairing_code: '830001', fingerprint: 'gf1', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  await pair('830001'); await sleep(150);

  const t1 = Date.now();
  const ack = await new Promise((res) => { s.once('device:heartbeat-ack', res); s.emit('device:heartbeat', { device_id: d.device_id, client_ms: t1, telemetry: {} }); setTimeout(() => res(null), 2000); });
  assert.ok(ack, 'an ack was received');
  assert.equal(typeof ack.server_ms, 'number', 'ack carries the server clock (server_ms)');
  assert.equal(ack.client_ms, t1, 'ack echoes the client send time (t1) verbatim for RTT correction');
  assert.ok(ack.server_ms >= t1 - 5000 && ack.server_ms <= Date.now() + 5000, 'server_ms is a sane wall-clock');
  s.close();
});

test('POST /groups/:id/resync fans group:resync out to the group members', async () => {
  // A device to receive the nudge.
  const s = connect(); await new Promise(r => s.on('connect', r));
  const d = await reg(s, { pairing_code: '830002', fingerprint: 'gf2', device_info: {}, client_type: 'apk', contract_version: 'v4' });
  await pair('830002'); await sleep(150);

  // Create a group, add the device, enable sync.
  const grp = await (await api('/api/groups', 'POST', { name: 'sync-grp' })).json();
  assert.ok(grp.id, 'group created');
  const addRes = await api(`/api/groups/${grp.id}/devices`, 'POST', { device_id: d.device_id });
  assert.ok(addRes.status === 200 || addRes.status === 201, 'device joined the group');
  await api(`/api/groups/${grp.id}`, 'PUT', { sync_enabled: true });

  // Arm a listener, then trigger the manual resync.
  const got = new Promise((res) => { s.once('group:resync', res); setTimeout(() => res(null), 2000); });
  const r = await api(`/api/groups/${grp.id}/resync`, 'POST');
  assert.equal(r.status, 200, 'resync route ok');
  const body = await r.json();
  assert.ok(body.notified >= 1, 'reports at least one member notified');

  const msg = await got;
  assert.ok(msg, 'the member received group:resync');
  assert.equal(msg.group_id, grp.id, 'resync carries the group id');
  s.close();
});
