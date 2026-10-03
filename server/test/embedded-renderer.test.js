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
    playlist_id TEXT, playlist_source TEXT, layout_id TEXT,
    timezone TEXT, reported_timezone TEXT, background_color TEXT DEFAULT '#000000',
    default_content_id TEXT
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, status TEXT DEFAULT 'published',
    published_snapshot TEXT, published_structure TEXT, updated_at INTEGER DEFAULT 0,
    playback_order TEXT DEFAULT 'sequential', published_playback_order TEXT
  );
  CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY, playlist_id TEXT, content_id TEXT,
    sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 30, updated_at INTEGER DEFAULT 0,
    zone_id TEXT, widget_id TEXT, child_playlist_id TEXT, muted INTEGER DEFAULT 0,
    play_from TEXT, play_until TEXT, enabled INTEGER DEFAULT 1, log_play INTEGER DEFAULT 1,
    fit_mode TEXT, play_when TEXT, weight INTEGER DEFAULT 1
  );
  CREATE TABLE playlist_item_schedules (
    id TEXT PRIMARY KEY, playlist_item_id TEXT, active_days TEXT,
    start_time TEXT, end_time TEXT, start_date TEXT, end_date TEXT,
    sort_order INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0
  );
  CREATE TABLE widgets (
    id TEXT PRIMARY KEY, workspace_id TEXT, widget_type TEXT, name TEXT, config TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, mime_type TEXT, filepath TEXT,
    filename TEXT, file_size INTEGER DEFAULT 0, duration_sec REAL, remote_url TEXT,
    thumbnail_path TEXT, updated_at INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
    -- created_at is NOT decoration: getPublishedPlaylistItems reads
    -- COALESCE(NULLIF(updated_at,0), created_at) inside a bare catch, so a fixture without this
    -- column made that whole refresh branch throw and be swallowed, silently untested.
    created_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER, unstable_connection INTEGER DEFAULT 0,
    captions_enabled INTEGER DEFAULT 0, captions_lang TEXT, subtitle_url TEXT, subtitle_lang TEXT,
    tags TEXT, meta TEXT
  );
  CREATE TABLE embedded_cursor (
    device_id TEXT PRIMARY KEY, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0
  );
  CREATE TABLE embedded_zone_cursor (
    device_id TEXT, zone_id TEXT, item_index INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0,
    PRIMARY KEY(device_id, zone_id)
  );
  CREATE TABLE layouts (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, is_template INTEGER DEFAULT 0,
    width INTEGER DEFAULT 1920, height INTEGER DEFAULT 1080, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE layout_zones (
    id TEXT PRIMARY KEY, layout_id TEXT, name TEXT, x_percent REAL, y_percent REAL,
    width_percent REAL, height_percent REAL, z_index INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    fit_mode TEXT DEFAULT 'contain', background_color TEXT DEFAULT '#000000'
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
const { publishPlaylist } = require('../routes/playlists');
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

const { render, renderLayout, closeBrowser, safeDimension } = require('../lib/embedded-render');

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

  test('safeDimension sanitizes dimension inputs against CSS injection and hostile payloads', () => {
    assert.equal(safeDimension('800px; background:red', 800), 800);
    assert.equal(safeDimension('480" onload=alert(1)', 480), 480);
    assert.equal(safeDimension(-50, 800), 800);
    assert.equal(safeDimension('NaN', 800), 800);
    assert.equal(safeDimension(1024, 800), 1024);
    assert.equal(safeDimension('1200', 800), 1200);
  });
});

