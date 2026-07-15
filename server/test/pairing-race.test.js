'use strict';

// Pairing-race (fix/pairing-race-1.9.9) — PROVES the deferred-offline zombie race is closed.
//
// THE BUG (now fixed in ws/deviceSocket.js): on socket disconnect the server defers
// heartbeat.removeConnection() by OFFLINE_DEBOUNCE_MS (~5s) via `pendingOfflines`, so
// heartbeat.getConnection() keeps returning a "live" ZOMBIE for the grace window. A
// same-fingerprint reconnect INSIDE that window used to hit the fingerprint-reclaim
// guard and false-reject with device:auth-error, and for an UNCLAIMED row the retry then
// INSERTed the on-screen pairing_code the zombie still held -> UNIQUE constraint failed:
// devices.pairing_code -> wedged, unclaimed player.
//
// WHAT WE VALIDATE:
//  CASE 1 — a same-fingerprint + same-code reconnect INSIDE the deferred-offline window is
//    NOT rejected, does NOT collide on UNIQUE(pairing_code), and settles to exactly ONE
//    still-claimable row (Fix A gate `!inDeferredOffline` + Fix B same-code adopt).
//  CASE 2 — a genuinely-live display (never disconnected, so NO pending-offline armed) STILL
//    rejects a cloned-fingerprint takeover with device:auth-error (Fix A did not open a hole).
//
// Both cases run for a web-style fingerprint AND an android-style (SHA-256 hex) fingerprint.
//
// HARNESS: spawn the real server.js against a temp DATA_DIR + socket.io-client, mirroring
// fingerprint-reclaim.test.js. DETERMINISM: to guarantee socket B reconnects AFTER socket A's
// server-side disconnect has ARMED the pending-offline timer (and BEFORE the 5s timer fires),
// we poll the server log for the exact line the disconnect handler prints
// ("Device disconnected: <id> (offline transition deferred ...)"). That line is emitted on the
// same synchronous tick, immediately before pendingOfflines.set(...), so observing it proves the
// zombie window is open — no wall-clock sleep, no reliance on a fixed reconnect budget.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-prace-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-prace-' + crypto.randomBytes(4).toString('hex') + '.log');
const DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
let proc, tdb;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR,
      SELF_HOSTED: 'true',
      PORT: String(PORT),
      NODE_ENV: 'test',
      // Raise the flap/connect-rate ceiling so rapid connect/disconnect/reconnect of the same
      // fingerprint in these tests can never be soft-refused as flapping (would mask the result).
      CONNECT_RATE_MAX: '1000',
      CONNECT_RATE_ANON_MAX: '1000',
      CONNECT_RATE_QUARANTINE_TRIPS: '0',
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  tdb = new Database(DB_PATH); tdb.pragma('busy_timeout = 3000'); tdb.pragma('foreign_keys = OFF');
});

after(() => {
  try { tdb && tdb.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
});

// ---- helpers -------------------------------------------------------------

const rndCode = () => String(crypto.randomInt(100000, 1000000));
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };

// Poll the server log until `substr` appears (event-driven proof a server-side step ran).
async function waitForLog(substr, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readLog().includes(substr)) return true;
    await sleep(25);
  }
  throw new Error(`timed out waiting for log line: ${substr}`);
}

function openSocket() {
  return ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
}

// Emit device:register on `sock` and resolve on the FIRST terminal server verdict.
// Also records whether device:paired arrived (settle-checked by callers) on sock._paired.
function register(sock, payload) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (o) => { if (!done) { done = true; resolve(o); } };
    sock._paired = false;
    sock.on('device:paired', () => { sock._paired = true; });
    sock.once('device:registered', (d) => fin({ outcome: 'registered', device_id: d.device_id, token: d.device_token, status: d.status }));
    sock.once('device:auth-error', (e) => fin({ outcome: 'auth-error', error: (e && e.error) || '' }));
    sock.once('device:throttled', (e) => fin({ outcome: 'throttled', reason: (e && e.reason) || '' }));
    if (sock.connected) sock.emit('device:register', payload);
    else sock.once('connect', () => sock.emit('device:register', payload));
    setTimeout(() => fin({ outcome: 'timeout' }), 4000);
  });
}

// Fingerprint shapes: a short web-player id and an android SHA-256 hardware hash. Fresh each call.
const SHAPES = [
  { label: 'web-style id', fp: () => `web-${crypto.randomBytes(3).toString('hex')}-${crypto.randomBytes(1).toString('hex')}` },
  { label: 'android-style hash', fp: () => crypto.createHash('sha256').update('android|' + crypto.randomUUID()).digest('hex') },
];

// ---- CASE 1 — the race is closed ----------------------------------------

