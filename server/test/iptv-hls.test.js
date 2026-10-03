'use strict';

/*
 * IPTV / live HLS. A live channel is a playlist item with mime_type 'video/hls' + a remote_url the
 * PLAYER opens on its LAN. The server never fetches it. These pin the gates that keep that true:
 *
 *  - the URL split: a player-opened URL may be private (venue IPTV is 10.x/.local); a
 *    server-retrievable one still may not (SSRF unchanged);
 *  - the capability gate: playback.hls is in NO baseline, so a legacy/undeclared/e-ink device is
 *    stripped of live items rather than sent a black <video src=m3u8> it hangs on;
 *  - dwell, not clip length: 0 is a real value ("stay until skipped") and is safe only for live;
 *  - e-ink skips a live item entirely;
 *  - every player switches on 'video/hls', and the server route never fetches the stream.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-iptv-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { Server } = require('socket.io');

const ROOT = path.join(__dirname, '..', '..');
const readF = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------------ URL gates (pure)

const { validateRemoteUrl, validatePlayerOpenedUrl, validateRtspUrl, looksLikeHlsUrl, looksLikeRtspUrl, classifyLiveUrl, LIVE_MIME, RTSP_MIME } = require('../lib/remote-url');

test('validatePlayerOpenedUrl ALLOWS private / .local http(s) hosts (venue IPTV lives on the LAN)', () => {
  for (const u of [
    'http://10.0.0.1/live.m3u8',
    'http://192.168.1.50:8080/stream/index.m3u8',
    'https://172.16.4.4/hls/ch1.m3u8',
    'http://iptv.local/playlist.m3u8',
    'http://127.0.0.1/x.m3u8',
    'https://cdn.example.com/live.m3u8',
  ]) {
    assert.equal(validatePlayerOpenedUrl(u), null, `${u} should be allowed for a player-opened URL`);
  }
});

test('validateRemoteUrl STILL rejects those private hosts (server-fetched URLs are unchanged)', () => {
  for (const u of ['http://10.0.0.1/live.m3u8', 'http://192.168.1.50/x', 'http://iptv.local/y', 'http://127.0.0.1/z']) {
    const r = validateRemoteUrl(u);
    assert.ok(r && r.status === 400, `${u} must still be blocked by the SSRF gate`);
  }
  // and a public URL still passes the SSRF gate
  assert.equal(validateRemoteUrl('https://cdn.example.com/a.m3u8'), null);
});

test('validatePlayerOpenedUrl rejects non-http(s) schemes and credentials-in-URL', () => {
  for (const u of ['rtsp://10.0.0.1/live', 'udp://239.0.0.1:1234', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://h/x']) {
    const r = validatePlayerOpenedUrl(u);
    assert.ok(r && r.status === 400, `${u} must be rejected`);
  }
  const cred = validatePlayerOpenedUrl('http://user:pass@10.0.0.1/live.m3u8');
  assert.ok(cred && cred.status === 400, 'credentials in the URL must be rejected');
});

test('looksLikeHlsUrl matches an m3u8 shape without fetching anything', () => {
  assert.ok(looksLikeHlsUrl('http://10.0.0.1/live.m3u8'));
  assert.ok(looksLikeHlsUrl('https://h/hls/index.m3u8?token=abc'));
  assert.ok(looksLikeHlsUrl('https://h/path?src=stream.m3u8'));
  assert.ok(!looksLikeHlsUrl('https://example.com/page.html'));
  assert.ok(!looksLikeHlsUrl('https://youtube.com/watch?v=abc'));
  assert.equal(LIVE_MIME, 'video/hls');
});

// ------------------------------------------------------------------ RTSP (native, Android-only)

test('classifyLiveUrl maps rtsp:// to video/rtsp (credentials allowed) and http .m3u8 to video/hls', () => {
  assert.deepEqual(classifyLiveUrl('rtsp://10.0.0.5:554/stream'), { mime: RTSP_MIME });
  assert.deepEqual(classifyLiveUrl('rtsp://admin:pass@192.168.1.10/h264'), { mime: RTSP_MIME }, 'camera credentials are allowed for rtsp');
  assert.deepEqual(classifyLiveUrl('https://cdn.example.com/live.m3u8'), { mime: LIVE_MIME });
  assert.equal(RTSP_MIME, 'video/rtsp');
});

test('classifyLiveUrl rejects non-live URLs', () => {
  for (const u of ['udp://239.0.0.1:1234', 'file:///etc/passwd', 'https://example.com/page.html']) {
    assert.ok(classifyLiveUrl(u).error, `${u} must be rejected`);
  }
  assert.ok(looksLikeRtspUrl('rtsp://x/y'));
  assert.ok(!looksLikeRtspUrl('https://x/y.m3u8'));
  assert.ok(validateRtspUrl('http://x/y'), 'the rtsp gate rejects a non-rtsp scheme');
  assert.equal(validateRtspUrl('rtsp://x/y'), null, 'and accepts rtsp://');
});

// ------------------------------------------------------------------ dwell default (pure)

const { resolveItemDuration, LIVE_DEFAULT_DWELL } = require('../lib/item-duration');

test('a live stream (hls OR rtsp) defaults to a 5-minute dwell and KEEPS an explicit 0', () => {
  for (const mime of ['video/hls', 'video/rtsp']) {
    const live = { mime_type: mime, duration_sec: null };
    assert.equal(resolveItemDuration(undefined, live), LIVE_DEFAULT_DWELL, mime);
    assert.equal(resolveItemDuration(null, live), 300, mime);
    assert.equal(resolveItemDuration(0, live), 0, `${mime}: dwell 0 must survive`);
    assert.equal(resolveItemDuration(30, live), 30, mime);
  }
});

test('dwell 0 is refused for NON-live media (a 0ms advance self-loops into a black screen)', () => {
  assert.notEqual(resolveItemDuration(0, { mime_type: 'video/mp4', duration_sec: 20 }), 0);
  assert.equal(resolveItemDuration(0, { mime_type: 'video/mp4', duration_sec: 20 }), 20, 'falls back to the clip length');
  assert.equal(resolveItemDuration(0, { mime_type: 'image/png' }), 10, 'or the flat default');
});

// ------------------------------------------------------------------ capability vocabulary (pure)

const caps = require('../lib/player-capabilities');

test('playback.hls / playback.rtsp are in the vocabulary but in NO baseline', () => {
  for (const cap of ['playback.hls', 'playback.rtsp']) {
    assert.ok(caps.CAP_SET.has(cap), `${cap} must be a known capability`);
    for (const [platform, list] of Object.entries(caps.BASELINE)) {
      assert.ok(!list.includes(cap), `${cap} must NOT be in the ${platform} baseline`);
    }
  }
});

test('supports(playback.hls) is true only when the device DECLARED it', () => {
  assert.equal(caps.supports({ capabilities: JSON.stringify(['playback.video', 'playback.hls']) }, 'playback.hls'), true);
  assert.equal(caps.supports({ capabilities: JSON.stringify(['playback.video']) }, 'playback.hls'), false);
  // null capabilities -> baseline -> no hls, on every platform
  assert.equal(caps.supports({ capabilities: null, platform: 'android' }, 'playback.hls'), false);
  assert.equal(caps.supports({ capabilities: null, platform: 'tizen' }, 'playback.hls'), false);
  assert.equal(caps.supports({ capabilities: null, platform: 'Web/1.0' }, 'playback.hls'), false);
});

// ------------------------------------------------------------------ source assertions

test('every player switches on video/hls (web, legacy, Tizen, Android)', () => {
  assert.match(readF('server/player/index.html'), /renderLiveStream/, 'web player has a live-stream branch');
  assert.match(readF('server/player/index.html'), /const isHls = item\.mime_type === LIVE_MIME/, 'web player classifies hls');
  assert.match(readF('server/player/legacy.html'), /video\/hls|renderLiveStream/, 'legacy player (rebuilt) carries the live path');
  assert.match(readF('tizen/js/player.js'), /video\/hls/, 'Tizen player references video/hls');
  assert.match(readF('android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt'), /video\/hls/, 'Android references video/hls');
});

test('live streams are first-class in multi-zone layouts too (web zone + Android ZoneManager)', () => {
  const web = readF('server/player/index.html');
  // The zone renderer routes video/hls through the shared native+hls.js attach, not a bare <video>.
  assert.match(web, /const isHls = a\.mime_type === 'video\/hls'/, 'showZoneItem classifies a live item');
  assert.match(web, /attachHlsTo\(/, 'and attaches it via the hls.js-capable helper');
  const zm = readF('android/app/src/main/java/com/remotedisplay/player/player/ZoneManager.kt');
  assert.match(zm, /val isLive = mimeType == "video\/hls"/, 'ZoneManager recognises a live stream');
  assert.match(zm, /!isLive && state == Player\.STATE_ENDED/, 'a live zone item does not wait for STATE_ENDED');
  assert.match(zm, /liveDwell/, 'and advances on its dwell instead');
});

test('every HLS-capable player DECLARES playback.hls; e-ink and no baseline do not', () => {
  assert.match(readF('server/player/index.html'), /'playback\.hls'/, 'web player declares it');
  assert.match(readF('tizen/js/capabilities.js'), /'playback\.hls'/, 'Tizen declares it');
  assert.match(readF('android/app/src/main/java/com/remotedisplay/player/telemetry/PlayerCapabilities.kt'), /"playback\.hls"/, 'Android declares it');
});

test('native RTSP is wired in the Android player (fullscreen + zones), gated and TCP-forced', () => {
  const gradle = readF('android/app/build.gradle.kts');
  assert.match(gradle, /media3-exoplayer-rtsp/, 'the RTSP ExoPlayer module is a dependency');
  const caps = readF('android/app/src/main/java/com/remotedisplay/player/telemetry/PlayerCapabilities.kt');
  assert.match(caps, /"playback\.rtsp"/, 'Android declares playback.rtsp');
  const mpm = readF('android/app/src/main/java/com/remotedisplay/player/player/MediaPlayerManager.kt');
  assert.match(mpm, /RtspMediaSource/, 'fullscreen path builds an RtspMediaSource');
  assert.match(mpm, /setForceUseRtpTcp\(true\)/, 'and forces TCP (NAT/firewall/camera-friendly)');
  const zm = readF('android/app/src/main/java/com/remotedisplay/player/player/ZoneManager.kt');
  assert.match(zm, /video\/rtsp/, 'ZoneManager handles video/rtsp');
  assert.match(zm, /RtspMediaSource/, 'zones build an RtspMediaSource too');
  // No other player claims RTSP (browsers/Tizen cannot open rtsp://).
  assert.doesNotMatch(readF('server/player/index.html'), /'playback\.rtsp'/, 'the web player must NOT declare playback.rtsp');
  assert.doesNotMatch(readF('tizen/js/capabilities.js'), /playback\.rtsp/, 'Tizen must NOT declare playback.rtsp');
});

test('the vendored hls.js is present and served locally (no CDN on an air-gapped LAN)', () => {
  const p = path.join(ROOT, 'server/player/hls.light.min.js');
  assert.ok(fs.existsSync(p), 'hls.light.min.js must be vendored under server/player/');
  assert.ok(fs.statSync(p).size > 50000, 'and be the real library, not a stub');
  assert.match(readF('server/player/index.html'), /player\/hls\.light\.min\.js/, 'the player loads the local copy');
});

test('the /hls route never fetches the stream from the server (P1: no SSRF, no WAN pull)', () => {
  const src = readF('server/routes/content.js');
  // isolate the POST /hls handler body and prove it makes no network call
  const start = src.indexOf("router.post('/hls'");
  assert.ok(start > 0, 'POST /hls handler not found');
  const end = src.indexOf('router.post(', start + 10);
  const handler = src.slice(start, end > 0 ? end : src.length).split('\n').slice(0, 40).join('\n');
  assert.ok(!/\bfetch\s*\(|https?\.get\s*\(|http?\.request\s*\(|axios/.test(handler),
    'the /hls handler must not fetch the URL — it trusts the shape and the player fails junk to a skip');
});

test('deviceSocket strips live items only for a device without playback.hls', () => {
  const ds = readF('server/ws/deviceSocket.js');
  assert.match(ds, /capsLib\.supports\(device, 'playback\.hls'\)/, 'the strip is gated on the capability');
  assert.match(ds, /mime_type === 'video\/hls'/, 'and filters live items');
  assert.match(ds, /d\.capabilities/, 'the device SELECT carries capabilities for the gate');
});

test('e-ink treats a live stream as not playable', () => {
  assert.match(readF('server/routes/embedded.js'), /mime_type !== 'video\/hls'/, 'embedded eligibility excludes live');
});

test('i18n: the new live-stream keys exist in BOTH en and nl', () => {
  const en = readF('frontend/js/i18n/en.js');
  const nl = readF('frontend/js/i18n/nl.js');
  for (const k of ['content.hls', 'content.hls_desc', 'content.hls_url_placeholder', 'content.hls_add_btn',
    'content.filter_type_live', 'content.type_live', 'content.error_enter_hls_url', 'content.toast.hls_added',
    'playlist.dwell', 'playlist.dwell_hint']) {
    assert.ok(en.includes(`'${k}'`), `en is missing ${k}`);
    assert.ok(nl.includes(`'${k}'`), `nl is missing ${k}`);
  }
});

// ------------------------------------------------------------------ DB behavior: strip + e-ink skip

const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const embedded = require('../routes/embedded');
let httpServer, io, buildPlaylistPayload;

const PLID = 'iptv-pl';
const HLS_CID = 'iptv-hls-content';
const IMG_CID = 'iptv-img-content';

before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));

  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url, workspace_id) VALUES (?,?,?,?,0,?,?)")
    .run(HLS_CID, 'Channel 1', '', 'video/hls', 'http://10.0.0.9/live.m3u8', 'ws-iptv');
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id) VALUES (?,?,?,?,0,?)")
    .run(IMG_CID, 'poster.png', 'poster.png', 'image/png', 'ws-iptv');

  const snapshot = JSON.stringify([
    { content_id: HLS_CID, mime_type: 'video/hls', remote_url: 'http://10.0.0.9/live.m3u8', duration_sec: 0, sort_order: 0 },
    { content_id: 'rtsp-cid', mime_type: 'video/rtsp', remote_url: 'rtsp://10.0.0.9/cam', duration_sec: 0, sort_order: 1 },
    { content_id: IMG_CID, mime_type: 'image/png', filepath: 'poster.png', duration_sec: 10, sort_order: 2 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES (?,?,?,?,?, 'sequential')")
    .run(PLID, 'u-iptv', 'iptv', 'ws-iptv', snapshot);

  const mkDevice = (id, capsJson) =>
    db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, capabilities, platform) VALUES (?, 'online', 'ws-iptv', ?, ?, 'Web/1.0')")
      .run(id, PLID, capsJson);
  mkDevice('dev-hls', JSON.stringify(['playback.video', 'playback.image', 'playback.hls']));   // web: hls, no rtsp
  mkDevice('dev-android', JSON.stringify(['playback.video', 'playback.image', 'playback.hls', 'playback.rtsp']));
  mkDevice('dev-nohls', JSON.stringify(['playback.video', 'playback.image']));
  mkDevice('dev-baseline', null);   // legacy: NULL capabilities -> baseline -> no hls/rtsp
  db.pragma('foreign_keys = ON');
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

test('a web device with playback.hls gets the HLS item but NOT the RTSP item (browsers cannot rtsp)', () => {
  const mimes = buildPlaylistPayload('dev-hls').assignments.map((a) => a.mime_type);
  assert.ok(mimes.includes('video/hls'), 'HLS present for an hls-capable device');
  assert.ok(!mimes.includes('video/rtsp'), 'RTSP stripped (no playback.rtsp)');
  assert.ok(mimes.includes('image/png'), 'and the normal item too');
});

test('an Android device (hls + rtsp) receives BOTH live transports', () => {
  const mimes = buildPlaylistPayload('dev-android').assignments.map((a) => a.mime_type);
  assert.ok(mimes.includes('video/hls') && mimes.includes('video/rtsp'), 'both live items present');
});

test('a device WITHOUT playback.hls has BOTH live items stripped, keeping the rest', () => {
  const mimes = buildPlaylistPayload('dev-nohls').assignments.map((a) => a.mime_type);
  assert.ok(!mimes.includes('video/hls') && !mimes.includes('video/rtsp'), 'both live items dropped');
  assert.ok(mimes.includes('image/png'), 'the rest of the playlist still plays');
});

test('a legacy device (NULL capabilities -> baseline) has the live items stripped', () => {
  const mimes = buildPlaylistPayload('dev-baseline').assignments.map((a) => a.mime_type);
  assert.ok(!mimes.includes('video/hls') && !mimes.includes('video/rtsp'), 'baseline lacks both caps');
  assert.ok(mimes.includes('image/png'));
});

test('e-ink resolveCurrentItem never lands on a live item', () => {
  // The e-ink device resolves the same playlist; the live item must be skipped to the image.
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO devices (id, status, workspace_id, playlist_id, platform, client_type) VALUES ('dev-eink','online','ws-iptv',?, 'eink', 'embedded')").run(PLID);
  db.pragma('foreign_keys = ON');
  const resolved = embedded.resolveCurrentItem('dev-eink');
  assert.ok(resolved, 'e-ink resolves something (the image), not nothing');
  assert.notEqual(resolved.item && resolved.item.mime_type, 'video/hls', 'e-ink must never resolve a live stream');
});
