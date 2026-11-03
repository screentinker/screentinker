'use strict';

// #777 end to end: a real server and a real device socket. A flooding player (1.9.0 beat ~20/s) must
// still be ACKed on every beat and stay online, but write at most one telemetry row (and one
// dashboard push) per floor, carry the latest telemetry when it does, and be named in the log once.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-hbfloor-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-hbfloor-' + crypto.randomBytes(4).toString('hex') + '.log');

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
      // Short floor so the test is quick; the behaviour is the same at the 5s default.
      HEARTBEAT_MIN_INTERVAL_MS: '1500' },
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


const rows = (id) => db.prepare('SELECT COUNT(*) AS n FROM device_telemetry WHERE device_id = ?').get(id).n;

test('#777 end to end: a flood is ACKed on every beat, stays online, and writes once per floor', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  let acks = 0;
  s.on('device:heartbeat-ack', () => { acks++; });
  for (let i = 0; i < 60; i++) {                       // ~60 beats in ~0.6s: a 1.9.0-style flood
    s.emit('device:heartbeat', { device_id: dev.id, client_ms: Date.now(), telemetry: { ...BASE_TELEMETRY, uptime_seconds: i } });
    await wait(10);
  }
  await wait(500);
  assert.equal(acks, 60, 'every beat is still acknowledged (the client never sees a difference)');
  assert.equal(rows(dev.id), 1, 'one telemetry row inside the floor, not 60');
  assert.equal(db.prepare('SELECT status FROM devices WHERE id = ?').get(dev.id).status, 'online');

  await wait(1600);                                    // past the floor
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: { ...BASE_TELEMETRY, uptime_seconds: 999 } });
  await wait(400);
  assert.equal(rows(dev.id), 2, 'the next beat after the floor is written');
  const last = db.prepare('SELECT uptime_seconds FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(dev.id);
  assert.equal(last.uptime_seconds, 999, 'and it carries the LATEST telemetry');

  const log = fs.readFileSync(LOG, 'utf8');
  const lines = log.split('\n').filter((l) => l.includes(dev.id) && l.includes('over the heartbeat floor'));
  assert.equal(lines.length, 1, 'the operator is told once, naming the screen');
  s.close();
});

test('#777 end to end: a normal screen (one beat) is written immediately', async () => {
  const dev = makeDevice();
  const s = await connect(dev);
  s.emit('device:heartbeat', { device_id: dev.id, telemetry: BASE_TELEMETRY });
  await wait(400);
  assert.equal(rows(dev.id), 1);
  s.close();
});
