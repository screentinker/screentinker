'use strict';

/*
 * Android "native 4K video" (android/.../player/NativeVideoPlane.kt): a per-display opt-in that puts
 * full-screen video on a SurfaceView, the display's hardware plane, instead of a TextureView drawn
 * into a UI layer that most TV boxes render at 1080p. It follows the route `background_color`
 * takes: a column on devices, the device SELECT that feeds the socket payload, a top-level payload
 * field, and the player.
 *
 * Off by default: on the hardware plane a clip loses transitions, screenshots and rotation.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'st-nv-' + crypto.randomBytes(4).toString('hex'));
let PORT, BASE, jwt, deviceId, proc, db;

const put = (o) => ({ method: 'PUT', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-nv.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const email = 'nv' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
  const ws = db.prepare('SELECT id FROM workspaces LIMIT 1').get();
  deviceId = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, 'online')").run(deviceId, 'chromecast', ws.id);
});
after(() => {
  try { db && db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const nvOf = () => db.prepare('SELECT native_video FROM devices WHERE id = ?').get(deviceId).native_video;

test('the column exists and is off for every existing screen', () => {
  assert.equal(nvOf(), 0);
});

test('Save Settings turns it on and off', async () => {
  let r = await fetch(BASE + '/api/devices/' + deviceId, put({ native_video: 1 }));
  assert.equal(r.status, 200);
  assert.equal(nvOf(), 1);
  assert.equal((await r.json()).native_video, 1, 'echoed back so the dashboard shows what was saved');
  r = await fetch(BASE + '/api/devices/' + deviceId, put({ native_video: 0 }));
  assert.equal(r.status, 200);
  assert.equal(nvOf(), 0);
});

test('a save that does not mention it leaves it alone', async () => {
  await fetch(BASE + '/api/devices/' + deviceId, put({ native_video: true }));
  await fetch(BASE + '/api/devices/' + deviceId, put({ name: 'renamed' }));
  assert.equal(nvOf(), 1);
});

/*
 * The #336 lesson (device-background-colour.test.js): a field can be in assemblePayload and still
 * never arrive, because the device SELECT feeding it is an explicit column list. Run that SELECT.
 */
test('the device query that feeds the payload selects it', () => {
  const ds = fs.readFileSync(path.join(ROOT, 'ws', 'deviceSocket.js'), 'utf8');
  const m = ds.match(/const device = db\.prepare\(`(SELECT r\.playlist_id AS playlist_id[\s\S]*?WHERE d\.id = \?)`\)\.get\(deviceId\);/);
  assert.ok(m, 'the device SELECT in buildPlaylistPayload was not found -- did it restructure?');
  db.prepare('UPDATE devices SET native_video = 1 WHERE id = ?').run(deviceId);
  const row = db.prepare(m[1]).get(deviceId);
  assert.ok(row, 'the query returns the device (real schema, real view)');
  assert.equal(row.native_video, 1);
});

test('it is a top-level payload field, passed from that row, never per item', () => {
  const ds = fs.readFileSync(path.join(ROOT, 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(ds, /native_video: !!\(device && device\.native_video\)/, 'buildPlaylistPayload passes the column');
  assert.match(ds, /function assemblePayload\(\{[^}]*\bnative_video\b[^}]*\}\)/, 'assemblePayload takes it');
  assert.match(ds, /\n {4}\.\.\.\(native_video \? \{ native_video: true \} : \{\}\),\n/,
    'and returns it top-level, ONLY when on, so an untouched screen gets the previous release\'s exact payload');
});

test('a change is pushed to the screen at once, like orientation', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'devices.js'), 'utf8');
  const m = src.match(/const payloadFields = \[([^\]]*)\]/);
  assert.ok(m && /\bnative_video\b/.test(m[1]), 'native_video is one of the fields that trigger a payload push');
});

test('the Android player reads a live payload without the key as off, and an offline state as no change', () => {
  // Absent means off (the server omits it when off). The offline-schedule states are a subset of the
  // payload (offlineStatePayload) that never carries it, so the player tags them and skips them;
  // otherwise every offline schedule change would drop the plane.
  const ds = fs.readFileSync(path.join(ROOT, 'ws', 'deviceSocket.js'), 'utf8');
  const allowed = ds.match(/function offlineStatePayload\(payload\) \{\s*const allowed = \[([^\]]*)\]/);
  assert.ok(allowed, 'offlineStatePayload found');
  assert.ok(!/native_video/.test(allowed[1]), 'offline states do not carry it (if they start to, the tag can go)');
  const main = fs.readFileSync(path.join(ROOT, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'MainActivity.kt'), 'utf8');
  assert.match(main, /if \(!data\.optBoolean\(OFFLINE_STATE_TAG, false\) && ::mediaPlayer\.isInitialized\) mediaPlayer\.setNativeVideo\(data\.optBoolean\("native_video", false\)\)/);
  assert.match(main, /optJSONObject\("payload"\)\?\.let \{ p -> try \{ JSONObject\(p\.toString\(\)\)\.put\(OFFLINE_STATE_TAG, true\)/, 'driveOfflinePlan tags the state it replays');
});

test('the dashboard offers it on Android screens only, and sends it only when shown', () => {
  const view = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.match(view, /\$\{isAndroidDevice\(device\) \? `[\s\S]{0,200}id="nativeVideoToggle"/);
  assert.match(view, /document\.getElementById\('nativeVideoToggle'\)\s*\?\s*\{ native_video:/);
  const en = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  assert.match(en, /'device\.native_video\.toggle':/);
  assert.match(en, /'device\.native_video\.hint':/);
});
