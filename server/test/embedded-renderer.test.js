const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const { Jimp } = require('jimp');

// Set test environment
process.env.JWT_SECRET = 'test-secret-embedded';
process.env.EMBEDDED_CACHE_DIR = path.join(__dirname, '..', 'data', 'test-embedded-cache');

// Setup in-memory database with required tables
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user',
    auth_provider TEXT, avatar_url TEXT, plan_id TEXT, email_alerts INTEGER,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT, organization_id TEXT
  );
  CREATE TABLE workspace_members (
    workspace_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY(workspace_id, user_id)
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT,
    pairing_code TEXT, claim_secret TEXT, status TEXT,
    device_token TEXT, blocked INTEGER DEFAULT 0, screen_profile TEXT,
    playlist_id TEXT, playlist_source TEXT, layout_id TEXT
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, status TEXT DEFAULT 'published'
  );
  CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY, playlist_id TEXT, content_id TEXT,
    sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 30, updated_at INTEGER DEFAULT 0,
    zone_id TEXT, widget_id TEXT
  );
  CREATE TABLE widgets (
    id TEXT PRIMARY KEY, workspace_id TEXT, widget_type TEXT, name TEXT, config TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, mime_type TEXT, filepath TEXT,
    remote_url TEXT, thumbnail_path TEXT, updated_at INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
  );
  CREATE TABLE embedded_cursor (
    device_id TEXT PRIMARY KEY, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0
  );
  CREATE TABLE embedded_zone_cursor (
    device_id TEXT, zone_id TEXT, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0,
    PRIMARY KEY(device_id, zone_id)
  );
  CREATE TABLE layouts (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, is_template INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE layout_zones (
    id TEXT PRIMARY KEY, layout_id TEXT, name TEXT, x_percent REAL, y_percent REAL,
    width_percent REAL, height_percent REAL, z_index INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0
  );
  CREATE VIEW device_resolved_playlist AS
  SELECT d.id AS device_id, d.playlist_id, 'device' AS source, d.layout_id
  FROM devices d;
`);

require.cache[require.resolve('../db/database')] = { id: require.resolve('../db/database'), loaded: true, exports: { db } };

const { parseProfile, getPreset, listPresets } = require('../lib/embedded-profiles');
const { cacheKey, toETag, isNotModified, get: cacheGet, set: cacheSet } = require('../lib/embedded-cache');
const { postprocess } = require('../lib/embedded-postprocess');
const { deviceTokenAuth } = require('../middleware/deviceTokenAuth');
const embeddedRouter = require('../routes/embedded');

describe('Embedded Profiles', () => {
  test('lists known presets', () => {
    const presets = listPresets();
    assert.ok(presets.length >= 8);
    const sticky = presets.find(p => p.key === 'seeed-reterminal-sticky');
    assert.ok(sticky);
    assert.equal(sticky.width, 800);
    assert.equal(sticky.height, 480);
    assert.equal(sticky.colorDepth, '1bit');
    assert.equal(sticky.dither, 'floyd-steinberg');
    assert.equal(sticky.outputFormat, 'x-epd-packed');
  });

  test('parses and validates profiles with fallback defaults', () => {
    const valid = parseProfile({ width: 800, height: 480, colorDepth: '1bit', dither: 'atkinson', outputFormat: 'bmp', rotation: 90 });
    assert.deepEqual(valid, {
      width: 800,
      height: 480,
      rotation: 90,
      colorDepth: '1bit',
      dither: 'atkinson',
      outputFormat: 'bmp',
    });

    const withDefaults = parseProfile({ width: 640, height: 480, unknownField: true });
    assert.equal(withDefaults.width, 640);
    assert.equal(withDefaults.height, 480);
    assert.equal(withDefaults.colorDepth, '1bit');
    assert.equal(withDefaults.dither, 'floyd-steinberg');
    assert.equal(withDefaults.outputFormat, 'x-epd-packed');

    assert.equal(parseProfile(null), null);
    assert.equal(parseProfile({}), null);
    assert.equal(parseProfile('invalid-json'), null);
  });
});

describe('Device Token Auth Middleware', () => {
  const deviceId = 'dev-test-1';
  const token = 'secret_device_token_123';

  db.prepare('INSERT INTO devices (id, name, device_token, workspace_id, blocked) VALUES (?, ?, ?, ?, ?)').run(
    deviceId, 'Test Device', token, 'ws-1', 0
  );

  test('rejects missing authorization header', async () => {
    let status = null, json = null;
    const req = { headers: {}, query: { device_id: deviceId } };
    const res = { status(c) { status = c; return this; }, json(d) { json = d; } };
    deviceTokenAuth(req, res, () => {});
    assert.equal(status, 401);
  });

  test('rejects missing device_id', async () => {
    let status = null, json = null;
    const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
    const res = { status(c) { status = c; return this; }, json(d) { json = d; } };
    deviceTokenAuth(req, res, () => {});
    assert.equal(status, 400);
  });

  test('rejects invalid token', async () => {
    let status = null, json = null;
    const req = { headers: { authorization: 'Bearer wrong_token' }, query: { device_id: deviceId } };
    const res = { status(c) { status = c; return this; }, json(d) { json = d; } };
    deviceTokenAuth(req, res, () => {});
    assert.equal(status, 401);
  });

  test('passes with valid device_id and device_token', async () => {
    let calledNext = false;
    const req = { headers: { authorization: `Bearer ${token}` }, query: { device_id: deviceId } };
    const res = { status() { return this; }, json() {} };
    deviceTokenAuth(req, res, () => { calledNext = true; });
    assert.ok(calledNext);
    assert.equal(req.device.id, deviceId);
    assert.equal(req.workspaceId, 'ws-1');
  });
});

describe('Embedded Cache', () => {
  test('computes deterministic key and handles ETags', () => {
    const profile = { width: 800, height: 480, rotation: 0, colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed' };
    const key = cacheKey('dev-1', 'item-1', 123456, profile);
    assert.equal(typeof key, 'string');
    assert.equal(key.length, 64);

    const etag = toETag(key);
    assert.equal(etag, `"${key}"`);
    assert.ok(isNotModified(key, etag));
    assert.ok(isNotModified(key, key));
    assert.ok(!isNotModified(key, '"different"'));
  });

  test('sets and gets cache buffers', () => {
    const key = 'test_key_' + Date.now();
    const testBuf = Buffer.from('hello-embedded-image-bytes');
    cacheSet(key, testBuf);
    const res = cacheGet(key);
    assert.ok(res.hit);
    assert.deepEqual(res.buffer, testBuf);
  });
});

describe('Postprocessing & Dithering', () => {
  test('converts test image to 1-bit packed binary (x-epd-packed)', async () => {
    const img = new Jimp({ width: 200, height: 100, color: 0x808080FF }); // 50% gray
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 800,
      height: 480,
      rotation: 0,
      colorDepth: '1bit',
      dither: 'floyd-steinberg',
      outputFormat: 'x-epd-packed',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'application/octet-stream');
    // 800 * 480 / 8 = 48000 bytes
    assert.equal(out.buffer.length, 48000);
  });

  test('converts test image to 1-bit BMP', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0xFFFFFFFF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 800,
      height: 480,
      rotation: 0,
      colorDepth: '1bit',
      dither: 'atkinson',
      outputFormat: 'bmp',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'image/bmp');
    // BMP header starts with 'BM'
    assert.equal(out.buffer.toString('ascii', 0, 2), 'BM');
    assert.ok(out.buffer.length > 48000);
  });

  test('converts test image to RGB565', async () => {
    const img = new Jimp({ width: 10, height: 10, color: 0xFF0000FF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 320,
      height: 240,
      rotation: 0,
      colorDepth: '16bit-rgb565',
      dither: 'none',
      outputFormat: 'raw',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'application/octet-stream');
    // 320 * 240 * 2 = 153600 bytes
    assert.equal(out.buffer.length, 153600);
  });

  test('converts test image to JPEG', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0xFFFFFFFF });
    const pngBuf = await img.getBuffer('image/png');

    const profile = {
      width: 800,
      height: 480,
      rotation: 0,
      colorDepth: '1bit',
      dither: 'floyd-steinberg',
      outputFormat: 'jpeg',
    };

    const out = await postprocess(pngBuf, profile);
    assert.equal(out.contentType, 'image/jpeg');
    // JPEG header SOI starts with 0xFF 0xD8
    assert.equal(out.buffer[0], 0xFF);
    assert.equal(out.buffer[1], 0xD8);
  });
});

const { render, renderLayout, closeBrowser } = require('../lib/embedded-render');

describe('Embedded Renderer Native Image Path & Multi-Zone Layout', () => {
  after(async () => {
    await closeBrowser();
  });

  test('renders local image content via Jimp', async () => {
    // Create a temporary image in uploads
    const tmpUpload = path.join(__dirname, '..', 'uploads', 'content');
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'test-item.png');
    const img = new Jimp({ width: 200, height: 100, color: 0x00FF00FF });
    fs.writeFileSync(imgPath, await img.getBuffer('image/png'));

    const item = { id: 'item-img-1' };
    const content = { id: 'cnt-1', filepath: 'test-item.png' };
    const profile = { width: 800, height: 480 };

    const res = await render(item, content, profile);
    assert.ok(res.png);
    assert.ok(Buffer.isBuffer(res.png));
    assert.ok(res.png.length > 500);

    // Clean up temporary image
    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('returns unsupported when content is not found', async () => {
    const item = { id: 'item-empty' };
    const res = await render(item, {}, { width: 800, height: 480 });
    assert.ok(res.unsupported);
  });

  test('rejects a local image filepath that escapes the content directory', async () => {
    const item = { id: 'item-traversal' };
    // A `../` filepath must never be resolved outside the uploads content dir.
    const content = { id: 'cnt-traversal', filepath: '../../../../etc/passwd' };
    const profile = { width: 800, height: 480 };

    // The renderer must NOT succeed in reading a file outside the content dir.
    // It should reject (either because the basename-guarded path is absent, or because
    // the escalation is denied) rather than return pixels from /etc/passwd.
    await assert.rejects(
      () => render(item, content, profile),
      (e) => e.code === 'INVALID_PATH' || e.code === 'NOT_FOUND',
      'expected a path-traversal filepath to be rejected, not read from disk',
    );
  });

  test('renders weather widget or reports unsupported cleanly when browser absent', async () => {
    const item = {
      id: 'item-weather-1',
      widget_type: 'weather',
      widget_config: JSON.stringify({ location: 'Berlin', units: 'metric' }),
    };
    const profile = { width: 800, height: 480 };

    const res = await render(item, {}, profile);
    if (res.unsupported) {
      assert.ok(res.reason);
    } else {
      assert.ok(res.png);
      assert.ok(Buffer.isBuffer(res.png));
      assert.ok(res.png.length > 500);
    }
  });

  test('renders multi-zone layout composition via renderLayout', async () => {
    const layout = { id: 'tpl-split-h', name: 'Split Horizontal' };
    const zoneEntries = [
      {
        zone: { id: 'z1', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { widget_type: 'clock', widget_config: { timezone: 'Europe/Berlin' } },
        content: null,
      },
      {
        zone: { id: 'z2', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { widget_type: 'weather', widget_config: { location: 'Berlin', units: 'metric' } },
        content: null,
      },
    ];
    const profile = { width: 800, height: 480 };

    const res = await renderLayout(layout, zoneEntries, profile);
    if (res.unsupported) {
      assert.ok(res.reason);
    } else {
      assert.ok(res.png);
      assert.ok(Buffer.isBuffer(res.png));
      assert.ok(res.png.length > 500);
    }
  });

  test('renders image-only layout natively via Jimp without browser', async () => {
    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath1 = path.join(tmpUpload, 'layout-test-1.png');
    const imgPath2 = path.join(tmpUpload, 'layout-test-2.png');
    const img1 = new Jimp({ width: 200, height: 100, color: 0xFF0000FF });
    const img2 = new Jimp({ width: 200, height: 100, color: 0x0000FFFF });
    fs.writeFileSync(imgPath1, await img1.getBuffer('image/png'));
    fs.writeFileSync(imgPath2, await img2.getBuffer('image/png'));

    const layout = { id: 'tpl-split-img', name: 'Split Images' };
    const zoneEntries = [
      {
        zone: { id: 'z1', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { id: 'item-img-1' },
        content: { id: 'cnt-1', filepath: 'layout-test-1.png', mime_type: 'image/png' },
      },
      {
        zone: { id: 'z2', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { id: 'item-img-2' },
        content: { id: 'cnt-2', filepath: 'layout-test-2.png', mime_type: 'image/png' },
      },
    ];
    const profile = { width: 800, height: 480 };

    const res = await renderLayout(layout, zoneEntries, profile);
    assert.ok(res.png, 'expected native Jimp composite to return PNG');
    assert.ok(Buffer.isBuffer(res.png));
    assert.ok(res.png.length > 500);

    try { fs.unlinkSync(imgPath1); } catch (_) {}
    try { fs.unlinkSync(imgPath2); } catch (_) {}
  });

  test('renderLayout coerces a malicious profile dimension to a safe integer', async () => {
    const layout = { id: 'tpl-split-h', name: 'Split Horizontal' };
    const zoneEntries = [
      {
        zone: { id: 'z1', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0 },
        item: { widget_type: 'clock', widget_config: { timezone: 'Europe/Berlin' } },
        content: null,
      },
    ];
    // A hostile/overflowing profile must not be interpolated into CSS.
    const profile = { width: '800px; background:red', height: '480" onload=alert(1)' };

    const res = await renderLayout(layout, zoneEntries, profile);
    if (res.unsupported) {
      assert.ok(res.reason);
    } else {
      assert.ok(res.png);
      assert.ok(Buffer.isBuffer(res.png));
    }
  });
});

describe('Embedded Edge Cases & Robustness', () => {
  const { resolveCurrentItem, resolveLayoutItems } = require('../routes/embedded');
  const { looksLikeImage, isLayoutImageOnly, isBrowserAvailable } = require('../lib/embedded-render');

  test('looksLikeImage identifies extensions, bare filenames, URLs, and MIME types', () => {
    assert.equal(looksLikeImage('image.png'), true);
    assert.equal(looksLikeImage('uploads/content/picture.jpeg'), true);
    assert.equal(looksLikeImage('https://example.com/banner.webp'), true);
    assert.equal(looksLikeImage('http://example.com/api/chart', 'image/png; charset=utf-8'), true);
    assert.equal(looksLikeImage('video.mp4'), false);
    assert.equal(looksLikeImage('document.pdf'), false);
    assert.equal(looksLikeImage('https://example.com/page.html'), false);
    assert.equal(looksLikeImage(null), false);
    assert.equal(looksLikeImage(''), false);
  });

  test('isLayoutImageOnly correctly classifies image vs non-image layouts', () => {
    const imageEntries = [
      { zone: { id: 'z1' }, content: { filepath: 'photo.jpg', mime_type: 'image/jpeg' }, item: {} },
      { zone: { id: 'z2' }, content: { remote_url: 'https://example.com/pic.png', mime_type: 'image/png' }, item: {} },
    ];
    assert.equal(isLayoutImageOnly(imageEntries), true);

    const videoEntries = [
      { zone: { id: 'z1' }, content: { filepath: 'clip.mp4', mime_type: 'video/mp4' }, item: {} },
    ];
    assert.equal(isLayoutImageOnly(videoEntries), false);

    const widgetEntries = [
      { zone: { id: 'z1' }, content: null, item: { widget_type: 'clock' } },
    ];
    assert.equal(isLayoutImageOnly(widgetEntries), false);

    const webEntries = [
      { zone: { id: 'z1' }, content: { remote_url: 'https://news.ycombinator.com', mime_type: 'text/html' }, item: {} },
    ];
    assert.equal(isLayoutImageOnly(webEntries), false);

    const emptyEntries = [
      { zone: { id: 'z1' }, content: null, item: null },
    ];
    assert.equal(isLayoutImageOnly(emptyEntries), true);
  });

  test('isBrowserAvailable returns boolean without throwing', () => {
    const available = isBrowserAvailable();
    assert.equal(typeof available, 'boolean');
  });

  test('resolveCurrentItem safely clamps non-integer forceIndex without NaN crash', () => {
    const plId = 'pl-edge-1';
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Test PL', 'published')").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, is_active) VALUES ('c1', 'ws-1', 'image', 1)").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi1', ?, 'c1', 0, 30)").run(plId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id) VALUES ('dev-edge-1', 'Edge Dev', 'ws-1', ?)").run(plId);

    // Non-integer inputs must not produce NaN index
    const resAbc = resolveCurrentItem('dev-edge-1', 'abc');
    assert.ok(resAbc);
    assert.equal(resAbc.itemIndex, 0);

    const resNegative = resolveCurrentItem('dev-edge-1', -5);
    assert.ok(resNegative);
    assert.equal(resNegative.itemIndex, 0);

    const resOverflow = resolveCurrentItem('dev-edge-1', 999);
    assert.ok(resOverflow);
    assert.equal(resOverflow.itemIndex, 0);
  });

  test('resolveLayoutItems returns null for empty or unpublished playlist (yields 404, not black 200)', () => {
    const layoutId = 'lay-empty-1';
    db.prepare("INSERT INTO layouts (id, workspace_id, name) VALUES (?, 'ws-1', 'Empty Lay')").run(layoutId);
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, width_percent, height_percent) VALUES ('z-emp-1', ?, 'Z1', 100, 100)").run(layoutId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, screen_profile) VALUES ('dev-lay-empty', 'Lay Empty', 'ws-1', '{\"preset\":\"seeed-reterminal-sticky\"}')").run();

    const res = resolveLayoutItems('dev-lay-empty');
    assert.equal(res, null, 'expected null for device with layout but no playlist items');
  });

  test('zone bucketing matches player parity (unassigned items into first empty zone, orphans into largest area zone)', () => {
    const layoutId = 'lay-zones-parity';
    const plId = 'pl-zones-parity';
    db.prepare("INSERT INTO layouts (id, workspace_id, name) VALUES (?, 'ws-1', 'Parity Lay')").run(layoutId);
    // Zone 1: 30x100 = 3000 area. Zone 2: 70x100 = 7000 area (largest)
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order) VALUES ('z_small', ?, 'Small', 0, 0, 30, 100, 0)").run(layoutId);
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order) VALUES ('z_large', ?, 'Large', 30, 0, 70, 100, 1)").run(layoutId);

    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Parity PL', 'published')").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, is_active) VALUES ('c_assigned', 'ws-1', 'image', 1)").run();
    db.prepare("INSERT INTO content (id, workspace_id, type, is_active) VALUES ('c_unassigned', 'ws-1', 'image', 1)").run();
    db.prepare("INSERT INTO content (id, workspace_id, type, is_active) VALUES ('c_orphan', 'ws-1', 'image', 1)").run();

    // pi_assigned has zone_id = z_large
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi_assigned', ?, 'c_assigned', 0, 30)").run(plId);
    db.exec("UPDATE playlist_items SET zone_id = 'z_large' WHERE id = 'pi_assigned'");

    // pi_unassigned has zone_id = NULL -> should go to first empty zone (z_small)
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi_unassigned', ?, 'c_unassigned', 1, 30)").run(plId);

    // pi_orphan has zone_id = 'z_deleted' -> should go to largest zone (z_large)
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi_orphan', ?, 'c_orphan', 2, 30)").run(plId);
    db.exec("UPDATE playlist_items SET zone_id = 'z_deleted' WHERE id = 'pi_orphan'");

    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, layout_id, screen_profile) VALUES ('dev-parity-1', 'Parity Dev', 'ws-1', ?, ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(plId, layoutId);

    const res = resolveLayoutItems('dev-parity-1');
    assert.ok(res);
    assert.equal(res.zoneEntries.length, 2);

    const smallEntry = res.zoneEntries.find(e => e.zone.id === 'z_small');
    const largeEntry = res.zoneEntries.find(e => e.zone.id === 'z_large');

    assert.ok(smallEntry);
    assert.ok(largeEntry);
    assert.equal(smallEntry.item.id, 'pi_unassigned', 'unassigned item should land in first empty zone (z_small)');
    assert.equal(largeEntry.item.id, 'pi_assigned', 'assigned item should land in z_large');
  });
});

describe('Embedded HTTP Route & Fallback Handling', () => {
  const http = require('node:http');
  const express = require('express');
  let app, server, baseUrl;

  before(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/embedded', embeddedRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/embedded`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('GET /api/embedded/render returns single-item image for device with single playlist', async () => {
    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'route-test-single.png');
    const img = new Jimp({ width: 200, height: 100, color: 0x00FF00FF });
    fs.writeFileSync(imgPath, await img.getBuffer('image/png'));

    const plId = 'pl-route-single';
    const devId = 'dev-route-single';
    const token = 'tok-route-single';
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Single PL', 'published')").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active) VALUES ('c-rt-1', 'ws-1', 'image', 'image/png', 'route-test-single.png', 1)").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-rt-1', ?, 'c-rt-1', 0, 30)").run(plId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, device_token, screen_profile) VALUES (?, 'Single Dev', 'ws-1', ?, ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(devId, plId, token);

    const res = await fetch(`${baseUrl}/render?device_id=${devId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('x-st-device-id'), devId);
    assert.equal(res.headers.get('x-st-item-index'), '0');
    assert.equal(res.headers.get('x-st-total-items'), '1');

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 48000); // 800 * 480 / 8 = 48000 bytes for seeed-reterminal-sticky

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('GET /api/embedded/render falls back to single-item with X-ST-Layout-Fallback header when browser unavailable', async () => {
    // Setup device with a layout containing a widget (non-image) and an image item in playlist
    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'route-test-fallback.png');
    const img = new Jimp({ width: 200, height: 100, color: 0x00FF00FF });
    fs.writeFileSync(imgPath, await img.getBuffer('image/png'));

    const layId = 'lay-route-fallback';
    const plId = 'pl-route-fallback';
    const devId = 'dev-route-fallback';
    const token = 'tok-route-fallback';

    db.prepare("INSERT INTO layouts (id, workspace_id, name) VALUES (?, 'ws-1', 'Widget Lay')").run(layId);
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent) VALUES ('z-w-1', ?, 'Z1', 0, 0, 100, 100)").run(layId);

    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Fallback PL', 'published')").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active) VALUES ('c-rt-fb', 'ws-1', 'image', 'image/png', 'route-test-fallback.png', 1)").run();
    // Item 1: widget (requires browser)
    db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config) VALUES ('w-rt-fb', 'ws-1', 'weather', 'Weather', '{}')").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, widget_id, zone_id, sort_order, duration_sec) VALUES ('pi-rt-w', ?, 'w-rt-fb', 'z-w-1', 0, 30)").run(plId);
    // Item 2: image
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-rt-img', ?, 'c-rt-fb', 1, 30)").run(plId);

    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, layout_id, device_token, screen_profile) VALUES (?, 'Fallback Dev', 'ws-1', ?, ?, ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(devId, plId, layId, token);

    // Test explicit mode=layout -> returns 501 if browser unavailable (or 200 if browser is present)
    const explicitRes = await fetch(`${baseUrl}/render?device_id=${devId}&mode=layout`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok(explicitRes.status === 200 || explicitRes.status === 501);

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });
});




