'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseProfile, getPreset, listPresets, PRESETS } = require('../lib/embedded-profiles.js');
const { postprocess, UnpackableWidthError } = require('../lib/embedded-postprocess.js');
const { Jimp } = require('jimp');

// These tests poll the same device in quick succession. The RATE axis of the OTA breaker would
// trip on that flood; the NO-PROGRESS axis is what RF-6 asserts, so the rate axis is widened here.
process.env.OTA_BREAKER_THRESHOLD = process.env.OTA_BREAKER_THRESHOLD || '1000';

describe('reTerminal E-Series Hardware Profiles & Presets', () => {
  test('all 5 reTerminal models are defined in PRESETS', () => {
    const models = [
      'seeed-reterminal-sticky',
      'seeed-reterminal-e1001',
      'seeed-reterminal-e1002',
      'seeed-reterminal-e1003',
      'seeed-reterminal-e1004',
    ];
    for (const model of models) {
      assert.ok(PRESETS[model], `Missing preset for ${model}`);
    }
  });

  test('e1001 profile: 800x480 1-bit mono e-paper with partial refresh support', () => {
    const p = parseProfile('seeed-reterminal-e1001');
    assert.equal(p.width, 800);
    assert.equal(p.height, 480);
    assert.equal(p.colorDepth, '1bit');
    assert.equal(p.outputFormat, 'x-epd-packed');
    assert.equal(p.supportsPartialRefresh, true);
    assert.equal(p.minRefreshInterval, 5);
    assert.equal(p.fullRefreshDurationMs, 3000);
    assert.equal(p.partialRefreshDurationMs, 350);
  });

  test('e1002 profile: 800x480 6-color Spectra 6 with 30s min interval and no partial refresh', () => {
    const p = parseProfile('seeed-reterminal-e1002');
    assert.equal(p.width, 800);
    assert.equal(p.height, 480);
    assert.equal(p.colorDepth, 'spectra6');
    assert.equal(p.outputFormat, 'x-epd-spectra6');
    assert.equal(p.supportsPartialRefresh, false);
    assert.equal(p.minRefreshInterval, 30);
    assert.equal(p.fullRefreshDurationMs, 14000);
    assert.equal(p.partialRefreshDurationMs, 0);
  });

  test('e1003 profile: 1872x1404 16-level grayscale with touch and fast partial refresh', () => {
    const p = parseProfile('seeed-reterminal-e1003');
    assert.equal(p.width, 1872);
    assert.equal(p.height, 1404);
    assert.equal(p.colorDepth, 'gray16');
    assert.equal(p.outputFormat, 'x-epd-gray16');
    assert.equal(p.supportsPartialRefresh, true);
    assert.equal(p.touchSupported, true);
    assert.equal(p.touchController, 'GT911');
    assert.equal(p.minRefreshInterval, 2);
    assert.equal(p.fullRefreshDurationMs, 1200);
    assert.equal(p.partialRefreshDurationMs, 180);
  });

  test('e1004 profile: 1200x1600 6-color Spectra 6 with 60s min interval and no partial refresh', () => {
    const p = parseProfile('seeed-reterminal-e1004');
    assert.equal(p.width, 1200);
    assert.equal(p.height, 1600);
    assert.equal(p.colorDepth, 'spectra6');
    assert.equal(p.outputFormat, 'x-epd-spectra6');
    assert.equal(p.supportsPartialRefresh, false);
    assert.equal(p.minRefreshInterval, 60);
    assert.equal(p.fullRefreshDurationMs, 22000);
    assert.equal(p.partialRefreshDurationMs, 0);
  });
});

