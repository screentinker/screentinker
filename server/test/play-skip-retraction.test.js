'use strict';

/*
 * #649 — a bundle that asks to be skipped is not a play. Players send play_end with skipped:true
 * for it; the server DELETES the row that item opened (Reports count rows, so closing it with
 * completed=0 would still count it), deletes nothing else, and winds the throttle back so the next
 * item's start a moment later is not dropped in its place. Over a real socket against a real server.
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

let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-psr-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
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
  S.device = crypto.randomUUID();
  S.token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, device_token, created_at)
              VALUES (?, 'B', 'online', ?, strftime('%s','now'))`).run(S.device, S.token);
  S.bundle = crypto.randomUUID();
  S.image = crypto.randomUUID();
  S.widget = crypto.randomUUID();
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type) VALUES (?, 'tile.zip', 'tile.zip', 'application/vnd.screentinker.bundle+zip')").run(S.bundle);
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type) VALUES (?, 'next.png', 'next.png', 'image/png')").run(S.image);
  db.prepare(`INSERT INTO widgets (id, name, widget_type, config, created_at, updated_at)
              VALUES (?, 'Clock', 'clock', '{}', strftime('%s','now'), strftime('%s','now'))`).run(S.widget);
});
after(() => {
  try { db && db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(LOG, { force: true }); } catch { /* */ }
});

function connect() {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: S.device, device_token: S.token }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clearThrottle = () => wait(2200);
const rowsFor = (id) => db.prepare('SELECT * FROM play_logs WHERE device_id = ? AND (content_id = ? OR widget_id = ?) ORDER BY id').all(S.device, id, id);
const ev = (s, body) => s.emit('device:play-event', { device_id: S.device, ...body });

test('a skipped play is deleted, and the next item starting a moment later is still recorded', async () => {
  const s = await connect();
  try {
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.bundle, content_name: 'tile.zip' });
    await wait(300);
    assert.equal(rowsFor(S.bundle).length, 1, 'precondition: the start opened a row');
    ev(s, { event: 'play_end', content_id: S.bundle, completed: false, skipped: true, elapsed_ms: 120 });
    // The next item, well inside the 2 s throttle window that the bundle's start opened.
    ev(s, { event: 'play_start', content_id: S.image, content_name: 'next.png' });
    await wait(500);
    assert.deepEqual(rowsFor(S.bundle), [], 'the skipped bundle left no row');
    assert.equal(rowsFor(S.image).length, 1, 'the throttle was wound back: the real play that followed is recorded');
  } finally { s.close(); }
});

test('⚠️ only the row that item opened: an earlier, real play of the same bundle survives', async () => {
  const s = await connect();
  try {
    // A real play of the bundle that was never closed (a campaign zone never sends play_end).
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.bundle, content_name: 'tile.zip' });
    await wait(300);
    const real = rowsFor(S.bundle).map((r) => r.id);
    assert.equal(real.length, 1);
    // Something else plays in between, then a later visit of the bundle skips. Its own start was
    // throttled away, so there is no row of its own to retract.
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.image, content_name: 'next.png' });
    await wait(300);
    await clearThrottle();
    ev(s, { event: 'play_end', content_id: S.bundle, completed: false, skipped: true, elapsed_ms: 200 });
    await wait(400);
    assert.deepEqual(rowsFor(S.bundle).map((r) => r.id), real, 'the earlier play was not taken for the skipped one');
  } finally { s.close(); }
  db.prepare('DELETE FROM play_logs WHERE device_id = ?').run(S.device);
});

test('the fallback is scoped to the zone, and a widget named in content_id (Android) matches', async () => {
  const s = await connect();
  try {
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.widget, content_name: 'Clock', zone_id: 'z-left' });
    await wait(300);
    assert.equal(rowsFor(S.widget).length, 1);
    assert.equal(rowsFor(S.widget)[0].widget_id, S.widget, 'precondition: attributed to the widget');
    // A skip from ANOTHER zone for the same item: not this row (the remembered row matches by id,
    // so drop it first by starting something else).
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.image, content_name: 'next.png' });
    await wait(300);
    ev(s, { event: 'play_end', content_id: S.widget, skipped: true, completed: false, zone_id: 'z-right', elapsed_ms: 5000 });
    await wait(300);
    assert.equal(rowsFor(S.widget).length, 1, 'another zone cannot retract it');
    ev(s, { event: 'play_end', content_id: S.widget, skipped: true, completed: false, zone_id: 'z-left', elapsed_ms: 5000 });
    await wait(300);
    assert.deepEqual(rowsFor(S.widget), [], 'its own zone can');
  } finally { s.close(); }
  db.prepare('DELETE FROM play_logs WHERE device_id = ?').run(S.device);
});

test('a plain play_end is unchanged: closed, not deleted', async () => {
  const s = await connect();
  try {
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.bundle, content_name: 'tile.zip' });
    await wait(300);
    ev(s, { event: 'play_end', content_id: S.bundle, completed: true });
    await wait(300);
    const r = rowsFor(S.bundle);
    assert.equal(r.length, 1);
    assert.ok(r[0].ended_at != null, 'closed');
    assert.equal(r[0].completed, 1);
    // skipped must be exactly true: a truthy string is not a skip.
    await clearThrottle();
    ev(s, { event: 'play_start', content_id: S.image, content_name: 'next.png' });
    await wait(300);
    ev(s, { event: 'play_end', content_id: S.image, completed: true, skipped: 'yes' });
    await wait(300);
    assert.equal(rowsFor(S.image).length, 1, 'not retracted');
  } finally { s.close(); }
});
