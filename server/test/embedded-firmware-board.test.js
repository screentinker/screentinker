'use strict';

/*
 * Firmware offers are tied to the board the panel reports (#638 review). Real schema.
 *
 * screentinker_mcu v1.3.0 sends no board header on its polls; the one thing it says about its
 * hardware is the compile-time preset it registers with (POST /pair/register screen_profile). That
 * is recorded as devices.reported_board, and a later firmware may state it per poll (X-ST-Preset).
 *   - a panel that reports a board is only offered that board's firmware;
 *   - a panel that reports none is still offered its screen profile's firmware, and the operator is
 *     told so (firmware.board_verified false) instead of "update triggered";
 *   - a panel this server has no firmware for is refused when the update is queued, with a reason,
 *     instead of "queued" followed by a silent drop on its next poll.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const fwRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fw-board-'));
const FW = Buffer.alloc(2048, 0x33);
const FW_SHA = crypto.createHash('sha256').update(FW).digest('hex');
fs.mkdirSync(path.join(fwRoot, 'seeed_reterminal_e1001'));
fs.writeFileSync(path.join(fwRoot, 'seeed_reterminal_e1001', 'firmware.bin'), FW);
fs.writeFileSync(path.join(fwRoot, 'seeed_reterminal_e1001', 'version.json'), JSON.stringify({ version: '9.9.9' }));

const deviceNs = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }) };
const h = require('./helpers/embedded-real-db').boot({
  firmwareDir: fwRoot,
  configure(app) {
    app.set('io', { of: (n) => (n === '/device' ? deviceNs : { to: () => ({ emit() {} }) }) });
    const { requireAuth } = require('../middleware/auth');
    app.use('/api/devices', requireAuth, require('../routes/devices'));
  },
});
const queue = require('../lib/command-queue');
const otaBreaker = require('../lib/ota-breaker');
const { Jimp } = require('jimp');
const { toRGB888, toRGB565, postprocess } = require('../lib/embedded-postprocess');

after(async () => { queue._resetForTests(); await h.close(); fs.rmSync(fwRoot, { recursive: true, force: true }); });

const row = (id) => h.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
async function command(base, id, type) {
  const api = base.replace('/api/embedded', '/api/devices');
  const res = await fetch(`${api}/${id}/command`, {
    method: 'POST', headers: { Authorization: `Bearer ${h.sessionToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
  });
  return { status: res.status, body: await res.json() };
}
const poll = (base, p, headers = {}) => fetch(`${base}/render?device_id=${p.id}`, { headers: { Authorization: `Bearer ${p.token}`, 'X-ST-Firmware-Version': '1.0.0', ...headers } });

test('pairing records the preset the firmware registered with as the panel\'s reported board', async () => {
  const base = await h.ready();
  const res = await fetch(`${base}/pair/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen_profile: 'seeed-reterminal-e1004', screen_width: 1200, screen_height: 1600 }),
  });
  assert.equal(res.status, 200);
  const { device_id } = await res.json();
  assert.equal(row(device_id).reported_board, 'seeed_reterminal_e1004');

  // No profile sent: the server's Sticky default is not something the hardware said.
  const res2 = await fetch(`${base}/pair/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(row((await res2.json()).device_id).reported_board, null);

  // seeed-xiao-led with custom dimensions: preserves custom dimensions in screen_profile JSON
  const res3 = await fetch(`${base}/pair/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_profile: 'seeed-xiao-led', screen_width: 64, screen_height: 64 }),
  });
  assert.equal(res3.status, 200);
  const r3 = row((await res3.json()).device_id);
  assert.equal(r3.reported_board, 'seeed_xiao_led');
  assert.equal(r3.screen_width, 64);
  assert.equal(r3.screen_height, 64);
  const parsedProfile = JSON.parse(r3.screen_profile);
  assert.equal(parsedProfile.preset, 'seeed-xiao-led');
  assert.equal(parsedProfile.width, 64);
  assert.equal(parsedProfile.height, 64);
});

test('a panel this server has no firmware for is refused when update is queued, with the reason', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('waveshare-7.5in-v2', { extra: { power_source: 'usb' } });
  const r = await command(base, p.id, 'update');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMBEDDED_NO_FIRMWARE');
  assert.match(r.body.error, /no firmware/i);
  assert.deepEqual(queue.peekPendingCommands(p.id), [], 'not queued to be dropped later');
});

test('a panel that reports no board: queued, offered its profile\'s firmware, and the operator is told it is unverified', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { power_source: 'usb' } });
  otaBreaker.reset();
  const r = await command(base, p.id, 'update');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'queued');
  assert.deepEqual(r.body.firmware, { preset: 'seeed_reterminal_e1001', version: '9.9.9', board_verified: false });
  const res = await poll(base, p);
  assert.equal(res.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${FW_SHA}`);
});

test('a panel that reports a different board than its profile is refused at the door and never offered', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { power_source: 'usb', reported_board: 'seeed_reterminal_e1002' } });
  const r = await command(base, p.id, 'update');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMBEDDED_BOARD_MISMATCH');

  // Even if one reaches the queue some other way, the poll does not offer it.
  otaBreaker.reset();
  queue.queueCommand(p.id, 'update', {});
  const res = await poll(base, p);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-command'), null);
  assert.deepEqual(queue.peekPendingCommands(p.id), []);
});

test('a board stated per poll (X-ST-Preset) is checked and remembered', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { power_source: 'usb' } });
  otaBreaker.reset();
  queue.queueCommand(p.id, 'update', {});
  const wrong = await poll(base, p, { 'X-ST-Preset': 'seeed-reterminal-e1003' });
  assert.equal(wrong.headers.get('x-st-command'), null, 'a stated mismatch is not offered');

  const ok = await poll(base, p, { 'X-ST-Preset': 'seeed-reterminal-e1001' });
  assert.equal(row(p.id).reported_board, 'seeed_reterminal_e1001');
  assert.equal(ok.headers.get('x-st-command'), null, 'the mismatched one was dropped, nothing left');
  const r = await command(base, p.id, 'update');
  assert.equal(r.body.firmware.board_verified, true);
  const res = await poll(base, p, { 'X-ST-Preset': 'seeed-reterminal-e1001' });
  assert.equal(res.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${FW_SHA}`);
});

test('toRGB888 packs RGBA to exact 24-bit [R, G, B] order and correct length', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255,     // Red
    0, 255, 0, 255,     // Green
    0, 0, 255, 255,     // Blue
    128, 64, 32, 255,   // Custom
  ]);
  const packed = toRGB888(rgba);
  assert.equal(packed.length, 12);
  assert.deepEqual(Array.from(packed), [
    255, 0, 0,
    0, 255, 0,
    0, 0, 255,
    128, 64, 32,
  ]);
});

test('postprocess() handles 24bit-rgb888: raw RGB888 and format=jpeg override', async () => {
  const img = new Jimp({ width: 4, height: 2, color: 0xFF0000FF });
  const png = await img.getBuffer('image/png');

  // Raw RGB888 output
  const rawRes = await postprocess(png, {
    width: 4,
    height: 2,
    colorDepth: '24bit-rgb888',
    outputFormat: 'raw',
  });
  assert.equal(rawRes.contentType, 'application/octet-stream');
  assert.equal(rawRes.buffer.length, 4 * 2 * 3); // 24 bytes

  // JPEG format override output
  const jpegRes = await postprocess(png, {
    width: 4,
    height: 2,
    colorDepth: '24bit-rgb888',
    outputFormat: 'jpeg',
  });
  assert.equal(jpegRes.contentType, 'image/jpeg');
  assert.equal(jpegRes.buffer[0], 0xFF);
  assert.equal(jpegRes.buffer[1], 0xD8);
  assert.equal(jpegRes.buffer[2], 0xFF);
});

test('seeed-xiao-led end-to-end render with custom dimensions and dimension preservation', async () => {
  const base = await h.ready();
  // Register or create panel with seeed-xiao-led and custom 64x64 dimensions
  const p = await h.mkPanel('seeed-xiao-led', { extra: { screen_width: 64, screen_height: 64, power_source: 'usb' } });

  // 1. Initial render -> 64x64 raw RGB888 (12,288 bytes)
  const res = await fetch(`${base}/render?device_id=${p.id}`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-st-color-mode'), '24bit-rgb888');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 64 * 64 * 3); // 12,288 bytes

  // 2. Format override ?format=jpeg returns real JPEG bytes and image/jpeg Content-Type
  const jpegRes = await fetch(`${base}/render?device_id=${p.id}&format=jpeg`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(jpegRes.status, 200);
  assert.equal(jpegRes.headers.get('content-type'), 'image/jpeg');
  const jpegBuf = Buffer.from(await jpegRes.arrayBuffer());
  assert.equal(jpegBuf[0], 0xFF);
  assert.equal(jpegBuf[1], 0xD8);
  assert.equal(jpegBuf[2], 0xFF);

  // 3. Cache hit for ?format=jpeg also serves JPEG bytes and image/jpeg
  const cachedJpegRes = await fetch(`${base}/render?device_id=${p.id}&format=jpeg`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(cachedJpegRes.status, 200);
  assert.equal(cachedJpegRes.headers.get('content-type'), 'image/jpeg');
  const cachedBuf = Buffer.from(await cachedJpegRes.arrayBuffer());
  assert.equal(cachedBuf[0], 0xFF);
  assert.equal(cachedBuf[1], 0xD8);
  assert.equal(cachedBuf[2], 0xFF);

  // 4. PUT /api/devices/:id updating orientation preserves 64x64 dimensions in screen_profile
  const api = base.replace('/api/embedded', '/api/devices');
  const updateRes = await fetch(`${api}/${p.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${h.sessionToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation: 'portrait' }),
  });
  assert.equal(updateRes.status, 200);
  const updatedDev = row(p.id);
  const prof = typeof updatedDev.screen_profile === 'string' ? JSON.parse(updatedDev.screen_profile) : updatedDev.screen_profile;
  assert.equal(prof.width, 64);
  assert.equal(prof.height, 64);

  // 5. Subsequent render still uses 64x64 (12,288 bytes)
  const afterUpdateRes = await fetch(`${base}/render?device_id=${p.id}`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(afterUpdateRes.status, 200);
  const afterBuf = Buffer.from(await afterUpdateRes.arrayBuffer());
  assert.equal(afterBuf.length, 64 * 64 * 3);
});

test('toRGB565 packs RGBA to little-endian RGB565', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255,     // Red: (31 << 11) = 0xF800 -> LE [0x00, 0xF8]
    0, 255, 0, 255,     // Green: (63 << 5) = 0x07E0 -> LE [0xE0, 0x07]
    0, 0, 255, 255,     // Blue: 31 = 0x001F -> LE [0x1F, 0x00]
    255, 255, 255, 255, // White: 0xFFFF -> LE [0xFF, 0xFF]
  ]);
  const packed = toRGB565(rgba);
  assert.equal(packed.length, 8);
  assert.deepEqual(Array.from(packed), [
    0x00, 0xF8,
    0xE0, 0x07,
    0x1F, 0x00,
    0xFF, 0xFF,
  ]);
});

test('postprocess() handles 16bit-rgb565: raw RGB565 and format=jpeg/png override', async () => {
  const img = new Jimp({ width: 4, height: 2, color: 0xFF0000FF });
  const png = await img.getBuffer('image/png');

  // Raw RGB565 output (4 * 2 * 2 = 16 bytes)
  const rawRes = await postprocess(png, {
    width: 4,
    height: 2,
    colorDepth: '16bit-rgb565',
    outputFormat: 'raw',
  });
  assert.equal(rawRes.contentType, 'application/octet-stream');
  assert.equal(rawRes.buffer.length, 4 * 2 * 2);

  // JPEG format override output
  const jpegRes = await postprocess(png, {
    width: 4,
    height: 2,
    colorDepth: '16bit-rgb565',
    outputFormat: 'jpeg',
  });
  assert.equal(jpegRes.contentType, 'image/jpeg');
  assert.equal(jpegRes.buffer[0], 0xFF);
  assert.equal(jpegRes.buffer[1], 0xD8);
  assert.equal(jpegRes.buffer[2], 0xFF);

  // PNG format override output
  const pngRes = await postprocess(png, {
    width: 4,
    height: 2,
    colorDepth: '16bit-rgb565',
    outputFormat: 'png',
  });
  assert.equal(pngRes.contentType, 'image/png');
  assert.equal(pngRes.buffer[0], 0x89);
  assert.equal(pngRes.buffer[1], 0x50);
});

test('elecrow-crowpanel-43 end-to-end render: 480x272 raw RGB565 and ?format=jpeg preview', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('elecrow-crowpanel-43', { extra: { power_source: 'usb' } });

  // 1. Initial render -> 480x272 raw RGB565 (261,120 bytes)
  const res = await fetch(`${base}/render?device_id=${p.id}`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-st-color-mode'), '16bit-rgb565');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 480 * 272 * 2); // 261,120 bytes

  // 2. Format override ?format=jpeg returns real JPEG bytes and image/jpeg Content-Type
  const jpegRes = await fetch(`${base}/render?device_id=${p.id}&format=jpeg`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(jpegRes.status, 200);
  assert.equal(jpegRes.headers.get('content-type'), 'image/jpeg');
  const jpegBuf = Buffer.from(await jpegRes.arrayBuffer());
  assert.equal(jpegBuf[0], 0xFF);
  assert.equal(jpegBuf[1], 0xD8);
  assert.equal(jpegBuf[2], 0xFF);

  // 3. Cache hit for ?format=jpeg also serves JPEG bytes and image/jpeg
  const cachedJpegRes = await fetch(`${base}/render?device_id=${p.id}&format=jpeg`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  assert.equal(cachedJpegRes.status, 200);
  assert.equal(cachedJpegRes.headers.get('content-type'), 'image/jpeg');
  const cachedBuf = Buffer.from(await cachedJpegRes.arrayBuffer());
  assert.equal(cachedBuf[0], 0xFF);
  assert.equal(cachedBuf[1], 0xD8);
  assert.equal(cachedBuf[2], 0xFF);
});

test('parameterizedDimensions: fixed-geometry e-paper presets are never affected by devices.screen_width/height', async () => {
  const base = await h.ready();
  const api = base.replace('/api/embedded', '/api/devices');

  // 1. Device with Sticky preset and screen_width 800, screen_height 480
  const p1 = await h.mkPanel('seeed-reterminal-sticky', { extra: { screen_width: 800, screen_height: 480, power_source: 'usb' } });

  // Switching preset to waveshare-4.2in-v2 (400x300) does NOT copy Sticky's 800x480 dimensions
  const updateRes1 = await fetch(`${api}/${p1.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${h.sessionToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_profile: 'waveshare-4.2in-v2' }),
  });
  assert.equal(updateRes1.status, 200);
  const row1 = row(p1.id);
  assert.equal(row1.screen_profile, 'waveshare-4.2in-v2');

  // 2. PUT with string preset seeed-reterminal-sticky stays a string
  const p2 = await h.mkPanel('seeed-reterminal-sticky', { extra: { screen_width: 800, screen_height: 480, power_source: 'usb' } });
  const updateRes2 = await fetch(`${api}/${p2.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${h.sessionToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_profile: 'seeed-reterminal-sticky' }),
  });
  assert.equal(updateRes2.status, 200);
  const row2 = row(p2.id);
  assert.equal(row2.screen_profile, 'seeed-reterminal-sticky');

  // 3. Legacy row with stale screen_width 1920x1080 and preset seeed-reterminal-sticky
  const p3 = await h.mkPanel('seeed-reterminal-sticky', { extra: { screen_width: 1920, screen_height: 1080, power_source: 'usb' } });
  const infoRes = await fetch(`${base}/info?device_id=${p3.id}`, {
    headers: { Authorization: `Bearer ${p3.token}` },
  });
  assert.equal(infoRes.status, 200);
  const infoData = await infoRes.json();
  // Sticky panel must report 800x480, NOT 1920x1080!
  assert.equal(infoData.screen_profile.width, 800);
  assert.equal(infoData.screen_profile.height, 480);

  // 4. POST /pair/register only stores custom dimension JSON for parameterizedDimensions presets
  const regFixedRes = await fetch(`${base}/pair/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_profile: 'seeed-reterminal-sticky', screen_width: 640, screen_height: 400 }),
  });
  assert.equal(regFixedRes.status, 200);
  const regFixed = await regFixedRes.json();
  assert.equal(row(regFixed.device_id).screen_profile, 'seeed-reterminal-sticky');

  // 5. POST /pair/register for seeed-xiao-led with oversized dimensions falls back safely to defaults
  const regOversizedRes = await fetch(`${base}/pair/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_profile: 'seeed-xiao-led', screen_width: 5000, screen_height: 5000 }),
  });
  assert.equal(regOversizedRes.status, 200);
  const regOversized = await regOversizedRes.json();
  assert.equal(row(regOversized.device_id).screen_profile, 'seeed-xiao-led');
  assert.equal(row(regOversized.device_id).screen_width, 5);
  assert.equal(row(regOversized.device_id).screen_height, 1);
});

test('security hardening: parseProfile dimension ceiling and toRGB888 buffer bounds', async () => {
  const { parseProfile } = await import('../lib/embedded-profiles.js');
  const { toRGB888 } = await import('../lib/embedded-postprocess.js');

  // Valid LED dimensions within 512 edge / 16384 pixel ceiling
  assert.ok(parseProfile({ preset: 'seeed-xiao-led', width: 64, height: 64 }));
  assert.ok(parseProfile({ preset: 'seeed-xiao-led', width: 128, height: 64 }));
  assert.ok(parseProfile({ preset: 'seeed-xiao-led', width: 512, height: 1 }));

  // Rejects oversized LED dimensions (DoS protection)
  assert.equal(parseProfile({ preset: 'seeed-xiao-led', width: 10000, height: 10000 }), null);
  assert.equal(parseProfile({ preset: 'seeed-xiao-led', width: 513, height: 1 }), null);
  assert.equal(parseProfile({ preset: 'seeed-xiao-led', width: 256, height: 128 }), null); // 32768 > 16384

  // toRGB888 safely floors non-multiple-of-4 buffer lengths without leaking uninitialized memory
  const oddRgba = Buffer.from([10, 20, 30, 255, 99, 88]);
  const rgb = toRGB888(oddRgba);
  assert.equal(rgb.length, 3);
  assert.deepEqual([...rgb], [10, 20, 30]);
});