describe('Spectra 6 & Gray16 Postprocessing Pipeline', () => {
  test('Spectra 6 pure palette colors pack to exact nibbles without dither', async () => {
    const colors = [
      { r: 20, g: 20, b: 20, expNibble: 0 },       // Black
      { r: 251, g: 251, b: 251, expNibble: 1 },   // White
      { r: 245, g: 222, b: 0, expNibble: 2 },     // Yellow
      { r: 215, g: 25, b: 32, expNibble: 3 },     // Red
      { r: 0, g: 91, b: 172, expNibble: 5 },      // Blue (controller index 5)
      { r: 0, g: 135, b: 61, expNibble: 6 },      // Green (controller index 6)
    ];

    for (const c of colors) {
      const col = (((c.r << 24) | (c.g << 16) | (c.b << 8) | 0xFF) >>> 0);
      const img = new Jimp({ width: 10, height: 10, color: col });
      const pngBuf = await img.getBuffer('image/png');
      const processed = await postprocess(pngBuf, {
        width: 10,
        height: 10,
        colorDepth: 'spectra6',
        outputFormat: 'x-epd-spectra6',
        dither: 'none',
      });
      const expByte = (c.expNibble << 4) | c.expNibble;
      assert.equal(processed.buffer[0], expByte, `Expected ${expByte.toString(16)} for color nibble ${c.expNibble}`);
    }

    // Adjacent Red (3) and Green (6) pixels pack to (3 << 4) | 6 == 0x36
    const imgPair = new Jimp({ width: 2, height: 1, color: 0x000000FF });
    imgPair.setPixelColor(0xD71920FF, 0, 0); // Red (215, 25, 32)
    imgPair.setPixelColor(0x00873DFF, 1, 0); // Green (0, 135, 61)
    const pairBuf = await imgPair.getBuffer('image/png');
    const pairProcessed = await postprocess(pairBuf, {
      width: 2,
      height: 1,
      colorDepth: 'spectra6',
      outputFormat: 'x-epd-spectra6',
      dither: 'none',
    });
    assert.equal(pairProcessed.buffer[0], 0x36, 'Red (3) + Green (6) should pack to 0x36');
  });

  test('Floyd-Steinberg diffusion carries error forward across adjacent pixels', async () => {
    // Create a horizontal gradient from black to white (0 to 255)
    const img = new Jimp({ width: 100, height: 10, color: 0x000000FF });
    for (let x = 0; x < 100; x++) {
      const v = Math.floor((x / 99) * 255);
      const col = (((v << 24) | (v << 16) | (v << 8) | 0xFF) >>> 0);
      for (let y = 0; y < 10; y++) {
        img.setPixelColor(col, x, y);
      }
    }
    const pngBuf = await img.getBuffer('image/png');

    const dithered = await postprocess(pngBuf, {
      width: 100,
      height: 10,
      colorDepth: '1bit',
      outputFormat: 'x-epd-packed',
      dither: 'floyd-steinberg',
    });

    const nonDithered = await postprocess(pngBuf, {
      width: 100,
      height: 10,
      colorDepth: '1bit',
      outputFormat: 'x-epd-packed',
      dither: 'none',
    });

    // Dithered and non-dithered output must differ on a continuous gradient
    assert.notDeepEqual(dithered.buffer, nonDithered.buffer);
    assert.equal(dithered.buffer.length, Math.ceil(100 * 10 / 8));
  });

  test('format=png produces valid decodable PNG matching target dimensions', async () => {
    const img = new Jimp({ width: 50, height: 50, color: 0xFF0000FF });
    const srcBuf = await img.getBuffer('image/png');

    const processed = await postprocess(srcBuf, {
      width: 800,
      height: 480,
      colorDepth: '1bit',
      outputFormat: 'png',
      dither: 'none',
    });

    assert.equal(processed.contentType, 'image/png');
    const decoded = await Jimp.read(processed.buffer);
    assert.equal(decoded.bitmap.width, 800);
    assert.equal(decoded.bitmap.height, 480);
  });

  test('odd widths rejected for the nibble formats (spectra6, gray16) to prevent row straddling', async () => {
    const img = new Jimp({ width: 297, height: 10, color: 0x000000FF });
    const srcBuf = await img.getBuffer('image/png');

    // parseProfile rejects odd width for spectra6 and gray16 (two pixels per byte)...
    assert.equal(parseProfile({ width: 297, height: 10, colorDepth: 'spectra6' }), null);
    assert.equal(parseProfile({ width: 297, height: 10, colorDepth: 'gray16' }), null);
    // ...but not for 1-bit, which always accepted odd widths (fielded panels use them).
    assert.ok(parseProfile({ width: 297, height: 10, colorDepth: '1bit' }));

    // postprocess throws UnpackableWidthError for an odd-width nibble frame
    await assert.rejects(
      () => postprocess(srcBuf, {
        width: 297,
        height: 10,
        colorDepth: 'spectra6',
        outputFormat: 'x-epd-spectra6',
        dither: 'none',
      }),
      (err) => err instanceof UnpackableWidthError || err.code === 'UNPACKABLE_WIDTH'
    );
  });

  test('e1002 Spectra 6 produces exact 192,000 bytes packed payload (800x480 / 2)', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0xD71920FF }); // Red (215, 25, 32)
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile('seeed-reterminal-e1002');
    profile.dither = 'none';
    const processed = await postprocess(pngBuf, profile);

    assert.equal(processed.contentType, 'application/octet-stream');
    assert.equal(processed.buffer.length, 192000); // 800 * 480 / 2 = 192000 bytes

    // Pure red without dither packs to nibbles 0x33
    assert.equal(processed.buffer[0], 0x33);
  });

  test('e1004 Spectra 6 produces exact 960,000 bytes packed payload (1200x1600 / 2)', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0x00873DFF }); // Green (0, 135, 61)
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile('seeed-reterminal-e1004');
    profile.dither = 'none';
    const processed = await postprocess(pngBuf, profile);

    assert.equal(processed.contentType, 'application/octet-stream');
    assert.equal(processed.buffer.length, 960000); // 1200 * 1600 / 2 = 960000 bytes
    // Pure green without dither packs to nibbles 0x66 (controller index 6)
    assert.equal(processed.buffer[0], 0x66);
  });

  test('e1003 Gray16 produces exact 1,314,144 bytes packed payload (1872x1404 / 2)', async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0x808080FF }); // 50% Gray
    const pngBuf = await img.getBuffer('image/png');

    const profile = parseProfile('seeed-reterminal-e1003');
    const processed = await postprocess(pngBuf, profile);

    assert.equal(processed.contentType, 'application/octet-stream');
    assert.equal(processed.buffer.length, 1314144); // 1872 * 1404 / 2 = 1314144 bytes
    const midNibble = (processed.buffer[0] >> 4) & 0x0F;
    assert.ok(midNibble >= 6 && midNibble <= 9, `Expected mid-gray nibble, got ${midNibble}`);
  });

  test('portrait 90-degree and 270-degree produce 180-degree inverted buffers', async () => {
    // Create a 480x800 image with a white horizontal line at y=10
    const img = new Jimp({ width: 480, height: 800, color: 0x000000FF });
    for (let x = 0; x < 480; x++) {
      img.setPixelColor(0xFFFFFFFF, x, 10);
    }
    const pngBuf = await img.getBuffer('image/png');

    // 90°
    const p90 = await postprocess(pngBuf, {
      width: 480,
      height: 800,
      rotation: 90,
      orientation: 'portrait',
      mcuTranspose: true,   // the reTerminal firmware transposes; other profiles rotate server-side
      colorDepth: '1bit',
      dither: 'none',
      outputFormat: 'x-epd-packed',
    });
    assert.equal(p90.width, 480);
    assert.equal(p90.height, 800);
    assert.equal(p90.buffer.length, 48000); // 480 * 800 / 8

    // Row 10 in 1-bit packed format starts at 10 * (480 / 8) = 600 bytes
    for (let b = 0; b < 60; b++) {
      assert.equal(p90.buffer[600 + b], 0xFF, `90 deg: Byte ${b} in row 10 should be 0xFF`);
      assert.equal(p90.buffer[660 + b], 0x00, `90 deg: Byte ${b} in row 11 should be 0x00`);
    }

    // 270°: Rotated 180° by server postprocess! Row 10 moves to Row 789 (789 * 60 = 47340)
    const p270 = await postprocess(pngBuf, {
      width: 480,
      height: 800,
      rotation: 270,
      orientation: 'portrait-flipped',
      mcuTranspose: true,
      colorDepth: '1bit',
      dither: 'none',
      outputFormat: 'x-epd-packed',
    });
    assert.equal(p270.width, 480);
    assert.equal(p270.height, 800);
    assert.equal(p270.buffer.length, 48000);

    for (let b = 0; b < 60; b++) {
      assert.equal(p270.buffer[47340 + b], 0xFF, `270 deg: Byte ${b} in row 789 should be 0xFF`);
      assert.equal(p270.buffer[600 + b], 0x00, `270 deg: Byte ${b} in row 10 should be 0x00`);
    }
  });
});

