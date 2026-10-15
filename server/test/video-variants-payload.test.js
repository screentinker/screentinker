'use strict';

// 3.0 TV-safe video copies: the payload half, through the real send path (buildPlaylistPayload).
//
// A Tizen TV must learn, per video item, (a) whether the video is tall (width/height), (b) whether
// the operator marked it "already rotated for portrait screens", and (c) which server copies are
// ready — and a screen that uses copies must queue its missing one lazily while one that does not
// must never cost the server a frame of encoding. Also pins the schema: the migration is additive,
// and the copy tables are classified for org export (a cache / instance accounting: never exported).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-vvp-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.VIDEO_VARIANTS_ENABLED;

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const vv = require('../lib/video-variants');

let buildPlaylistPayload;
const PL = 'pl-vv';
const TALL = 'c-tall';
const WIDE = 'c-wide';
const PRE = 'c-pre';
const TV_CAPS = JSON.stringify(['playback.video', 'playback.video_variants']);

function addDevice(id, orientation, caps) {
  db.prepare('INSERT INTO devices (id, name, playlist_id, workspace_id, orientation, capabilities, platform) VALUES (?,?,?,?,?,?,?)')
    .run(id, id, PL, 'ws-vv', orientation, caps, 'tizen');
}
const items = (dev) => {
  const out = {};
  for (const a of buildPlaylistPayload(dev).assignments) out[a.content_id] = a;
  return out;
};
const queued = () => db.prepare('SELECT content_id, kind, status FROM content_video_variants ORDER BY content_id, kind').all().map((r) => ({ ...r }));

before(() => {
  const httpServer = http.createServer(); const io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  vv._resetForTest({});

  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').run('u', 'vv@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run('org-vv', 'Org', 'u');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?,?,?)').run('ws-vv', 'org-vv', 'WS');
  const add = db.prepare('INSERT INTO content (id, workspace_id, filename, mime_type, file_size, filepath, width, height, video_prerotated, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  add.run(TALL, 'ws-vv', 'tall.mp4', 'video/mp4', 100, 'tall.mp4', 1080, 1920, 0, 1000, 1000);
  add.run(WIDE, 'ws-vv', 'wide.mp4', 'video/mp4', 100, 'wide.mp4', 1920, 1080, 0, 1000, 1000);
  add.run(PRE, 'ws-vv', 'pre.mp4', 'video/mp4', 100, 'pre.mp4', 1920, 1080, 1, 1000, 1000);
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?,?,?,?)').run(PL, 'u', 'ws-vv', 'vv');
  const snap = [];
  [TALL, WIDE, PRE].forEach((id, i) => {
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,?,?)').run(PL, id, i, 10);
    snap.push({ content_id: id, filename: id + '.mp4', mime_type: 'video/mp4', filepath: id.slice(2) + '.mp4', duration_sec: 10 });
  });
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(snap), PL);
});

test('schema: the migration is additive and re-runnable', () => {
  const cols = db.prepare('PRAGMA table_info(content)').all().map((c) => c.name);
  assert.ok(cols.includes('video_prerotated'));
  assert.equal(db.prepare('SELECT video_prerotated FROM content WHERE id = ?').get(WIDE).video_prerotated, 0, 'defaults to off');
  for (const t of ['content_video_variants', 'video_variant_usage']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8');
  assert.match(src, /CREATE TABLE IF NOT EXISTS content_video_variants/);
  assert.match(src, /CREATE TABLE IF NOT EXISTS video_variant_usage/);
});

test('export: the copy tables are classified (never exported: a cache, and instance accounting)', () => {
  const { EXCLUDED } = require('../lib/trust/export-tables');
  assert.ok(EXCLUDED.content_video_variants);
  assert.ok(EXCLUDED.video_variant_usage);
});

test('payload: width/height and the pre-rotated flag ride on every uploaded video, read at send time', () => {
  addDevice('web-portrait', 'portrait', JSON.stringify(['playback.video']));
  const it = items('web-portrait');
  assert.equal(it[TALL].width, 1080); assert.equal(it[TALL].height, 1920);
  assert.equal(it[WIDE].width, 1920);
  assert.equal(it[PRE].video_prerotated, 1);
  assert.equal(it[WIDE].video_prerotated, undefined, 'sent only when set');

  db.prepare('UPDATE content SET video_prerotated = 1 WHERE id = ?').run(WIDE);
  assert.equal(items('web-portrait')[WIDE].video_prerotated, 1, 'no republish needed');
  db.prepare('UPDATE content SET video_prerotated = 0 WHERE id = ?').run(WIDE);
});

test('NEED-GATING: a screen that does not use copies never queues one', () => {
  const it = items('web-portrait');
  assert.equal(it[TALL].video_variant_state, undefined);
  assert.deepEqual(queued(), []);
});

test('the forecast preview reads but never queues', () => {
  addDevice('tv-portrait', 'portrait', TV_CAPS);
  // lib/device-simulate.js (the dashboard's "what will this screen show") calls it this way.
  setupDeviceSocket.buildPlaylistPayloadUnchecked('tv-portrait', { forecast: true });
  assert.deepEqual(queued(), []);
});

test('a portrait Tizen TV queues ONLY its rot_cw copy of the tall video and is told "preparing"', () => {
  const it = items('tv-portrait');
  assert.deepEqual(queued(), [{ content_id: TALL, kind: 'rot_cw', status: 'queued' }], 'nothing for wide or pre-rotated videos');
  assert.equal(it[TALL].video_variant_state, 'preparing');
  assert.equal(it[TALL].video_variants, undefined);
  assert.equal(it[WIDE].video_variant_state, undefined);
});

test('once ready, the copy is listed by kind with its revision; a landscape TV adds only fit', () => {
  db.prepare("UPDATE content_video_variants SET status = 'ready', filepath = ?, updated_at = 4242 WHERE content_id = ? AND kind = 'rot_cw'")
    .run(`stv_${TALL}_rot_cw_0badf00d.mp4`, TALL);
  const it = items('tv-portrait');
  assert.deepEqual(it[TALL].video_variants, { rot_cw: 4242 });
  assert.equal(it[TALL].video_variant_state, undefined);

  addDevice('tv-landscape', 'landscape', TV_CAPS);
  items('tv-landscape');
  assert.deepEqual(queued().map((r) => r.kind), ['fit', 'rot_cw']);
});

test('a wall member needs the upright copy whatever its own orientation says', () => {
  assert.equal(vv.kindForDevice({ orientation: 'portrait', wall_id: 'w1', capabilities: TV_CAPS, platform: 'tizen' }), 'fit');
  assert.equal(vv.kindForDevice({ orientation: 'portrait', capabilities: TV_CAPS, platform: 'tizen' }), 'rot_cw');
});

test('the Tizen player declares the capability; the web player does not', () => {
  const fs = require('node:fs');
  const tizenCaps = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'capabilities.js'), 'utf8');
  assert.match(tizenCaps, /'playback\.video_variants'/);
  const web = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.doesNotMatch(web, /'playback\.video_variants'/, 'the web player rotates tall video fine itself: no CPU for it');
});
