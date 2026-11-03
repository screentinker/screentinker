'use strict';

// A device row can vanish while its socket is still open — an operator deletes it, or a re-pair
// replaces it. The next heartbeat carrying telemetry then failed the foreign key on
// device_telemetry, and that throw was fatal in a way nobody would guess:
//
//   the safe-socket wrapper treats a throwing handler as a broken one and disconnects the socket
//   SERVER-side  ->  socket.io does NOT auto-retry an 'io server disconnect'  ->  the player
//   sits there doing nothing until a human reloads the page.
//
// That is not theoretical. Deleting a device row mid-session took a real screen dark, and it
// needed someone at the other end to press reload. A heartbeat for a device that no longer
// exists is an ordinary race, not a fault worth ending a connection over.

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
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-hbdel-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-hbdel-' + crypto.randomBytes(4).toString('hex') + '.log');

const TELEMETRY = { battery_level: 80, battery_charging: true, storage_free_mb: 100, storage_total_mb: 200,
  ram_free_mb: 50, ram_total_mb: 100, cpu_usage: 5, wifi_ssid: 'x', wifi_rssi: -50, uptime_seconds: 60 };

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      // The beat after the row is deleted comes ~400ms after an admitted one; with the #777 floor on it
      // would be skipped and never reach the guard this file tests.
      HEARTBEAT_MIN_INTERVAL_MS: '0' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

function makeDevice() {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, device_token, created_at)
              VALUES (?, 'HB', 'online', ?, strftime('%s','now'))`).run(id, token);
  return { id, token };
}
function connect(dev) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('a heartbeat for a device deleted mid-session does NOT drop the socket', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: TELEMETRY });
  await wait(400);
  assert.equal(s.connected, true, 'sanity: healthy heartbeat keeps the socket');

  // The row disappears underneath the live socket.
  db.prepare('DELETE FROM devices WHERE id = ?').run(dev.id);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: TELEMETRY });
  await wait(700);

  assert.equal(s.connected, true,
    'the socket survives — before this, the FK threw, the server disconnected it, and socket.io '
    + 'would not retry, so the screen stayed dark until someone reloaded it');
  s.close();
});

test('and the server stays up rather than logging a foreign-key failure', async () => {
  const log = fs.readFileSync(LOG, 'utf8');
  assert.doesNotMatch(log, /FOREIGN KEY constraint failed/,
    'no constraint error was raised at all');
  assert.doesNotMatch(log, /handler threw for/, 'and no handler was reported as broken');
});

test('telemetry for a LIVE device is still recorded', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: TELEMETRY });
  await wait(600);
  const n = db.prepare('SELECT COUNT(*) c FROM device_telemetry WHERE device_id = ?').get(dev.id).c;
  assert.ok(n >= 1, 'the guard must not have turned telemetry off for everyone');
  s.close();
});

test('a heartbeat with no telemetry is unaffected', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id });
  await wait(400);
  assert.equal(s.connected, true);
  s.close();
});