describe('Embedded Edge Cases & Robustness', () => {
  const { resolveCurrentItem, resolveLayoutItems } = require('../routes/embedded');
  const { looksLikeImage, isLayoutImageOnly, isBrowserAvailable, safeDimension } = require('../lib/embedded-render');

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
    publishPlaylist(plId);
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

  test('resolveCurrentItem returns null for draft/unpublished playlists', () => {
    const plId = 'pl-draft-test';
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status, published_snapshot) VALUES (?, 'ws-1', 'Draft PL', 'draft', NULL)").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, is_active) VALUES ('c-draft', 'ws-1', 'image', 1)").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-draft', ?, 'c-draft', 0, 30)").run(plId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id) VALUES ('dev-draft-1', 'Draft Dev', 'ws-1', ?)").run(plId);

    const res = resolveCurrentItem('dev-draft-1');
    assert.equal(res, null, 'draft/unpublished playlist must never be served to embedded devices');
  });

  test('resolveCurrentItem advance:false does not move the panel cursor (/info + preview)', () => {
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, is_active) VALUES ('c-adv-a','ws-1','image','image/png',1)").run();
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, is_active) VALUES ('c-adv-b','ws-1','image','image/png',1)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status, published_playback_order) VALUES ('pl-adv','ws-1','Adv','published','sequential')").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-adv-1','pl-adv','c-adv-a',0,30)").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-adv-2','pl-adv','c-adv-b',1,30)").run();
    publishPlaylist('pl-adv');   // resolveCurrentItem reads the published snapshot, not raw items
    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id) VALUES ('dev-adv','Adv Dev','ws-1','pl-adv')").run();
    // cursor at item 0, started at epoch 1 so the 30s dwell has elapsed -> a normal resolve advances.
    db.prepare("INSERT INTO embedded_cursor (device_id, item_index, started_at) VALUES ('dev-adv', 0, 1)").run();
    const idx = () => db.prepare("SELECT item_index FROM embedded_cursor WHERE device_id='dev-adv'").get().item_index;

    resolveCurrentItem('dev-adv', undefined, { advance: false });
    assert.equal(idx(), 0, 'a read-only resolve (advance:false) must not move the cursor');
    resolveCurrentItem('dev-adv', undefined);            // a real device render advances, time-gated
    assert.equal(idx(), 1, 'a real render advances the cursor');
  });

  test('resolveCurrentItem falls back to the device default image when there is no playlist', () => {
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filename, is_active) VALUES ('c-def-img', 'ws-1', 'image', 'image/png', 'off.png', 1)").run();
    // no playlist_id at all -> previously black/404; now the configured default image shows
    db.prepare("INSERT INTO devices (id, name, workspace_id, default_content_id) VALUES ('dev-def-1', 'Default Dev', 'ws-1', 'c-def-img')").run();

    const res = resolveCurrentItem('dev-def-1');
    assert.ok(res, 'a device with a default image must resolve something instead of null');
    assert.equal(res.item.content_id, 'c-def-img', 'the resolved item is the configured default');
    assert.equal(res.total, 1, 'default fallback is a single-item rotation');
  });

  test('resolveCurrentItem ignores a non-image default (e-ink renders images only)', () => {
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filename, is_active) VALUES ('c-def-vid', 'ws-1', 'video', 'video/mp4', 'clip.mp4', 1)").run();
    db.prepare("INSERT INTO devices (id, name, workspace_id, default_content_id) VALUES ('dev-def-vid', 'Vid Default Dev', 'ws-1', 'c-def-vid')").run();

    const res = resolveCurrentItem('dev-def-vid');
    assert.equal(res, null, 'a video default cannot render on an e-ink panel -> null, not a broken item');
  });

  test('resolveLayoutItems returns null for empty or unpublished playlist (yields 404, not black 200)', () => {
    const layoutId = 'lay-empty-1';
    db.prepare("INSERT INTO layouts (id, workspace_id, name) VALUES (?, 'ws-1', 'Empty Lay')").run(layoutId);
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, width_percent, height_percent) VALUES ('z-emp-1', ?, 'Z1', 100, 100)").run(layoutId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, layout_id, screen_profile) VALUES ('dev-lay-empty', 'Lay Empty', 'ws-1', ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(layoutId);

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

    publishPlaylist(plId);

    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, layout_id, screen_profile) VALUES ('dev-parity-1', 'Parity Dev', 'ws-1', ?, ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(plId, layoutId);

    const res = resolveLayoutItems('dev-parity-1');
    assert.ok(res);
    assert.equal(res.zoneEntries.length, 2);

    const smallEntry = res.zoneEntries.find(e => e.zone.id === 'z_small');
    const largeEntry = res.zoneEntries.find(e => e.zone.id === 'z_large');

    assert.ok(smallEntry);
    assert.ok(largeEntry);
    assert.equal(smallEntry.item.content_id, 'c_unassigned', 'unassigned item should land in first empty zone (z_small)');
    assert.equal(largeEntry.item.content_id, 'c_assigned', 'assigned item should land in z_large');
  });
});

