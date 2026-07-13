'use strict';

// #146 — /api/status: always-on live-fleet gauge (devices_connected, from the WS
// connection map) + admin-toggleable debug block. Booted server + JWT + DB access.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-statusdbg-' + crypto.randomBytes(4).toString('hex'));
let proc, db;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-statusdbg.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },  // no STATUS_DEBUG_ENABLED -> default ON
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const status = async () => (await fetch(BASE + '/api/status')).json();
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const put = (tok, o) => ({ method: 'PUT', headers: tok ? { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

test('devices_connected is always present, numeric, and reflects the LIVE socket map', async () => {
  const b = await status();
  assert.equal(typeof b.devices_connected, 'number', 'devices_connected always present + numeric');
  const before = b.devices_connected;

  // open a real device socket -> the connection map (and the count) must move
  const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((resolve) => {
    s.on('connect', () => s.emit('device:register', { pairing_code: String(crypto.randomInt(100000, 1000000)) }));
    s.on('device:registered', resolve);
    setTimeout(resolve, 3000);
  });
  await new Promise(r => setTimeout(r, 150));
  const during = (await status()).devices_connected;
  assert.ok(during >= before + 1, `devices_connected rose with a live socket (${before} -> ${during})`);
  try { s.close(); } catch { /* */ }
});

test('debug block: present by default (env), and gated by the admin flag', async () => {
  // default (no env override) -> ON
  let b = await status();
  assert.ok(b.debug, 'debug present by default');
  assert.equal(typeof b.debug.flap.buckets, 'number');

  // register an admin + a normal user; promote the admin in the DB (role read from DB).
  const adminEmail = 'ad' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const userEmail = 'u' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const adminTok = (await (await fetch(BASE + '/api/auth/register', reg({ email: adminEmail, password: 'Passw0rd123' }))).json()).token;
  const userTok = (await (await fetch(BASE + '/api/auth/register', reg({ email: userEmail, password: 'Passw0rd123' }))).json()).token;
  db.prepare("UPDATE users SET role = 'platform_admin' WHERE email = ?").run(adminEmail);

  // non-admin cannot flip it
  assert.equal((await fetch(BASE + '/api/admin/status-debug', put(userTok, { enabled: false }))).status, 403, 'non-admin denied');
  // unauthenticated cannot flip it
  assert.equal((await fetch(BASE + '/api/admin/status-debug', put(null, { enabled: false }))).status, 401, 'anon denied');

  // admin flips OFF -> debug omitted; loop_lag + devices_connected remain
  const off = await fetch(BASE + '/api/admin/status-debug', put(adminTok, { enabled: false }));
  assert.equal(off.status, 200);
  b = await status();
  assert.equal('debug' in b, false, 'debug key omitted entirely when off');
  assert.ok(b.loop_lag, 'loop_lag still present when debug off');
  assert.equal(typeof b.devices_connected, 'number', 'devices_connected still present when debug off');

  // admin flips ON -> debug back, no restart
  assert.equal((await fetch(BASE + '/api/admin/status-debug', put(adminTok, { enabled: true }))).status, 200);
  b = await status();
  assert.ok(b.debug, 'debug back on after re-enable, no restart');
});
