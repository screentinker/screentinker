'use strict';

/*
 * The dashboard socket joins the CURRENT workspace's room, not every workspace it could open.
 *
 * On prod (2026-10-15) a platform admin's socket joined 676 rooms, one per workspace on the
 * platform, and was sent every live event of every screen — for a dashboard that only ever shows
 * the current workspace (GET /api/devices is scoped to it) and that reloads on a workspace switch.
 * Now it joins the current one; a device page showing a screen elsewhere (acting-as) asks for that
 * room with `dashboard:watch-device`, behind the same read check as the HTTP API.
 *
 * End-to-end on a real server: real device sockets register, and the assertion is on which
 * `dashboard:device-status` events each dashboard socket actually receives.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { freePort } = require('./helpers/free-port');
const { roomsForDashboard, workspaceRoom, UNCLAIMED_ROOM } = require('../lib/socket-rooms');

const DATA_DIR = path.join(os.tmpdir(), 'st-wsrooms-' + crypto.randomBytes(4).toString('hex'));
const DBPATH = path.join(DATA_DIR, 'db', 'remote_display.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc, BASE, admin, other;

async function register(email) {
  return fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'RoomsPassw0rd!', name: email.split('@')[0] }),
  }).then((r) => r.json());
}

before(async () => {
  {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    proc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
      stdio: 'ignore',
    });
  }
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* booting */ }
    await sleep(150);
  }
  admin = await register('platform@test.local');   // workspace A
  other = await register('tenant@test.local');     // workspace B, someone else's
  const seed = new Database(DBPATH);
  seed.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(admin.user.id);
  seed.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(other.user.id);
  const ins = seed.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, client_type, device_token)
    VALUES (?, ?, ?, ?, ?, 'offline', 'apk', ?)`);
  ins.run('dev-in-a', admin.user.id, admin.current_workspace_id, 'In A', '910001', 'tok-dev-in-a');
  ins.run('dev-in-b', other.user.id, other.current_workspace_id, 'In B', '910002', 'tok-dev-in-b');
  seed.close();
});

after(async () => {
  if (proc) proc.kill('SIGKILL');
  await sleep(200);
});

function dashboard(token) {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/dashboard`, { transports: ['websocket'], auth: { token }, reconnection: false });
    s.statusFor = new Set();
    s.on('dashboard:device-status', (d) => { if (d && d.device_id) s.statusFor.add(d.device_id); });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
function bringOnline(deviceId) {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/device`, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: deviceId, device_token: 'tok-' + deviceId }));
    s.on('device:registered', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('register timed out for ' + deviceId)), 10000);
  });
}
const watch = (dash, deviceId) => new Promise((res) => dash.emit('dashboard:watch-device', { device_id: deviceId }, res));

test('roomsForDashboard: the current workspace only, when the session can open it', () => {
  const ids = ['w1', 'w2', 'w3'];
  assert.deepEqual(roomsForDashboard(ids, false, 'w2'), [workspaceRoom('w2')]);
  assert.deepEqual(roomsForDashboard(ids, true, 'w2'), [workspaceRoom('w2'), UNCLAIMED_ROOM], 'platform roles keep the unclaimed room');
  // No current workspace, or one the session can no longer open: the old behaviour, all of them.
  assert.deepEqual(roomsForDashboard(ids, false, null), ids.map(workspaceRoom));
  assert.deepEqual(roomsForDashboard(ids, false, 'gone'), ids.map(workspaceRoom));
  assert.deepEqual(roomsForDashboard([], true, null), [UNCLAIMED_ROOM]);
});

test('a platform admin hears its current workspace, not every workspace on the platform', async () => {
  const dash = await dashboard(admin.token);
  const a = await bringOnline('dev-in-a');
  const b = await bringOnline('dev-in-b');
  await sleep(600);
  assert.ok(dash.statusFor.has('dev-in-a'), 'a screen in the current workspace reaches the dashboard');
  assert.ok(!dash.statusFor.has('dev-in-b'), 'a screen in some other workspace does not');
  a.disconnect(); b.disconnect(); dash.disconnect();
  await sleep(300);
});

test('a device page acting-as into another workspace asks for that screen, and then hears it', async () => {
  const dash = await dashboard(admin.token);
  assert.deepEqual(await watch(dash, 'dev-in-b'), { ok: true, room: true });
  const b = await bringOnline('dev-in-b');
  await sleep(600);
  assert.ok(dash.statusFor.has('dev-in-b'), 'once watched, the other workspace\'s screen reaches it');
  b.disconnect(); dash.disconnect();
  await sleep(300);
});

test('watching is gated like the API: a tenant cannot watch a screen it cannot open', async () => {
  const dash = await dashboard(other.token);
  assert.deepEqual(await watch(dash, 'dev-in-a'), { ok: false });
  assert.deepEqual(await watch(dash, 'no-such-device'), { ok: false });
  assert.deepEqual(await watch(dash, null), { ok: false });
  const a = await bringOnline('dev-in-a');
  await sleep(600);
  assert.ok(!dash.statusFor.has('dev-in-a'), 'and it hears nothing about it');
  a.disconnect(); dash.disconnect();
  await sleep(300);
});
