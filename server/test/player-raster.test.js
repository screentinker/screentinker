'use strict';

/*
 * GET /api/player/raster — a browser-only item as a still frame for the Roku (routes/player-raster.js).
 *
 * Chromium is stubbed at the route's renderer seam: what is under test here is the contract — who
 * may render what, the parameters, the cache key / ETag / 304, X-ST-Refresh-In, the 501 when there is
 * no browser — not Chromium. The colour encoder is the real one, so the bytes that come back really
 * are a JPEG or a PNG of the requested size.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-raster-' + crypto.randomBytes(4).toString('hex'));
process.env.PLAYER_RASTER_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-raster-cache-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { Jimp } = require('jimp');

const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const raster = require('../routes/player-raster');

const RASTER_CAPS = JSON.stringify(['playback.video', 'playback.image', 'playback.widget', 'render.server_raster', 'clock.tz_table']);
const TOKEN_A = 'tok-raster-a';
const TOKEN_A2 = 'tok-raster-a2';
const TOKEN_WEB = 'tok-raster-web';

let server, base, io, ioServer;
const calls = [];
let available = true;
let frameDelayMs = 0;
let framePng;

before(async () => {
  // A real PNG, so the real encoder has something to encode.
  framePng = await new Jimp({ width: 32, height: 18, color: 0x3366ccff }).getBuffer('image/png');
  raster.__renderer.available = () => available;
  raster.__renderer.frame = async (source, profile, options) => {
    calls.push({ source, profile, options });
    if (frameDelayMs) await new Promise((r) => setTimeout(r, frameDelayMs));
    return framePng;
  };

  db.pragma('foreign_keys = OFF');
  const snapshot = JSON.stringify([
    { widget_id: 'w-ref', widget_type: 'clock', duration_sec: 10, sort_order: 0 },
    { content_id: 'c-ref-page', mime_type: 'text/html', remote_url: 'https://example.org/ref', duration_sec: 10, sort_order: 1 },
  ]);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id, published_snapshot, published_playback_order) VALUES ('pl-a','u-a','A','ws-a',?, 'sequential')").run(snapshot);
  const dev = (id, ws, token, capsJson, playlist, platform, clientType) =>
    db.prepare("INSERT INTO devices (id, status, workspace_id, device_token, capabilities, playlist_id, platform, client_type, timezone) VALUES (?, 'online', ?, ?, ?, ?, ?, ?, 'America/Chicago')")
      .run(id, ws, token, capsJson, playlist, platform, clientType);
  dev('dev-a', 'ws-a', TOKEN_A, RASTER_CAPS, 'pl-a', 'roku', 'roku');
  dev('dev-a2', 'ws-a', TOKEN_A2, RASTER_CAPS, null, 'roku', 'roku');
  dev('dev-web', 'ws-a', TOKEN_WEB, JSON.stringify(['playback.video', 'playback.widget']), null, 'Web/Chrome', 'player');
  const widget = (id, ws, type, config = '{}') =>
    db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config, updated_at) VALUES (?, ?, ?, ?, ?, 1000)").run(id, ws, type, id, config);
  widget('w-clock', 'ws-a', 'clock');
  widget('w-slide', 'ws-a', 'slide', JSON.stringify({ fields: { title: 'Hello' } }));
  widget('w-room', 'ws-a', 'room-display');
  widget('w-foreign', 'ws-b', 'clock');
  widget('w-ref', 'ws-b', 'clock');   // another workspace's, but in dev-a's own playlist (a corporate mandate, say)
  const content = (id, ws, mime, extra = {}) =>
    db.prepare(`INSERT INTO content (id, workspace_id, filename, mime_type, filepath, remote_url, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 500, 500)`).run(id, ws, id, mime, extra.filepath || '', extra.remote_url || null);
  content('c-page', 'ws-a', 'text/html', { remote_url: 'https://example.org/board' });
  content('c-img', 'ws-a', 'image/png', { filepath: 'x.png' });
  content('c-video', 'ws-a', 'video/mp4', { filepath: 'x.mp4' });
  content('c-hls', 'ws-a', 'video/hls', { remote_url: 'https://example.org/live.m3u8' });
  content('c-pdf', 'ws-a', 'application/pdf', { filepath: 'x.pdf' });
  content('c-foreign', 'ws-b', 'text/html', { remote_url: 'https://example.org/theirs' });
  content('c-ref-page', 'ws-b', 'text/html', { remote_url: 'https://example.org/ref' });
  db.pragma('foreign_keys = ON');

  // The payload builder (for "referenced by its own playlist") is exported once the socket is set up.
  ioServer = http.createServer();
  io = new Server(ioServer);
  setupDeviceSocket(io);

  const app = express();
  app.use('/api/player', raster);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/player/raster`;
});
after(() => {
  try { server.close(); } catch { /* */ }
  try { io.close(); } catch { /* */ }
  try { ioServer.close(); } catch { /* */ }
});
beforeEach(() => { raster.__reset(); calls.length = 0; available = true; frameDelayMs = 0; });

