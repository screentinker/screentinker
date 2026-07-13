'use strict';

// #143 (highest-priority) — auth short-circuit fix + operator kill switch.
//   - A provisioned device whose token is NULLed is now REJECTED (Bold 75c2a08a:
//     nulling the token used to RE-PROVISION the device instead of locking it out).
//   - A `blocked=1` device is refused at the first register gate (the enforceable
//     kill switch), settable by DIRECT SQLite edit while the server runs (no restart).
//   - First pairing (token-less, no device_id) and normal auth still work.
// Direct DB edits below mimic the operator hand-editing SQLite during an outage.
// Unique PORT 3987 (not 3982-3986).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-block-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-block-' + crypto.randomBytes(4).toString('hex') + '.log');
const DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
let proc;
let tdb; // ONE long-lived operator-style connection (mirrors how the server holds one);
         // avoids the cross-process WAL checkpoint churn of many short-lived openers.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  tdb = new Database(DB_PATH);
  tdb.pragma('busy_timeout = 3000');
});
after(() => { try { tdb && tdb.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

// Operator's direct hand-edit of SQLite while the server is running (no restart) —
// a single persistent connection, as a `sqlite3` session would be.
function dbEdit(sql, ...params) { return tdb.prepare(sql).run(...params).changes; }

function register(payload) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { registered: false, authError: false, errorMsg: null, playlist: false, newId: null, newToken: null };
    const finish = () => { try { sock.close(); } catch { /* */ } resolve(got); };
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', (d) => { got.registered = true; got.newId = d.device_id; got.newToken = d.device_token; setTimeout(finish, 250); });
    sock.on('device:playlist-update', () => { got.playlist = true; });
    sock.on('device:auth-error', (e) => { got.authError = true; got.errorMsg = e && e.error; finish(); });
    setTimeout(finish, 4000);
  });
}
async function provision() {
  const g = await register({ pairing_code: String(crypto.randomInt(100000, 1000000)) });
  return g.registered ? { id: g.newId, token: g.newToken } : null;
}

test('#143 repro: a provisioned device whose token is NULLed is REJECTED (was: re-provisioned)', async () => {
  const dev = await provision();
  assert.ok(dev && dev.token, 'provisioned with a token');
  assert.equal(dbEdit('UPDATE devices SET device_token = NULL WHERE id = ?', dev.id), 1, 'operator nulled the token');
  const got = await register({ device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } });
  assert.ok(got.authError, 'null-token device is rejected (auth-error)');
  assert.ok(!got.registered, 'and must NOT register / re-provision');
});

test('kill switch: blocked=1 refuses at the first gate (no register, no playlist)', async () => {
  const dev = await provision();
  assert.equal(dbEdit('UPDATE devices SET blocked = 1 WHERE id = ?', dev.id), 1, 'operator blocked the device');
  // no server restart — the block takes effect on the very next reconnect
  const got = await register({ device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } });
  assert.ok(got.authError && got.errorMsg === 'Device blocked', 'refused with Device blocked');
  assert.ok(!got.registered, 'no register');
  assert.ok(!got.playlist, 'no playlist build (refused at the first gate)');
});

test('unblocking (blocked=0) lets the same device connect again', async () => {
  const dev = await provision();
  dbEdit('UPDATE devices SET blocked = 1 WHERE id = ?', dev.id);
  let got = await register({ device_id: dev.id, device_token: dev.token, device_info: {} });
  assert.ok(!got.registered, 'blocked first');
  dbEdit('UPDATE devices SET blocked = 0 WHERE id = ?', dev.id);
  got = await register({ device_id: dev.id, device_token: dev.token, device_info: {} });
  assert.ok(got.registered, 'unblocked -> connects normally again');
});

test('the pairing/provisioning seam still works: a NEW token-less device first-pairs', async () => {
  const got = await register({ pairing_code: String(crypto.randomInt(100000, 1000000)) });
  assert.ok(got.registered, 'first pairing (no device_id) still succeeds');
  assert.ok(got.newId && got.newToken, 'a fresh device_id + token are issued');
});

test('no regression: a normal device with a valid token registers + gets its playlist', async () => {
  const dev = await provision();
  const got = await register({ device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } });
  assert.ok(got.registered, 'valid token registers');
  assert.ok(got.playlist, 'and receives its playlist');
  assert.ok(!got.authError, 'no auth error');
});
