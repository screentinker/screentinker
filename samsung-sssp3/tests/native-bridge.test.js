'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../app/native-bridge.js'), 'utf8');
function environment() {
  const files = {}, downloads = [], scheduled = [], opened = [], plugins = [];
  function FileSystem() {}
  FileSystem.prototype.createCommonDir = function () {};
  FileSystem.prototype.openCommonFile = function (name, mode) { opened.push(name); if (name.indexOf('screentinker_media/') === 0) name = '/mtd_down/common/' + name; if (mode !== 'w' && !Object.prototype.hasOwnProperty.call(files, name)) throw Error('missing'); return { name, readAll() { return files[name]; }, writeAll(value) { files[name] = value; } }; };
  FileSystem.prototype.closeCommonFile = function () {};
  const downloader = { cancels: 0, StartDownFile: (url, destination) => downloads.push({ url, destination }), CancelDownload() { this.cancels++; } };
  const player = { style: {}, stops: 0, Stop() { this.stops++; }, InitPlayer(url) { this.url = url; }, SetDisplayArea() {}, SetInitialBuffer() {}, StartPlayback() { this.started = true; } };
  const container = { appendChild(el) { el.parentNode = container; }, removeChild(el) { el.parentNode = null; } };
  const storage = {};
  const window = { __STNative: { base: 'http://example.test' }, STOfflinePlan: { dependencies(plan) { const out = []; for (const s of (plan && plan.states) || []) { const payload = s && s.payload || {}; for (const item of (payload.assignments || [])) out.push(item); if (payload.default_content) out.push(payload.default_content); } return out; } }, localStorage: { getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; }, setItem(key, value) { storage[key] = String(value); } } };
  const body = { appendChild(p) { p.parentNode = body; }, removeChild(p) { p.parentNode = null; } };
  const ctx = { window, FileSystem, document: { getElementById: (id) => id === 'NativePlayer' ? player : id === 'NativeDownloader' ? downloader : id === 'playerContainer' ? container : null, createElement: tag => { if (tag !== 'object') return { style: {} }; const p = { style: {}, calls: [], setAttribute() {}, Open() {}, Close() {}, Execute(...args) { this.calls.push(args); return 1; } }; plugins.push(p); return p; }, body }, setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, clearTimeout: () => {} };
  vm.runInNewContext(code, ctx); window.__STNative.init();
  return { b: window.__STNative, done: window.STNativeDownloadComplete, files, downloads, scheduled, player, opened, plugins, downloader, storage };
}
const image = { content_id: 'one', filepath: 'a.png', mime_type: 'image/png', content_rev: 1 };
test('only activates the playlist after the complete local file is present', () => {
  const e = environment(), activated = [], payload = { assignments: [image, image] };
  e.b.accept(payload, p => activated.push(p));
  assert.equal(e.downloads.length, 1); assert.equal(activated.length, 0);
  e.files[e.downloads[0].destination] = true; e.done('1000?1');
  assert.deepEqual(activated, [payload]); assert.match(e.b.mediaUrl(image, 'remote'), /^file:\/\//);
});
test('accepts the DB48E completed-download callback variant after verifying the file', () => {
  const e = environment(), activated = [], payload = { assignments: [image] };
  e.b.accept(payload, p => activated.push(p));
  e.files[e.downloads[0].destination] = true;
  e.done('1000?9');
  assert.deepEqual(activated, [payload]);
});
test('failure never replaces the last good playlist', () => {
  const e = environment(), activated = [];
  e.b.accept({ assignments: [image] }, p => activated.push(p));
  for (let i = 0; i < 4; i++) { e.done('500'); const retry = e.scheduled.find(x => x.ms === (i + 1) * 2000); if (retry) retry.fn(); }
  assert.equal(activated.length, 0); assert.ok(e.b.error);
});
test('changed revisions use different cache paths', () => {
  const e = environment();
  assert.notEqual(e.b._test.path(image), e.b._test.path({ ...image, content_rev: 2 }));
});
function pipLayout() {
  return {
    id: 'tpl-pip',
    zones: [
      { id: 'z-pip-1', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 },
      { id: 'z-pip-2', x_percent: 65, y_percent: 5, width_percent: 30, height_percent: 30 }
    ]
  };
}
function assertFitDownload(e, item, fit, name) {
  assert.equal(item.fill_fit, fit);
  assert.equal(item.fill_width, 1920);
  assert.equal(item.fill_height, 1080);
  assert.match(e.downloads[0].url, /\/api\/content\/[^/]+\/sssp3-fit\/[a-f0-9]{32}/, 'only the approved opaque rendition URL is downloaded');
}
function approved(item, fit, width, height) {
  item.fill_fit = fit; item.fill_width = width || 1920; item.fill_height = height || 1080;
  item.sssp3_rendition_state = 'ready';
  item.sssp3_rendition_url = '/api/content/' + item.content_id + '/sssp3-fit/' + 'a'.repeat(32) + '?rev=1';
  return item;
}
test('zoned fill video downloads an intrinsic-size rendition of the same asset', () => {
  const e = environment();
  const video = approved({ content_id: 'motion', filepath: 'sssp-motion-test.mp4', mime_type: 'video/mp4', content_rev: 3, zone_id: 'z-pip-1', fit_mode: 'fill' }, 'fill');
  e.b.accept({ assignments: [video], layout: pipLayout() }, () => {});
  assertFitDownload(e, video, 'fill', 'sssp-motion-test');
  const original = { content_id: 'motion', filepath: 'sssp-motion-test.mp4', mime_type: 'video/mp4', content_rev: 3 };
  assert.notEqual(e.b._test.path(video), e.b._test.path(original));
  assert.equal(e.b._test.source(original).includes('fill-1920x1080'), false);
});
test('zoned contain video downloads a letterboxed zone-sized rendition', () => {
  const e = environment();
  const video = approved({ content_id: 'motion', filepath: 'sssp-motion-test.mp4', mime_type: 'video/mp4', content_rev: 3, zone_id: 'z-pip-1', fit_mode: 'contain' }, 'contain');
  e.b.accept({ assignments: [video], layout: pipLayout() }, () => {});
  assertFitDownload(e, video, 'contain', 'sssp-motion-test');
});
test('zoned cover video downloads a cropped zone-sized rendition', () => {
  const e = environment();
  const video = approved({ content_id: 'motion', filepath: 'sssp-motion-test.mp4', mime_type: 'video/mp4', content_rev: 3, zone_id: 'z-pip-1', fit_mode: 'cover' }, 'cover');
  e.b.accept({ assignments: [video], layout: pipLayout() }, () => {});
  assertFitDownload(e, video, 'cover', 'sssp-motion-test');
});
test('fitted SVG assets use a PNG cache extension', () => { const e = environment(); const item = { content_id: 'svg', filepath: 'zone.svg', mime_type: 'image/svg+xml', fill_fit: 'fill', fill_width: 960, fill_height: 540 }; assert.match(e.b._test.path(item), /\.png$/); });

test('zoned image contain/cover/fill download intrinsic-size renditions', () => {
  for (const fit of ['contain', 'cover', 'fill']) {
    const e = environment();
    const imageItem = approved({ content_id: 'probe', filepath: 'sssp-fit-probe.jpg', mime_type: 'image/jpeg', content_rev: 1, zone_id: 'z-pip-1', fit_mode: fit }, fit);
    e.b.accept({ assignments: [imageItem], layout: pipLayout() }, () => {});
    assertFitDownload(e, imageItem, fit, 'sssp-fit-probe');
  }
});
test('fullscreen image still requests a 1920x1080 fitted rendition', () => {
  const e = environment();
  const imageItem = approved({ content_id: 'probe', filepath: 'sssp-fit-probe.jpg', mime_type: 'image/jpeg', content_rev: 1, fit_mode: 'cover' }, 'cover');
  e.b.accept({ assignments: [imageItem], layout: { id: 'tpl-fullscreen', zones: [{ id: 'z-fs-1', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] } }, () => {});
  assert.equal(imageItem.fill_fit, 'cover');
  assert.equal(imageItem.fill_width, 1920);
  assert.match(e.downloads[0].url, /\/api\/content\/probe\/sssp3-fit\/[a-f0-9]{32}/);
});
test('source-only supported image formats never request nonexistent fitted renditions', () => {
  for (const [extension, mime] of [['gif', 'image/gif'], ['bmp', 'image/bmp']]) {
    const e = environment();
    const imageItem = { content_id: extension, filepath: 'asset.' + extension, mime_type: mime, content_rev: 1, fit_mode: 'fill' };
    e.b.accept({ assignments: [imageItem], layout: { id: 'tpl-fullscreen', zones: [{ id: 'z-fs-1', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] } }, () => {});
    assert.equal(imageItem.fill_width, undefined);
    assert.match(e.downloads[0].url, new RegExp('asset\\.' + extension + '\\?rev=1$'));
    assert.equal(e.downloads[0].url.includes('fit='), false);
  }
});
test('unsupported image decoders are not downloaded into a black playback path', () => {
  for (const [extension, mime] of [['avif', 'image/avif'], ['heic', 'image/heic']]) {
    const e = environment();
    const item = { content_id: extension, filepath: 'asset.' + extension, mime_type: mime, content_rev: 1 };
    e.b.accept({ assignments: [item] }, () => {});
    assert.equal(e.downloads.length, 0);
    assert.equal(e.b.supports(item), false);
  }
});
test('two server-approved renditions of the same asset use different cache paths', () => {
  const e = environment();
  const fill = { content_id: 'motion', filepath: 'sssp-motion-test.mp4', mime_type: 'video/mp4', content_rev: 3, zone_id: 'z-pip-1', fit_mode: 'fill' };
  const contain = { ...fill, fit_mode: 'contain' };
  approved(fill, 'fill', 960, 540);
  approved(contain, 'contain', 960, 540);
  fill.sssp3_rendition_url = '/api/content/motion/sssp3-fit/' + 'a'.repeat(32);
  contain.sssp3_rendition_url = '/api/content/motion/sssp3-fit/' + 'b'.repeat(32);
  assert.notEqual(e.b._test.path(fill), e.b._test.path(contain));
});
test('fullscreen native video keeps the original encoded file', () => {
  const e = environment();
  const video = { content_id: 'motion', filepath: 'sssp-motion-test.mp4', mime_type: 'video/mp4', content_rev: 3 };
  e.b.accept({ assignments: [video], layout: { id: 'tpl-fullscreen', zones: [{ id: 'z-fs-1', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] } }, () => {});
  assert.equal(video.fill_width, undefined);
  assert.match(e.downloads[0].url, /sssp-motion-test\.mp4\?rev=3$/);
  assert.equal(e.downloads[0].url.includes('fill-1920x1080'), false);
});
test('a future scheduled playlist is fully prepared before its plan is committed', () => {
  const e = environment(), activated = [];
  const future = { content_id: 'future', filepath: 'future.mp4', mime_type: 'video/mp4', content_rev: 1 };
  const payload = { assignments: [image], offline_plan: { states: [{ payload: { assignments: [future] } }] } };
  e.b.accept(payload, p => activated.push(p));
  assert.equal(e.downloads.length, 1);
  e.files[e.downloads[0].destination] = true; e.done('1000?1');
  assert.equal(e.downloads.length, 2, 'the current state must wait for the future schedule asset');
  e.files[e.downloads[1].destination] = true; e.done('1000?1');
  assert.deepEqual(activated, [payload]);
  assert.match(e.b.mediaUrl(future, 'remote'), /^file:\/\//);
});
test('current and future standby images are prepared with their offline states', () => {
  const e = environment(), applied = [];
  const current = { content_id: 'now', filepath: 'now.jpg', mime_type: 'image/jpeg', content_rev: 1 };
  const standby = { content_id: 'standby', filepath: 'standby.jpg', mime_type: 'image/jpeg', content_rev: 2 };
  const future = { content_id: 'future', filepath: 'future.jpg', mime_type: 'image/jpeg', content_rev: 3 };
  const futureStandby = { content_id: 'future-standby', filepath: 'future-standby.jpg', mime_type: 'image/jpeg', content_rev: 4 };
  const payload = { assignments: [current], default_content: standby, offline_plan: {
    states: [{ payload: { assignments: [future], default_content: futureStandby } }]
  } };
  e.b.accept(payload, p => applied.push(p));
  assert.equal(e.downloads.length, 1);
  for (let i = 0; i < 4; i++) {
    e.files[e.downloads[i].destination] = true;
    e.done('1000?1');
  }
  assert.deepEqual(applied, [payload]);
  assert.match(e.b.mediaUrl(standby, 'remote'), /^file:\/\//);
  assert.match(e.b.mediaUrl(futureStandby, 'remote'), /^file:\/\//);
});

test('a new default is journaled with its cache even while an assigned playlist remains active', () => {
  const e = environment(), applied = [];
  const assigned = { content_id: 'assigned', filepath: 'assigned.jpg', mime_type: 'image/jpeg', content_rev: 1 };
  const firstDefault = { content_id: 'default-a', filepath: 'default-a.jpg', mime_type: 'image/jpeg', content_rev: 1 };
  const nextDefault = { content_id: 'default-b', filepath: 'default-b.jpg', mime_type: 'image/jpeg', content_rev: 2 };
  e.b.accept({ assignments: [assigned], default_content: firstDefault }, p => applied.push(p));
  for (let i = 0; i < 2; i++) { e.files[e.downloads[i].destination] = true; e.done('1000?1'); }
  e.b.accept({ assignments: [assigned], default_content: nextDefault }, p => applied.push(p));
  assert.equal(e.downloads.length, 3, 'a default revision changes its cache key even when assignments do not');
  e.files[e.downloads[2].destination] = true; e.done('1000?1');
  assert.deepEqual(applied.map(p => p.assignments), [[assigned], [assigned]], 'default caching must not replace the assigned playlist');
  assert.deepEqual(JSON.parse(e.storage.st_default_content), nextDefault);
  const restored = e.b.readState();
  assert.deepEqual(JSON.parse(restored.st_default_content), nextDefault, 'the cache index and standby choice commit in one journal generation');
  assert.match(e.b.mediaUrl(nextDefault, 'remote'), /^file:\/\//);
});

test('an interval state does not erase the parent offline plan after activation', () => {
  const e = environment(), plan = { protocol_version: 1, states: [] }, future = { content_id: 'future', filepath: 'future.jpg', mime_type: 'image/jpeg', content_rev: 1 };
  e.storage.st_offline_plan = JSON.stringify(plan);
  e.b.accept({ assignments: [future] }, () => {});
  e.files[e.downloads[0].destination] = true; e.done('1000?1');
  assert.equal(e.storage.st_offline_plan, JSON.stringify(plan));
});
test('offline-safe widget HTML is cached by revision', () => {
  const e = environment(), widget = { widget_id: 'clock', widget_type: 'clock', widget_rev: 4 }, applied = [];
  e.b.accept({ assignments: [widget] }, p => applied.push(p));
  assert.match(e.downloads[0].url, /\/api\/widgets\/clock\/render\?/);
  assert.match(e.downloads[0].destination, /\.html$/);
  e.files[e.downloads[0].destination] = true; e.done('1000?1');
  assert.equal(applied.length, 1);
  assert.match(e.b.widgetUrl(widget, 'remote'), /^file:\/\//);
  assert.equal(e.b.widgetUrl({ ...widget, widget_rev: 5 }, 'remote'), 'remote');
  for (const widget_type of ['text', 'weather', 'rss', 'social', 'directory-board', 'directory-search', 'menu-board', 'room-display']) {
    assert.equal(e.b.supports({ widget_id: widget_type, widget_type, widget_rev: 1 }), true, widget_type);
  }
  assert.equal(e.b.supports({ widget_id: 'radar', widget_type: 'radar', widget_rev: 1 }), false);
  for (const widget_type of ['radar', 'webpage', 'diag-smoothness']) {
    assert.equal(e.b.canRender({ widget_id: widget_type, widget_type }), true, widget_type + ' remains online-renderable');
  }
  for (const widget_type of ['cloud-doc', 'bi-dashboard']) {
    assert.equal(e.b.canRender({ widget_id: widget_type, widget_type }), false, widget_type + ' must fail visibly until qualified');
  }
});
test('a cached replacement playlist applies while an obsolete download is stalled', () => {
  const e = environment(), activated = [], cached = { assignments: [image] };
  e.b.accept(cached, p => activated.push(p)); e.files[e.downloads[0].destination] = true; e.done('1000?1');
  const old = { content_id: 'old', filepath: 'old.mp4', mime_type: 'video/mp4' };
  e.b.accept({ assignments: [old] }, p => activated.push(p));
  e.b.accept(cached, p => activated.push(p));
  assert.equal(activated.length, 2);
  assert.equal(activated[1], cached);
  e.scheduled.filter(x => x.ms === 120000).at(-1).fn();
  assert.equal(e.downloader.cancels, 1);
});
test('cancels an obsolete download before starting a new playlist download', () => {
  const e = environment(), applied = [], replacement = { content_id: 'new', filepath: 'new.png', mime_type: 'image/png' };
  e.b.accept({ assignments: [image] }, p => applied.push(p));
  const latest = { assignments: [replacement] };
  e.b.accept(latest, p => applied.push(p));
  assert.equal(e.downloader.cancels, 1);
  assert.equal(e.downloads.length, 1, 'wait for the cancellation callback before reusing the downloader');
  e.done('1000?0');
  assert.equal(e.downloads.length, 2);
  e.files[e.downloads[1].destination] = true; e.done('1000?1');
  assert.deepEqual(applied, [latest]);
});
test('gapless uses a matched local video sequence and stops it on teardown', () => {
  const e = environment(), a = { content_id: 'a', filepath: 'a.mp4', mime_type: 'video/mp4', duration_sec: 8, content_duration: 8, native_gapless_signature: 'h264|baseline|1280x720|25' }, b = { ...a, content_id: 'b', filepath: 'b.mp4' };
  e.b.accept({ assignments: [a, b] }, () => {});
  for (let i = 0; i < 2; i++) { e.files[e.downloads[i].destination] = true; e.done('1000?1'); }
  let ended = 0;
  assert.equal(e.b.playGapless([a, b], {left:0,top:0,width:1920,height:1080}, () => ended++), true);
  assert.equal(e.plugins[0].calls.filter(c => c[0] === 'pushplaylist').length, 2);
  assert.deepEqual(e.plugins[0].calls.find(c => c[0] === 'startplaylist'), ['startplaylist', 0, 0, 1920, 1080, '4', '0', '1']);
  e.plugins[0].OnRenderingStart();
  e.plugins[0].OnEvent(0, '', 'Stop'); assert.equal(ended, 1);
  e.plugins[0].OnEvent(0, '', 'Stop'); assert.equal(ended, 2, 'each native playlist item must advance the player');
  e.b.stopVideo(); assert.equal(e.b.gaplessActive(), false);
  assert.ok(e.plugins[0].calls.some(c => c[0] === 'stopplaylist'));
  assert.equal(e.b.playGapless([{ ...a, duration_sec: 2 }, b], {left:0,top:0,width:1920,height:1080}, () => {}), false);
  assert.equal(e.b.playGapless([{ ...a, duration_sec: 30 }, b], {left:0,top:0,width:1920,height:1080}, () => {}), false);
  assert.equal(e.b.playGapless([{ ...a, native_gapless_signature: null }, b], {left:0,top:0,width:1920,height:1080}, () => {}), false);
});

test('native playlists stay disabled until an operator explicitly enables the diagnostic flag', () => {
  const e = environment();
  assert.equal(e.b.gaplessEnabled(), false);
  e.storage.st_native_gapless = '1';
  assert.equal(e.b.gaplessEnabled(), true);
});

test('a native playlist that never renders falls back exactly once and stale callbacks are ignored', () => {
  const e = environment(), a = { content_id: 'a', filepath: 'a.mp4', mime_type: 'video/mp4', duration_sec: 8, content_duration: 8, native_gapless_signature: 'h264|baseline|1280x720|25' }, b = { ...a, content_id: 'b', filepath: 'b.mp4' };
  e.b.accept({ assignments: [a, b] }, () => {});
  for (let i = 0; i < 2; i++) { e.files[e.downloads[i].destination] = true; e.done('1000?1'); }
  let fallback = 0, ended = 0;
  assert.equal(e.b.playGapless([a, b], {left:0,top:0,width:1920,height:1080}, () => ended++, () => fallback++), true);
  const plugin = e.plugins[0];
  const timer = e.scheduled.find(x => x.ms === 3000);
  timer.fn();
  assert.equal(fallback, 1);
  assert.equal(e.b.gaplessActive(), false);
  plugin.OnRenderingStart(); plugin.OnEvent(0, '', 'Stop');
  assert.equal(fallback, 1);
  assert.equal(ended, 0);
});

test('native video is hidden after playback completes', () => {
  const e = environment(), video = { content_id: 'v', filepath: 'v.mp4', mime_type: 'video/mp4' };
  e.b.accept({ assignments: [video] }, () => {}); e.files[e.downloads[0].destination] = true; e.done('1000?1');
  let completed = 0;
  assert.equal(e.b.playVideo(video, {left: 0, top: 0, width: 1920, height: 1080}, () => completed++), true);
  assert.match(e.player.url, /^file:\/\//); assert.equal(e.player.style.visibility, 'visible');
  e.player.OnRenderingComplete();
  assert.equal(completed, 1); assert.equal(e.player.style.visibility, 'hidden');
  e.b.stopVideo();
  assert.equal(e.player.stops, 1, 'repeated teardown does not stop the decoder again');
});
test('native video reports playback errors and releases its surface', () => {
  const e = environment(), video = { content_id: 'v', filepath: 'v.mp4', mime_type: 'video/mp4' };
  e.b.accept({ assignments: [video] }, () => {}); e.files[e.downloads[0].destination] = true; e.done('1000?1');
  e.b.playVideo(video, {left: 0, top: 0, width: 10, height: 10}, () => {});
  e.player.OnRenderError(2);
  assert.equal(e.b.error, 'Video error: 2'); assert.equal(e.player.style.visibility, 'hidden');
});

test('state journal falls back to the previous valid slot when a write is corrupt', () => {
  const e = environment();
  assert.equal(e.b.writeState({ deviceId: 'one', playlist: ['old'] }), true);
  assert.equal(e.b.writeState({ deviceId: 'one', playlist: ['new'] }), true);
  e.files['/mtd_down/common/screentinker/state-0.json'] = '{partial';
  assert.deepEqual(JSON.parse(JSON.stringify(e.b.readState())), { deviceId: 'one', playlist: ['old'] });
});

test('a partial file left by a failed download cannot become a cache hit', () => {
  const e = environment(), activated = [];
  e.b.accept({ assignments: [image] }, p => activated.push(p));
  e.files[e.downloads[0].destination] = 'partial';
  e.done('500');
  assert.equal(e.b.mediaUrl(image, 'remote'), 'remote');
  assert.equal(activated.length, 0);
});

test('progress callbacks do not fail or prematurely complete a download', () => {
  const e = environment(), activated = [];
  e.b.accept({ assignments: [image] }, p => activated.push(p));
  e.done('1001?25'); e.done('1002?10240');
  assert.equal(e.b.error, undefined); assert.equal(activated.length, 0); assert.equal(e.downloads.length, 1);
  e.files[e.downloads[0].destination] = true; e.done('1000?1');
  assert.equal(activated.length, 1);
});
test('completion with an error status never promotes a file', () => {
  const e = environment(), activated = [];
  e.b.accept({ assignments: [image] }, p => activated.push(p));
  e.files[e.downloads[0].destination] = 'partial'; e.done('1000?0');
  assert.equal(activated.length, 0); assert.equal(e.b.mediaUrl(image, 'remote'), 'remote');
});

test('media verification uses a path relative to Samsung common storage', () => {
  const e = environment();
  e.b.accept({ assignments: [image] }, () => {});
  e.files[e.downloads[0].destination] = true; e.done('1000?1');
  assert.ok(e.opened.some(name => name.indexOf('screentinker_media/') === 0));
});
test('video duration watchdog advances at the configured dwell without an extra second', () => {
  const e = environment(), video = { content_id: 'v', filepath: 'v.mp4', mime_type: 'video/mp4', duration_sec: 6 };
  e.b.accept({ assignments: [video] }, () => {}); e.files[e.downloads[0].destination] = true; e.done('1000?1');
  let completed = 0;
  e.b.playVideo(video, { left: 0, top: 0, width: 1920, height: 1080 }, () => completed++);
  const watchdog = e.scheduled.find(x => x.ms === 6000);
  assert.ok(watchdog); watchdog.fn();
  assert.equal(completed, 1);
});

test('video transitions do not capture or display a frozen frame', () => {
  const e = environment(), video = { content_id: 'v', filepath: 'v.mp4', mime_type: 'video/mp4', duration_sec: 6 };
  e.b.accept({ assignments: [video] }, () => {}); e.files[e.downloads[0].destination] = true; e.done('1000?1');
  let captures = 0; e.b.captureScreen = () => captures++;
  e.b.playVideo(video, { left: 0, top: 0, width: 1920, height: 1080 }, () => {});
  e.player.OnRenderingComplete();
  assert.equal(captures, 0);
  assert.equal(e.b.visibleHeldFrame(), null);
});

test('package config starts the installed ZIP without waiting on sssp_config', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../app/config.xml'), 'utf8');
  assert.match(xml, /<autoUpdate itemtype="boolean">n<\/autoUpdate>/);
  assert.match(xml, /<network itemtype="boolean">n<\/network>/);
});

test('boot event is flushed to common storage and reread after a failed POST', () => {
  const e = environment();
  const recorded = e.b.recordBootEvent({ playing: true, items: 2, cached: true, cold_start: true });
  assert.equal(recorded.nv, true);
  assert.equal(recorded.flushed, true);
  assert.equal(typeof recorded.written_at_utc_ms, 'number');
  const stored = e.b.readBootEvent();
  assert.equal(stored.written_at_utc_ms, recorded.written_at_utc_ms);
  assert.equal(stored.playing, true);
  assert.equal(stored.items, 2);
  assert.equal(stored.cached, true);
  assert.equal(stored.cold_start, true);
  assert.equal(stored.flushed, true);
});

test('flushReports posts a nonvolatile boot event that survived a CMS outage', () => {
  const posts = [];
  function XMLHttpRequest() {
    this.status = 204;
    this.open = function () {};
    this.setRequestHeader = function () {};
    this.send = function (body) {
      posts.push(body);
      this.onload && this.onload();
    };
  }
  const files = {};
  function FileSystem() {
    this.createCommonDir = function () {};
    this.openCommonFile = function (name, mode) {
      if (mode !== 'w' && !Object.prototype.hasOwnProperty.call(files, name)) throw Error('missing');
      return { readAll() { return files[name]; }, writeAll(value) { files[name] = value; } };
    };
    this.closeCommonFile = function () {};
  }
  const window = { __STNative: { base: 'http://example.test' }, localStorage: { getItem() { return JSON.stringify({ deviceId: 'device-1' }); }, setItem() {} } };
  vm.runInNewContext(code, {
    window, FileSystem, XMLHttpRequest,
    document: { getElementById: () => ({ StartDownFile() {} }), createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} } },
    setTimeout() { return 1; }, clearTimeout() {}
  });
  window.__STNative.init();
  const recorded = window.__STNative.recordBootEvent({ playing: true, items: 2, cached: true, cold_start: true, written_at_utc_ms: 1700000000123 });
  assert.equal(recorded.flushed, true);
  window.__STNative.flushReports();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /1700000000123/);
  assert.match(posts[0], /sssp3-boot/);
});

test('launcher manifest poll does not block when sssp_config is unreachable', () => {
  function XMLHttpRequest() {
    this.open = function () {};
    this.send = function () { this.ontimeout && this.ontimeout(); };
  }
  const window = { __STNative: { base: 'http://example.test', launcherUrl: 'http://example.test/sssp3/' }, localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(code, {
    window, FileSystem: function () { this.createCommonDir = function () {}; this.openCommonFile = function () { throw Error('missing'); }; this.closeCommonFile = function () {}; },
    XMLHttpRequest,
    document: { getElementById: () => ({ StartDownFile() {} }), createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} } },
    setTimeout() { return 1; }, clearTimeout() {}
  });
  window.__STNative.init();
  let info;
  window.__STNative.pollLauncherManifest((_, result) => { info = result; });
  assert.equal(info.reachable, false);
  assert.equal(info.update, false);
});

test('launcher manifest poll reports an update when CMS is reachable with a higher ver', () => {
  function XMLHttpRequest() {
    this.status = 200;
    this.responseText = '<?xml version="1.0"?><widget><ver>1269</ver><size>1</size><widgetname>ScreenTinkerSSSP3</widgetname></widget>';
    this.open = function (method, url) { this.url = url; };
    this.send = function () { this.onload && this.onload(); };
  }
  const window = { __STNative: { base: 'http://example.test', launcherUrl: 'http://example.test/sssp3/' }, localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(code, {
    window, FileSystem: function () { this.createCommonDir = function () {}; this.openCommonFile = function () { throw Error('missing'); }; this.closeCommonFile = function () {}; },
    XMLHttpRequest,
    document: { getElementById: () => ({ StartDownFile() {} }), createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} } },
    setTimeout() { return 1; }, clearTimeout() {}
  });
  window.__STNative.init();
  let info;
  window.__STNative.pollLauncherManifest((_, result) => { info = result; });
  assert.equal(info.reachable, true);
  assert.equal(info.version, 1269);
  assert.equal(info.update, true);
});

test('boot reports retry after a failed debug POST', () => {
  const posts = [];
  function XMLHttpRequest() {
    this.status = 0;
    this.open = function () {};
    this.setRequestHeader = function () {};
    this.send = function (body) {
      posts.push(body);
      if (posts.length === 1) { this.status = 0; this.onerror && this.onerror(); }
      else { this.status = 204; this.onload && this.onload(); }
    };
  }
  const window = { __STNative: { base: 'http://example.test' }, STOfflinePlan: { dependencies() { return []; } }, localStorage: { getItem() { return null; }, setItem() {} } };
  const ctx = {
    window, FileSystem: function () { this.createCommonDir = function () {}; this.openCommonFile = function () { throw Error('missing'); }; this.closeCommonFile = function () {}; },
    document: { getElementById: () => ({ StartDownFile() {} }), createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} } },
    XMLHttpRequest, setTimeout() { return 1; }, clearTimeout() {}
  };
  vm.runInNewContext(code, ctx);
  window.__STNative.init();
  window.__STNative.report('boot', '{"playing":true,"items":2}', 'device-1');
  assert.equal(posts.length, 1);
  assert.equal(window.__STNative._test.pendingReports().length, 1);
  window.__STNative.flushReports();
  assert.equal(posts.length, 2);
  assert.equal(window.__STNative._test.pendingReports().length, 0);
  assert.match(posts[1], /sssp3-boot/);
});

test('Samsung capture uses the LFD plugin and returns the captured image', () => {
  const calls = [], timers = [], body = { appendChild(el) { el.parentNode = body; }, removeChild() {} };
  const plugin = { style: {}, setAttribute(k, v) { calls.push([k, v]); }, Open(...a) { calls.push(['Open', ...a]); return 1; }, Execute(name, ...args) { calls.push(['Execute', name, ...args]); return name === 'GetScreenCapture' ? '/tmp/capture_screen.jpg' : 1; }, Close() {} };
  const canvas = { getContext() { return { drawImage() {} }; }, toDataURL() { return 'data:image/jpeg;base64,' + 'A'.repeat(200); } };
  function Image() { this.width = 1920; this.height = 1080; }
  Object.defineProperty(Image.prototype, 'src', { set(value) { calls.push(['src', value]); this.onload(); } });
  const window = { __STNative: {} };
  function FileSystem() { this.createCommonDir = function () {}; this.openCommonFile = () => ({}); this.closeCommonFile = function () {}; }
  vm.runInNewContext(code, { window, Image, FileSystem, document: { body, getElementById: () => ({ StartDownFile() {} }), createElement: tag => tag === 'object' ? plugin : canvas }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  window.__STNative.init();
  let result;
  window.__STNative.captureScreen((err, data) => { result = { err, data }; });
  timers.find(x => x.ms === 100).fn();
  assert.equal(result.err, null);
  assert.equal(result.data.length, 200);
  assert.ok(calls.some(x => x[0] === 'Execute' && x[1] === 'GetScreenCapture'));
  assert.ok(calls.some(x => x[0] === 'Execute' && x[1] === 'Move' && x[2] === '/tmp/capture_screen.jpg'));
  assert.ok(calls.some(x => x[0] === 'src' && /^file:\/\/\/mtd_down\/common\/screentinker\/capture-\d+-\d+\.jpg$/.test(x[1])));
});