const get = (qs, { token = TOKEN_A, device = 'dev-a', headers = {} } = {}) => fetch(`${base}?device_id=${device}&${qs}`, {
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
});

// ------------------------------------------------------------------ auth

test('device-token auth exactly like /api/embedded', async () => {
  assert.equal((await get('widget_id=w-clock', { token: null })).status, 401);
  assert.equal((await get('widget_id=w-clock', { token: 'wrong-token-wrong' })).status, 401);
  assert.equal((await fetch(`${base}?widget_id=w-clock`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).status, 400, 'device_id required');
  assert.equal((await get('widget_id=w-clock', { token: TOKEN_A2 })).status, 401, "another device's token is not this one's");
});

test('a device that does not declare render.server_raster is refused', async () => {
  const res = await get('widget_id=w-clock', { token: TOKEN_WEB, device: 'dev-web' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'capability_required', capability: 'render.server_raster' });
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ tenancy

test("another workspace's widget or content is a 404 — the same answer as an unknown id", async () => {
  for (const qs of ['widget_id=w-foreign', 'content_id=c-foreign', 'widget_id=nope', 'content_id=nope']) {
    const res = await get(qs);
    assert.equal(res.status, 404, qs);
    assert.deepEqual(await res.json(), { error: 'not_found' }, qs);
  }
  assert.equal(calls.length, 0, 'nothing was rendered for a foreign id');
});

test("an item in this device's OWN playlist renders even when it belongs to another workspace", async () => {
  assert.equal((await get('widget_id=w-ref')).status, 200);
  assert.equal((await get('content_id=c-ref-page')).status, 200);
  // ...but not for a sibling screen in the same workspace whose playlist does not carry it.
  assert.equal((await get('widget_id=w-ref', { token: TOKEN_A2, device: 'dev-a2' })).status, 404);
});

// ------------------------------------------------------------------ the frame

test('a widget: 200 colour JPEG at the requested size, rendered from its public render page in the screen\'s zone', async () => {
  const res = await get('widget_id=w-clock&w=640&h=360');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('etag'), /^"[0-9a-f]{64}"$/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic');
  const img = await Jimp.fromBuffer(buf);
  assert.equal(img.bitmap.width, 640);
  assert.equal(img.bitmap.height, 360);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source.path, '/api/widgets/w-clock/render', 'no ?rev= (Chromium would cache an immutable copy)');
  assert.deepEqual(calls[0].profile, { width: 640, height: 360 });
  assert.equal(calls[0].options.timezone, 'America/Chicago');
});

test('bg: the zone colour goes under a transparent page (default black), is validated, and keys the cache', async () => {
  // A clock widget is white text on a transparent body; captured without a colour under it, it is
  // white on white — which is exactly what the first Roku screenshots showed.
  const plain = await get('widget_id=w-clock&w=320&h=180');
  assert.equal(plain.status, 200);
  assert.equal(calls[0].options.background, '000000', 'black when the player sends none');
  const red = await get('widget_id=w-clock&w=320&h=180&bg=%23FF0000');
  assert.equal(red.status, 200);
  assert.equal(calls[1].options.background, 'ff0000', '# allowed, lower-cased');
  assert.notEqual(plain.headers.get('etag'), red.headers.get('etag'), 'a different colour is a different frame');
  for (const bad of ['red', 'fff', '12345g', '1234567']) {
    const r = await get(`widget_id=w-clock&bg=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, bad);
  }
});

test('format=png is a PNG; q only matters for JPEG; unknown formats are refused', async () => {
  const png = await get('widget_id=w-slide&format=png&w=320&h=180');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...Buffer.from(await png.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const pngQ = await get('widget_id=w-slide&format=png&w=320&h=180&q=50');
  assert.equal(pngQ.headers.get('etag'), png.headers.get('etag'), 'q does not split the PNG cache');
  const j85 = await get('widget_id=w-slide&w=320&h=180');
  const j50 = await get('widget_id=w-slide&w=320&h=180&q=50');
  assert.notEqual(j85.headers.get('etag'), j50.headers.get('etag'), 'quality is part of a JPEG key');
  const clampLow = await get('widget_id=w-slide&w=320&h=180&q=1');
  const clampLow40 = await get('widget_id=w-slide&w=320&h=180&q=40');
  assert.equal(clampLow.headers.get('etag'), clampLow40.headers.get('etag'), 'q is clamped to 40..95');
  assert.equal((await get('widget_id=w-slide&format=gif')).status, 400);
});

test('sizes default to 1920x1080 and clamp to 64..3840', async () => {
  await get('widget_id=w-slide');
  assert.deepEqual(calls.at(-1).profile, { width: 1920, height: 1080 });
  await get('widget_id=w-slide&w=5&h=99999');
  assert.deepEqual(calls.at(-1).profile, { width: 64, height: 3840 });
  assert.equal((await get('widget_id=w-slide&w=wide')).status, 400);
});

test('exactly one of widget_id / content_id', async () => {
  assert.equal((await get('')).status, 400);
  assert.equal((await get('widget_id=w-clock&content_id=c-page')).status, 400);
});

// ------------------------------------------------------------------ caching

test('If-None-Match answers 304 without rendering; a repeat is served from the disk cache', async () => {
  const first = await get('widget_id=w-slide&w=800&h=450');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.equal(calls.length, 1);

  const notMod = await get('widget_id=w-slide&w=800&h=450', { headers: { 'If-None-Match': etag } });
  assert.equal(notMod.status, 304);
  assert.equal(notMod.headers.get('etag'), etag);
  assert.equal(notMod.headers.get('x-st-refresh-in'), '0');

  const again = await get('widget_id=w-slide&w=800&h=450');
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('etag'), etag);
  assert.equal(calls.length, 1, 'neither the 304 nor the repeat rendered again');

  // `rev` is the player's cache-buster and is ignored, or counting it up would force a render per call.
  const rev = await get('widget_id=w-slide&w=800&h=450&rev=99', { headers: { 'If-None-Match': etag } });
  assert.equal(rev.status, 304);
});

test('an edit changes the key; a stale ETag gets the new frame', async () => {
  const before = await get('widget_id=w-slide&w=400&h=225');
  const etag = before.headers.get('etag');
  db.prepare('UPDATE widgets SET updated_at = 2000 WHERE id = ?').run('w-slide');
  const after = await get('widget_id=w-slide&w=400&h=225', { headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get('etag'), etag);
});

test('a frame that does not depend on the screen is shared by the fleet; a room sign is per screen', async () => {
  // A static slide, not a clock: a clock's minute could roll between the two requests.
  const a = await get('widget_id=w-slide&w=200&h=200');
  const b = await get('widget_id=w-slide&w=200&h=200', { token: TOKEN_A2, device: 'dev-a2' });
  assert.equal(a.headers.get('etag'), b.headers.get('etag'), 'one render serves both screens');
  assert.equal(calls.length, 1);

  const ra = await get('widget_id=w-room&w=200&h=200');
  const rb = await get('widget_id=w-room&w=200&h=200', { token: TOKEN_A2, device: 'dev-a2' });
  assert.notEqual(ra.headers.get('etag'), rb.headers.get('etag'));
  assert.equal(calls.at(-1).source.path, '/api/widgets/w-room/render?device=dev-a2');
});

test('concurrent identical requests cost ONE render', async () => {
  frameDelayMs = 150;
  const rs = await Promise.all([1, 2, 3, 4].map(() => get('widget_id=w-slide&w=300&h=300')));
  for (const r of rs) assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
});

// ------------------------------------------------------------------ refresh header

test('X-ST-Refresh-In: the rest of the time bucket for a clock, 0 for a static slide', async () => {
  const clock = await get('widget_id=w-clock&w=120&h=120');
  const s = Number(clock.headers.get('x-st-refresh-in'));
  assert.ok(s >= 1 && s <= 60, `clock refresh ${s}`);
  const slide = await get('widget_id=w-slide&w=120&h=120');
  assert.equal(slide.headers.get('x-st-refresh-in'), '0');
  const page = await get('content_id=c-page&w=120&h=120');
  const p = Number(page.headers.get('x-st-refresh-in'));
  assert.ok(p >= 1 && p <= 300, `web page refresh ${p}`);
  // The raster's extra types (unknown to e-ink) have buckets too.
  assert.equal(raster.__periodFor({ widget_type: 'room-display' }).seconds, 60);
  assert.equal(raster.__periodFor({ widget_type: 'cap_alert' }).seconds, 60);
  assert.equal(raster.__periodFor({ widget_type: 'weather' }).seconds, 600, 'e-ink table wins where it has an answer');
});

// ------------------------------------------------------------------ content

test('content: a web page is navigated; native media is refused; the rest is unsupported', async () => {
  const page = await get('content_id=c-page&w=256&h=144');
  assert.equal(page.status, 200);
  assert.deepEqual(calls.at(-1).source, { url: 'https://example.org/board' });
  for (const id of ['c-img', 'c-video', 'c-hls']) {
    const r = await get(`content_id=${id}`);
    assert.equal(r.status, 400, id);
    assert.deepEqual(await r.json(), { error: 'plays_natively' }, id);
  }
  const pdf = await get('content_id=c-pdf');
  assert.equal(pdf.status, 415);
  assert.deepEqual(await pdf.json(), { error: 'unsupported_type' });
});

// ------------------------------------------------------------------ no browser

test('no Chromium configured: 501 renderer_unavailable, and a cached frame is still served', async () => {
  const warm = await get('widget_id=w-slide&w=96&h=96');
  assert.equal(warm.status, 200);
  available = false;
  const cold = await get('widget_id=w-slide&w=97&h=97');
  assert.equal(cold.status, 501);
  assert.deepEqual(await cold.json(), { error: 'renderer_unavailable' });
  assert.equal(cold.headers.get('etag'), null, 'no ETag for a frame that was never sent');
  const hit = await get('widget_id=w-slide&w=96&h=96');
  assert.equal(hit.status, 200, 'what is already rendered does not need a browser');
});

test('renders are rate-limited per device on cache misses (429 + Retry-After)', async () => {
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await get(`widget_id=w-slide&w=${500 + i}&h=100`);
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the render budget ran out');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(calls.length, 30);
  // A different screen has its own budget.
  assert.equal((await get('widget_id=w-slide&w=999&h=100', { token: TOKEN_A2, device: 'dev-a2' })).status, 200);
});

test('the renderer itself vets requests and refuses writes to this server (source)', () => {
  const src = fs.readFileSync(require.resolve('../lib/embedded-render'), 'utf8');
  const fn = src.slice(src.indexOf('function guardRasterRequests'), src.indexOf('async function renderPlayerFrame'));
  assert.match(fn, /setRequestInterception\(true\)/);
  assert.match(fn, /assertSafeUrl\(r\.url\(\)\)/, 'every non-local request is SSRF-vetted');
  assert.match(fn, /m !== 'GET' && m !== 'HEAD'/, 'the local origin is read-only');
  const frame = src.slice(src.indexOf('async function renderPlayerFrame'));
  assert.match(frame, /await assertSafeUrl\(source\.url\)/, 'a remote page is vetted before the browser sees it');
  assert.match(frame, /setCacheEnabled\(false\)/);
});