for (const shape of SHAPES) {
  test(`CASE 1 [${shape.label}]: same-fingerprint+same-code reconnect INSIDE the deferred-offline window is adopted (no false reject, no UNIQUE collision, exactly one claimable row)`, async () => {
    const F = shape.fp();
    const C = rndCode();

    // 1. Socket A: fresh unclaimed web-player-style registration (fingerprint + pairing_code, NO device_id).
    const sockA = openSocket();
    const rA = await register(sockA, { fingerprint: F, pairing_code: C, device_info: {} });
    assert.equal(rA.outcome, 'registered', 'socket A provisions cleanly');
    const deviceId = rA.device_id;
    assert.ok(deviceId, 'A got a device_id');

    // Exactly one row for fingerprint F, holding code C, unclaimed.
    const fpRow = tdb.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?').get(F);
    assert.equal(fpRow && fpRow.device_id, deviceId, 'fingerprint F is linked to A\'s new device row');
    let rowsForCode = tdb.prepare('SELECT id, user_id, pairing_code FROM devices WHERE pairing_code = ?').all(C);
    assert.equal(rowsForCode.length, 1, 'exactly one device row holds pairing_code C after A');
    assert.equal(rowsForCode[0].id, deviceId, 'that row IS A\'s row');
    assert.equal(rowsForCode[0].user_id, null, 'row is unclaimed (user_id NULL)');

    // 2. Disconnect A. Wait ONLY until the server has ARMED the deferred-offline timer (log proof),
    //    which is far inside the 5s window — the zombie connection is now live.
    sockA.close();
    await waitForLog(`Device disconnected: ${deviceId} (offline transition deferred`);

    // Snapshot log length so the UNIQUE-collision check is scoped to the reconnect that follows.
    const logBefore = readLog();
    assert.ok(!logBefore.includes('UNIQUE constraint failed: devices.pairing_code'), 'no UNIQUE collision before the reconnect');

    // 3. Socket B: SAME fingerprint F, SAME pairing_code C, no device_id — reconnect inside the window.
    const sockB = openSocket();
    const rB = await register(sockB, { fingerprint: F, pairing_code: C, device_info: {} });

    // No false-positive reject / throttle — B is adopted.
    assert.notEqual(rB.outcome, 'auth-error', `B must NOT be false-rejected (got ${rB.outcome}${rB.error ? ': ' + rB.error : ''})`);
    assert.notEqual(rB.outcome, 'throttled', 'B must NOT be throttled');
    assert.equal(rB.outcome, 'registered', 'B resolves to device:registered (adopted the existing unclaimed row)');
    assert.equal(rB.device_id, deviceId, 'B adopted the SAME row (no new device_id)');

    // Settle briefly to catch any late device:paired (there must be none — the row is unclaimed).
    await sleep(200);
    assert.equal(sockB._paired, false, 'no device:paired for an UNCLAIMED adopt (still on the pairing screen)');

    // No UNIQUE(pairing_code) collision was hit by the reconnect.
    assert.ok(!readLog().includes('UNIQUE constraint failed: devices.pairing_code'), 'no UNIQUE constraint failed on devices.pairing_code');

    // After settling: EXACTLY ONE row for fingerprint F, still code C, still claimable.
    const fpRow2 = tdb.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?').get(F);
    assert.equal(fpRow2 && fpRow2.device_id, deviceId, 'fingerprint F still maps to the same single row');
    rowsForCode = tdb.prepare('SELECT id, user_id, pairing_code FROM devices WHERE pairing_code = ?').all(C);
    assert.equal(rowsForCode.length, 1, 'still EXACTLY ONE device row holds pairing_code C (no duplicate insert)');
    assert.equal(rowsForCode[0].id, deviceId, 'it is the same original row');
    assert.equal(rowsForCode[0].user_id, null, 'still claimable — user_id NULL');
    assert.equal(rowsForCode[0].pairing_code, C, 'still holds the on-screen code C');

    sockB.close();
  });
}

// ---- CASE 2 — hijack boundary intact ------------------------------------

for (const shape of SHAPES) {
  test(`CASE 2 [${shape.label}]: a genuinely-live display (no pending-offline armed) STILL rejects a cloned-fingerprint takeover`, async () => {
    const F = shape.fp();
    const C = rndCode();

    // Socket A registers and STAYS CONNECTED — it never disconnects, so NO pending-offline timer is armed.
    const sockA = openSocket();
    const rA = await register(sockA, { fingerprint: F, pairing_code: C, device_info: {} });
    assert.equal(rA.outcome, 'registered', 'live socket A registers');
    const deviceId = rA.device_id;

    // A second socket presents the SAME fingerprint F (a clone) while A is genuinely live.
    const sockB = openSocket();
    const rB = await register(sockB, { fingerprint: F, pairing_code: rndCode(), device_info: {} });

    assert.equal(rB.outcome, 'auth-error', `cloned-fingerprint takeover of a LIVE display must be rejected (got ${rB.outcome})`);
    assert.match(rB.error, /active on another connection/i, 'rejected with the "active on another connection" auth-error');

    // No duplicate row was minted for the clone's code, and the fingerprint still points at A's row.
    const fpRow = tdb.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?').get(F);
    assert.equal(fpRow && fpRow.device_id, deviceId, 'fingerprint still linked to the live device (takeover gained nothing)');

    sockA.close();
    sockB.close();
  });
}
