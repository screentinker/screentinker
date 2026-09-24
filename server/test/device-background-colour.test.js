'use strict';

/*
 * #325: a per-device background colour behind letterboxed content.
 *
 * The player's stylesheet hardcoded #000 in several places, so a white-background image that did
 * not fill the frame sat in a black surround and looked like a fault rather than a choice. There
 * was no per-device or per-playlist setting anywhere. This follows the route `orientation` already
 * takes: a column on devices, threaded through the socket payload, applied by the player.
 *
 * NULL means "the player's own default", so a screen that has never been given one is untouched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, jwt, deviceId;
const DATA_DIR = path.join(os.tmpdir(), 'st-bg-' + crypto.randomBytes(4).toString('hex'));
let proc, db;
const Database = require('better-sqlite3');

const put = (o) => ({ method: 'PUT', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-bg.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const email = 'bg' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
  const ws = db.prepare('SELECT id FROM workspaces LIMIT 1').get();
  deviceId = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, 'online')").run(deviceId, 'bg screen', ws.id);
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const bgOf = () => db.prepare('SELECT background_color FROM devices WHERE id = ?').get(deviceId).background_color;

test('#325: the column exists and starts NULL, so nothing changes for existing screens', () => {
  assert.equal(bgOf(), null);
});

test('#325: a hex colour is stored', async () => {
  const r = await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: '#204060' }));
  assert.equal(r.status, 200);
  assert.equal(bgOf(), '#204060');
});

test('#325: an empty value clears it back to the player default, not to an empty string', async () => {
  await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: '#ffffff' }));
  const r = await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: '' }));
  assert.equal(r.status, 200);
  assert.equal(bgOf(), null, 'cleared to NULL, so the player keeps its own default');
});

test('#325: a value that is not a hex colour is refused', async () => {
  for (const bad of ['red', 'url(x)', 'expression(1)', '#zzz', 'black; background:url(//evil)']) {
    const r = await fetch(BASE + '/api/devices/' + deviceId, put({ background_color: bad }));
    assert.equal(r.status, 400, `${bad} must be refused`);
    assert.match((await r.json()).error, /hex colour/i);
  }
  assert.equal(bgOf(), null, 'and nothing was stored');
});

test('#325: the player applies it, and only when it is a hex value', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(player, /data\.background_color/, 'the player reads the field');
  assert.match(player, /\/\^#\[0-9a-fA-F\]\{3,8\}\$\//, 'and validates it before assigning to style');
});

test('#325: it travels in the socket payload like orientation does', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(ds, /background_color: background_color \|\| null/, 'included in the assembled payload');
  assert.match(ds, /background_color: device\?\.background_color \|\| null/, 'read from the device row');
});

/*
 * #336: "The background color is not working." Saved fine, showed red in the dashboard, screen
 * stayed black through a client and a server reboot. The SELECT that feeds assemblePayload is an
 * explicit column list and background_color was never in it, so the payload carried null on every
 * push and the player kept its default. The test above matched the JavaScript text
 * `device?.background_color || null` and passed the whole time. This one runs the actual query.
 */
