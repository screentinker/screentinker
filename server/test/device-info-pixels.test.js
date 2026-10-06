'use strict';

// A player's screen and render size reach the dashboard's HTML (device detail, video wall), and a
// player is not trusted: a web player can send anything as device_info. SQLite keeps a string bound
// to an INTEGER column as TEXT, so `screen_width: "<img onerror=...>"` used to be stored verbatim
// and run in whoever opened that screen. The server now keeps whole, plausible pixel counts only.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-px-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-px-' + crypto.randomBytes(4).toString('hex') + '.log');

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
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
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
function register(dev, deviceInfo) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: deviceInfo }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}
const dims = (id) => db.prepare('SELECT screen_width, screen_height, render_width, render_height FROM devices WHERE id = ?').get(id);
// Poll rather than sleep a fixed time: a slow CI runner must not turn this into a timing test.
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); }
}

test('real pixel sizes are stored', async () => {
  const dev = makeDevice();
  const s = await register(dev, { app_version: 'px-test', screen_width: 1920, screen_height: 1080, render_width: 1280, render_height: 720 });
  const row = await until(() => { const r = dims(dev.id); return r && r.screen_width ? r : null; });
  assert.deepEqual({ ...row }, { screen_width: 1920, screen_height: 1080, render_width: 1280, render_height: 720 });
  s.close();
});

test('THE BUG: markup, strings and nonsense are never stored as a size', async () => {
  const dev = makeDevice();
  const bad = '<img src=x onerror=alert(1)>';
  const s = await register(dev, { app_version: 'px-test-bad', screen_width: bad, screen_height: '1080', render_width: 1.5, render_height: -4 });
  await until(() => db.prepare('SELECT app_version FROM devices WHERE id = ?').get(dev.id).app_version === 'px-test-bad');
  const row = dims(dev.id);
  for (const [k, v] of Object.entries(row)) assert.equal(v, null, `${k} kept ${JSON.stringify(v)}`);
  s.close();
});
