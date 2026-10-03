'use strict';

/*
 * The interactive terminal relay, end to end on a real server: a real Pi-shaped device socket, real
 * dashboard sockets, and assertions on what each side actually RECEIVED. The unit rules live in
 * pty-relay.test.js; this file exists because the failure modes that matter here are wiring —
 * output fanned out to a workspace room instead of one socket, an authz gate that is not the one
 * the `shell` command uses, a device event trusted on the payload's device_id.
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

const DATA_DIR = path.join(os.tmpdir(), 'st-ptyrelay-' + crypto.randomBytes(4).toString('hex'));
const DBPATH = path.join(DATA_DIR, 'db', 'remote_display.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc, BASE, owner, stranger;

const PI_PLATFORM = 'Linux/Debian 12 (Raspberry Pi 5 Model B Rev 1.0)';
const PTY_CAPS = JSON.stringify(['playback.video', 'system.shell', 'system.pty']);
const DEVICES = [
  ['pi-a', PTY_CAPS],
  ['pi-b', PTY_CAPS],
  ['pi-nopty', JSON.stringify(['playback.video', 'system.shell'])],
  ['pi-offline', PTY_CAPS],
];

async function registerUser(email) {
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'PtyPassw0rd!x', name: email.split('@')[0] }),
  }).then((x) => x.json());
  return { jwt: r.token, userId: r.user.id, workspaceId: r.current_workspace_id };
}

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* booting */ }
    await sleep(150);
  }
  owner = await registerUser('pty-owner@test.local');
  stranger = await registerUser('pty-stranger@test.local');

  const seed = new Database(DBPATH);
  const ins = seed.prepare(`INSERT INTO devices
    (id, user_id, workspace_id, name, pairing_code, status, client_type, platform, android_version, capabilities, device_token)
    VALUES (?, ?, ?, ?, ?, 'online', 'pi', ?, '', ?, ?)`);
  let n = 0;
  for (const [id, caps] of DEVICES) ins.run(id, owner.userId, owner.workspaceId, id, String(910001 + n++), PI_PLATFORM, caps, 'tok-' + id);
  seed.close();
});

after(async () => {
  if (proc) proc.kill('SIGKILL');
  await sleep(200);
});

