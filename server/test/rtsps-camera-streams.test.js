'use strict';

// RTSPS (RTSP over TLS) camera streams: the URL gate, the playback.rtsps capability, the strip that
// keeps an rtsps item off a player that only declares playback.rtsp (3.0.1 and earlier would open it
// as plain RTSP), and the per-item tls_self_signed flag reaching the player's payload.

const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = require('node:path').join(os.tmpdir(), 'st-rtsps-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const fs = require('node:fs');
const path = require('node:path');

const ru = require('../lib/remote-url');
const caps = require('../lib/player-capabilities');
const ROOT = path.join(__dirname, '..', '..');
const readF = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------------ URL gate (pure)

test('rtsp:// and rtsps:// both classify as video/rtsp; other schemes are refused', () => {
  assert.deepEqual(ru.classifyLiveUrl('rtsp://10.0.0.5/stream'), { mime: 'video/rtsp' });
  assert.deepEqual(ru.classifyLiveUrl('rtsps://admin:pw@10.0.0.5:7441/abc'), { mime: 'video/rtsp' });
  assert.deepEqual(ru.classifyLiveUrl('RTSPS://cam.local/x'), { mime: 'video/rtsp' });
  assert.equal(ru.validateRtspUrl('rtsps://cam.local/x'), null);
  assert.equal(ru.validateRtspUrl('rtspx://cam.local/x').status, 400);
  assert.equal(ru.validateRtspUrl('https://cam.local/x').status, 400);
  assert.equal(ru.isRtspsUrl('rtsps://h/x'), true);
  assert.equal(ru.isRtspsUrl('rtsp://h/x'), false);
  assert.equal(ru.isRtspsUrl(null), false);
});

test('a URL whose password is the mask is refused as a new stream (the stars are not a password)', () => {
  const e = ru.validateRtspUrl(`rtsp://admin:${ru.CREDENTIAL_MASK}@cam/x`);
  assert.equal(e && e.status, 400);
});

// ------------------------------------------------------------------ capability vocabulary (pure)

test('playback.rtsps is a known capability in NO baseline', () => {
  assert.ok(caps.CAP_SET.has('playback.rtsps'));
  for (const [platform, list] of Object.entries(caps.BASELINE)) {
    assert.ok(!list.includes('playback.rtsps'), `playback.rtsps must NOT be in the ${platform} baseline`);
  }
});

test('Android and the native player declare playback.rtsps; browser players do not', () => {
  assert.match(readF('android/app/src/main/java/com/remotedisplay/player/telemetry/PlayerCapabilities.kt'), /"playback\.rtsps"/);
  assert.match(readF('native/screentinker_native/capabilities.py'), /"playback\.rtsps"/);
  assert.doesNotMatch(readF('server/player/index.html'), /playback\.rtsps/);
  assert.doesNotMatch(readF('tizen/js/capabilities.js'), /playback\.rtsps/);
});

// ------------------------------------------------------------------ payload strip (DB)

const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
let httpServer, io, buildPlaylistPayload;
const PLID = 'rtsps-pl';

before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));
  db.pragma('foreign_keys = OFF');
  const snapshot = JSON.stringify([
    { content_id: 'cam-plain', mime_type: 'video/rtsp', remote_url: 'rtsp://10.0.0.9/cam', duration_sec: 0, sort_order: 0 },
    { content_id: 'cam-tls', mime_type: 'video/rtsp', remote_url: 'rtsps://u:p@10.0.0.9:7441/cam', tls_self_signed: 1, duration_sec: 0, sort_order: 1 },
    { content_id: 'img', mime_type: 'image/png', filepath: 'poster.png', duration_sec: 10, sort_order: 2 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES (?,?,?,?,?, 'sequential')")
    .run(PLID, 'u-rtsps', 'rtsps', 'ws-rtsps', snapshot);
  const mk = (id, list) => db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, capabilities, platform) VALUES (?, 'online', 'ws-rtsps', ?, ?, 'android')")
    .run(id, PLID, list ? JSON.stringify(list) : null);
  mk('dev-301', ['playback.video', 'playback.image', 'playback.rtsp']);                      // 3.0.1 player
  mk('dev-rtsps', ['playback.video', 'playback.image', 'playback.rtsp', 'playback.rtsps']);   // this release
  mk('dev-web', ['playback.video', 'playback.image', 'playback.hls']);
  db.pragma('foreign_keys = ON');
});
after(() => {
  try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const ids = (devId) => buildPlaylistPayload(devId).assignments.map((a) => a.content_id);

test('a player with playback.rtsp only keeps plain RTSP and loses the rtsps item', () => {
  const got = ids('dev-301');
  assert.ok(got.includes('cam-plain'));
  assert.ok(!got.includes('cam-tls'), 'an rtsps item must never reach a player that would open it as plain RTSP');
  assert.ok(got.includes('img'));
});

test('a player with playback.rtsps gets both, with tls_self_signed and the real URL', () => {
  const p = buildPlaylistPayload('dev-rtsps');
  const tls = p.assignments.find((a) => a.content_id === 'cam-tls');
  assert.ok(tls, 'the rtsps item is sent');
  assert.equal(tls.remote_url, 'rtsps://u:p@10.0.0.9:7441/cam', 'the screen gets the unmasked URL over its socket');
  assert.equal(Number(tls.tls_self_signed), 1);
  assert.ok(p.assignments.some((a) => a.content_id === 'cam-plain'));
});

test('a browser player gets neither camera', () => {
  const got = ids('dev-web');
  assert.ok(!got.includes('cam-plain') && !got.includes('cam-tls'));
});

// ------------------------------------------------------------------ live dwell on edit (source)

test('editing a playlist item accepts dwell 0 on every live type, not just HLS', () => {
  const src = readF('server/routes/playlists.js');
  const i = src.indexOf('accepts dwell 0 ("stay until skipped")');
  assert.ok(i > 0, 'the edit-path comment moved');
  const block = src.slice(i, i + 900);
  assert.match(block, /LIVE_MIMES\.includes/, 'the edit path uses the shared live list');
  assert.doesNotMatch(block, /mime_type = 'video\/hls'/, 'no HLS-only check');
});
