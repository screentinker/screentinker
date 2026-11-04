'use strict';

// Temperature is the one real sensor reading this platform exposes, and it arrives from a promise
// on the player. Two things have to hold at the server end, and neither is provable from a unit
// test of the guard alone — this drives a real socket into a real server:
//
//   1. Adding the column must not break the insert for every OTHER player. The telemetry INSERT is
//      on the heartbeat path, which every device hits every 15 seconds; getting its arity wrong
//      would take the whole fleet's telemetry down, not just BrightSign's.
//   2. A panel with no sensor sends nothing, and a flaky one can send NaN or Infinity. Both must
//      land as "no reading" rather than as a number, because the dashboard renders this value and
//      null is the only honest way to say "this hardware has no thermometer".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-temp-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-temp-' + crypto.randomBytes(4).toString('hex') + '.log');

// Exactly what a browser/Android player sends: no temperature key at all.
const BASE_TELEMETRY = {
  battery_level: null, battery_charging: false, storage_free_mb: null, storage_total_mb: null,
  ram_free_mb: null, ram_total_mb: null, cpu_usage: null, wifi_ssid: 'Web Player',
  wifi_rssi: null, uptime_seconds: 42,
};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      // Back-to-back heartbeats are the point of these tests (one reading each); the #777 floor would
      // admit one per 5s. Rate limiting is tested in heartbeat-floor.test.js.
      HEARTBEAT_MIN_INTERVAL_MS: '0' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => {
  try { db && db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
});

function makeDevice() {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, device_token, created_at)
              VALUES (?, 'TEMP', 'online', ?, strftime('%s','now'))`).run(id, token);
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastTemp = (id) => db.prepare(
  'SELECT temperature_c FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC, id DESC LIMIT 1'
).get(id);

test('a reading is stored', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: { ...BASE_TELEMETRY, temperature_c: 47.3 } });
  await wait(400);
  assert.equal(lastTemp(dev.id).temperature_c, 47.3);
  s.close();
});

test('EVERY OTHER PLAYER still records telemetry — the insert arity did not change under them', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: BASE_TELEMETRY });
  await wait(400);
  const row = db.prepare(
    'SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC, id DESC LIMIT 1'
  ).get(dev.id);
  assert.ok(row, 'a player that sends no temperature must still get a telemetry row');
  assert.equal(row.temperature_c, null);
  assert.equal(row.uptime_seconds, 42, 'the rest of the payload is unaffected');
  s.close();
});

test('a flaky sensor cannot poison the column', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  for (const bad of [NaN, Infinity, -Infinity, 'hot', {}, true]) {
    s.emit('device:heartbeat', { device_id: dev.id, telemetry: { ...BASE_TELEMETRY, temperature_c: bad } });
    await wait(220);
    assert.equal(lastTemp(dev.id).temperature_c, null, `accepted ${String(bad)} as a reading`);
  }
  s.close();
});

test('a sub-zero reading is a real reading, not a falsy one', async () => {
  // 0 and negatives are legitimate temperatures; a truthiness check here would drop them.
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: { ...BASE_TELEMETRY, temperature_c: 0 } });
  await wait(400);
  assert.equal(lastTemp(dev.id).temperature_c, 0);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: { ...BASE_TELEMETRY, temperature_c: -5.5 } });
  await wait(400);
  assert.equal(lastTemp(dev.id).temperature_c, -5.5);
  s.close();
});
