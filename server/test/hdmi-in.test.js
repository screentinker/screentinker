'use strict';

/*
 * Live input: the screen's own HDMI IN played as an item (mime video/hdmi-in, remote_url
 * hdmi://<port>). Feasibility verified on a Fire TV Cube 3rd gen: a third-party app can list and
 * tune the input with a TvView, boxed and overlaid; the picture can never be captured.
 *
 * These pin the server side: the URL shape, the capability gate (only a player that FOUND an input
 * declares playback.hdmi_in, so every other screen is stripped of the item), live dwell semantics,
 * and e-ink never landing on it.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-hdmi-in-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');

const { classifyLiveUrl, looksLikeHdmiInUrl, validateHdmiInUrl, HDMI_IN_MIME, LIVE_MIMES } = require('../lib/remote-url');

test('hdmi:// and hdmi://<port> classify as video/hdmi-in', () => {
  assert.equal(HDMI_IN_MIME, 'video/hdmi-in');
  for (const u of ['hdmi://', 'hdmi://1', 'hdmi://2', 'HDMI://1', ' hdmi://3 ']) {
    assert.deepEqual(classifyLiveUrl(u), { mime: HDMI_IN_MIME }, u);
  }
});

test('anything else under hdmi: is refused with the shape spelled out, never classified as HLS', () => {
  for (const u of ['hdmi://0', 'hdmi://100', 'hdmi://1/x', 'hdmi://host', 'hdmi:1', 'hdmi://1?a=b']) {
    const r = classifyLiveUrl(u);
    assert.ok(r.error, u);
    assert.match(r.error.error, /hdmi:\/\/<port>/);
  }
  assert.equal(looksLikeHdmiInUrl('http://hdmi/1.m3u8'), false);
  assert.equal(validateHdmiInUrl('hdmi://1'), null);
});

test('it is a live item: dwell defaults to 5 minutes, 0 is kept, and it is never woven in by repeat-every', () => {
  assert.ok(LIVE_MIMES.includes('video/hdmi-in'));
  const { resolveItemDuration, LIVE_DEFAULT_DWELL } = require('../lib/item-duration');
  assert.equal(resolveItemDuration(undefined, { mime_type: 'video/hdmi-in' }), LIVE_DEFAULT_DWELL);
  assert.equal(resolveItemDuration(0, { mime_type: 'video/hdmi-in' }), 0);
});

test('playback.hdmi_in is in the vocabulary but in NO baseline', () => {
  const caps = require('../lib/player-capabilities');
  assert.ok(caps.CAPABILITIES.includes('playback.hdmi_in'));
  for (const platform of ['Android 9', 'Web/1.0', 'Tizen 6', 'BrightSign', 'Linux/Debian (Raspberry Pi)']) {
    assert.equal(caps.supports({ capabilities: null, platform, android_version: platform.startsWith('Android') ? '9' : '' }, 'playback.hdmi_in'), false, platform);
  }
});

// ------------------------------------------------------------------ payload strip

const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const embedded = require('../routes/embedded');
let httpServer, io, buildPlaylistPayload;
const PLID = 'hdmi-pl';

before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));
  db.pragma('foreign_keys = OFF');
  const snapshot = JSON.stringify([
    { content_id: 'hdmi-cid', mime_type: 'video/hdmi-in', remote_url: 'hdmi://1', duration_sec: 60, sort_order: 0 },
    { content_id: 'img-cid', mime_type: 'image/png', filepath: 'p.png', duration_sec: 10, sort_order: 1 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES (?,?,?,?,?, 'sequential')")
    .run(PLID, 'u-hdmi', 'hdmi', 'ws-hdmi', snapshot);
  const mk = (id, caps, platform = 'Android 9', clientType = null) =>
    db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, capabilities, platform, client_type) VALUES (?, 'online', 'ws-hdmi', ?, ?, ?, ?)")
      .run(id, PLID, caps, platform, clientType);
  mk('dev-cube', JSON.stringify(['playback.video', 'playback.image', 'playback.hls', 'playback.rtsp', 'playback.hdmi_in']));
  mk('dev-stick', JSON.stringify(['playback.video', 'playback.image', 'playback.hls', 'playback.rtsp']));   // Android, no input
  mk('dev-legacy', null);
  mk('dev-eink', null, 'eink', 'embedded');
  db.pragma('foreign_keys = ON');
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

const mimesFor = (id) => buildPlaylistPayload(id).assignments.map((a) => a.mime_type);

test('a player that found an HDMI input receives the item', () => {
  assert.ok(mimesFor('dev-cube').includes('video/hdmi-in'));
});

test('an Android player WITHOUT an input (a Fire TV Stick) is stripped of it and keeps the rest', () => {
  const m = mimesFor('dev-stick');
  assert.ok(!m.includes('video/hdmi-in'));
  assert.ok(m.includes('image/png'));
});

test('a legacy device (no declaration -> baseline) is stripped of it', () => {
  assert.ok(!mimesFor('dev-legacy').includes('video/hdmi-in'));
});

test('e-ink never lands on a live input', () => {
  const r = embedded.resolveCurrentItem('dev-eink');
  assert.notEqual(r && r.item && r.item.mime_type, 'video/hdmi-in');
});

// ------------------------------------------------------------------ wiring (source)

const fs = require('node:fs');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

test('dashboard: the Add content form posts hdmi://<port>, and the library labels and previews it as HDMI in', () => {
  // The form lives in the Add content modal (components/library/add-content.js); the type, the
  // thumbnail and the inspector's preview in components/library/content-meta.js and inspector.js.
  const add = readF('frontend/js/components/library/add-content.js');
  assert.match(add, /'addHdmiInBtn'/);
  assert.match(add, /'hdmi:\/\/' \+ port/);
  const meta = readF('frontend/js/components/library/content-meta.js');
  assert.match(meta, /m === 'video\/hdmi-in'\) return \{ key: 'hdmi'/, 'its own type, not the generic "Remote" link');
  assert.match(meta, /\['hold', 'hdmi', 'live', 'bundle'\]\.includes\(ty\)\) return null/, 'an icon, never an <img> of hdmi://');
  const insp = readF('frontend/js/components/library/inspector.js');
  assert.match(insp, /if \(ty === 'hdmi'\) return explain\(/, 'the inspector explains it and never builds a <video src="hdmi://...">');
  const lib = readF('frontend/js/views/content-library.js');
  assert.match(lib, /isHdmiIn/, 'the full preview never builds a <video src="hdmi://...">');
});

test('i18n: the live-input keys exist in BOTH en and nl', () => {
  const en = readF('frontend/js/i18n/en.js');
  const nl = readF('frontend/js/i18n/nl.js');
  for (const k of ['content.hdmi_in', 'content.hdmi_in_desc', 'content.hdmi_in_add_btn', 'content.type_hdmi_in', 'content.toast.hdmi_in_added']) {
    assert.ok(en.includes(`'${k}'`), `en ${k}`);
    assert.ok(nl.includes(`'${k}'`), `nl ${k}`);
  }
});

test('web player (dashboard preview): a live input renders a card for its dwell, never a <video>', () => {
  const html = readF('server/player/index.html');
  assert.match(html, /const isHdmiIn = item\.mime_type === 'video\/hdmi-in'/);
  assert.match(html, /const isVideo = !isYoutube && !isHls && !isHdmiIn/);
  assert.match(html, /function hdmiInCard\(item\)/);
});

test('Android declares playback.hdmi_in only when it found an input, and live input skips like a dead stream', () => {
  const caps = readF('android/app/src/main/java/com/remotedisplay/player/telemetry/PlayerCapabilities.kt');
  assert.match(caps, /if \(com\.remotedisplay\.player\.player\.LiveInputPlayer\.deviceHasInput\(context\)\) caps \+= "playback\.hdmi_in"/);
  const main = readF('android/app/src/main/java/com/remotedisplay/player/MainActivity.kt');
  assert.match(main, /LiveInput\.isLiveInput\(item\.mimeType\)/);
  const zm = readF('android/app/src/main/java/com/remotedisplay/player/player/ZoneManager.kt');
  assert.match(zm, /private fun addZoneView\(zone: Zone, view: View\)/, 'zone views keep z_index order (overlays over a live input)');
  assert.doesNotMatch(zm, /container\.addView\(\w+\); zoneViews\[zone\.id\]/, 'no zone view is appended on top any more');
  assert.doesNotMatch(readF('server/player/index.html'), /'playback\.hdmi_in'/, 'the web player must NOT declare it');
  assert.doesNotMatch(readF('tizen/js/capabilities.js'), /playback\.hdmi_in/, 'Tizen must NOT declare it');
});
