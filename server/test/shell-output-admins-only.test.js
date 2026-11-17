'use strict';

/*
 * SHELL OUTPUT AND THE LIVE DEBUG LOG REACH ONLY THOSE WHO COULD RUN THE SHELL (GHSA finding C,
 * and the server half of 13.2).
 *
 * device:shell-result and device:log were relayed to the WHOLE workspace room, so a viewer (and an
 * editor) received every admin's shell output and every debug line — including credential-bearing
 * URLs a WebView logs. The page filters by device id; a member's own client does not have to.
 *
 * The invariant: in one workspace room, a viewer and an editor still get device-status, but not
 * shell-result or device-log; the workspace admin gets both.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');

const PW = 'Passw0rd123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-shellout-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const U = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const H = (tok, body) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function register(name) {
  const email = name + crypto.randomBytes(4).toString('hex') + '@example.com';
  const reg = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, name }) });
  assert.ok(reg.body && reg.body.token, 'registered: ' + JSON.stringify(reg.body));
  return { jwt: reg.body.token, userId: reg.body.user.id, wsId: reg.body.current_workspace_id };
}

async function member(role) {
  const m = await register(role.replace('workspace_', ''));
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(U.owner.wsId, m.userId, role);
  const sw = await jfetch('/api/auth/switch-workspace', H(m.jwt, { workspace_id: U.owner.wsId }));
  assert.equal(sw.status, 200, 'switched into the shared workspace: ' + JSON.stringify(sw.body));
  return { ...m, jwt: sw.body.token || m.jwt };
}

function dashboard(jwt) {
  return new Promise((resolve, reject) => {
    const got = { status: [], shell: [], log: [] };
    const s = ioClient(BASE + '/dashboard', { transports: ['websocket'], reconnection: false, auth: { token: jwt } });
    s.on('dashboard:device-status', (p) => got.status.push(p));
    s.on('dashboard:shell-result', (p) => got.shell.push(p));
    s.on('dashboard:device-log', (p) => got.log.push(p));
    s.on('connect', () => resolve({ s, got }));
    s.on('connect_error', reject);
  });
}

function deviceSocket(id, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: id, device_token: token, device_info: { app_version: 'test' } }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 8000);
  });
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  U.owner = await register('owner');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  U.admin = await member('workspace_admin');
  U.editor = await member('workspace_editor');
  U.viewer = await member('workspace_viewer');
});

after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('shell output and the debug log go to the workspace admin, not to editors or viewers', async () => {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, created_at)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'apk', strftime('%s','now'))`).run(id, U.owner.wsId, U.owner.userId, token);

  const dash = {};
  for (const who of ['admin', 'editor', 'viewer']) dash[who] = await dashboard(U[who].jwt);
  let dev;
  try {
    dev = await deviceSocket(id, token);
    dev.emit('device:shell-result', { device_id: id, cmd: 'cat /data/secret.conf', output: 'password=hunter2', exit: 0 });
    dev.emit('device:log', { tag: 'WebView', level: 'w', message: 'retry url=https://x.test/?token=SECRET' });
    // Let every relay land, then wait a little longer so a late delivery would be seen too.
    for (let i = 0; i < 40 && !(dash.admin.got.shell.length && dash.admin.got.log.length); i++) await sleep(100);
    await sleep(300);

    assert.equal(dash.admin.got.shell.length, 1, 'the workspace admin gets the shell output');
    assert.equal(dash.admin.got.shell[0].output, 'password=hunter2');
    assert.equal(dash.admin.got.log.length, 1, 'and the debug log line');
    for (const who of ['editor', 'viewer']) {
      assert.ok(dash[who].got.status.some((p) => p.device_id === id), `${who} is in the room: it got device-status`);
      assert.equal(dash[who].got.shell.length, 0, `${who} must not receive shell output`);
      assert.equal(dash[who].got.log.length, 0, `${who} must not receive the debug log`);
    }
  } finally {
    try { dev && dev.close(); } catch { /* */ }
    for (const d of Object.values(dash)) d.s.close();
  }
});
