'use strict';

/*
 * STARTING A REMOTE SESSION SAYS WHETHER ONE STARTED.
 *
 * Every other action on a screen's page reports what happened to it: a command to an offline
 * screen says "device offline, will deliver on reconnect", a screenshot says the display is
 * offline. "Start Remote" emitted its event, flipped its own button, and announced "Remote
 * session started" without hearing anything back, so on an offline screen the operator was told a
 * session existed and then pressed keys that went nowhere.
 *
 * The invariant: the server answers a remote-start with whether a screen was there to receive it,
 * no session is recorded for a screen that was not, and the page only announces a session the
 * server confirmed (or, against a server too old to answer, behaves as it did before).
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
const DATA_DIR = path.join(os.tmpdir(), 'st-remoteack-' + crypto.randomBytes(4).toString('hex'));
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
    body: JSON.stringify({ email: 'rem' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'R' }) })).json();
  admin = { token: reg.token, userId: reg.user.id, wsId: reg.current_workspace_id };
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

function device(token) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, created_at)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'apk', strftime('%s','now'))`).run(id, admin.wsId, admin.userId, token);
  return id;
}
const dashboard = () => new Promise((resolve, reject) => {
  const s = ioClient(BASE + '/dashboard', { transports: ['websocket'], reconnection: false, auth: { token: admin.token } });
  s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});
const ask = (s, id) => new Promise((resolve) => {
  s.timeout(3000).emit('dashboard:remote-start', { device_id: id }, (err, ack) => resolve(err ? { timedOut: true } : ack));
});

test('a remote-start for a screen that is not connected is answered: not delivered, offline', async () => {
  const s = await dashboard();
  try {
    const ack = await ask(s, device(crypto.randomBytes(32).toString('hex')));
    assert.ok(ack && !ack.timedOut, 'the server answers');
    assert.equal(ack.delivered, false);
    assert.equal(ack.reason, 'offline');
  } finally { s.close(); }
});

test('a remote-start the server refuses is answered too, so the page cannot take it for started', async () => {
  const s = await dashboard();
  try {
    const ack = await ask(s, crypto.randomUUID());   // no screen of this account's
    assert.ok(ack && !ack.timedOut, 'the server answers');
    assert.deepEqual([ack.delivered, ack.reason], [false, 'forbidden']);
  } finally { s.close(); }
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.match(page, /ack\.reason === 'forbidden'\) \{ showToast\(t\('device\.toast\.remote_forbidden'\)/);
});

test('the server only records a session, and says delivered, when a screen is in the room', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'dashboardSocket.js'), 'utf8');
  const h = src.slice(src.indexOf("socket.on('dashboard:remote-start'"), src.indexOf("socket.on('dashboard:remote-stop'"));
  const offlineAt = h.indexOf("reason: 'offline'"), addAt = h.indexOf('remoteSessions.add'), okAt = h.indexOf('delivered: true');
  assert.ok(offlineAt > 0 && addAt > offlineAt, 'the offline answer returns before a session is recorded');
  assert.ok(okAt > addAt, 'and delivered: true comes after the session is recorded and the screen told');
  assert.match(h, /capabilityRefused\(device_id, 'remote\.stream', ack\)/, 'a screen that cannot stream is still refused first');
});

test('the page announces a session only when one was confirmed', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  const click = view.slice(view.indexOf("startBtn?.addEventListener('click'"), view.indexOf("stopBtn?.addEventListener('click'"));
  assert.match(click, /startRemote\(device\.id, \(ack\) =>/, 'the click waits for the server\'s answer');
  assert.match(click, /reason === 'offline'[\s\S]{0,160}remote_offline/, 'an offline screen gets the offline message');
  const offlineBranch = click.slice(click.indexOf("reason === 'offline'"));
  const startedAt = click.indexOf('remote_started');
  assert.ok(startedAt > 0, 'the started message still exists');
  assert.ok(!/remote_started/.test(click.slice(0, click.indexOf('(ack) =>'))), 'and is not shown before the answer');
  assert.ok(offlineBranch.length > 0);
  const en = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  assert.match(en, /'device\.toast\.remote_offline':/, 'the new message has English text');
  const sock = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'socket.js'), 'utf8');
  assert.match(sock, /export function startRemote\(deviceId, callback\)/, 'startRemote takes the answer callback');
});
