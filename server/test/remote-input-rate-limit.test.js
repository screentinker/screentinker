'use strict';

/*
 * REMOTE INPUT IS RATE-LIMITED PER DASHBOARD SOCKET (advisory 7.7, server side).
 *
 * Every dashboard:remote-key / remote-touch was forwarded to the screen, and the Android player
 * spawns a thread and an `input keyevent` process per key — so a flood from one write session
 * could stall the panel. The invariant: a flood is cut to the burst allowance, the refusal is
 * answered (reason 'rate_limited'), human-paced input is never refused, and the budget refills.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE, admin;
const DATA_DIR = path.join(os.tmpdir(), 'st-inputrate-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'inp' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'I' }) })).json();
  admin = { token: reg.token, userId: reg.user.id, wsId: reg.current_workspace_id };
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const connect = (ns, opts) => new Promise((resolve, reject) => {
  const s = ioClient(BASE + ns, { transports: ['websocket'], reconnection: false, ...opts });
  s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});

test('a flood of remote keys is cut to the burst, answered, and the budget refills', async () => {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, capabilities, created_at)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'apk', ?, strftime('%s','now'))`)
    .run(id, admin.wsId, admin.userId, token, JSON.stringify(['remote.input', 'remote.screenshot']));
  const dev = await connect('/device');
  const keys = [];
  dev.on('device:remote-key', (d) => keys.push(d));
  await new Promise((resolve, reject) => {
    dev.on('device:registered', resolve);
    dev.on('device:auth-error', () => reject(new Error('auth-error')));
    dev.emit('device:register', { device_id: id, device_token: token, device_info: { app_version: 'test' } });
  });
  const dash = await connect('/dashboard', { auth: { token: admin.token } });
  try {
    // Human pace first: ten keys, 150 ms apart, all delivered.
    for (let i = 0; i < 10; i++) { dash.emit('dashboard:remote-key', { device_id: id, keycode: 19 }); await sleep(150); }
    await sleep(300);
    assert.equal(keys.length, 10, 'human-paced input is never refused');

    // A flood: 300 keys at once.
    keys.length = 0;
    const acks = Array.from({ length: 300 }, () => new Promise((resolve) => {
      dash.timeout(5000).emit('dashboard:remote-key', { device_id: id, keycode: 19 }, (err, a) => resolve(err ? null : a));
    }));
    // Touch shares the bucket, so one sent in the same breath as the flood is limited too.
    const touch = new Promise((resolve) => dash.timeout(5000).emit('dashboard:remote-touch', { device_id: id, x: 1, y: 1 }, (e, a) => resolve(a)));
    await Promise.all(acks);
    const t = await touch;
    assert.equal(t && t.reason, 'rate_limited', 'remote-touch is limited by the same bucket');
    for (let i = 0; i < acks.length; i++) acks[i] = await acks[i];
    await sleep(300);
    const refused = acks.filter((a) => a && a.reason === 'rate_limited').length;
    assert.ok(keys.length <= 60, `the flood is cut to about the burst (delivered ${keys.length})`);
    assert.ok(keys.length >= 20, `but the burst itself goes through (delivered ${keys.length})`);
    assert.equal(refused + acks.filter((a) => a && a.delivered).length, 300, 'every key is answered');
    assert.ok(refused >= 240, `and the rest are refused as rate_limited (${refused})`);

    // After a second the budget is back.
    await sleep(1200);
    keys.length = 0;
    dash.emit('dashboard:remote-key', { device_id: id, keycode: 20 });
    await sleep(300);
    assert.equal(keys.length, 1, 'the budget refills');
  } finally { dash.close(); dev.close(); }
});
