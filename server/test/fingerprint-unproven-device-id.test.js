'use strict';

// AUDIT F06 — an UNAUTHENTICATED device:register must not be able to link a fingerprint it
// controls to someone else's device_id.
//
// The fingerprint block in device:register runs BEFORE the device-token check. It used to write
// the client-supplied device_id into device_fingerprints whenever that id named an existing row,
// token or no token. So:
//   (1) register { device_id: VICTIM, fingerprint: 'atk', device_token: 'wrong' }
//       -> 'Invalid device token', BUT device_fingerprints now holds ('atk' -> VICTIM)
//   (2) register { fingerprint: 'atk', pairing_code: '123456' }   (no device_id)
//       -> the "reinstalled app" reclaim path: VICTIM is claimed + offline, so the server minted
//          a NEW token for VICTIM, overwrote the real panel's token, and handed it to the attacker
//          with device:paired and the victim's playlist.
// Both the INSERT (new fingerprint) and the UPDATE (attacker re-points a fingerprint it already
// has) were affected; both are covered here, end-to-end over a real socket.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-f06-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-f06-' + crypto.randomBytes(4).toString('hex') + '.log');
const DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
let proc, tdb;
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
  tdb = new Database(DB_PATH); tdb.pragma('busy_timeout = 3000'); tdb.pragma('foreign_keys = OFF');
});
after(() => {
  try { tdb && tdb.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(LOG, { force: true }); } catch { /* */ }
});

// A claimed, offline victim display (no socket -> no liveConn, so only the token stands guard).
function seedVictim(fp = null) {
  const id = crypto.randomUUID();
  const token = 'victim-tok-' + crypto.randomBytes(6).toString('hex');
  tdb.prepare("INSERT INTO devices (id, name, status, last_heartbeat, device_token, user_id) VALUES (?, 'Lobby', 'offline', strftime('%s','now') - 99999, ?, ?)")
    .run(id, token, 'user-' + crypto.randomBytes(3).toString('hex'));
  if (fp) tdb.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, id);
  return { id, token };
}

function attempt(payload) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { registered: null, paired: false, authError: null };
    const finish = () => { try { sock.close(); } catch { /* */ } resolve(got); };
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', (d) => { got.registered = d; setTimeout(finish, 200); });
    sock.on('device:paired', () => { got.paired = true; });
    sock.on('device:auth-error', (e) => { got.authError = (e && e.error) || 'auth-error'; finish(); });
    setTimeout(finish, 4000);
  });
}
const rnd = () => String(crypto.randomInt(100000, 1000000));
const fpRow = (fp) => tdb.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fp);
const tokenOf = (id) => tdb.prepare('SELECT device_token FROM devices WHERE id = ?').get(id).device_token;

test('F06 INSERT path: a wrong-token register cannot link a NEW fingerprint to the victim', async () => {
  const victim = seedVictim();
  const atk = 'atk-' + crypto.randomBytes(4).toString('hex');

  const r1 = await attempt({ device_id: victim.id, fingerprint: atk, device_token: 'x' });
  assert.equal(r1.authError, 'Invalid device token');
  const row = fpRow(atk);
  assert.ok(!row || row.device_id !== victim.id, 'the unauthenticated register must not store atk -> victim');

  // The follow-up that used to complete the takeover.
  const r2 = await attempt({ fingerprint: atk, pairing_code: rnd() });
  assert.ok(!r2.registered || r2.registered.device_id !== victim.id, 'attacker is NOT handed the victim row');
  assert.equal(r2.paired, false, 'no device:paired for the victim');
  assert.equal(tokenOf(victim.id), victim.token, 'the real panel keeps its token (not locked out)');
});

test('F06 UPDATE path: an attacker cannot re-point a fingerprint it already holds at the victim', async () => {
  const victim = seedVictim();
  const atk = 'atk-upd-' + crypto.randomBytes(4).toString('hex');
  tdb.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, NULL)').run(atk);

  const r1 = await attempt({ device_id: victim.id, fingerprint: atk, device_token: 'nope' });
  assert.equal(r1.authError, 'Invalid device token');
  assert.notEqual(fpRow(atk).device_id, victim.id, 'the existing link is not rebound by an unproven id');

  const r2 = await attempt({ fingerprint: atk, pairing_code: rnd() });
  assert.ok(!r2.registered || r2.registered.device_id !== victim.id);
  assert.equal(r2.paired, false);
  assert.equal(tokenOf(victim.id), victim.token);
});

test('a token-PROVEN register still links its fingerprint (normal tracking unaffected)', async () => {
  const dev = seedVictim();
  const fp = 'legit-' + crypto.randomBytes(4).toString('hex');
  const r = await attempt({ device_id: dev.id, fingerprint: fp, device_token: dev.token });
  assert.equal(r.authError, null);
  assert.equal(fpRow(fp).device_id, dev.id, 'a proven owner links its fingerprint to its own row');
});

test('the legit reinstall reclaim (link written by the device itself) still works', async () => {
  const fp = 'reinstall-' + crypto.randomBytes(4).toString('hex');
  const dev = seedVictim(fp);   // the link pre-exists, as the device itself wrote it while authenticated
  const r = await attempt({ fingerprint: fp, pairing_code: rnd() });
  assert.ok(r.registered, 'reclaimed');
  assert.equal(r.registered.device_id, dev.id);
  assert.equal(r.paired, true);
});