const DASH_EVENTS = ['dashboard:pty-opened', 'dashboard:pty-data', 'dashboard:pty-exit', 'dashboard:pty-error'];
function dashboard(jwt) {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/dashboard`, { transports: ['websocket'], auth: { token: jwt }, reconnection: false, forceNew: true });
    const got = [];
    for (const ev of DASH_EVENTS) s.on(ev, (p) => got.push({ ev, p }));
    s.on('connect', () => resolve({ sock: s, got }));
    s.on('connect_error', reject);
  });
}

const DEV_EVENTS = ['device:pty-open', 'device:pty-input', 'device:pty-resize', 'device:pty-close'];
function device(deviceId) {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = [];
    for (const ev of DEV_EVENTS) s.on(ev, (p) => got.push({ ev, p }));
    s.on('connect', () => s.emit('device:register', { device_id: deviceId, device_token: 'tok-' + deviceId }));
    s.on('device:registered', () => resolve({ sock: s, got }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('register timed out for ' + deviceId)), 10000);
  });
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  return fn();
};
const find = (got, ev) => got.find((g) => g.ev === ev);

async function openSession(dash, dev, deviceId) {
  dash.sock.emit('dashboard:pty-open', { device_id: deviceId, cols: 100, rows: 30 });
  const opened = await until(() => dash.got.find((g) => g.ev === 'dashboard:pty-opened' && g.p.device_id === deviceId && !g.used));
  assert.ok(opened, 'dashboard:pty-opened never arrived');
  opened.used = true;
  const sid = opened.p.session_id;
  const devOpen = await until(() => dev.got.find((g) => g.ev === 'device:pty-open' && g.p.session_id === sid));
  assert.ok(devOpen, 'the device was never told to open');
  return sid;
}

test('a full session: open, input, output to the opener only, resize, close — and it is audited', async () => {
  const dash = await dashboard(owner.jwt);
  const bystander = await dashboard(owner.jwt);   // same user, same workspace room, different tab
  const dev = await device('pi-a');
  await sleep(200);

  const sid = await openSession(dash, dev, 'pi-a');
  assert.match(sid, /^[0-9a-f]{32}$/);
  assert.deepEqual(find(dev.got, 'device:pty-open').p, { session_id: sid, cols: 100, rows: 30 });

  dash.sock.emit('dashboard:pty-input', { session_id: sid, data: Buffer.from('ls\r').toString('base64') });
  const inp = await until(() => find(dev.got, 'device:pty-input'));
  assert.deepEqual(inp.p, { session_id: sid, data: Buffer.from('ls\r').toString('base64') });

  dev.sock.emit('device:pty-data', { session_id: sid, data: Buffer.from('hello\r\n').toString('base64') });
  const out = await until(() => find(dash.got, 'dashboard:pty-data'));
  assert.deepEqual(out.p, { device_id: 'pi-a', session_id: sid, data: Buffer.from('hello\r\n').toString('base64') });
  await sleep(200);
  assert.equal(find(bystander.got, 'dashboard:pty-data'), undefined, '⚠️ terminal output must never reach another socket in the room');

  dash.sock.emit('dashboard:pty-resize', { session_id: sid, cols: 132, rows: 43 });
  assert.deepEqual((await until(() => find(dev.got, 'device:pty-resize'))).p, { session_id: sid, cols: 132, rows: 43 });

  dash.sock.emit('dashboard:pty-close', { session_id: sid });
  assert.deepEqual((await until(() => find(dev.got, 'device:pty-close'))).p, { session_id: sid });
  const exit = await until(() => find(dash.got, 'dashboard:pty-exit'));
  assert.equal(exit.p.reason, 'closed_by_user');

  await sleep(150);
  const db = new Database(DBPATH, { readonly: true });
  const rows = db.prepare("SELECT action, user_id, device_id FROM activity_log WHERE action LIKE 'device_pty_%' AND device_id = 'pi-a' ORDER BY id").all();
  db.close();
  assert.deepEqual(rows.map((r) => r.action), ['device_pty_open', 'device_pty_close']);
  assert.ok(rows.every((r) => r.user_id === owner.userId), 'attributed to the operator who opened it');

  dev.sock.disconnect(); dash.sock.disconnect(); bystander.sock.disconnect();
});

test('refusals: another tenant, a device without system.pty, and an offline device', async () => {
  const mine = await dashboard(owner.jwt);
  const theirs = await dashboard(stranger.jwt);
  const devA = await device('pi-a');
  const devN = await device('pi-nopty');
  await sleep(200);

  theirs.sock.emit('dashboard:pty-open', { device_id: 'pi-a' });
  mine.sock.emit('dashboard:pty-open', { device_id: 'pi-nopty' });
  mine.sock.emit('dashboard:pty-open', { device_id: 'pi-offline' });
  await sleep(600);
  assert.deepEqual(find(theirs.got, 'dashboard:pty-error').p, { device_id: 'pi-a', error: 'forbidden' });
  const errs = mine.got.filter((g) => g.ev === 'dashboard:pty-error').map((g) => g.p);
  assert.deepEqual(errs.sort((a, b) => a.device_id.localeCompare(b.device_id)), [
    { device_id: 'pi-nopty', error: 'unsupported' },
    { device_id: 'pi-offline', error: 'offline' },
  ]);
  assert.equal(find(devA.got, 'device:pty-open'), undefined, 'the stranger never reached the device');
  assert.equal(find(devN.got, 'device:pty-open'), undefined);

  devA.sock.disconnect(); devN.sock.disconnect(); mine.sock.disconnect(); theirs.sock.disconnect();
});

test('a session id is not a bearer token: wrong socket and wrong device are both dropped', async () => {
  const dash = await dashboard(owner.jwt);
  const otherTab = await dashboard(owner.jwt);
  const devA = await device('pi-a');
  const devB = await device('pi-b');
  await sleep(200);
  const sid = await openSession(dash, devA, 'pi-a');

  otherTab.sock.emit('dashboard:pty-input', { session_id: sid, data: 'aWQK' });
  otherTab.sock.emit('dashboard:pty-close', { session_id: sid });
  devB.sock.emit('device:pty-data', { session_id: sid, data: Buffer.from('forged').toString('base64') });
  devB.sock.emit('device:pty-exit', { session_id: sid, code: 0 });
  await sleep(500);
  assert.equal(find(devA.got, 'device:pty-input'), undefined, 'input from another tab was delivered');
  assert.equal(find(devA.got, 'device:pty-close'), undefined, 'close from another tab was honoured');
  assert.equal(find(dash.got, 'dashboard:pty-data'), undefined, 'another screen wrote into this terminal');
  assert.equal(find(dash.got, 'dashboard:pty-exit'), undefined, 'another screen ended this terminal');

  dash.sock.emit('dashboard:pty-close', { session_id: sid });
  await until(() => find(devA.got, 'device:pty-close'));
  devA.sock.disconnect(); devB.sock.disconnect(); dash.sock.disconnect(); otherTab.sock.disconnect();
});

test('caps and oversized frames', async () => {
  const dash = await dashboard(owner.jwt);
  const dev = await device('pi-a');
  await sleep(200);
  const s1 = await openSession(dash, dev, 'pi-a');
  const s2 = await openSession(dash, dev, 'pi-a');
  dash.sock.emit('dashboard:pty-open', { device_id: 'pi-a' });
  const err = await until(() => find(dash.got, 'dashboard:pty-error'));
  assert.equal(err.p.error, 'too_many_sessions_device');

  dash.sock.emit('dashboard:pty-input', { session_id: s1, data: 'A'.repeat(64 * 1024 + 4) });
  await sleep(300);
  assert.equal(find(dev.got, 'device:pty-input'), undefined, 'a frame over 64 KiB must be dropped');

  for (const sid of [s1, s2]) dash.sock.emit('dashboard:pty-close', { session_id: sid });
  await sleep(200);
  dev.sock.disconnect(); dash.sock.disconnect();
});

test('closing the tab closes the shell; losing the device tells the tab', async () => {
  const dash = await dashboard(owner.jwt);
  const dev = await device('pi-a');
  await sleep(200);
  const sid = await openSession(dash, dev, 'pi-a');
  dash.sock.disconnect();
  const closed = await until(() => find(dev.got, 'device:pty-close'));
  assert.deepEqual(closed && closed.p, { session_id: sid }, 'an orphaned PTY was left running on the screen');

  const dash2 = await dashboard(owner.jwt);
  await sleep(100);
  const sid2 = await openSession(dash2, dev, 'pi-a');
  dev.sock.disconnect();
  const exit = await until(() => find(dash2.got, 'dashboard:pty-exit'));
  assert.deepEqual(exit && exit.p, { device_id: 'pi-a', session_id: sid2, code: null, reason: 'device_offline' });
  dash2.sock.disconnect();
});

test('device exit is relayed with its code and reason', async () => {
  const dash = await dashboard(owner.jwt);
  const dev = await device('pi-b');
  await sleep(200);
  const sid = await openSession(dash, dev, 'pi-b');
  dev.sock.emit('device:pty-exit', { session_id: sid, code: 0, reason: 'exited' });
  const exit = await until(() => find(dash.got, 'dashboard:pty-exit'));
  assert.deepEqual(exit.p, { device_id: 'pi-b', session_id: sid, code: 0, reason: 'exited' });
  dev.sock.disconnect(); dash.sock.disconnect();
});
