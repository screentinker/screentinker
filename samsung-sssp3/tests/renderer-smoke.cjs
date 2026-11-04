'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const assert = require('assert/strict');
/* The fake template the template-self-cache case below serves from a stand-in CMS:
 * one operator-uploaded content image (root-relative, NOT packaged — packaged tpl:
 * assets already arrive as data URIs) to be inlined offline, plus Arabic text so
 * the decode path (browser responseText, never readAll bytes) is proven intact. */
const TPL_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>body{background:#fff;margin:0}</style></head><body><img src="/uploads/content/clinic%20logo.png"><h1>عيادة إكرام</h1></body></html>';
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluateOnNewDocument(() => {
      window.WebSocket = function () { throw new Error('WebSocket disabled in renderer smoke test'); };
      const files = {};
      function getFile(name) { return localStorage.getItem('__mockfile:' + name); }
      window.FileSystem = function () {
        this.createCommonDir = function () {};
        this.openCommonFile = function (name, mode) {
          if (mode !== 'w' && getFile(name) === null) throw Error('missing');
          return { readAll() { return getFile(name); }, writeAll(data) { localStorage.setItem('__mockfile:' + name, data); } };
        };
        this.closeCommonFile = function () {};
      };
      window.Common = { API: { Widget: function () { this.sendReadyEvent = function () {}; } } };
      window.__testDownloads = [];
      Object.defineProperty(HTMLObjectElement.prototype, 'StartDownFile', { value(url, name) { window.__testDownloads.push({ url: url, name: name }); localStorage.setItem('__mockfile:' + name, 'video bytes'); setTimeout(() => window.STNativeDownloadComplete('1000?1'), 0); } });
      for (const name of ['Stop', 'SetDisplayArea', 'SetInitialBuffer']) Object.defineProperty(HTMLObjectElement.prototype, name, { value() {} });
      Object.defineProperty(HTMLObjectElement.prototype, 'InitPlayer', { value(url) { window.__testVideoUrl = url; } });
      Object.defineProperty(HTMLObjectElement.prototype, 'StartPlayback', { value() { window.__testVideoStarted = (window.__testVideoStarted || 0) + 1; } });
      Object.defineProperty(HTMLObjectElement.prototype, 'Open', { value() {} });
      Object.defineProperty(HTMLObjectElement.prototype, 'Close', { value() {} });
      Object.defineProperty(HTMLObjectElement.prototype, 'Execute', { value(command) { if (command === 'startplaylist') window.__testGapless = this; return 1; } });
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      /* A fake CMS for the template self-cache case below: the render URL and its
       * operator-uploaded asset are served with real bytes, everything else on
       * http is refused (offline realism for the other cases). */
      if (u.indexOf('smoke-cms.test/api/widgets/') !== -1) return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Access-Control-Allow-Origin': '*' }, body: TPL_HTML });
      if (u.indexOf('smoke-cms.test/uploads/content/') !== -1) return req.respond({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0x02, 0x03]) });
      return /^https?:/.test(u) ? req.abort() : req.continue();
    });
    await page.goto('file://' + path.resolve(__dirname, '../dist/index.html'), { waitUntil: 'load', timeout: 20000 });
    await page.evaluate(() => {
      window.handlePlaylistUpdate({ assignments: [{ content_id: 'test-video', filepath: 'test.mp4', mime_type: 'video/mp4', duration_sec: 10 }], layout: null });
    });
    await page.waitForFunction(() => window.__testVideoStarted > 0, { timeout: 5000 });
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('__mockfile:screentinker/boot-event.json');
      if (!raw) return false;
      const event = JSON.parse(raw);
      return !!(event && event.nv && event.written_at_utc_ms);
    }, { timeout: 3000 });
    const itemGateWinsOnline = await page.evaluate(() => {
      localStorage.setItem('st_active_schedule', JSON.stringify({ schedule: { start_time: '2020-01-01T00:00', end_time: '2020-01-01T00:01' }, table: { spans: [{ from_ms: 0, offset_min: 0 }] } }));
      const allowed = window.scheduleAllows({ content_id: 'test-video' });
      localStorage.removeItem('st_active_schedule');
      return allowed;
    });
    // Online playback follows the server payload. Persisted schedule state is
    // consulted only by the disconnected offline-plan tick.
    assert.equal(itemGateWinsOnline, true, 'online item gate decides playback; stale legacy schedule state only governs the offline tick');
    const result = await page.evaluate(() => ({ ready: window.__STNative.ready, videoUrl: window.__testVideoUrl, visibility: document.getElementById('NativePlayer').style.visibility }));
    assert.equal(result.ready, true);
    assert.match(result.videoUrl, /^file:\/\//);
    assert.equal(result.visibility, 'visible');
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [{ widget_id: 'cloud-doc-unqualified', widget_type: 'cloud-doc', widget_rev: 1, duration_sec: 10 }], layout: null }));
    await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('Unsupported on Samsung DB48E: cloud-doc widget') !== -1, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById('playerContainer').childElementCount), 0, 'an unqualified dynamic widget must not leave a blank iframe behind');
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [{ content_id: 'test-video', filepath: 'test.mp4', mime_type: 'video/mp4', duration_sec: 10 }], layout: null }));
    await page.waitForFunction(() => window.__testVideoStarted > 1, { timeout: 5000 });
    await page.evaluate(() => {
      window.__testDownloads = [];
      window.__startsBeforeConnectedPlan = window.__testVideoStarted || 0;
      const handlers = {};
      window.io = () => (window.__testSocket = {
        connected: true,
        onAny() {},
        on(name, handler) { handlers[name] = handler; },
        emit() {},
        disconnect() {},
        connect() {},
        io: { on() {}, reconnection() {} },
      });
      connect('http://example.test');
      const now = Date.now();
      localStorage.setItem('st_offline_plan', JSON.stringify({
        protocol_version: 1,
        generated_at_utc_ms: now - 1000,
        valid_until_utc_ms: now + 60000,
        intervals: [{ start_utc_ms: now - 1000, end_utc_ms: now + 60000, schedule_id: 'offline' }],
        states: [{ schedule_id: 'offline', payload: { assignments: [{ content_id: 'offline-only', filepath: 'offline.mp4', mime_type: 'video/mp4', duration_sec: 10 }], layout: null } }],
      }));
      nativeOfflinePlanTick();
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const connectedPlanAttempt = await page.evaluate(() => ({ starts: window.__testVideoStarted || 0, downloads: window.__testDownloads || [] }));
    assert.equal(connectedPlanAttempt.starts, await page.evaluate(() => window.__startsBeforeConnectedPlan), 'a connected player must not restart playback from its cached offline plan');
    assert.equal(connectedPlanAttempt.downloads.some(({ url }) => /offline\.mp4/.test(url)), false, 'a connected player must not download or apply its cached offline plan');
    const offlineTelemetry = await page.evaluate(() => {
      const reports = [];
      const originalReport = window.__STNative.report;
      window.__STNative.report = (kind, message) => reports.push({ kind, message });
      window.__testSocket.connected = false;
      nativeOfflinePlanTick();
      window.__testSocket.connected = true;
      window.__STNative.report = originalReport;
      return reports;
    });
    const selectedOfflineSchedule = offlineTelemetry.find(({ kind }) => kind === 'offline-schedule');
    assert.ok(selectedOfflineSchedule, 'a disconnected player must report the locally selected schedule');
    assert.deepEqual(JSON.parse(selectedOfflineSchedule.message), {
      event: 'offline_schedule_selected', schedule_id: 'offline', playlist_id: null,
      interval_start_utc_ms: JSON.parse(await page.evaluate(() => localStorage.getItem('st_offline_plan'))).intervals[0].start_utc_ms,
      interval_end_utc_ms: JSON.parse(await page.evaluate(() => localStorage.getItem('st_offline_plan'))).intervals[0].end_utc_ms,
      valid: true, state_ready: true
    });
    await page.evaluate(() => localStorage.removeItem('st_offline_plan'));
    const startsBeforeRestoringOnlineState = await page.evaluate(() => window.__testVideoStarted);
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [{ content_id: 'test-video', filepath: 'test.mp4', mime_type: 'video/mp4', duration_sec: 10 }], layout: null }));
    await page.waitForFunction(n => window.__testVideoStarted === n + 1, { timeout: 5000 }, startsBeforeRestoringOnlineState);
    await page.evaluate(() => document.getElementById('NativePlayer').OnRenderingComplete());
    await page.waitForFunction(n => window.__testVideoStarted >= n + 2, { timeout: 5000 }, startsBeforeRestoringOnlineState);
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [
      { content_id: 'test-video', filepath: 'test.mp4', mime_type: 'video/mp4', duration_sec: 60 },
      { content_id: 'second-video', filepath: 'second.mp4', mime_type: 'video/mp4', duration_sec: 60 }
    ], layout: { id: 'tpl-fullscreen', zones: [{ id: 'z-fs-1', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] } }));
    await page.waitForFunction(() => window.__STNative.missing({ assignments: [{ content_id: 'second-video', filepath: 'second.mp4', mime_type: 'video/mp4' }] }).length === 0, { timeout: 5000 });
    const beforeOverride = await page.evaluate(() => window.__testVideoStarted);
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [{ content_id: 'override-video', filepath: 'override.mp4', mime_type: 'video/mp4', duration_sec: 10 }], layout: null }));
    await page.waitForFunction(n => window.__testVideoStarted > n, { timeout: 5000 }, beforeOverride);
    assert.match(await page.evaluate(() => window.__testVideoUrl), /\.mp4$/);
    await page.evaluate(() => window.saveConfig({ serverUrl: 'http://example.test', deviceId: 'test-id', deviceToken: 'test-token', paired: true }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__testVideoStarted > 0, { timeout: 5000 });
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('__mockfile:screentinker/boot-event.json');
      if (!raw) return false;
      const event = JSON.parse(raw);
      return !!(event && event.nv && event.flushed && event.written_at_utc_ms && event.cold_start);
    }, { timeout: 3000 });
    const restored = await page.evaluate(() => ({ url: window.__testVideoUrl, config: JSON.parse(localStorage.getItem('rd_web_player')) }));
    assert.match(restored.url, /^file:\/\//);
    assert.equal(restored.config.deviceId, 'test-id');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('setupScreen')).display), 'none', 'cached offline playback must not wait at setup');
    assert.equal(await page.evaluate(() => document.body.textContent.includes('Tap anywhere to start')), false, 'cached playback must not wait for a tap');
    await page.evaluate(() => { localStorage.setItem('st_active_schedule', JSON.stringify({ schedule: { start_time: '2020-01-01T00:00', end_time: '2020-01-01T00:01' }, table: { spans: [{ from_ms: 0, offset_min: 0 }] } })); window.__STNative.persistStorage(); });
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('setupScreen')).display), 'none', 'an expired offline schedule must not return to setup');
    assert.equal(await page.evaluate(() => window.__testVideoStarted || 0), 0, 'expired offline content must not start');
    await page.evaluate(() => { localStorage.setItem('st_active_schedule', 'null'); window.__STNative.persistStorage(); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__testVideoStarted > 0, { timeout: 5000 });
    const nativeStartsBeforeZones = await page.evaluate(() => window.__testVideoStarted);
    await page.evaluate(() => window.handlePlaylistUpdate({
      assignments: [{ content_id: 'zone-video', filepath: 'zone.mp4', mime_type: 'video/mp4', duration_sec: 10, zone_id: 'right' }],
      layout: { id: 'split', zones: [ { id: 'left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 }, { id: 'right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 } ] }
    }));
    await page.waitForFunction(() => document.querySelector('#playerContainer .zone video'), { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__testVideoStarted), nativeStartsBeforeZones, 'zoned video must not start the always-on-top native plane');
    assert.equal(await page.evaluate(() => document.getElementById('NativePlayer').style.visibility), 'hidden');
    const legacyFit = await page.evaluate(() => {
      const video = document.querySelector('#playerContainer .zone video');
      Object.defineProperty(video, 'videoWidth', { value: 576, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 704, configurable: true });
      Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
      const beforeWidth = video.width, beforeHeight = video.height;
      window.stLegacyVideoFit(video, 'fill');
      video.dispatchEvent(new Event('loadedmetadata'));
      return {
        canvas: !!document.querySelector('.st-legacy-video-canvas'),
        width: video.width,
        height: video.height,
        beforeWidth,
        beforeHeight,
        styleWidth: video.style.width,
        styleHeight: video.style.height,
        videoVisibility: video.style.visibility,
        overflow: video.parentNode && video.parentNode.style.overflow,
        wrap: video.parentNode && video.parentNode.className,
        transform: video.style.transform || video.style.webkitTransform,
        nativeVisible: document.getElementById('NativePlayer').style.visibility,
      };
    });
    assert.equal(legacyFit.canvas, false, 'fill must not hide the plugin behind a canvas compositor');
    assert.equal(legacyFit.width, legacyFit.beforeWidth, 'do not retry HTMLVideoElement width/height property fill');
    assert.equal(legacyFit.height, legacyFit.beforeHeight, 'do not retry HTMLVideoElement width/height property fill');
    assert.notEqual(legacyFit.width, 960, 'client scale cannot stretch Orsay HTML video');
    assert.notEqual(legacyFit.videoVisibility, 'hidden', 'do not use visibility:hidden; that hid 1259 frames');
    assert.equal(legacyFit.overflow, 'hidden', 'the zone must clip the intrinsic-size plugin');
    assert.notEqual(legacyFit.wrap, 'st-legacy-video-fit', 'the failed wrapper transform must not be reused');
    assert.equal(legacyFit.transform, '', 'do not retry CSS transform fill');
    assert.equal(legacyFit.nativeVisible, 'hidden', 'zoned fill must keep the native LFD plane hidden');
    const beforeRevision = await page.evaluate(() => document.querySelector('#playerContainer .zone video').src);
    await page.evaluate(() => window.handlePlaylistUpdate({
      assignments: [{ content_id: 'zone-video', content_rev: 2, filepath: 'zone.mp4', mime_type: 'video/mp4', duration_sec: 10, zone_id: 'right' }],
      layout: { id: 'split', zones: [ { id: 'left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 }, { id: 'right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 } ] }
    }));
    await page.waitForFunction(old => { const v = document.querySelector('#playerContainer .zone video'); return v && v.src !== old; }, { timeout: 5000 }, beforeRevision);
    assert.equal(await page.evaluate(() => window.__testVideoStarted), nativeStartsBeforeZones);
    const splitLayout = { id: 'split-images', zones: [
      { id: 'left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
      { id: 'right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 }
    ] };
    const anchor = { content_id: 'anchor', filepath: 'anchor.png', mime_type: 'image/png', zone_id: 'left' };
    const previous = { content_id: 'old-image', filepath: 'old.png', mime_type: 'image/png', zone_id: 'right' };
    const replacement = { content_id: 'new-image', filepath: 'new.png', mime_type: 'image/png', zone_id: 'right' };
    await page.evaluate(({ anchor, previous, splitLayout }) => window.handlePlaylistUpdate({ assignments: [anchor, previous], layout: splitLayout }), { anchor, previous, splitLayout });
    await page.waitForFunction(() => document.querySelectorAll('#playerContainer .zone img').length === 2, { timeout: 5000 });
    const oldZoneUrl = await page.evaluate(() => document.querySelectorAll('#playerContainer .zone img')[1].src);
    await page.evaluate(({ anchor, replacement, splitLayout }) => window.handlePlaylistUpdate({ assignments: [anchor, replacement], layout: splitLayout }), { anchor, replacement, splitLayout });
    await page.waitForFunction(oldUrl => { const images = document.querySelectorAll('#playerContainer .zone img'); return images.length === 2 && images[1].src !== oldUrl; }, { timeout: 5000 }, oldZoneUrl);
    await page.evaluate(() => { window.__zoneBefore = document.querySelector('#playerContainer .zone'); });
    await page.evaluate(({ anchor, replacement, splitLayout }) => window.handlePlaylistUpdate({ assignments: [anchor, replacement], layout: splitLayout }), { anchor, replacement, splitLayout });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.evaluate(() => window.__zoneBefore === document.querySelector('#playerContainer .zone')), true, 'identical playlist must not restart zones');
    await page.evaluate(({ anchor, replacement, splitLayout }) => window.handlePlaylistUpdate({ assignments: [anchor, { ...replacement, duration_sec: 37 }], layout: splitLayout }), { anchor, replacement, splitLayout });
    await page.waitForFunction(() => window.__zoneBefore !== document.querySelector('#playerContainer .zone'), { timeout: 5000 });
    await page.evaluate(({ anchor, splitLayout }) => { window.__STNative.ready = false; window.handlePlaylistUpdate({ assignments: [anchor, { widget_id: 'text-widget', widget_type: 'text', widget_rev: 1, zone_id: 'right' }], layout: splitLayout }); }, { anchor, splitLayout });
    await page.waitForFunction(() => { const frame = document.querySelector('#playerContainer .zone iframe'); return frame && /^http:/.test(frame.src); }, { timeout: 5000 });
    await page.evaluate(({ anchor, splitLayout }) => { window.__STNative.ready = true; window.handlePlaylistUpdate({ assignments: [anchor, { widget_id: 'text-widget', widget_type: 'text', widget_rev: 1, zone_id: 'right' }], layout: splitLayout }); }, { anchor, splitLayout });
    await page.waitForFunction(() => { const frame = document.querySelector('#playerContainer .zone iframe'); return frame && /^file:\/\/\/mtd_down\/common\/screentinker_media\//.test(frame.src); }, { timeout: 5000 });
    await page.evaluate(() => window.stSetWidgetOffline(true));
    await page.waitForFunction(() => { const frame = document.querySelector('#playerContainer .zone iframe'); return frame && /^file:\/\/\/mtd_down\/common\/screentinker_media\//.test(frame.src); }, { timeout: 5000 });
    await page.evaluate(() => window.stSetWidgetOffline(false));
    await page.waitForFunction(() => { const frame = document.querySelector('#playerContainer .zone iframe'); return frame && /^file:\/\/\/mtd_down\/common\/screentinker_media\//.test(frame.src); }, { timeout: 5000 });
    await page.evaluate(() => window.handlePlaylistUpdate({
      assignments: [
        { content_id: 'pip-video', filepath: 'pip.mp4', mime_type: 'video/mp4', duration_sec: 10, zone_id: 'background', fit_mode: 'fill', fill_fit: 'fill', fill_width: 1920, fill_height: 1080, sssp3_rendition_state: 'ready', sssp3_rendition_url: '/api/content/pip-video/sssp3-fit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?rev=1' },
        { widget_id: 'pip-text', widget_type: 'text', widget_rev: 1, duration_sec: 10, zone_id: 'overlay' }
      ],
      layout: { id: 'tpl-pip', zones: [
        { id: 'background', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, z_index: 0 },
        { id: 'overlay', x_percent: 65, y_percent: 5, width_percent: 30, height_percent: 30, z_index: 1 }
      ] }
    }));
    await page.waitForFunction(() => document.querySelector('#playerContainer .zone video') && document.querySelector('#playerContainer .zone iframe'), { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById('NativePlayer').style.visibility), 'hidden', 'full-bleed PiP must keep the always-on-top native plane hidden');
    assert.equal(await page.evaluate(() => window.__testVideoStarted), nativeStartsBeforeZones, 'full-bleed PiP must not start the native plane');
    const pipFit = await page.evaluate(() => {
      const video = document.querySelector('#playerContainer .zone video');
      Object.defineProperty(video, 'videoWidth', { value: 576, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 704, configurable: true });
      Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
      const beforeWidth = video.width;
      window.stLegacyVideoFit(video, 'fill');
      video.dispatchEvent(new Event('loadedmetadata'));
      return {
        width: video.width,
        beforeWidth,
        canvas: !!document.querySelector('.st-legacy-video-canvas'),
        overflow: video.parentNode && video.parentNode.style.overflow,
        transform: video.style.transform || video.style.webkitTransform,
        nativeVisible: document.getElementById('NativePlayer').style.visibility,
        visibility: video.style.visibility,
        downloads: (window.__testDownloads || []).map(d => d.url),
      };
    });
    assert.ok(pipFit.downloads.some(url => /\/api\/content\/pip-video\/sssp3-fit\/a{32}\?rev=1/.test(url)), 'PiP fill must request only its server-approved opaque rendition');
    await page.evaluate(() => { window.__testDownloads = []; });
    await page.evaluate(() => window.handlePlaylistUpdate({
      assignments: [
        { content_id: 'pip-video', filepath: 'pip.mp4', mime_type: 'video/mp4', duration_sec: 10, zone_id: 'background', fit_mode: 'contain', fill_fit: 'contain', fill_width: 1920, fill_height: 1080, sssp3_rendition_state: 'ready', sssp3_rendition_url: '/api/content/pip-video/sssp3-fit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?rev=1' },
        { widget_id: 'pip-text', widget_type: 'text', widget_rev: 1, duration_sec: 10, zone_id: 'overlay' }
      ],
      layout: { id: 'tpl-pip', zones: [
        { id: 'background', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, z_index: 0 },
        { id: 'overlay', x_percent: 65, y_percent: 5, width_percent: 30, height_percent: 30, z_index: 1 }
      ] }
    }));
    await page.waitForFunction(() => (window.__testDownloads || []).some(d => /\/api\/content\/pip-video\/sssp3-fit\/b{32}\?rev=1/.test(d.url)), { timeout: 5000 });
    await page.evaluate(() => { window.__testDownloads = []; });
    await page.evaluate(() => window.handlePlaylistUpdate({
      assignments: [
        { content_id: 'pip-video', filepath: 'pip.mp4', mime_type: 'video/mp4', duration_sec: 10, zone_id: 'background', fit_mode: 'cover', fill_fit: 'cover', fill_width: 1920, fill_height: 1080, sssp3_rendition_state: 'ready', sssp3_rendition_url: '/api/content/pip-video/sssp3-fit/cccccccccccccccccccccccccccccccc?rev=1' },
        { widget_id: 'pip-text', widget_type: 'text', widget_rev: 1, duration_sec: 10, zone_id: 'overlay' }
      ],
      layout: { id: 'tpl-pip', zones: [
        { id: 'background', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, z_index: 0 },
        { id: 'overlay', x_percent: 65, y_percent: 5, width_percent: 30, height_percent: 30, z_index: 1 }
      ] }
    }));
    await page.waitForFunction(() => (window.__testDownloads || []).some(d => /\/api\/content\/pip-video\/sssp3-fit\/c{32}\?rev=1/.test(d.url)), { timeout: 5000 });
    await page.evaluate(() => { window.__testDownloads = []; });
    await page.evaluate(() => window.handlePlaylistUpdate({
      assignments: [
        { content_id: 'pip-image', filepath: 'probe.jpg', mime_type: 'image/jpeg', duration_sec: 10, zone_id: 'background', fit_mode: 'contain', fill_fit: 'contain', fill_width: 1920, fill_height: 1080, sssp3_rendition_state: 'ready', sssp3_rendition_url: '/api/content/pip-image/sssp3-fit/dddddddddddddddddddddddddddddddd?rev=1' },
        { widget_id: 'pip-text', widget_type: 'text', widget_rev: 1, duration_sec: 10, zone_id: 'overlay' }
      ],
      layout: { id: 'tpl-pip', zones: [
        { id: 'background', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, z_index: 0 },
        { id: 'overlay', x_percent: 65, y_percent: 5, width_percent: 30, height_percent: 30, z_index: 1 }
      ] }
    }));
    await page.waitForFunction(() => (window.__testDownloads || []).some(d => /\/api\/content\/pip-image\/sssp3-fit\/d{32}\?rev=1/.test(d.url)), { timeout: 5000 });
    assert.equal(pipFit.width, pipFit.beforeWidth, 'PiP fill must not retry HTMLVideoElement width/height properties');
    assert.notEqual(pipFit.width, 1920, 'client scale cannot stretch Orsay HTML video');
    assert.equal(pipFit.canvas, false, 'PiP fill must not canvas-hide the plugin');
    assert.equal(pipFit.overflow, 'hidden');
    assert.equal(pipFit.nativeVisible, 'hidden');
    assert.notEqual(pipFit.visibility, 'hidden');
    assert.equal(pipFit.transform, '', 'PiP fill must not retry CSS transform');
    await page.evaluate(() => { localStorage.setItem('st_native_gapless', '1'); });
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [
      { content_id: 'gapless-a', filepath: 'a.mp4', mime_type: 'video/mp4', duration_sec: 8, content_duration: 8, native_gapless_signature: 'h264|baseline|1280x720|25' },
      { content_id: 'gapless-b', filepath: 'b.mp4', mime_type: 'video/mp4', duration_sec: 12, content_duration: 12, native_gapless_signature: 'h264|baseline|1280x720|25' }
    ], layout: { id: 'tpl-fullscreen', zones: [{ id: 'z-fs-1', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] } }));
    await page.waitForFunction(() => window.__STNative.gaplessActive(), { timeout: 5000 });
    await page.evaluate(() => { window.__testGapless.OnRenderingStart(); window.__testGapless.OnEvent(0, '', 'Stop'); });
    assert.equal(await page.evaluate(() => window.__STNative.gaplessActive()), true, 'item completion must leave the gapless playlist running');
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [{ content_id: 'replacement', filepath: 'replacement.mp4', mime_type: 'video/mp4', duration_sec: 10 }], layout: null }));
    await page.waitForFunction(() => !window.__STNative.gaplessActive() && window.__testVideoUrl.indexOf('file:') === 0, { timeout: 5000 });
    /* ---- template-widget self-cache (offline story) ----
     * Drives the real accept() pipeline against the stand-in CMS above and asserts
     * the cache contract: only after the verified write does the cache index flip,
     * the written file is a single self-contained HTML (data URIs, Arabic intact,
     * no absolute /uploads refs left), and widgetUrl prefers the cached copy. */
    await page.evaluate(() => { window.__STNative.base = 'http://smoke-cms.test'; });
    const tplItem = { widget_id: 'tpl-smoke', widget_type: 'template', widget_rev: 1 };
    await page.evaluate((item) => {
      window.__testReports = [];
      const original = window.__STNative.report;
      window.__STNative.report = (kind, message) => window.__testReports.push(kind + ': ' + message);
      window.__restoreReport = () => { window.__STNative.report = original; };
      window.handlePlaylistUpdate({ assignments: [item], layout: null });
    }, tplItem);
    await page.waitForFunction((item) => window.__STNative.missing({ assignments: [item] }).length === 0, { timeout: 8000 }, tplItem);
    const cachedHtml = await page.evaluate(() => {
      const files = Object.keys(localStorage).filter(k => /\.html$/.test(k));


      /* earlier phases of this smoke also cache a text widget — filter to self-cache
       * products by their content (self-contained html: inlined data URI + template text) */
      const mine = files.filter(k => { const v = localStorage.getItem(k) || ''; return v.indexOf('data:image/png;base64,') !== -1 || v.indexOf('عيادة إكرام') !== -1; });
      const samples = files.map(k => { const v = localStorage.getItem(k) || ''; return { file: k.slice(-30), len: v.length, arabic: v.indexOf('عيادة إكرام') !== -1, png: v.indexOf('data:image/png;base64,') !== -1 }; });
      let raw = '';
      for (const k of mine) raw += localStorage.getItem(k) || '';
      return {
        count: mine.length,
        samples: samples,
        arabic: raw.indexOf('عيادة إكرام') !== -1,
        inlined: raw.indexOf('data:image/png;base64,iVBORw0KGgoA') !== -1,
        absoluteRefs: raw.indexOf('/uploads/content/') !== -1,
        widgetUrl: window.__STNative.widgetUrl({ widget_id: 'tpl-smoke', widget_type: 'template', widget_rev: 1 }, 'LIVE'),
        reports: window.__testReports.join(' | ')
      };
    });
    assert.equal(cachedHtml.count, 1, 'the template widget must persist exactly one self-contained cached html — saw ' + JSON.stringify(cachedHtml.samples));
    assert.equal(cachedHtml.arabic, true, 'the cached template html must keep Arabic intact (no decode mangling)');
    assert.equal(cachedHtml.inlined, true, 'the operator image must be inlined as a data URI');
    assert.equal(cachedHtml.absoluteRefs, false, 'no absolute /uploads refs may remain in the cached file');
    assert.equal(String(cachedHtml.widgetUrl).indexOf('file://'), 0, 'widgetUrl must prefer the cached file over the live render');
    assert.ok(cachedHtml.reports.indexOf('Template widget queued for offline caching') !== -1, 'the cache start must be reported for fleet observability');
    assert.ok(cachedHtml.reports.indexOf('Template widget cached (') !== -1, 'the cache completion must be reported for fleet observability');
    await page.evaluate(() => window.__restoreReport());
    await page.evaluate(() => window.handlePlaylistUpdate({ assignments: [], layout: null }));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('rd_playlist_cache'))), [], 'empty updates must clear the saved playlist');
    await page.reload({ waitUntil: 'load' });
    try { await page.waitForFunction(() => document.getElementById('statusText') && document.getElementById('statusText').textContent.indexOf('No cached content') !== -1, { timeout: 5000 }); }
    catch (e) { console.error(await page.evaluate(() => ({ config: localStorage.getItem('rd_web_player'), playlist: localStorage.getItem('rd_playlist_cache'), setup: document.getElementById('setupScreen').style.display, status: document.getElementById('statusOverlay').textContent, display: document.getElementById('statusOverlay').style.display, ready: window.__STNative && window.__STNative.ready, errors: window.__STNative && window.__STNative.error })), errors); throw e; }
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('setupScreen')).display), 'none', 'a paired offline player must not show the connect screen');
    assert.equal(await page.evaluate(() => document.getElementById('statusOverlay').style.display), 'block', 'waiting state must not depend on flex support');
    assert.deepEqual(errors, []);
    console.log('Renderer replayed native fullscreen video, restored it offline, kept split-zone and PiP video in HTML, hid the native plane, and requested intrinsic-size contain/cover/fill renditions instead of client scale.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
