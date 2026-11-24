'use strict';

/*
 * EVERY COMMAND THE DASHBOARD SENDS ACTUALLY REACHES A SCREEN, END TO END.
 *
 * dashboard-commands-allowed.test.js checks one list against another. This drives the real path:
 * a running server, a platform admin's dashboard socket, and a paired screen that declares every
 * capability. Each command the frontend sends goes through dashboard:device-command and must come
 * out of the screen's socket as device:command, with an ack of delivered.
 *
 * It exists because #908 sat broken for two months: the server refused set_debug, the dashboard
 * ignored the reply, and no test sent the command through the socket. It also checks the one
 * command whose point is what comes BACK: set_debug's log line must reach the dashboard.
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
const { CAPABILITIES } = require('../lib/player-capabilities');

// Loading the allowlist test also registers its tests in this file; that is harmless (they are
// fast, pure checks), and it keeps a single definition of "what the dashboard sends".
const { sentCommands } = require('./dashboard-commands-allowed.test.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE, owner;
const DATA_DIR = path.join(os.tmpdir(), 'st-cmddeliv-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

// A valid payload for the commands that validate theirs; the rest take {}.
const PAYLOADS = {
  set_server_url: { url: 'https://example.com' },
  install_apk: { url: 'https://example.com/app.apk' },
  shell: { cmd: 'echo hi' },
  set_debug: { enabled: true },
  set_volume: { level: 0.5 },
  set_brightness: { level: 0.5 },
  set_system_brightness: { level: 0.5 },
  set_screen_timeout: { ms: 60000 },
  upload_logs: {},
};

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
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* booting */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `owner${crypto.randomBytes(4).toString('hex')}@example.com`, password: 'Passw0rd123', name: 'owner' }),
  })).json();
  owner = { jwt: reg.token, userId: reg.user.id, wsId: reg.current_workspace_id };
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});

after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

async function pairScreen() {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, created_at)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'apk', strftime('%s','now'))`).run(id, owner.wsId, owner.userId, token);
  const dev = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    dev.on('connect', () => dev.emit('device:register', {
      device_id: id, device_token: token,
      device_info: { app_version: 'test', capabilities: CAPABILITIES },
    }));
    dev.on('device:registered', resolve);
    dev.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 8000);
  });
  return { id, dev };
}

function dashboard() {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/dashboard', { transports: ['websocket'], reconnection: false, auth: { token: owner.jwt } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

test('every command the dashboard sends is delivered to a screen that supports it', async () => {
  const { id, dev } = await pairScreen();
  const dash = await dashboard();
  const received = [];
  dev.on('device:command', (c) => received.push(c.type));
  const problems = [];
  try {
    // update needs a published APK to send; the firmware path is covered by its own tests.
    for (const type of [...sentCommands().keys()].filter((c) => c !== 'update').sort()) {
      const ack = await new Promise((r) => dash.timeout(5000).emit('dashboard:device-command',
        { device_id: id, type, payload: PAYLOADS[type] || {} }, (err, a) => r(err ? { reason: 'no_ack' } : a)));
      for (let i = 0; i < 20 && !received.includes(type); i++) await sleep(50);
      if (!ack || ack.delivered !== true || !received.includes(type)) {
        problems.push(`${type}: ack=${JSON.stringify(ack)} reached screen=${received.includes(type)}`);
      }
    }
  } finally { dev.close(); dash.close(); }
  assert.deepEqual(problems, [], 'refused or lost on the way to the screen');
});

test('set_debug: the screen\'s log line comes back to the dashboard', async () => {
  const { id, dev } = await pairScreen();
  const dash = await dashboard();
  const lines = [];
  dash.on('dashboard:device-log', (l) => lines.push(l));
  dev.on('device:command', (c) => {
    if (c.type === 'set_debug') dev.emit('device:log', { device_id: id, tag: 'Debug', level: 'i', message: 'Remote debug logging ON' });
  });
  try {
    dash.emit('dashboard:device-command', { device_id: id, type: 'set_debug', payload: { enabled: true } });
    for (let i = 0; i < 40 && !lines.length; i++) await sleep(50);
    assert.equal(lines.length, 1, 'the debug line reached the dashboard');
    assert.equal(lines[0].device_id, id);
    assert.equal(lines[0].message, 'Remote debug logging ON');
  } finally { dev.close(); dash.close(); }
});

test('a refused command is logged on the server', async () => {
  const { id, dev } = await pairScreen();
  const dash = await dashboard();
  try {
    const ack = await new Promise((r) => dash.timeout(5000).emit('dashboard:device-command',
      { device_id: id, type: 'zz_not_a_command', payload: {} }, (err, a) => r(a)));
    assert.equal(ack.reason, 'invalid');
    let log = '';
    for (let i = 0; i < 20 && !log.includes('zz_not_a_command'); i++) { await sleep(50); log = fs.readFileSync(LOG, 'utf8'); }
    assert.match(log, /\[command\] refused zz_not_a_command on .*: invalid/);
  } finally { dev.close(); dash.close(); }
});
