'use strict';

/*
 * The server half of Esc-unpair: what actually happens to the row.
 *
 * ⚠️ Asserted against a REAL registered device socket, not by calling the applier. The thing most
 * likely to be wrong here is the authentication — an event that unpairs a screen must be reachable
 * only by that screen, holding that screen's token — and no amount of calling the function directly
 * can witness that. This is the same reason the local_api payload test drives a socket.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-unpair-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, dbFile;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

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
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `unpair${Date.now()}@example.com`, password: 'Passw0rd123', name: 'UP',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;
  dbFile = path.join(DATA_DIR, 'db', 'remote_display.db');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

function openDb(readonly = true) {
  const Database = require('better-sqlite3');
  return new Database(dbFile, readonly ? { readonly: true } : {});
}
const rowOf = (id) => { const d = openDb(); try { return d.prepare('SELECT * FROM devices WHERE id = ?').get(id); } finally { d.close(); } };
const fpCount = (id) => { const d = openDb(); try { return d.prepare('SELECT COUNT(*) c FROM device_fingerprints WHERE device_id = ?').get(id).c; } finally { d.close(); } };

/** Register a device, claim it into the workspace, and give it a fingerprint row. */
async function pairedDevice() {
  const code = String(crypto.randomInt(100000, 1000000));
  const dev = await new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', {
      pairing_code: code, device_info: { app_version: 'test' },
      fingerprint: 'fp-' + code, hw_fingerprint: 'hw-' + code,
    }));
    sock.on('device:registered', (d) => resolve({ sock, id: d.device_id, token: d.device_token }));
    setTimeout(() => resolve(null), 5000);
  });
  assert.ok(dev, 'the device never registered');
  const d = openDb(false);
  try {
    d.prepare("UPDATE devices SET workspace_id = ?, user_id = (SELECT id FROM users LIMIT 1) WHERE id = ?")
      .run(workspaceId, dev.id);
  } finally { d.close(); }
  return dev;
}

test('a device can unpair itself, and the ROW SURVIVES', async () => {
  const dev = await pairedDevice();
  try {
    assert.equal(fpCount(dev.id), 1, 'the fixture needs a fingerprint row to prove it is removed');

    const acked = new Promise((res) => { dev.sock.once('device:self-unpair-ok', () => res(true)); setTimeout(() => res(false), 4000); });
    dev.sock.emit('device:self-unpair', { device_id: dev.id });
    assert.equal(await acked, true, 'no ack: the player cannot tell the operator what happened');

    const row = rowOf(dev.id);
    assert.ok(row, '⚠️ the row must NOT be deleted — assignments and history hang off it');
    assert.equal(row.user_id, null, 'unpaired means user_id NULL');
    assert.equal(row.device_token, null, 'the discarded credential must stop working');
    assert.equal(row.offline_reason, 'unpaired');
    // ⚠️ The workspace stays, or the screen vanishes from the fleet page of the person who owns it.
    assert.equal(row.workspace_id, workspaceId);
    // ⚠️ And the fingerprint mapping goes, or #150's settings restore hands this row's configuration
    // to whatever registers next from the same browser.
    assert.equal(fpCount(dev.id), 0);
  } finally { try { dev.sock.close(); } catch { /* */ } }
});

test('⚠️ the discarded token no longer authenticates', async () => {
  const dev = await pairedDevice();
  const token = dev.token;
  try {
    const acked = new Promise((res) => { dev.sock.once('device:self-unpair-ok', () => res(true)); setTimeout(() => res(false), 4000); });
    dev.sock.emit('device:self-unpair', { device_id: dev.id });
    assert.equal(await acked, true);
    dev.sock.close();

    // Reconnect presenting the SAME credentials a stale copy would hold.
    const back = await new Promise((resolve) => {
      const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
      let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
      s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: token, device_info: { app_version: 'test' } }));
      s.on('device:paired', () => fin({ s, paired: true }));
      s.on('device:auth-error', () => fin({ s, paired: false, authError: true }));
      s.on('device:registered', () => setTimeout(() => fin({ s, paired: false }), 600));
      setTimeout(() => fin({ s, paired: false }), 4000);
    });
    try {
      assert.equal(back.paired, false, 'the old token was still accepted as paired');
    } finally { try { back.s.close(); } catch { /* */ } }
  } finally { try { dev.sock.close(); } catch { /* */ } }
});

test('⚠️ one screen cannot unpair another', async () => {
  const a = await pairedDevice();
  const b = await pairedDevice();
  try {
    // A authenticated, naming B. dispatch() no-ops a mismatched device_id, so B must be untouched.
    const acked = new Promise((res) => { a.sock.once('device:self-unpair-ok', () => res(true)); setTimeout(() => res(false), 1500); });
    a.sock.emit('device:self-unpair', { device_id: b.id });
    assert.equal(await acked, false, 'a forged device_id was acknowledged');

    const rb = rowOf(b.id);
    assert.ok(rb.user_id, 'B was unpaired by A');
    assert.ok(rb.device_token, 'B lost its token to A');
    assert.equal(fpCount(b.id), 1, "B's fingerprint row was removed by A");
    // And A is untouched too — a mismatched id is a no-op, not "unpair the sender instead".
    assert.ok(rowOf(a.id).user_id, 'A unpaired itself on a forged id');
  } finally { try { a.sock.close(); b.sock.close(); } catch { /* */ } }
});

test('⚠️ an UNAUTHENTICATED socket cannot unpair anything', async () => {
  const dev = await pairedDevice();
  try {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    await new Promise((res) => { s.on('connect', res); setTimeout(res, 3000); });
    // Never registered, so there is no currentDeviceId: requireDeviceAuth() refuses.
    s.emit('device:self-unpair', { device_id: dev.id });
    await sleep(800);
    try {
      assert.ok(rowOf(dev.id).user_id, 'an unregistered socket unpaired a screen');
      assert.equal(fpCount(dev.id), 1);
    } finally { try { s.close(); } catch { /* */ } }
  } finally { try { dev.sock.close(); } catch { /* */ } }
});

test('it is idempotent, and a second attempt does not throw', async () => {
  const dev = await pairedDevice();
  try {
    dev.sock.emit('device:self-unpair', { device_id: dev.id });
    await sleep(500);
    dev.sock.emit('device:self-unpair', { device_id: dev.id });
    await sleep(500);
    assert.equal(rowOf(dev.id).user_id, null);
    // The socket must still be alive: an applier that throws would take the connection with it.
    assert.equal(dev.sock.connected, true);
  } finally { try { dev.sock.close(); } catch { /* */ } }
});