describe('reTerminal E-Series Registration & Route Handling', () => {
  const http = require('node:http');
  const express = require('express');
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { Database } = require('../db/sqlite-driver');

  let db, app, server, baseUrl, embeddedRouter, testFwDir;

  test('setup test server and database', async () => {
    process.env.JWT_SECRET = 'test-secret-embedded-e-series';
    process.env.EMBEDDED_CACHE_DIR = path.join(__dirname, '..', 'data', 'test-embedded-cache-e-series');
    testFwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fw-test-'));
    process.env.ST_FIRMWARE_DIR = testFwDir;

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY(workspace_id, user_id));
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT,
        pairing_code TEXT, claim_secret TEXT, status TEXT, client_type TEXT,
        device_token TEXT, blocked INTEGER DEFAULT 0, screen_profile TEXT,
        screen_width INTEGER, screen_height INTEGER, render_width INTEGER, render_height INTEGER,
        playlist_id TEXT, playlist_source TEXT, layout_id TEXT,
        timezone TEXT, reported_timezone TEXT, background_color TEXT DEFAULT '#000000',
        default_content_id TEXT, last_heartbeat INTEGER, ip_address TEXT,
        app_version TEXT, updated_at INTEGER, heartbeat_expected_by INTEGER,
        power_source TEXT, orientation TEXT DEFAULT 'landscape', reported_orientation TEXT, reported_board TEXT
      );
      CREATE TABLE device_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT, battery_level INTEGER, battery_charging INTEGER,
        wifi_rssi INTEGER, local_ip TEXT, power_source TEXT,
        temperature_c REAL, humidity REAL,
        reported_at INTEGER
      );
      CREATE TABLE playlists (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, status TEXT DEFAULT 'published',
        published_snapshot TEXT, published_structure TEXT, updated_at INTEGER DEFAULT 0,
        playback_order TEXT DEFAULT 'sequential', published_playback_order TEXT,
        smart_rules TEXT, published_smart_rules TEXT
      );
      CREATE TABLE playlist_items (
        id TEXT PRIMARY KEY, playlist_id TEXT, content_id TEXT,
        sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 10, updated_at INTEGER DEFAULT 0,
        zone_id TEXT, widget_id TEXT, child_playlist_id TEXT, muted INTEGER DEFAULT 0,
        play_from TEXT, play_until TEXT, enabled INTEGER DEFAULT 1, log_play INTEGER DEFAULT 1,
        fit_mode TEXT, play_when TEXT, weight INTEGER DEFAULT 1, repeat_every_sec INTEGER
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
        created_at INTEGER NOT NULL DEFAULT 0
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
      CREATE TABLE IF NOT EXISTS display_power_schedules (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, device_id TEXT, group_id TEXT,
        timezone TEXT, enabled INTEGER NOT NULL DEFAULT 1, windows TEXT, set_by_org_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS device_groups (
        id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT
      );
      CREATE TABLE IF NOT EXISTS device_group_members (
        group_id TEXT, device_id TEXT, workspace_id TEXT, PRIMARY KEY(group_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS device_diagnostic_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        log_json TEXT,
        log_count INTEGER DEFAULT 0,
        battery INTEGER,
        wifi_rssi INTEGER,
        version TEXT,
        uploaded_at INTEGER
      );
    `);

    require.cache[require.resolve('../db/database')] = {
      id: require.resolve('../db/database'),
      loaded: true,
      exports: { db, pruneTelemetry: () => {} },
    };

    delete require.cache[require.resolve('../routes/embedded')];
    embeddedRouter = require('../routes/embedded');

    app = express();
    app.use((req, res, next) => (/^\/api\/embedded\/logs\/?$/i.test(req.path) ? next() : express.json({ limit: '12mb' })(req, res, next)));
    app.use('/api/embedded', embeddedRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/embedded`;
  });

  test('POST /pair/register auto-assigns dimensions from screen_profile preset', async () => {
    // E1003 registration without explicit width/height
    const res = await fetch(`${baseUrl}/pair/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen_profile: 'seeed-reterminal-e1003' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.device_id);

    const dev = db.prepare('SELECT screen_width, screen_height, render_width, render_height FROM devices WHERE id = ?').get(body.device_id);
    assert.equal(dev.screen_width, 1872);
    assert.equal(dev.screen_height, 1404);
    assert.equal(dev.render_width, 1872);
    assert.equal(dev.render_height, 1404);
  });

  test('POST /pair/register auto-assigns dimensions for E1004', async () => {
    const res = await fetch(`${baseUrl}/pair/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen_profile: 'seeed-reterminal-e1004' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const dev = db.prepare('SELECT screen_width, screen_height, render_width, render_height FROM devices WHERE id = ?').get(body.device_id);
    assert.equal(dev.screen_width, 1200);
    assert.equal(dev.screen_height, 1600);
    assert.equal(dev.render_width, 1200);
    assert.equal(dev.render_height, 1600);
  });

  test('GET /render clamps expiresIn to minRefreshInterval and emits X-ST-Supports-Partial for E1002', async () => {
    const fs = require('node:fs');
    const { contentDir } = require('../config');
    fs.mkdirSync(contentDir, { recursive: true });
    const img = new Jimp({ width: 100, height: 100, color: 0xFF0000FF });
    const pngPath = path.join(contentDir, 'test-e1002.png');
    await img.write(pngPath);

    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active, created_at) VALUES ('c-e1002', 'ws-test', 'image', 'image/png', 'test-e1002.png', 1, 1)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status, published_snapshot) VALUES ('pl-e1002', 'ws-test', 'PL E1002', 'published', ?)").run(JSON.stringify([
      { id: 'pi-1', content_id: 'c-e1002', duration_sec: 10, enabled: 1 }
    ]));
    db.prepare(`
      INSERT INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-e1002', 'E1002 Dev', 'ws-test', 'online', 'tok-e1002', 'pl-e1002', 'seeed-reterminal-e1002')
    `).run();

    const res = await fetch(`${baseUrl}/render?device_id=dev-e1002`, {
      headers: { 'Authorization': 'Bearer tok-e1002' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-supports-partial'), '0');
    const expiresIn = Number(res.headers.get('x-st-expires-in'));
    assert.ok(expiresIn >= 30, `Expected expiresIn >= 30, got ${expiresIn}`);

    try { fs.unlinkSync(pngPath); } catch (_) {}
  });

  test('GET /render emits X-ST-Supports-Partial: 1 for E1001', async () => {
    const fs = require('node:fs');
    const { contentDir } = require('../config');
    fs.mkdirSync(contentDir, { recursive: true });
    const img = new Jimp({ width: 100, height: 100, color: 0x000000FF });
    const pngPath = path.join(contentDir, 'test-e1001.png');
    await img.write(pngPath);

    db.prepare("INSERT INTO content (id, workspace_id, type, mime_type, filepath, is_active, created_at) VALUES ('c-e1001', 'ws-test', 'image', 'image/png', 'test-e1001.png', 1, 1)").run();
    db.prepare("INSERT INTO playlists (id, workspace_id, name, status, published_snapshot) VALUES ('pl-e1001', 'ws-test', 'PL E1001', 'published', ?)").run(JSON.stringify([
      { id: 'pi-2', content_id: 'c-e1001', duration_sec: 10, enabled: 1 }
    ]));
    db.prepare(`
      INSERT INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-e1001', 'E1001 Dev', 'ws-test', 'online', 'tok-e1001', 'pl-e1001', 'seeed-reterminal-e1001')
    `).run();

    const res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-supports-partial'), '1');
  });

  test('parseProfile swaps axes for portrait on landscape model and vice versa', () => {
    const portraitE1001 = parseProfile('seeed-reterminal-e1001', { orientation: 'portrait' });
    assert.equal(portraitE1001.width, 480);
    assert.equal(portraitE1001.height, 800);
    assert.equal(portraitE1001.orientation, 'portrait');

    const landscapeE1004 = parseProfile('seeed-reterminal-e1004', { orientation: 'landscape' });
    assert.equal(landscapeE1004.width, 1600);
    assert.equal(landscapeE1004.height, 1200);
    assert.equal(landscapeE1004.orientation, 'landscape');

    const flippedE1001 = parseProfile('seeed-reterminal-e1001', { orientation: 'landscape-flipped' });
    assert.equal(flippedE1001.rotation, 180);
  });

  test('GET /render emits rotation and orientation headers and swaps axes on orientation=portrait', async () => {
    const res = await fetch(`${baseUrl}/render?device_id=dev-e1001&orientation=portrait&rotation=90`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-orientation'), 'portrait');
    assert.equal(res.headers.get('x-st-rotation'), '90');
    assert.equal(res.headers.get('x-st-screen-width'), '480');
    assert.equal(res.headers.get('x-st-screen-height'), '800');
  });

  test('GET /render produces matching dimensions and headers for all rotation angles', async () => {
    for (const angle of [0, 90, 180, 270]) {
      const res = await fetch(`${baseUrl}/render?device_id=dev-e1001&rotation=${angle}`, {
        headers: { 'Authorization': 'Bearer tok-e1001' },
      });
      assert.equal(res.status, 200);
      const expW = (angle === 90 || angle === 270) ? '480' : '800';
      const expH = (angle === 90 || angle === 270) ? '800' : '480';
      assert.equal(res.headers.get('x-st-screen-width'), expW);
      assert.equal(res.headers.get('x-st-screen-height'), expH);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, 48000);
    }
  });

  test('embedded request ingests SHT40 temperature and humidity telemetry headers', async () => {
    const res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: {
        'Authorization': 'Bearer tok-e1001',
        'X-ST-Device-Temperature': '22.4',
        'X-ST-Device-Humidity': '48.6',
      },
    });
    assert.equal(res.status, 200);

    const latest = db.prepare('SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get('dev-e1001');
    assert.ok(latest, 'telemetry row should be inserted');
    assert.equal(latest.temperature_c, 22.4);
    assert.equal(latest.humidity, 48.6);
  });

  test('embedded telemetry rejects invalid or out-of-range sensor readings', async () => {
    // 1. Extreme temperature (> 85 C) and humidity (> 100%)
    await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: {
        'Authorization': 'Bearer tok-e1001',
        'X-ST-Device-Battery': '80',
        'X-ST-Device-Temperature': '125.0',
        'X-ST-Device-Humidity': '115.0',
      },
    });
    let latest = db.prepare('SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get('dev-e1001');
    assert.equal(latest.temperature_c, null, '125C must be rejected');
    assert.equal(latest.humidity, null, '115% RH must be rejected');

    // 2. Below minimum temperature (< -40 C) and negative humidity
    await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: {
        'Authorization': 'Bearer tok-e1001',
        'X-ST-Device-Battery': '80',
        'X-ST-Device-Temperature': '-55.0',
        'X-ST-Device-Humidity': '-5.0',
      },
    });
    latest = db.prepare('SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get('dev-e1001');
    assert.equal(latest.temperature_c, null, '-55C must be rejected');
    assert.equal(latest.humidity, null, '-5% RH must be rejected');

    // 3. Valid negative temperature (-5.2 C) and 0% / 100% boundary humidity
    await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: {
        'Authorization': 'Bearer tok-e1001',
        'X-ST-Device-Temperature': '-5.2',
        'X-ST-Device-Humidity': '0.0',
      },
    });
    latest = db.prepare('SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get('dev-e1001');
    assert.equal(latest.temperature_c, -5.2);
    assert.equal(latest.humidity, 0.0);
  });

  test('upload_logs command priority in getPendingCommand and X-ST-Command header delivery', async () => {
    const commandQueue = require('../lib/command-queue');
    commandQueue.queueCommand('dev-e1001', 'upload_logs', {});

    const res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-command'), 'upload_logs', 'Should pop and deliver upload_logs in X-ST-Command header');
  });

  test('POST /api/embedded/logs ingests diagnostic buffer and GET /logs retrieves it', async () => {
    const res = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
        'X-ST-Device-Battery': '85',
        'X-ST-Device-RSSI': '-60',
        'X-ST-Firmware-Version': '1.3.0',
      },
      body: JSON.stringify({
        device_id: 'dev-e1001',
        version: '1.3.0',
        battery: 85,
        rssi: -60,
        log_count: 2,
        logs: [
          { uptime_ms: 1200, level: 'INFO', tag: 'Boot', msg: 'ScreenTinker MCU v1.3.0 booting' },
          { uptime_ms: 2500, level: 'INFO', tag: 'WiFi', msg: 'Connected to AP' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.count, 2);
    assert.ok(body.id > 0);

    const saved = db.prepare('SELECT * FROM device_diagnostic_logs WHERE device_id = ?').get('dev-e1001');
    assert.ok(saved, 'Log row should be saved in database');
    assert.equal(saved.log_count, 2);
    assert.equal(saved.battery, 85);
    assert.equal(saved.wifi_rssi, -60);
    assert.equal(saved.version, '1.3.0');

    // Test GET /logs
    const getRes = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.ok(Array.isArray(getBody.logs));
    assert.equal(getBody.logs.length, 1);
    assert.equal(getBody.logs[0].log_count, 2);
    assert.equal(getBody.logs[0].battery, 85);
  });

  test('firmware distribution routes GET /version and GET /latest.bin', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');

    const fwDir = path.join(testFwDir, 'seeed_reterminal_sticky');
    fs.mkdirSync(fwDir, { recursive: true });

    const dummyFw = Buffer.alloc(1024, 0xAA);
    const expectedSha = crypto.createHash('sha256').update(dummyFw).digest('hex');
    fs.writeFileSync(path.join(fwDir, 'firmware.bin'), dummyFw);
    fs.writeFileSync(path.join(fwDir, 'version.json'), JSON.stringify({ version: '1.3.0' }));

    // 1. GET /firmware/:preset/version
    const vRes = await fetch(`${baseUrl}/firmware/seeed_reterminal_sticky/version`);
    assert.equal(vRes.status, 200);
    const vBody = await vRes.json();
    assert.equal(vBody.preset, 'seeed_reterminal_sticky');
    assert.equal(vBody.version, '1.3.0');
    assert.equal(vBody.size, 1024);
    assert.equal(vBody.sha256, expectedSha);
    assert.equal(vBody.download_url, '/api/embedded/firmware/seeed_reterminal_sticky/latest.bin');

    // 2. GET /firmware/:preset/latest.bin
    const binRes = await fetch(`${baseUrl}/firmware/seeed_reterminal_sticky/latest.bin`);
    assert.equal(binRes.status, 200);
    assert.equal(binRes.headers.get('content-type'), 'application/octet-stream');
    assert.equal(binRes.headers.get('content-length'), '1024');
    assert.equal(binRes.headers.get('x-st-firmware-version'), '1.3.0');
    assert.equal(binRes.headers.get('x-st-firmware-sha256'), expectedSha);
    const binBuf = Buffer.from(await binRes.arrayBuffer());
    assert.equal(binBuf.length, 1024);
    assert.equal(binBuf[0], 0xAA);

    // 3. Nonexistent preset returns 404
    const errRes = await fetch(`${baseUrl}/firmware/nonexistent_board_xyz/version`);
    assert.equal(errRes.status, 404);

    // Clean up
    fs.rmSync(fwDir, { recursive: true, force: true });
  });

  test('RF-1: Orientation persistence via headers across subsequent polls', async () => {
    // 1. Nothing reported yet. (devices.orientation is 'landscape' by schema default on every row
    //    and is NOT what the panel said; the panel's own report lives in reported_orientation.)
    db.prepare("UPDATE devices SET reported_orientation = NULL WHERE id = 'dev-e1001'").run();

    // 2. Poll with X-ST-Device-Orientation: portrait
    const res1 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: {
        'Authorization': 'Bearer tok-e1001',
        'X-ST-Device-Orientation': 'portrait',
      },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-st-orientation'), 'portrait');
    assert.equal(res1.headers.get('x-st-rotation'), '90');
    assert.equal(res1.headers.get('x-st-screen-width'), '480');
    assert.equal(res1.headers.get('x-st-screen-height'), '800');

    // Verify DB updated
    const devAfter1 = db.prepare('SELECT reported_orientation FROM devices WHERE id = ?').get('dev-e1001');
    assert.equal(devAfter1.reported_orientation, 'portrait');

    // 3. Subsequent poll without orientation header retains portrait
    const res2 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-st-orientation'), 'portrait');
    assert.equal(res2.headers.get('x-st-rotation'), '90');
    assert.equal(res2.headers.get('x-st-screen-width'), '480');
    assert.equal(res2.headers.get('x-st-screen-height'), '800');

    // Reset: nothing reported
    db.prepare("UPDATE devices SET reported_orientation = NULL WHERE id = 'dev-e1001'").run();
  });

  test('RF-3: Sibling command delivery in FIFO order without starvation', async () => {
    const commandQueue = require('../lib/command-queue');
    // Clear queue for dev-e1001 first
    commandQueue.popPendingCommands('dev-e1001');

    // Queue upload_logs followed by reboot. (This used a custom-URL update; a caller-supplied
    // firmware URL is never offered any more, so a reboot stands in as the sibling.)
    commandQueue.queueCommand('dev-e1001', 'upload_logs', {});
    commandQueue.queueCommand('dev-e1001', 'reboot', {});

    // Poll 1: delivers upload_logs
    const res1 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-st-command'), 'upload_logs');

    // Poll 2: delivers reboot (upload_logs was popped on Poll 1)
    const res2 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-st-command'), 'reboot');

    // Poll 3: queue is now empty
    const res3 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get('x-st-command'), null);
  });

  test('RF-4: a 304 that carries X-ST-Command delivers it once, then it is gone', async () => {
    const commandQueue = require('../lib/command-queue');
    commandQueue.popPendingCommands('dev-e1001');

    // First render to get the current ETag
    const firstRes = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(firstRes.status, 200);
    const etag = firstRes.headers.get('etag');
    assert.ok(etag, 'ETag must be present');

    // Queue upload_logs, then poll with the matching ETag -> 304 that carries the command
    commandQueue.queueCommand('dev-e1001', 'upload_logs', {});
    const poll304 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001', 'If-None-Match': etag },
    });
    assert.equal(poll304.status, 304);
    assert.equal(poll304.headers.get('x-st-command'), 'upload_logs');

    // The next 304 must NOT replay it (this is the re-run-on-every-poll bug)
    const poll304Again = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001', 'If-None-Match': etag },
    });
    assert.equal(poll304Again.status, 304);
    assert.equal(poll304Again.headers.get('x-st-command'), null);

    // Nor the next 200
    const poll200 = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(poll200.status, 200);
    assert.equal(poll200.headers.get('x-st-command'), null);

    // A second queued type is still delivered on the following poll, via a 304
    commandQueue.queueCommand('dev-e1001', 'reboot', {});
    const poll304Reboot = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001', 'If-None-Match': etag },
    });
    assert.equal(poll304Reboot.status, 304);
    assert.equal(poll304Reboot.headers.get('x-st-command'), 'reboot');

    const pollNext = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001', 'If-None-Match': etag },
    });
    assert.equal(pollNext.status, 304);
    assert.equal(pollNext.headers.get('x-st-command'), null);
  });

  test('RF-5: Firmware directory isolation, SHA caching, and normalized preset', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const commandQueue = require('../lib/command-queue');
    commandQueue.popPendingCommands('dev-e1001');

    const fwDir = path.join(testFwDir, 'seeed_reterminal_e1001');
    fs.mkdirSync(fwDir, { recursive: true });

    const dummyFw = Buffer.alloc(2048, 0x55);
    const expectedSha = crypto.createHash('sha256').update(dummyFw).digest('hex');
    fs.writeFileSync(path.join(fwDir, 'firmware.bin'), dummyFw);
    fs.writeFileSync(path.join(fwDir, 'version.json'), JSON.stringify({ version: '1.4.0' }));

    // 1. seeed_reterminal_e1004 has no firmware: must return 404 (no fallback to e1001 or parent)
    const res404 = await fetch(`${baseUrl}/firmware/seeed_reterminal_e1004/latest.bin`);
    assert.equal(res404.status, 404);

    // 2. Default update command for dev-e1001 picks up the normalized preset and sha256
    commandQueue.queueCommand('dev-e1001', 'update', {});
    const resUpdate = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(resUpdate.status, 200);
    assert.equal(
      resUpdate.headers.get('x-st-command'),
      `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${expectedSha}`
    );

    // Clean up
    fs.rmSync(fwDir, { recursive: true, force: true });
  });

  test('RF-6: OTA circuit breaker suppresses update after 6 offers without progress, and progress re-enables it', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const commandQueue = require('../lib/command-queue');
    const otaBreaker = require('../lib/ota-breaker');

    const fwDir = path.join(testFwDir, 'seeed_reterminal_e1001');
    fs.mkdirSync(fwDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(fwDir, 'firmware.bin'), Buffer.alloc(100, 0x11));
      fs.writeFileSync(path.join(fwDir, 'version.json'), JSON.stringify({ version: '1.4.0' }));

      otaBreaker.reset();
      commandQueue.popPendingCommands('dev-e1001');

      const poll = (version) => fetch(`${baseUrl}/render?device_id=dev-e1001`, {
        headers: { 'Authorization': 'Bearer tok-e1001', 'X-ST-Firmware-Version': version },
      });

      // Device keeps reporting 1.3.0 while the target is 1.4.0. Offers 1..6 are delivered.
      for (let offer = 1; offer <= 6; offer++) {
        commandQueue.queueCommand('dev-e1001', 'update', {});
        const res = await poll('1.3.0');
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('x-st-command')?.startsWith('update '), `Offer ${offer} should deliver update command`);
      }

      // Offer 7: no progress after 6 -> suppressed. Still suppressed on the next poll.
      for (let i = 0; i < 2; i++) {
        commandQueue.queueCommand('dev-e1001', 'update', {});
        const res = await poll('1.3.0');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-st-command'), null, 'Breaker held: update must not be emitted');
      }

      // A poll that reports the target version is progress: the hold clears.
      await poll('1.4.0');
      assert.equal(db.prepare('SELECT app_version FROM devices WHERE id = ?').get('dev-e1001').app_version, '1.4.0');

      // Target moves on to 1.5.0; the device at 1.4.0 is offered again.
      fs.writeFileSync(path.join(fwDir, 'version.json'), JSON.stringify({ version: '1.5.0' }));
      commandQueue.queueCommand('dev-e1001', 'update', {});
      const resAfter = await poll('1.4.0');
      assert.equal(resAfter.status, 200);
      assert.ok(resAfter.headers.get('x-st-command')?.startsWith('update '), 'after progress the next offer must be allowed');
    } finally {
      fs.rmSync(fwDir, { recursive: true, force: true });
    }
  });

  test('RF-7: minRefreshInterval never holds a panel past its scheduled-off edge', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The E1002 test deletes its PNG; this test renders the same playlist, so it needs one back.
    const fsImg = require('node:fs');
    const { contentDir: rf7ContentDir } = require('../config');
    fsImg.mkdirSync(rf7ContentDir, { recursive: true });
    await (new Jimp({ width: 100, height: 100, color: 0xFF0000FF })).write(path.join(rf7ContentDir, 'test-e1002.png'));
    const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

    // A panel on E1004 (minRefreshInterval 60). Its off-edge is the next UTC minute, so it is a few
    // seconds away: a minute-granular edge would tell it to wait the full 60 s floor.
    let remainingSec;
    while ((remainingSec = (60000 - (Date.now() % 60000)) / 1000) < 4) await sleep(100);
    const nextMinuteMs = Date.now() - (Date.now() % 60000) + 60000;
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const windows = JSON.stringify([{ days: allDays, start: hhmm(nextMinuteMs), end: hhmm(nextMinuteMs + 10 * 60000) }]);

    db.prepare(`
      INSERT INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-e1004', 'E1004 Dev', 'ws-test', 'online', 'tok-e1004', 'pl-e1002', 'seeed-reterminal-e1004')
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO display_power_schedules (id, workspace_id, name, device_id, timezone, enabled, windows)
      VALUES ('sch-e1004', 'ws-test', 'Power Sch', 'dev-e1004', 'UTC', 1, ?)
    `).run(windows);
    try {
      const res = await fetch(`${baseUrl}/render?device_id=dev-e1004`, {
        headers: { 'Authorization': 'Bearer tok-e1004' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-st-power-state'), 'on', 'panel is still on until the edge');
      const expiresIn = Number(res.headers.get('x-st-expires-in'));
      assert.ok(
        expiresIn <= Math.floor(remainingSec),
        `X-ST-Expires-In ${expiresIn} must not run past the off edge (${remainingSec.toFixed(1)}s away)`
      );
      assert.ok(expiresIn >= 1);
    } finally {
      db.prepare("DELETE FROM display_power_schedules WHERE device_id = 'dev-e1004'").run();
      try { fsImg.unlinkSync(path.join(rf7ContentDir, 'test-e1002.png')); } catch (_) {}
    }

    // With no schedule the floor still applies
    const floorRes = await fetch(`${baseUrl}/render?device_id=dev-e1004`, {
      headers: { 'Authorization': 'Bearer tok-e1004' },
    });
    assert.equal(floorRes.status, 200);
    assert.ok(Number(floorRes.headers.get('x-st-expires-in')) >= 60, 'minRefreshInterval floor applies with no off edge');
  });

  test('RF-8: Diagnostic Log API schema validation, limits, and storage', async () => {
    const commandQueue = require('../lib/command-queue');
    commandQueue.queueCommand('dev-e1001', 'upload_logs', {});

    // 1. Invalid battery string "nope" should be rejected with 400
    const resBadBatt = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({ battery: 'nope', logs: [{ msg: 'test' }] }),
    });
    assert.equal(resBadBatt.status, 400);

    // 2. Out-of-bounds battery (150) should be rejected with 400
    const resOverBatt = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({ battery: 150, logs: [{ msg: 'test' }] }),
    });
    assert.equal(resOverBatt.status, 400);

    // 3. Out-of-bounds RSSI (10) should be rejected with 400
    const resOverRssi = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({ wifi_rssi: 10, logs: [{ msg: 'test' }] }),
    });
    assert.equal(resOverRssi.status, 400);

    // 4. Excess logs (> 100 items) should be rejected with 400
    const hugeLogs = new Array(101).fill({ msg: 'log line' });
    const resHuge = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({ logs: hugeLogs }),
    });
    assert.equal(resHuge.status, 400);

    // 5. Body (> 256KB) refused with 413, including trailing slash (S8)
    const bigString = 'x'.repeat(300 * 1024);
    const resBig = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({ padding: bigString }),
    });
    assert.equal(resBig.status, 413);

    const resBigSlash = await fetch(`${baseUrl}/logs/?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({ padding: bigString }),
    });
    assert.equal(resBigSlash.status, 413);

    // 6. Valid upload with Claim 6 body (wifi_rssi: -60, battery: 92, no rssi)
    const resValid = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-e1001',
      },
      body: JSON.stringify({
        battery: 92,
        wifi_rssi: -60,
        logs: [{ msg: 'hello diagnostic log' }],
      }),
    });
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid.status, 'ok');
    assert.ok(Number.isInteger(bodyValid.log_id));
    assert.equal(bodyValid.id, bodyValid.log_id);
    assert.equal(bodyValid.count, 1);

    // 7. Read the row back from the database and verify wifi_rssi: -60 and battery: 92
    const row = db.prepare('SELECT * FROM device_diagnostic_logs WHERE id = ?').get(bodyValid.log_id);
    assert.ok(row, 'diagnostic log row should exist in database');
    assert.equal(row.battery, 92);
    assert.equal(row.wifi_rssi, -60);

    // Verify GET /logs retrieves it
    const resGet = await fetch(`${baseUrl}/logs?device_id=dev-e1001`, {
      headers: { 'Authorization': 'Bearer tok-e1001' },
    });
    assert.equal(resGet.status, 200);
    const bodyGet = await resGet.json();
    assert.ok(bodyGet.logs.some(l => l.id === bodyValid.log_id && l.wifi_rssi === -60));

    // Verify upload_logs was popped
    const pending = commandQueue.peekPendingCommands('dev-e1001');
    assert.ok(!pending.some(c => c.type === 'upload_logs'), 'upload_logs command should have been popped');
  });

  test('S7: format=png is rejected for spectra6 and gray16 panels', async () => {
    db.prepare(`
      INSERT OR IGNORE INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-e1003', 'E1003 Dev', 'ws-test', 'online', 'tok-e1003', 'pl-e1001', 'seeed-reterminal-e1003')
    `).run();

    // dev-e1002 is spectra6
    const resSpectra = await fetch(`${baseUrl}/render?device_id=dev-e1002&format=png`, {
      headers: { 'Authorization': 'Bearer tok-e1002' },
    });
    assert.equal(resSpectra.status, 400);
    const bodySpectra = await resSpectra.json();
    assert.ok(bodySpectra.error.includes('not available for spectra6'));

    // dev-e1003 is gray16
    const resGray = await fetch(`${baseUrl}/render?device_id=dev-e1003&format=png`, {
      headers: { 'Authorization': 'Bearer tok-e1003' },
    });
    assert.equal(resGray.status, 400);
    const bodyGray = await resGray.json();
    assert.ok(bodyGray.error.includes('not available for gray16'));
  });

  test('update command delivery via X-ST-Command header', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const commandQueue = require('../lib/command-queue');
    const otaBreaker = require('../lib/ota-breaker');
    const fwDir = path.join(testFwDir, 'seeed_reterminal_e1001');
    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    otaBreaker.reset();
    commandQueue.popPendingCommands('dev-e1001');
    // RF-6 left the device reporting 1.4.0. These offers are judged against an older device.
    db.prepare("UPDATE devices SET app_version = '1.3.0' WHERE id = 'dev-e1001'").run();
    try {
      // 1. A custom URL, even with its own SHA-256 and version, is never offered: only this
      //    server's own binary is (there is none on disk yet, so nothing at all).
      commandQueue.queueCommand('dev-e1001', 'update', { url: 'http://custom.example.com/fw.bin', sha256: sha, version: '1.4.0' });
      let res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, {
        headers: { 'Authorization': 'Bearer tok-e1001' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-st-command'), null, 'a caller-supplied firmware URL must never be emitted');

      // 2. Custom URL with no hash is NOT offered (S2)
      commandQueue.queueCommand('dev-e1001', 'update', { url: 'http://custom.example.com/fw.bin', version: '1.4.0' });
      res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, { headers: { 'Authorization': 'Bearer tok-e1001' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-st-command'), null, 'custom URL without its own sha256 must not be emitted');

      // 3. Default preset URL with no file on disk is NOT offered (S2)
      commandQueue.queueCommand('dev-e1001', 'update', {});
      res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, { headers: { 'Authorization': 'Bearer tok-e1001' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-st-command'), null, 'no firmware file on disk: no update');

      // 4. Default preset URL with a file: the hash is the file's, and matches the served bytes
      const dummyFw = Buffer.alloc(64, 0x22);
      const fileSha = crypto.createHash('sha256').update(dummyFw).digest('hex');
      fs.mkdirSync(fwDir, { recursive: true });
      fs.writeFileSync(path.join(fwDir, 'firmware.bin'), dummyFw);
      fs.writeFileSync(path.join(fwDir, 'version.json'), JSON.stringify({ version: '1.4.0' }));
      commandQueue.queueCommand('dev-e1001', 'update', {});
      res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, { headers: { 'Authorization': 'Bearer tok-e1001' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${fileSha}`);
      const served = Buffer.from(await (await fetch(`${baseUrl}/firmware/seeed_reterminal_e1001/latest.bin`)).arrayBuffer());
      assert.equal(crypto.createHash('sha256').update(served).digest('hex'), fileSha, 'token must match the served bytes');

      // 5. Default preset with no version.json is NOT offered (S2)
      fs.rmSync(path.join(fwDir, 'version.json'));
      otaBreaker.reset();
      commandQueue.queueCommand('dev-e1001', 'update', {});
      res = await fetch(`${baseUrl}/render?device_id=dev-e1001`, { headers: { 'Authorization': 'Bearer tok-e1001' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-st-command'), null, 'no version.json: no update');
    } finally {
      commandQueue.popPendingCommands('dev-e1001');
      fs.rmSync(fwDir, { recursive: true, force: true });
    }
  });

  test('S1: handleRenderLayout delivers X-ST-Command on 404 when device has no layout assigned', async () => {
    const commandQueue = require('../lib/command-queue');
    db.prepare(`
      INSERT OR IGNORE INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-no-layout', 'No Layout Dev', 'ws-test', 'online', 'tok-no-layout', NULL, 'seeed-reterminal-sticky')
    `).run();
    commandQueue.queueCommand('dev-no-layout', 'reboot', {});
    const res = await fetch(`${baseUrl}/render?device_id=dev-no-layout&mode=layout`, {
      headers: { 'Authorization': 'Bearer tok-no-layout' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-st-command'), 'reboot');
    const remaining = commandQueue.peekPendingCommands('dev-no-layout');
    assert.equal(remaining.length, 0, 'reboot command should be popped upon delivery');
  });

  test('S2/S3: suppressed update command is popped and sibling reboot is delivered on same poll', async () => {
    const commandQueue = require('../lib/command-queue');
    db.prepare(`
      INSERT OR IGNORE INTO devices (id, name, workspace_id, status, device_token, playlist_id, screen_profile)
      VALUES ('dev-suppressed-cmd', 'Suppressed Cmd Dev', 'ws-test', 'online', 'tok-suppressed', 'pl-e1001', 'seeed-reterminal-sticky')
    `).run();
    commandQueue.popPendingCommands('dev-suppressed-cmd');
    // Queue update with missing sha256 (will be suppressed) and reboot
    commandQueue.queueCommand('dev-suppressed-cmd', 'update', { url: 'http://custom.example.com/no-sha.bin' });
    commandQueue.queueCommand('dev-suppressed-cmd', 'reboot', {});

    const res = await fetch(`${baseUrl}/render?device_id=dev-suppressed-cmd`, {
      headers: { 'Authorization': 'Bearer tok-suppressed' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-command'), 'reboot', 'reboot should be delivered because suppressed update was popped');
    const remaining = commandQueue.peekPendingCommands('dev-suppressed-cmd');
    assert.equal(remaining.length, 0, 'both commands should have been popped');
  });

  test('teardown server', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { contentDir } = require('../config');
    try { fs.unlinkSync(path.join(contentDir, 'test-e1001.png')); } catch (_) {}
    try { fs.rmSync(testFwDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.ST_FIRMWARE_DIR;
    if (server) await new Promise((resolve) => server.close(resolve));
  });
});