describe('Embedded HTTP Route & Fallback Handling', () => {
  const http = require('node:http');
  const express = require('express');
  const { isBrowserAvailable, closeBrowser } = require('../lib/embedded-render');
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
    await closeBrowser();
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
    publishPlaylist(plId);
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
    // Setup device with a multi-zone layout containing a widget (non-image) and an image item in playlist
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
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent) VALUES ('z-w-1', ?, 'Z1', 0, 0, 50, 100)").run(layId);
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent) VALUES ('z-w-2', ?, 'Z2', 50, 0, 50, 100)").run(layId);

    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Fallback PL', 'published')").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active) VALUES ('c-rt-fb', 'ws-1', 'image', 'image/png', 'route-test-fallback.png', 1)").run();
    // Item 1: widget (requires browser)
    db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config) VALUES ('w-rt-fb', 'ws-1', 'weather', 'Weather', '{}')").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, widget_id, zone_id, sort_order, duration_sec) VALUES ('pi-rt-w', ?, 'w-rt-fb', 'z-w-1', 0, 30)").run(plId);
    // Item 2: image
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, zone_id, sort_order, duration_sec) VALUES ('pi-rt-img', ?, 'c-rt-fb', 'z-w-2', 1, 30)").run(plId);

    publishPlaylist(plId);

    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, layout_id, device_token, screen_profile) VALUES (?, 'Fallback Dev', 'ws-1', ?, ?, ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(devId, plId, layId, token);

    // Auto-mode test:
    const autoRes = await fetch(`${baseUrl}/render?device_id=${devId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(autoRes.status, 200);

    // Explicit mode test:
    const explicitRes = await fetch(`${baseUrl}/render?device_id=${devId}&mode=layout`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!isBrowserAvailable()) {
      assert.equal(autoRes.headers.get('x-st-layout-fallback'), '1', 'fallback header must be set in auto-mode when browser unavailable');
      assert.equal(explicitRes.status, 501, 'explicit layout mode must return 501 when browser unavailable');
    } else {
      assert.equal(autoRes.headers.get('x-st-total-zones'), '2');
      assert.equal(explicitRes.status, 200);
    }

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });
});





// ---------------------------------------------------------------------------------------------
// Follow-ups to #331, fixed on main after the merge.

describe('the published snapshot carries every column the renderer reads', () => {
  const { resolveCurrentItem, dynamicRevFor } = embeddedRouter;

  /*
   * published_snapshot is built for players and omits four columns the embedded renderer needs.
   * Each omission fails silently: a video loses its poster and Jimp is handed the .mp4, widget
   * data-source tokens resolve empty, and dynamicRevFor sees 0 so an edit never invalidates the
   * panel's cached frame. Assert the shape rather than the symptoms.
   */
  test('a widget item keeps its workspace and its edit stamp', () => {
    const plId = 'pl-cols-w';
    db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config, updated_at) VALUES ('w-cols', 'ws-1', 'slide', 'W', '{\"f\":\"{{ds:room.status}}\"}', 4242)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Cols W', 'published')").run(plId);
    db.prepare("INSERT INTO playlist_items (id, playlist_id, widget_id, sort_order, duration_sec) VALUES ('pi-cols-w', ?, 'w-cols', 0, 30)").run(plId);
    publishPlaylist(plId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id) VALUES ('dev-cols-w', 'D', 'ws-1', ?)").run(plId);

    const r = resolveCurrentItem('dev-cols-w');
    assert.ok(r, 'the item resolves');
    assert.equal(r.item.widget_workspace_id, 'ws-1', 'workspace survives the snapshot, or {{ds:}} resolves empty');
    assert.equal(r.item.widget_updated_at, 4242, 'edit stamp survives, or the cache never invalidates');
    assert.notEqual(dynamicRevFor(r.item, 1_000_000), 0);
  });

  test('a video item keeps its poster frame', () => {
    const plId = 'pl-cols-v';
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, thumbnail_path, updated_at, is_active) VALUES ('c-cols', 'ws-1', 'video', 'video/mp4', 'clip.mp4', 'clip.jpg', 77, 1)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Cols V', 'published')").run(plId);
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-cols-v', ?, 'c-cols', 0, 30)").run(plId);
    publishPlaylist(plId);
    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id) VALUES ('dev-cols-v', 'D', 'ws-1', ?)").run(plId);

    const r = resolveCurrentItem('dev-cols-v');
    assert.ok(r);
    assert.equal(r.item.thumbnail_path, 'clip.jpg', 'without this Jimp is handed the .mp4 and the layout drops to Chromium');
    assert.equal(r.item.content_updated_at, 77);
  });
});

describe('dynamicRevFor: an edit and a time bucket both invalidate', () => {
  const { dynamicRevFor } = embeddedRouter;
  const T = 1_700_000_000;

  test('THE BUG: editing a data-bound slide changes its rev inside the same minute', () => {
    // The first helper returned the bucket alone, so a text edit was invisible until it rolled.
    const before = dynamicRevFor({ widget_type: 'slide', widget_config: '{"f":"{{ds:room.status}}"}', widget_updated_at: 100 }, T);
    const after = dynamicRevFor({ widget_type: 'slide', widget_config: '{"f":"{{ds:room.status}}"}', widget_updated_at: 101 }, T);
    assert.notEqual(before, after);
  });

  test('the bucket still rolls on its own for an unedited widget', () => {
    const a = dynamicRevFor({ widget_type: 'rss', widget_updated_at: 5 }, T);
    const b = dynamicRevFor({ widget_type: 'rss', widget_updated_at: 5 }, T + 300);
    assert.notEqual(a, b);
    assert.equal(dynamicRevFor({ widget_type: 'rss', widget_updated_at: 5 }, T + 1), a, 'inside the bucket the rev holds');
  });

  test('a static slide is keyed on its edit alone, so it is not re-rendered every minute', () => {
    const a = dynamicRevFor({ widget_type: 'slide', widget_config: '{"f":"Hello"}', widget_updated_at: 7 }, T);
    const b = dynamicRevFor({ widget_type: 'slide', widget_config: '{"f":"Hello"}', widget_updated_at: 7 }, T + 3600);
    assert.equal(a, b);
    assert.notEqual(a, dynamicRevFor({ widget_type: 'slide', widget_config: '{"f":"Hello"}', widget_updated_at: 8 }, T));
  });

  test('every time-bucketed type carries the edit rev', () => {
    for (const widget_type of ['clock', 'weather', 'rss', 'webpage', 'social', 'directory-board']) {
      const a = dynamicRevFor({ widget_type, widget_updated_at: 1 }, T);
      const b = dynamicRevFor({ widget_type, widget_updated_at: 2 }, T);
      assert.notEqual(a, b, `${widget_type}: an edit must change the rev`);
    }
  });

  test('a directory board rolls with its own 60s poll, not a 300s bucket', () => {
    const a = dynamicRevFor({ widget_type: 'directory-board', widget_updated_at: 1 }, T);
    assert.notEqual(a, dynamicRevFor({ widget_type: 'directory-board', widget_updated_at: 1 }, T + 60));
  });

  test('plain content stays keyed on its own updated_at; a remote page is bucketed', () => {
    assert.equal(dynamicRevFor({ content_updated_at: 42 }, T), 42);
    assert.equal(dynamicRevFor({ remote_url: 'https://x/pic.png', mime_type: 'image/png', content_updated_at: 42 }, T), 42);
    const page = dynamicRevFor({ remote_url: 'https://x/board', mime_type: 'text/html', content_updated_at: 42 }, T);
    assert.match(String(page), /^url_\d+_42$/);
  });
});

describe('remote web pages are navigated, not pasted', () => {
  const { render, closeBrowser } = require('../lib/embedded-render');
  const pupPath = require.resolve('puppeteer-core');
  let hadCache, savedChrome, savedFetch;
  const calls = { goto: [], setContent: [], fetch: [] };
  const fakePage = {
    setViewport: async () => {},
    setRequestInterception: async () => {},   // SSRF hardening: renderRemotePage vets each request
    on: () => {},
    goto: async (u) => { calls.goto.push(u); },
    setContent: async (h) => { calls.setContent.push(h); },
    waitForNetworkIdle: async () => {},
    evaluate: async () => {},
    screenshot: async () => Buffer.from('png'),
    close: async () => {},
  };
  const fakeBrowser = { connected: true, newPage: async () => fakePage, close: async () => {}, on() {}, process() { return null; } };

  before(async () => {
    await closeBrowser();                                   // never let a real instance answer these
    hadCache = require.cache[pupPath];
    require.cache[pupPath] = { id: pupPath, filename: pupPath, loaded: true, exports: { launch: async () => fakeBrowser } };
    savedChrome = process.env.CHROME_PATH;
    process.env.CHROME_PATH = process.execPath;             // findChromePath only asks whether it exists
    savedFetch = global.fetch;
    global.fetch = async (u) => { calls.fetch.push(String(u)); return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };
  });
  after(async () => {
    await closeBrowser();
    if (hadCache) require.cache[pupPath] = hadCache; else delete require.cache[pupPath];
    if (savedChrome === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = savedChrome;
    global.fetch = savedFetch;
  });

  test('THE BUG: a non-image remote_url is loaded with page.goto, never used as the document', async () => {
    calls.goto.length = 0; calls.setContent.length = 0;
    const res = await render({ id: 'i1' }, { remote_url: 'http://8.8.8.8/board', mime_type: 'text/html' }, { width: 800, height: 480 });
    assert.ok(Buffer.isBuffer(res.png));
    assert.deepEqual(calls.goto, ['http://8.8.8.8/board']);
    assert.equal(calls.setContent.length, 0, 'the URL string must never be pasted as HTML');
  });

  test('a remote page on a private address is refused before the browser sees it', async () => {
    calls.goto.length = 0;
    await assert.rejects(
      () => render({ id: 'i2' }, { remote_url: 'http://127.0.0.1:3001/', mime_type: 'text/html' }, { width: 800, height: 480 }),
      (e) => e.code === 'BLOCKED_URL');
    assert.equal(calls.goto.length, 0);
  });

  test('a remote IMAGE on a private address is refused before it is fetched', async () => {
    calls.fetch.length = 0;
    await assert.rejects(
      () => render({ id: 'i3' }, { remote_url: 'http://169.254.169.254/latest/meta-data/', mime_type: 'image/jpeg' }, { width: 800, height: 480 }),
      (e) => e.code === 'BLOCKED_URL');
    assert.equal(calls.fetch.length, 0);
  });
});

describe('SSRF: server-side remote_url fetches are guarded', () => {
  test('every remote_url fetch goes through guardedRequest, and the page render vets each request', () => {
    const src = fs.readFileSync(require.resolve('../lib/embedded-render'), 'utf8');
    // No bare fetch() of an operator-supplied remote url anywhere (that path skips the pin + redirect
    // re-vet that guardedRequest provides). renderRemoteImage and renderLayoutNative use guardedRequest.
    assert.ok(!/\bfetch\(\s*content\.remote_url/.test(src), 'renderLayoutNative must not bare-fetch remote_url');
    assert.ok(!/\bawait fetch\(\s*url\b/.test(src), 'renderRemoteImage must not bare-fetch the url');
    assert.match(src, /guardedRequest\(url,/, 'renderRemoteImage uses guardedRequest');
    assert.match(src, /guardedRequest\(content\.remote_url,/, 'renderLayoutNative uses guardedRequest');
    // renderRemotePage (Chromium) vets every request the page makes, since page.goto is not pinned.
    assert.match(src, /setRequestInterception\(true\)/, 'renderRemotePage intercepts requests');
    assert.match(src, /assertSafeUrl\(r\.url\(\)\)/, 'and vets each request URL');
  });
});

describe('Issue #337 Follow-ups: Robustness, Parity & Deduplication', () => {
  const { resolveCurrentItem, resolveLayoutItems } = embeddedRouter;
  const {
    safeLocalImagePath,
    parseColorToRgba,
    withTimeout,
    renderLayoutNative,
    safeDimension,
  } = require('../lib/embedded-render');
  const { parseProfile } = require('../lib/embedded-profiles');

  test('parseProfile enforces 10000 dimension ceiling', () => {
    assert.equal(parseProfile({ width: 10001, height: 480 }), null);
    assert.equal(parseProfile({ width: 800, height: 10001 }), null);
    const valid = parseProfile({ width: 10000, height: 10000 });
    assert.ok(valid);
    assert.equal(valid.width, 10000);
    assert.equal(valid.height, 10000);
    assert.equal(safeDimension(10001, 800), 800);
    assert.equal(safeDimension(500, 800), 500);
  });

  test('safeLocalImagePath rejects path traversal and returns safe absolute path', () => {
    assert.equal(safeLocalImagePath(null), null);
    assert.throws(() => safeLocalImagePath('../../../etc/passwd'), (e) => e.code === 'NOT_FOUND' || e.code === 'INVALID_PATH');

    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'safe-path-test.png');
    fs.writeFileSync(imgPath, Buffer.from('test'));

    const resolved = safeLocalImagePath('safe-path-test.png');
    assert.equal(resolved, imgPath);

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('parseColorToRgba converts hex and numbers to uint32 RGBA', () => {
    assert.equal(parseColorToRgba('#ffffff'), 0xFFFFFFFF);
    assert.equal(parseColorToRgba('#fff'), 0xFFFFFFFF);
    assert.equal(parseColorToRgba('#ff0000'), 0xFF0000FF);
    assert.equal(parseColorToRgba('#00ff0080'), 0x00FF0080);
    assert.equal(parseColorToRgba(0x12345678), 0x12345678);
    assert.equal(parseColorToRgba('invalid', 0x000000FF), 0x000000FF);
  });

  test('withTimeout rejects on deadline exceeded', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(
      () => withTimeout(slow, 50, 'Deadline reached'),
      (e) => e.code === 'RENDER_TIMEOUT' && e.message === 'Deadline reached'
    );

    const fast = Promise.resolve('ok');
    const res = await withTimeout(fast, 1000);
    assert.equal(res, 'ok');
  });

  test('renderLayoutNative handles per-zone failure gracefully without failing composite', async () => {
    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'zone-valid.png');
    const validImg = new Jimp({ width: 100, height: 100, color: 0x00FF00FF });
    fs.writeFileSync(imgPath, await validImg.getBuffer('image/png'));

    const layout = { id: 'lay-resilient', background_color: '#112233' };
    const zoneEntries = [
      // Zone 1: Missing / bad file
      {
        zone: { id: 'z1', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100, background_color: '#445566' },
        item: { id: 'i1' },
        content: { filepath: 'non-existent-file.png', mime_type: 'image/png' },
      },
      // Zone 2: Valid file with contain fit_mode
      {
        zone: { id: 'z2', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100, fit_mode: 'contain', background_color: '#000000' },
        item: { id: 'i2' },
        content: { filepath: 'zone-valid.png', mime_type: 'image/png' },
      },
    ];

    const res = await renderLayoutNative(layout, zoneEntries, { width: 400, height: 200 });
    assert.ok(res);
    assert.ok(Buffer.isBuffer(res.png));

    const rendered = await Jimp.fromBuffer(res.png);
    assert.equal(rendered.bitmap.width, 400);
    assert.equal(rendered.bitmap.height, 200);

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('embedded playlist resolution honors per-item ScheduleEval schedule blocks and timezone', () => {
    const devId = 'dev-sched-test';
    const plId = 'pl-sched-test';
    const token = 'tok-sched-test';

    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Sched PL', 'published')").run(plId);
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active) VALUES ('c-on', 'ws-1', 'image', 'image/png', 'on.png', 1)").run();
    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active) VALUES ('c-off', 'ws-1', 'image', 'image/png', 'off.png', 1)").run();

    // Item 1: Always on (no schedule blocks)
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-always-on', ?, 'c-on', 0, 30)").run(plId);

    // Item 2: Dayparting block for 01:00-02:00 UTC only (inactive outside that window)
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-scheduled-off', ?, 'c-off', 1, 30)").run(plId);
    db.prepare("INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time) VALUES ('pis-1', 'pi-scheduled-off', '0,1,2,3,4,5,6', '01:00', '02:00')").run();

    publishPlaylist(plId);

    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, device_token, timezone, screen_profile) VALUES (?, 'Sched Dev', 'ws-1', ?, ?, 'UTC', '{\"preset\":\"seeed-reterminal-sticky\"}')").run(devId, plId, token);

    // If current UTC time is outside 01:00-02:00, pi-scheduled-off is filtered out, leaving only pi-always-on
    const resolved = resolveCurrentItem(devId);
    assert.ok(resolved);
    assert.ok(resolved.total >= 1);
    assert.equal(resolved.content.content_id, 'c-on');
  });

  test('nested playlist items propagate zone_id and respect parent layout', () => {
    const parentPlId = 'pl-parent-test';
    const childPlId = 'pl-child-test';
    const layId = 'lay-nest-test';
    const devId = 'dev-nest-test';

    db.prepare("INSERT INTO layouts (id, workspace_id, name) VALUES (?, 'ws-1', 'Nest Lay')").run(layId);
    db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent) VALUES ('z-nest-1', ?, 'Z1', 0, 0, 100, 100)").run(layId);

    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Child PL', 'published')").run(childPlId);
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status) VALUES (?, 'ws-1', 'Parent PL', 'published')").run(parentPlId);

    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active) VALUES ('c-child-item', 'ws-1', 'image', 'image/png', 'child.png', 1)").run();
    db.prepare("INSERT INTO playlist_items (id, playlist_id, content_id, sort_order, duration_sec) VALUES ('pi-child-1', ?, 'c-child-item', 0, 30)").run(childPlId);

    // Parent item points to child playlist and assigns zone_id = 'z-nest-1'
    db.prepare("INSERT INTO playlist_items (id, playlist_id, child_playlist_id, zone_id, sort_order, duration_sec) VALUES ('pi-parent-ref', ?, ?, 'z-nest-1', 0, 30)").run(parentPlId, childPlId);

    publishPlaylist(childPlId);
    publishPlaylist(parentPlId);

    db.prepare("INSERT INTO devices (id, name, workspace_id, playlist_id, layout_id, screen_profile) VALUES (?, 'Nest Dev', 'ws-1', ?, ?, '{\"preset\":\"seeed-reterminal-sticky\"}')").run(devId, parentPlId, layId);

    const layoutResolved = resolveLayoutItems(devId);
    assert.ok(layoutResolved);
    assert.equal(layoutResolved.zoneEntries.length, 1);
    assert.equal(layoutResolved.zoneEntries[0].zone.id, 'z-nest-1');
    assert.equal(layoutResolved.zoneEntries[0].content.content_id, 'c-child-item');
  });

  test('renderLayoutNative stretches image in fit_mode fill', async () => {
    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'fill-mode-test.png');
    // Create a 200x100 source image
    const srcImg = new Jimp({ width: 200, height: 100, color: 0xFF0000FF });
    fs.writeFileSync(imgPath, await srcImg.getBuffer('image/png'));

    const layout = { id: 'lay-fill' };
    const zoneEntries = [
      {
        zone: { id: 'z-fill', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, fit_mode: 'fill' },
        item: { id: 'it-fill' },
        content: { filepath: 'fill-mode-test.png', mime_type: 'image/png' },
      },
    ];

    const res = await renderLayoutNative(layout, zoneEntries, { width: 300, height: 300 });
    assert.ok(res);
    assert.ok(Buffer.isBuffer(res.png));

    const rendered = await Jimp.fromBuffer(res.png);
    assert.equal(rendered.bitmap.width, 300);
    assert.equal(rendered.bitmap.height, 300);

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });

  test('renderLayout accepts device.background_color for composite background', async () => {
    const tmpUpload = path.join(require('../config').contentDir);
    fs.mkdirSync(tmpUpload, { recursive: true });
    const imgPath = path.join(tmpUpload, 'bg-color-test.png');
    const srcImg = new Jimp({ width: 100, height: 100, color: 0x0000FFFF });
    fs.writeFileSync(imgPath, await srcImg.getBuffer('image/png'));

    const layout = { id: 'lay-bg' };
    const zoneEntries = [
      {
        zone: { id: 'z-bg', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50, fit_mode: 'contain' },
        item: { id: 'it-bg' },
        content: { filepath: 'bg-color-test.png', mime_type: 'image/png' },
      },
    ];

    const res = await renderLayoutNative(layout, zoneEntries, { width: 200, height: 200 }, { device: { background_color: '#FFFFFF' } });
    assert.ok(res);
    assert.ok(Buffer.isBuffer(res.png));

    const rendered = await Jimp.fromBuffer(res.png);
    // Upper-right quadrant (150, 50) is background: should be white (0xFFFFFFFF)
    const color = rendered.getPixelColor(150, 50);
    assert.equal(color, 0xFFFFFFFF);

    try { fs.unlinkSync(imgPath); } catch (_) {}
  });
});