test('#336: the device query that feeds the payload actually selects background_color', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const m = ds.match(/const device = db\.prepare\(`(SELECT r\.playlist_id AS playlist_id[\s\S]*?WHERE d\.id = \?)`\)\.get\(deviceId\);/);
  assert.ok(m, 'the device SELECT in buildPlaylistPayload was not found -- did it restructure?');
  const sql = m[1];

  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, orientation TEXT, background_color TEXT, wall_id TEXT, timezone TEXT,
      reported_timezone TEXT, triggers_accept_http INTEGER, triggers_accept_udp INTEGER,
      trigger_secret TEXT, trigger_http_port INTEGER, trigger_udp_port INTEGER,
      trigger_multicast_group TEXT, trigger_clear_all_token TEXT,
      local_api_enabled INTEGER, local_api_secret TEXT,
      default_content_id TEXT, workspace_id TEXT,
      capabilities TEXT, platform TEXT, android_version TEXT, client_type TEXT,
      playlist_id TEXT, layout_id TEXT
    );
    CREATE VIEW device_resolved_playlist AS
      SELECT id AS device_id, playlist_id, 'device' AS source, layout_id FROM devices;
    INSERT INTO devices (id, orientation, background_color) VALUES ('d1', 'landscape', '#ff0000');
    INSERT INTO devices (id, orientation, background_color) VALUES ('d2', 'landscape', NULL);
  `);
  const red = mem.prepare(sql).get('d1');
  const unset = mem.prepare(sql).get('d2');
  mem.close();
  assert.equal(red.background_color, '#ff0000', 'a saved colour must come out of the query the payload is built from');
  assert.equal(unset.background_color, null, 'and an unset one stays null, which the player treats as its default');
});

/*
 * Same #336 class: the payload passes `workspace_id: device?.workspace_id` into assemblePayload, but
 * the device SELECT omitted d.workspace_id, so it was always undefined -> null. That made
 * attachDataSourceBag(null) / customShaderRegistry(null) no-op, so data-source play_when gating and
 * custom shader transitions were silently dead on every live device. Run the real query and prove
 * workspace_id comes out of it.
 */
test('the device query selects workspace_id (data-source play_when + custom shaders depend on it)', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const m = ds.match(/const device = db\.prepare\(`(SELECT r\.playlist_id AS playlist_id[\s\S]*?WHERE d\.id = \?)`\)\.get\(deviceId\);/);
  assert.ok(m, 'device SELECT not found');
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, orientation TEXT, background_color TEXT, wall_id TEXT, timezone TEXT,
      reported_timezone TEXT, triggers_accept_http INTEGER, triggers_accept_udp INTEGER,
      trigger_secret TEXT, trigger_http_port INTEGER, trigger_udp_port INTEGER,
      trigger_multicast_group TEXT, trigger_clear_all_token TEXT,
      local_api_enabled INTEGER, local_api_secret TEXT,
      default_content_id TEXT, workspace_id TEXT,
      capabilities TEXT, platform TEXT, android_version TEXT, client_type TEXT, playlist_id TEXT, layout_id TEXT
    );
    CREATE VIEW device_resolved_playlist AS SELECT id AS device_id, playlist_id, 'device' AS source, layout_id FROM devices;
    INSERT INTO devices (id, orientation, workspace_id) VALUES ('d1', 'landscape', 'ws-42');
  `);
  const got = mem.prepare(m[1]).get('d1');
  mem.close();
  assert.equal(got.workspace_id, 'ws-42', 'workspace_id must come out of the query the payload is built from');
});

test('#336: the fullscreen video and widget surfaces no longer paint their own black over it', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  // object-fit:contain letterboxes inside the element, so an opaque element background hides the
  // stage colour for every video that does not fill the frame. Wall tiles keep fill+black.
  assert.doesNotMatch(player, /object-fit:contain;background:#000/, 'a contain-fitted video must not carry an opaque black');
  assert.doesNotMatch(player, /border:none;background:#000'/, 'the widget iframe must not carry an opaque black');
});

/*
 * Default content (off-hours fallback image). `default_content_id` was a stored-but-dead device
 * setting: saved in the DB, never sent to any player, never rendered. A screen with no playlist,
 * or whose only item is outside its schedule window, went black. These lock in the wiring so it
 * stays a real feature: the device SELECT reads the column, the payload carries a resolved
 * `default_content` object, and the player renders it when it would otherwise show idle text.
 */
test('default_content: device SELECT reads default_content_id and payload carries the object', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(ds, /d\.default_content_id/, 'the device SELECT must read default_content_id');
  assert.match(ds, /if \(device\?\.default_content_id\)/, 'payload resolves default_content only when one is set');
  assert.match(ds, /FROM content WHERE id = \?/, 'default_content is resolved from the content row');
  assert.match(ds, /default_content: default_content \|\| null/, 'assembled payload carries default_content (null when unset)');
});

test('default_content: the web player reads it and renders it when idle', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(player, /data\.default_content/, 'the player reads the top-level field');
  assert.match(player, /function renderDefaultContent\(\)/, 'the player has an idle-fallback renderer');
  // it must be consulted on the "nothing to show" paths, not just declared
  assert.match(player, /if \(!renderDefaultContent\(\)\)/, 'idle paths try the default image before falling back to status text');
});
