'use strict';

/*
 * Web player: an uploaded audio file (audio/mpeg and friends) used to be logged as
 * "[player] skipping item with unrecognised type: audio/mpeg" and never played, though uploads
 * accept MP3, M4A, Ogg, WAV and FLAC. It now plays through a <video> element like a clip: full
 * screen on a "now playing" card, in a zone with no picture, advancing when the track ends.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const LEGACY = fs.readFileSync(path.join(__dirname, '..', 'player', 'legacy.html'), 'utf8');

function block(src, fromText) {
  const at = src.indexOf(fromText);
  assert.ok(at > 0, `${fromText} not found`);
  let end = src.indexOf('{', at), depth = 0;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) { end++; break; }
  }
  return src.slice(at, end);
}

test('every uploadable audio type counts as renderable (no more skip)', () => {
  const isRenderableItem = new Function(`const BUNDLE_MIME = 'x';
    ${block(PLAYER, 'function isRenderableItem(')}; return isRenderableItem;`)();
  for (const m of ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac']) {
    assert.equal(isRenderableItem({ content_id: 'a', mime_type: m }), true, m);
  }
  assert.equal(isRenderableItem({ content_id: 'a', mime_type: 'application/x-nope' }), false);
});

function fakeEl(tag) {
  const el = {
    tag, style: {}, children: [], attrs: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [], addEventListener() {}, removeAttribute() {}, pause() {}, load() {},
    play() { this.played = true; return Promise.resolve(); },
  };
  Object.defineProperty(el, 'innerHTML', { set() { el.children = []; }, get() { return ''; } });
  Object.defineProperty(el.style, 'cssText', { set(v) { el.css = v; }, get() { return el.css || ''; } });
  return el;
}

test('a zone plays an audio item on a media element and advances when it ends', () => {
  const start = PLAYER.indexOf('    // #74/#75 zone-level schedule helpers.');
  const end = PLAYER.indexOf('    // ==================== Screenshots ====================', start);
  const src = PLAYER.slice(start, end);
  const timeouts = [];
  const env = {
    zoneTimers: {}, setTimeout: (fn, ms) => { timeouts.push(ms); return timeouts.length; }, clearTimeout() {},
    scheduleAllows: () => true, itemFit: () => 'contain', mediaUrl: (a) => '/uploads/' + a.content_id + '.mp3',
    config: { serverUrl: '', deviceId: 'd1' }, widgetSandboxAttr: () => '', createYoutubeEmbed() {},
    addWebpageNote() {}, PREVIEW_MODE: false, destroyHls() {}, newVideoElement: () => fakeEl('video'),
    document: { createElement: (t) => fakeEl(t) },
  };
  const names = Object.keys(env);
  const { showZoneItem } = new Function(...names, `${src}; return { showZoneItem };`)(...names.map((n) => env[n]));
  const div = fakeEl('div');
  const items = [{ content_id: 'song', mime_type: 'audio/mpeg', duration_sec: 200 }, { content_id: 'img', mime_type: 'image/png' }];
  showZoneItem({ id: 'z1', sort_order: 0 }, div, items, 0);
  const el = div.children[0];
  assert.equal(el.tag, 'video', 'audio must not fall through to <img>');
  assert.equal(el.src, '/uploads/song.mp3');
  assert.equal(typeof el.onended, 'function', 'the zone moves on when the track ends');
  assert.equal(el.muted, false, 'the first zone keeps its sound');
  assert.ok(el.played);
});

test('full screen: audio mounts the now-playing card plus a hidden media element wired like a clip', () => {
  const body = block(PLAYER, 'function renderContent(');
  assert.match(body, /const isAudio = isAudioMime\(item\.mime_type\);/);
  assert.match(body, /\(item\.mime_type\?\.startsWith\('video\/'\) \|\| isAudio\)/);
  assert.match(body, /if \(isAudio\) \{\s*mount\.appendChild\(audioCard\(item\)\);/);
  const card = new Function('document', `${block(PLAYER, 'function audioCard(')}; return audioCard;`)({ createElement: fakeEl })({ filename: 'Lobby mix.mp3' });
  assert.equal(card.children[1].textContent, 'Lobby mix');
});

test('the legacy build carries the same change', () => {
  assert.ok(LEGACY.includes('function audioCard('), 'rebuild with npm run build:legacy-player');
  assert.ok(/isAudioMime\(item\.mime_type\)/.test(LEGACY));
});
