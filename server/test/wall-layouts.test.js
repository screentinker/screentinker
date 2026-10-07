'use strict';

/*
 * Wall layouts (lib/wall-layout.js) and hold items (lib/hold-item.js).
 *
 * A wall takes a layout like a screen does: zones in percent of the wall's player rect, each zone
 * paced by the shared clock. These pin the geometry (which panel sees a zone, which ONE plays its
 * sound), the payload a member receives, the hold strip, and — by running the player's own slot
 * maths — the cross-screen timeline from the field: "Vid A on screen 1 for 30s, then Vid B on
 * screen 2 for 60s, then A again".
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-wall-layouts-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');

const wallLayout = require('../lib/wall-layout');
const { HOLD_MIME, holdUrl } = require('../lib/hold-item');

// ------------------------------------------------------------------ geometry

const P = { x: 0, y: 0, w: 3840, h: 1080 };   // two 1920x1080 panels side by side
const SCREENS = [{ id: 'left', rect: { x: 0, y: 0, w: 1920, h: 1080 } }, { id: 'right', rect: { x: 1920, y: 0, w: 1920, h: 1080 } }];
const Z = (x, y, w, h) => ({ x_percent: x, y_percent: y, width_percent: w, height_percent: h });

test('a zone is placed in canvas units from the player rect', () => {
  assert.deepEqual(wallLayout.zoneCanvasRect(Z(50, 0, 50, 100), P), { x: 1920, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(wallLayout.zoneCanvasRect(Z(25, 25, 50, 50), { x: 100, y: 50, w: 400, h: 200 }), { x: 200, y: 100, w: 200, h: 100 });
});

test('a zone inside one panel touches only that panel, and that panel plays its sound', () => {
  assert.deepEqual(wallLayout.zonePanels(Z(0, 0, 50, 100), P, SCREENS), { touching: ['left'], audio: 'left' });
  assert.deepEqual(wallLayout.zonePanels(Z(60, 10, 20, 20), P, SCREENS), { touching: ['right'], audio: 'right' });
});

test('a zone across the seam touches both panels but plays its sound ONCE, from the panel under its centre', () => {
  const r = wallLayout.zonePanels(Z(30, 0, 30, 100), P, SCREENS);   // 1152..2304: centre 1728 → left
  assert.deepEqual(r.touching, ['left', 'right']);
  assert.equal(r.audio, 'left');
});

test('a zone whose centre falls in a bezel gap plays from the panel with the largest share of it', () => {
  const gapScreens = [{ id: 'a', rect: { x: 0, y: 0, w: 1000, h: 1000 } }, { id: 'b', rect: { x: 1100, y: 0, w: 1000, h: 1000 } }];
  const r = wallLayout.zonePanels(Z(40, 0, 20, 100), { x: 0, y: 0, w: 2100, h: 1000 }, gapScreens);   // 840..1260, centre 1050 = gap
  assert.deepEqual(r.touching, ['a', 'b']);
  assert.equal(r.audio, 'a');   // a holds 160px of it, b 160px — ties go to the first; widen b's share:
  const r2 = wallLayout.zonePanels(Z(45, 0, 20, 100), { x: 0, y: 0, w: 2100, h: 1000 }, gapScreens);   // 945..1365
  assert.equal(r2.audio, 'b');
});

test('one zone is not a layout', () => {
  assert.equal(wallLayout.isZonedLayout({ zones: [Z(0, 0, 100, 100)] }), false);
  assert.equal(wallLayout.isZonedLayout({ zones: [Z(0, 0, 50, 100), Z(50, 0, 50, 100)] }), true);
  assert.equal(wallLayout.isZonedLayout(null), false);
});

// ------------------------------------------------------------------ hold item

test('a hold is hold://blank or hold://freeze, and a junk mode is blank', () => {
  assert.equal(HOLD_MIME, 'application/x-st-hold');
  assert.equal(holdUrl('freeze'), 'hold://freeze');
  assert.equal(holdUrl('blank'), 'hold://blank');
  assert.equal(holdUrl('sideways'), 'hold://blank');
});

test('playback.hold and playback.wall_zones are in the vocabulary but in NO baseline', () => {
  const caps = require('../lib/player-capabilities');
  for (const c of ['playback.hold', 'playback.wall_zones']) {
    assert.ok(caps.CAPABILITIES.includes(c), c);
    for (const platform of ['Android 9', 'Web/1.0', 'Tizen 6', 'BrightSign', 'Linux/Debian (Raspberry Pi)']) {
      assert.equal(caps.supports({ capabilities: null, platform, android_version: platform.startsWith('Android') ? '9' : '' }, c), false, c + ' ' + platform);
    }
  }
});

// ------------------------------------------------------------------ payload

const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
let httpServer, io, buildPlaylistPayload;
const WEB_CAPS = JSON.stringify(['playback.video', 'playback.image', 'playback.zones', 'playback.hold', 'playback.wall_zones']);

function addWall(id, { layoutId = null, playlistId = null, panels }) {
  db.prepare(`INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, leader_device_id, layout_id, playlist_id)
              VALUES (?, 'u', 'ws-w', ?, 2, 1, ?, ?, ?)`).run(id, id, panels[0].id, layoutId, playlistId);
  for (const [i, p] of panels.entries()) {
    db.prepare(`INSERT INTO devices (id, status, workspace_id, wall_id, capabilities, platform) VALUES (?, 'online', 'ws-w', ?, ?, 'Web/1.0')`)
      .run(p.id, id, p.caps === undefined ? WEB_CAPS : p.caps);
    db.prepare(`INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row, rotation, canvas_x, canvas_y, canvas_width, canvas_height)
                VALUES (?, ?, ?, 0, 0, ?, 0, 1920, 1080)`).run(id, p.id, i, i * 1920);
  }
}
function addLayout(id, zones) {
  db.prepare("INSERT INTO layouts (id, name, width, height, workspace_id) VALUES (?, ?, 3840, 1080, 'ws-w')").run(id, id);
  zones.forEach((z, i) => db.prepare(`INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(z.id, id, z.id, z.x_percent, z.y_percent, z.width_percent, z.height_percent, i));
}

before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));
  db.pragma('foreign_keys = OFF');
  // The field timeline: zone 1 over the left panel, zone 2 over the right.
  addLayout('lay-two', [{ id: 'z-left', ...Z(0, 0, 50, 100) }, { id: 'z-right', ...Z(50, 0, 50, 100) }]);
  addLayout('lay-one', [{ id: 'z-all', ...Z(0, 0, 100, 100) }]);
  const snapshot = JSON.stringify([
    { content_id: 'vid-a', mime_type: 'video/mp4', filepath: 'a.mp4', zone_id: 'z-left', duration_sec: 30, sort_order: 0 },
    { content_id: 'hold-1', mime_type: HOLD_MIME, remote_url: 'hold://freeze', zone_id: 'z-left', duration_sec: 60, sort_order: 1 },
    { content_id: 'hold-2', mime_type: HOLD_MIME, remote_url: 'hold://freeze', zone_id: 'z-right', duration_sec: 30, sort_order: 2 },
    { content_id: 'vid-b', mime_type: 'video/mp4', filepath: 'b.mp4', zone_id: 'z-right', duration_sec: 60, sort_order: 3 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES ('pl-wall', 'u', 'w', 'ws-w', ?, 'sequential')").run(snapshot);
  addWall('wall-zoned', { layoutId: 'lay-two', playlistId: 'pl-wall', panels: [{ id: 'w-left' }, { id: 'w-right' }, ] });
  addWall('wall-plain', { playlistId: 'pl-wall', panels: [{ id: 'p-left' }, { id: 'p-right' }] });
  addWall('wall-onezone', { layoutId: 'lay-one', playlistId: 'pl-wall', panels: [{ id: 'o-left' }, { id: 'o-right' }] });
  addWall('wall-legacy', { layoutId: 'lay-two', playlistId: 'pl-wall', panels: [{ id: 'l-left', caps: null }, { id: 'l-right', caps: null }] });
  db.pragma('foreign_keys = ON');
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

test('a member of a wall with a layout gets the WALL\'s layout, flagged canvas_layout, with its zone ids kept', () => {
  const p = buildPlaylistPayload('w-left');
  assert.equal(p.layout && p.layout.id, 'lay-two');
  assert.equal(p.wall_config.canvas_layout, true);
  assert.deepEqual(p.assignments.map((a) => a.zone_id), ['z-left', 'z-left', 'z-right', 'z-right']);
});

test('each panel plays the sound of the zone over it, and only that one', () => {
  assert.deepEqual(buildPlaylistPayload('w-left').wall_config.audio_zones, ['z-left']);
  assert.deepEqual(buildPlaylistPayload('w-right').wall_config.audio_zones, ['z-right']);
});

test('REGRESSION: a wall with no layout is exactly the plain canvas it was', () => {
  const p = buildPlaylistPayload('p-left');
  assert.equal(p.wall_config.canvas_layout, undefined);
  assert.equal(p.wall_config.audio_zones, undefined);
  assert.equal(p.layout, null);
});

test('a one-zone wall layout is no layout: plain canvas, zone ids stripped', () => {
  const p = buildPlaylistPayload('o-left');
  assert.equal(p.wall_config.canvas_layout, undefined);
  assert.ok(p.assignments.every((a) => a.zone_id == null));
});

test('a legacy wall member that declares nothing is stripped of the holds (and still gets the layout to ignore)', () => {
  const p = buildPlaylistPayload('l-left');
  assert.ok(!p.assignments.some((a) => a.mime_type === HOLD_MIME));
  assert.ok(buildPlaylistPayload('w-left').assignments.some((a) => a.mime_type === HOLD_MIME), 'a declaring player keeps them');
});

// ------------------------------------------------------------------ the player's clock maths

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' not found in the player');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

// wallZoneTarget against a stubbed clock: the exact function every panel runs.
function targetAt(items, ms) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('syncedNow', 'scheduleAllows', 'LIVE_MIME', extractFn(PLAYER, 'wallZoneTarget') + '; return wallZoneTarget;')(
    () => ms, () => true, 'video/hls');
  return fn(items);
}

test('the field timeline: A on screen 1 for 30s, then B on screen 2 for 60s, then A again — every 90s, on every panel', () => {
  const left = [{ mime_type: 'video/mp4', duration_sec: 30 }, { mime_type: HOLD_MIME, remote_url: 'hold://freeze', duration_sec: 60 }];
  const right = [{ mime_type: HOLD_MIME, remote_url: 'hold://freeze', duration_sec: 30 }, { mime_type: 'video/mp4', duration_sec: 60 }];
  const epoch = 90000 * 1000000;   // any multiple of the 90s period
  const at = (s) => [targetAt(left, epoch + s * 1000), targetAt(right, epoch + s * 1000)];
  let [l, r] = at(10);
  assert.equal(l.index, 0); assert.equal(l.posSec, 10);    // A playing
  assert.equal(r.index, 0);                                // screen 2 holding
  [l, r] = at(45);
  assert.equal(l.index, 1);                                // screen 1 frozen on A's last frame
  assert.equal(r.index, 1); assert.equal(r.posSec, 15);    // B 15s in
  [l, r] = at(95);
  assert.equal(l.index, 0); assert.equal(l.posSec, 5);     // A again
  assert.equal(r.index, 0);
});

test('a freeze hold knows the item before it, so a panel joining mid-hold can show that frame', () => {
  const left = [{ mime_type: 'video/mp4', duration_sec: 30 }, { mime_type: HOLD_MIME, remote_url: 'hold://freeze', duration_sec: 60 }];
  assert.equal(targetAt(left, 90000 * 7 + 50000).prevIndex, 0);
});

test('a zone with nothing in its schedule has no target (and the zone blanks)', () => {
  assert.equal(targetAt([], 12345), null);
  assert.equal(targetAt([{ mime_type: 'video/hls', duration_sec: 0 }], 12345), null, 'an infinite live dwell has no slot');
});

test('the web player declares both capabilities, keeps the relay out of a wall layout, and routes it to the wall renderer', () => {
  const caps = extractFn(PLAYER, 'declaredCapabilities');
  assert.match(caps, /'playback\.hold'/);
  assert.match(caps, /'playback\.wall_zones'/);
  assert.match(extractFn(PLAYER, 'emitWallSync'), /if \(wallZonesActive\(\)\) return;/);
  assert.match(extractFn(PLAYER, 'renderContent'), /if \(wallZonesActive\(\)\) \{\s*renderWallZones\(container\);/);
  assert.match(extractFn(PLAYER, 'teardownCurrentMedia'), /stopWallZones\(\);/);
});

test('⚠️ BOOT: the wall-zone state is declared before the cached playlist is restored (a TDZ throw there bricks the screen)', () => {
  const decl = PLAYER.indexOf('let wallZoneState = null;');
  const hold = PLAYER.indexOf("const HOLD_MIME = 'application/x-st-hold';");
  const restore = PLAYER.indexOf('const cachedPlaylist = loadPlaylistCache();');
  assert.ok(decl > 0 && hold > 0 && restore > 0);
  assert.ok(decl < restore && hold < restore);
});

test('the legacy build carries the same wall-zone renderer', () => {
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'player', 'legacy.html'), 'utf8');
  assert.match(legacy, /renderWallZones/);
  assert.match(legacy, /playback\.wall_zones/);
});

// ------------------------------------------------------------------ found on the two-window run

test('a clip as long as its slot does NOT loop, so a freeze after it holds the LAST frame, not frame 0', () => {
  const mount = extractFn(PLAYER, 'mountWallZoneItem');
  assert.match(mount, /built\.video\.loop = d < t\.slotSec - 0\.3;/);
  assert.match(extractFn(PLAYER, 'wallZoneTarget'), /slotSec: s\.dur \/ 1000/);
});

test('a wall panel comes back from a reboot as its slice: the wall config is cached and restored before the first render', () => {
  assert.match(extractFn(PLAYER, 'applyWallMode'), /localStorage\.setItem\('st_wall_config'/);
  const restore = PLAYER.indexOf("const cw = localStorage.getItem('st_wall_config'); if (cw) applyWallMode(JSON.parse(cw));");
  const firstRender = PLAYER.indexOf('startPlaybackAt(0); // #74/#75: honour schedules from the first frame on cold-start');
  assert.ok(restore > 0 && firstRender > restore);
});

test('setting or clearing a wall layout, or moving a zone\'s sound, is a wall change (the panel re-applies it)', () => {
  assert.match(PLAYER, /`:z\$\{c\.canvas_layout \? 1 : 0\}:\$\{\(c\.audio_zones \|\| \[\]\)\.join\(','\)\}`/);
});

test('the same items under a new layout or wall geometry redraw now, not at the next item', () => {
  assert.match(PLAYER, /if \(layoutChanged \|\| wallChanged\) \{\s*console\.log\('Layout or wall changed with the same items - redrawing'\);\s*playCurrentItem\(\);/);
});

test('the wall panel summary counts by liveness state, never by an "online" state that does not exist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'video-wall.js'), 'utf8');
  const fn = extractFn(src, 'renderPanelStatus');
  assert.doesNotMatch(fn, /state !== 'online'/, 'livenessState() returns healthy/degraded/offline/provisioning');
  assert.match(fn, /x\.b\.state === 'offline' \|\| x\.b\.state === 'provisioning'/);
});

test('a non-looping clip past its end is left on its last frame (never seeked back toward frame 0)', () => {
  const tick = extractFn(PLAYER, 'wallZoneTick');
  assert.match(tick, /if \(!v\.loop && t\.posSec >= v\.duration - 0\.05\) continue;/);
  assert.ok(tick.indexOf('t.posSec >= v.duration - 0.05') < tick.indexOf('const target = t.posSec % v.duration'), 'the guard comes before the seek maths');
  assert.match(extractFn(PLAYER, 'mountWallZoneItem'), /if \(!loops && t\.posSec >= d - 0\.05\) \{ built\.video\.currentTime = Math\.max\(0, d - 0\.05\); built\.video\.pause\(\); \}/);
});

test('a ONE-slot zone restarts its clip every pass: the loop cycle is part of a clip\'s mount key', () => {
  const items = [{ mime_type: 'video/mp4', duration_sec: 30 }];
  assert.equal(targetAt(items, 30000 * 7 + 1000).cycle, 7);
  assert.equal(targetAt(items, 30000 * 8 + 1000).cycle, 8);
  assert.match(extractFn(PLAYER, 'wallZoneTick'), /\(isClip \? '\|' \+ t\.cycle : ''\)/);
});
