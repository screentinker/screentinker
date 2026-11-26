'use strict';

/*
 * The image-as-video render-size gate through the REAL playlist payload (#904 review). stampItems
 * skips the copy when the screen's UI already renders the image at its size, but the payload query
 * never selected render_width/render_height, so the gate never ran: every image over FHD got a 4K
 * clip, even on boxes whose UI is 4K. The unit tests passed because they built the device by hand.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const dataDir = path.join(os.tmpdir(), `st-iav-payload-${crypto.randomBytes(4).toString('hex')}`);
process.env.DATA_DIR = dataDir;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const config = require('../config');
const imageAsVideoVariants = require('../lib/image-as-video-variants');
const setupDeviceSocket = require('../ws/deviceSocket');

let httpServer, io, buildPlaylistPayload;
const C = 'iav-payload-img', PL = 'iav-payload-pl', WS = 'iav-payload-ws';

before(() => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(path.join(config.contentDir, 'big.jpg'), 'image source');
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('iavp-user', 'iavp@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('iavp-org', 'IAV', 'iavp-user');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, 'iavp-org', 'IAV');
  db.prepare(`INSERT INTO content (id, workspace_id, filename, filepath, mime_type, file_size, width, height, created_at, updated_at)
    VALUES (?, ?, 'big.jpg', 'big.jpg', 'image/jpeg', 12, 3840, 2160, 1000, 1000)`).run(C, WS);
  db.prepare('INSERT INTO playlists (id, user_id, name, workspace_id) VALUES (?,?,?,?)').run(PL, 'iavp-user', 'stills', WS);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,?,?)').run(PL, C, 0, 10);
  // Players get the PUBLISHED snapshot.
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
    .run(JSON.stringify([{ content_id: C, filename: 'big.jpg', mime_type: 'image/jpeg', filepath: 'big.jpg', duration_sec: 10, width: 3840, height: 2160 }]), PL);
});

after(() => {
  imageAsVideoVariants._resetForTest();
  try { io.close(); httpServer.close(); } catch (_) { /* */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* */ }
});

function screen(id, renderW, renderH) {
  db.prepare(`INSERT INTO devices (id, name, playlist_id, workspace_id, client_type, platform, native_video, orientation,
      screen_width, screen_height, render_width, render_height, capabilities)
    VALUES (?, ?, ?, ?, 'apk', 'Android 12', 1, 'landscape', 3840, 2160, ?, ?, ?)`)
    .run(id, id, PL, WS, renderW, renderH, JSON.stringify(['playback.video', imageAsVideoVariants.CAPABILITY]));
  return id;
}

test('a box whose UI already renders 4K gets the image itself, no clip queued', () => {
  imageAsVideoVariants.removeFor(C);
  const item = buildPlaylistPayload(screen('iavp-4k-ui', 3840, 2160)).assignments.find((a) => a.content_id === C);
  assert.ok(item, 'the image is in the payload');
  assert.equal(item.image_as_video_state, undefined);
  assert.equal(db.prepare('SELECT 1 FROM content_image_as_video_variants WHERE content_id = ?').get(C), undefined);
});

test('a box whose UI renders 1080p on a 4K panel gets the clip queued for it', () => {
  imageAsVideoVariants.removeFor(C);
  const item = buildPlaylistPayload(screen('iavp-fhd-ui', 1920, 1080)).assignments.find((a) => a.content_id === C);
  assert.equal(item.image_as_video_state, 'preparing');
  assert.equal(db.prepare('SELECT status FROM content_image_as_video_variants WHERE content_id = ?').get(C).status, 'queued');
  imageAsVideoVariants.removeFor(C);
});
