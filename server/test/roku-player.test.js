'use strict';

/*
 * The Roku player, server side (docs/roku-player.md):
 *   - the 'roku' family: how a Roku is recognised, and the honest baseline it falls back to;
 *   - a real registration over Engine.IO LONG-POLLING (the only transport a Roku has) persists
 *     client_type 'roku' and lands in the roku family, and a later register that omits the
 *     identity fields does not erase it;
 *   - tz_table rides the playlist payload ONLY for a player that declares clock.tz_table, and every
 *     other player's payload is unchanged.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-roku-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

const caps = require('../lib/player-capabilities');

// ------------------------------------------------------------------ family + baseline (pure)

test('a Roku is recognised by client_type OR platform, and never as Android or web', () => {
  assert.equal(caps.platformFamily({ client_type: 'roku' }), 'roku');
  assert.equal(caps.platformFamily({ platform: 'roku' }), 'roku');
  assert.equal(caps.platformFamily({ platform: 'Roku' }), 'roku');
  // ⚠️ The Android fallback claims any non-"Web/" android_version. A Roku that ever sent its OS
  // string there must still be a Roku.
  assert.equal(caps.platformFamily({ client_type: 'roku', android_version: 'Roku OS 13.0' }), 'roku');
  assert.equal(caps.platformFamily({ platform: 'roku', android_version: '13.0.4' }), 'roku');
  // An older register that dropped platform still has client_type, and vice versa.
  assert.equal(caps.platformFamily({ client_type: 'roku', platform: 'unknown' }), 'roku');
  assert.equal(caps.platformFamily({ client_type: 'legacy', platform: 'roku' }), 'roku');
  // A substring is not enough: nobody else becomes a Roku by mentioning it.
  assert.equal(caps.platformFamily({ platform: 'Tizen 6.5 (Rokugan)' }), 'tizen');
  assert.equal(caps.platformFamily({ android_version: 'Web/Chrome', platform: 'brokuser' }), 'web');
});

test('the roku baseline: what a Roku app can do, and nothing it cannot', () => {
  const row = { client_type: 'roku', platform: 'roku', capabilities: null };
  for (const c of ['playback.video', 'playback.image', 'playback.widget', 'playback.bundle', 'playback.zones',
    'playback.transitions', 'audio.mute', 'system.restart_player', 'clock.tz_table', 'render.server_raster']) {
    assert.equal(caps.supports(row, c), true, `baseline should grant ${c}`);
  }
  for (const c of ['system.reboot', 'audio.volume', 'display.brightness', 'system.brightness', 'remote.screenshot',
    'remote.stream', 'remote.input', 'system.shell', 'system.pty', 'system.install_apk', 'system.kiosk',
    'system.self_update', 'playback.youtube', 'playback.pip', 'playback.rtsp', 'playback.hdmi_in',
    'playback.slide_audio', 'sync.native', 'sync.clock', 'offline.cache', 'display.power', 'display.rotation',
    // brand new -> in NO baseline; the Roku declares the ones it has
    'playback.hls', 'playback.hold', 'display.power_schedule', 'remote.set_server_url', 'net.http_request']) {
    assert.equal(caps.supports(row, c), false, `baseline must not grant ${c}`);
  }
});

test('the commands a Roku cannot honour are refused at the door, by name', () => {
  const row = { client_type: 'roku', platform: 'roku', capabilities: null };
  for (const [cmd, cap] of [['reboot', 'system.reboot'], ['shutdown', 'system.reboot'], ['set_volume', 'audio.volume'],
    ['set_brightness', 'display.brightness'], ['shell', 'system.shell'], ['install_apk', 'system.install_apk'],
    ['kiosk_lock', 'system.kiosk'], ['update', 'system.self_update'], ['screen_off', 'display.power']]) {
    assert.deepEqual(caps.commandAllowed(row, cmd), { ok: false, capability: cap }, cmd);
  }
  assert.deepEqual(caps.commandAllowed(row, 'refresh'), { ok: true });
  assert.deepEqual(caps.commandAllowed(row, 'set_debug'), { ok: true }, 'diagnostics stay ungated');
});

test('the two new capability names are in the vocabulary and are not commands', () => {
  for (const c of ['clock.tz_table', 'render.server_raster']) {
    assert.ok(caps.CAP_SET.has(c), c);
    for (const v of Object.values(caps.COMMAND_CAPABILITY)) {
      assert.ok(!(Array.isArray(v) ? v : [v]).includes(c), `${c} must not gate a command`);
    }
  }
  // Only the roku family assumes them; every other player has to declare.
  for (const [fam, list] of Object.entries(caps.BASELINE)) {
    if (fam === 'roku') continue;
    assert.ok(!list.includes('clock.tz_table') && !list.includes('render.server_raster'), fam);
  }
});

test('a Roku is in no OTA rollout family and cannot be fired over a LAN trigger', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/ota-rollout'), 'utf8');
  const fams = src.match(/const FAMILIES = (\{[^}]*\})/);
  assert.ok(fams, 'FAMILIES not found in lib/ota-rollout.js');
  assert.ok(!/roku/.test(fams[1]), 'the Roku store updates the channel, never us');
  const emSrc = require('node:fs').readFileSync(require.resolve('../lib/corporate/emergency'), 'utf8');
  assert.match(emSrc, /fam === 'roku'/, 'platformCannotTrigger names the Roku');
});

// ------------------------------------------------------------------ registration over polling

const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
let httpServer, io, base, buildPlaylistPayload;

before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

// ⚠️ transports: ['polling'] and upgrade: false — exactly what the Roku's SocketTask speaks. A test
// over WebSocket would prove nothing about the transport a Roku actually has.
function register(payload) {
  return new Promise((resolve, reject) => {
    const s = ioClient(`${base}/device`, { transports: ['polling'], upgrade: false, reconnection: false, forceNew: true });
    const t = setTimeout(() => { try { s.close(); } catch { /* */ } reject(new Error('register timeout')); }, 5000);
    s.on('connect', () => s.emit('device:register', payload));
    s.on('device:registered', (d) => { clearTimeout(t); resolve({ s, d }); });
    s.on('device:auth-error', (e) => { clearTimeout(t); try { s.close(); } catch { /* */ } reject(new Error('auth-error ' + JSON.stringify(e))); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const ROKU_DECLARED = ['playback.video', 'playback.image', 'playback.hls', 'playback.widget', 'playback.zones',
  'playback.transitions', 'audio.mute', 'system.restart_player', 'display.power_schedule',
  'clock.tz_table', 'render.server_raster'];

test('a Roku registering over long-polling is stored as client_type roku and resolves to the roku family', async () => {
  const code = String(crypto.randomInt(100000, 1000000));
  const { s, d } = await register({
    pairing_code: code, fingerprint: 'fp-roku-1',
    device_info: { app_version: '0.1.0', screen_width: 1920, screen_height: 1080, hardware_model: '3941X', hardware_os_version: 'Roku OS 13.0' },
    client_type: 'roku', client_version: '0.1.0', platform: 'roku', contract_version: 'v4',
    capabilities: ROKU_DECLARED,
  });
  assert.ok(d.device_id && d.device_token, 'registered with an id and a token');
  // Ride the polling transport for real: the server must have kept a polling session open.
  assert.equal(s.io.engine.transport.name, 'polling');
  await settle();
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(d.device_id);
  assert.equal(row.client_type, 'roku');
  assert.equal(row.platform, 'roku');
  assert.deepEqual(JSON.parse(row.capabilities), ROKU_DECLARED, 'the declaration is stored as sent');
  assert.equal(caps.platformFamily(row), 'roku');
  s.close();

  // A later register from a build that omits identity (captureIdentity turns that into
  // 'legacy'/'unknown') must not erase it — the liveness.js preservation rule, same as 'wgt'.
  await settle();
  const again = await register({ device_id: d.device_id, device_token: d.device_token, fingerprint: 'fp-roku-1', device_info: {} });
  await settle();
  const row2 = db.prepare('SELECT client_type, platform, capabilities FROM devices WHERE id = ?').get(d.device_id);
  assert.equal(row2.client_type, 'roku', 'client_type preserved');
  assert.equal(row2.platform, 'roku', 'platform preserved');
  assert.equal(caps.platformFamily(row2), 'roku');
  again.s.close();
});

test('GET /api/devices reports platform_family roku for it (the field the dashboard reads)', () => {
  // routes/devices.js maps every row through platformFamily(); assert that mapping is still there
  // rather than standing up the whole authenticated router for one field.
  const src = require('node:fs').readFileSync(require.resolve('../routes/devices'), 'utf8');
  assert.match(src, /platform_family: playerCapabilities\.platformFamily\(d\)/);
});

// ------------------------------------------------------------------ tz_table in the payload

const PL = 'roku-pl';
before(() => {
  db.pragma('foreign_keys = OFF');
  const snapshot = JSON.stringify([
    { content_id: 'roku-img', mime_type: 'image/png', filepath: 'r.png', duration_sec: 10, sort_order: 0 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES (?,?,?,?,?, 'sequential')")
    .run(PL, 'u-roku', 'roku', 'ws-roku', snapshot);
  const mk = (id, capsJson, platform, clientType, tz) =>
    db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, capabilities, platform, client_type, timezone) VALUES (?, 'online', 'ws-roku', ?, ?, ?, ?, ?)")
      .run(id, PL, capsJson, platform, clientType, tz);
  mk('roku-tz', JSON.stringify(ROKU_DECLARED), 'roku', 'roku', 'America/Chicago');
  mk('roku-undeclared', null, 'roku', 'roku', 'America/Chicago');           // baseline has it
  mk('roku-nozone', JSON.stringify(ROKU_DECLARED), 'roku', 'roku', null);
  mk('web-tz', JSON.stringify(ROKU_DECLARED.filter((c) => c !== 'clock.tz_table' && c !== 'render.server_raster')),
    'Web/Chrome', 'player', 'America/Chicago');
  mk('web-legacy', null, 'Web/Chrome', 'player', 'America/Chicago');
  mk('apk-legacy', null, 'Android 12', 'apk', 'America/Chicago');
  db.pragma('foreign_keys = ON');
});

test('a player that declares clock.tz_table gets the table for its effective zone', () => {
  const p = buildPlaylistPayload('roku-tz');
  assert.equal(p.timezone, 'America/Chicago');
  assert.ok(p.tz_table, 'tz_table present');
  assert.equal(p.tz_table.zone, 'America/Chicago');
  const now = Date.now();
  assert.ok(p.tz_table.spans[0].from_ms <= now - 24 * 3600e3);
  assert.ok([-300, -360].includes(p.tz_table.spans[0].offset_min));
  // An undeclared Roku row falls back to the roku baseline, which has it.
  assert.ok(buildPlaylistPayload('roku-undeclared').tz_table);
});

test('no effective zone means no table: "trust your own clock" must not become "UTC"', () => {
  const p = buildPlaylistPayload('roku-nozone');
  assert.equal(p.timezone, null);
  assert.equal('tz_table' in p, false);
});

test('every player that does not declare it gets exactly the payload it got before', () => {
  for (const id of ['web-tz', 'web-legacy', 'apk-legacy']) {
    const p = buildPlaylistPayload(id);
    assert.equal('tz_table' in p, false, `${id} must not receive tz_table`);
  }
  // Byte-for-byte: the Roku's payload minus its table IS the web payload — so the table is the only
  // thing the capability adds, and nothing else moved for anyone.
  const roku = buildPlaylistPayload('roku-tz');
  delete roku.tz_table;
  assert.equal(JSON.stringify(roku), JSON.stringify(buildPlaylistPayload('web-tz')));
});

test('clock widgets in other zones get their own tables (tz_tables), so a Roku can tick them itself', () => {
  db.pragma('foreign_keys = OFF');
  const mkW = (id, tz) => db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, 'u-roku', 'ws-roku', 'clock', ?, ?)")
    .run(id, id, JSON.stringify({ timezone: tz }));
  mkW('w-ny', 'America/New_York');
  mkW('w-local', 'America/Chicago');     // the screen's own zone: covered by tz_table already
  mkW('w-bogus', 'Not/AZone');           // unknown: no table rather than a UTC one named after it
  const snap = JSON.stringify([
    { widget_id: 'w-ny', widget_type: 'clock', widget_config: JSON.stringify({ timezone: 'America/New_York' }), duration_sec: 10, sort_order: 0 },
    { widget_id: 'w-local', widget_type: 'clock', widget_config: JSON.stringify({ timezone: 'America/Chicago' }), duration_sec: 10, sort_order: 1 },
    { widget_id: 'w-bogus', widget_type: 'clock', widget_config: JSON.stringify({ timezone: 'Not/AZone' }), duration_sec: 10, sort_order: 2 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES ('roku-pl-clocks', 'u-roku', 'clocks', 'ws-roku', ?, 'sequential')").run(snap);
  db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, capabilities, platform, client_type, timezone) VALUES ('roku-clocks', 'online', 'ws-roku', 'roku-pl-clocks', ?, 'roku', 'roku', 'America/Chicago')")
    .run(JSON.stringify(ROKU_DECLARED));
  db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, capabilities, platform, client_type, timezone) VALUES ('web-clocks', 'online', 'ws-roku', 'roku-pl-clocks', NULL, 'Web/Chrome', 'player', 'America/Chicago')").run();
  db.pragma('foreign_keys = ON');

  const p = buildPlaylistPayload('roku-clocks');
  assert.ok(p.tz_tables, 'tz_tables present');
  assert.deepEqual(Object.keys(p.tz_tables), ['America/New_York']);
  assert.equal(p.tz_tables['America/New_York'].zone, 'America/New_York');
  assert.ok([-240, -300].includes(p.tz_tables['America/New_York'].spans[0].offset_min));
  assert.equal('tz_tables' in buildPlaylistPayload('web-clocks'), false, 'other players are unchanged');
});
