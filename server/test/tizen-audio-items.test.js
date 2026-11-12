'use strict';

// Uploaded audio files (audio/mpeg, audio/mp4, audio/ogg, audio/wav, audio/flac) on the TIZEN player.
// They used to fall to "unknown -> skip" full screen and to an empty div in a zone. They now play
// through an HTML5 <video> like a clip: full screen on a "now playing" card, in a zone with no
// picture. The web player (server/player/index.html isAudioMime / audioCard) is the reference.
//
// Harness: the REAL tizen/js/player.js in a node:vm context with a small DOM shim (as in
// tizen-wall-zones.test.js). What it cannot prove is what the panel's decoder does with each codec.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'player.js'), 'utf8');
const AUDIO_MIMES = ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac'];

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(), tag, style: {}, className: '', attrs: {}, children: [], parentNode: null,
    _html: '', _src: '', paused: true, ended: false, loop: false, muted: false, autoplay: false, textContent: '',
    currentTime: 0, duration: NaN, playbackRate: 1, readyState: 0, played: 0, loads: 0,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    get firstChild() { return this.children[0] || null; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const tags = sel.split(',').map((s) => s.trim());
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (tags.includes(c.tag)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this._src = ''; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    fire(ev) { const l = listeners[ev] || []; listeners[ev] = []; l.forEach((fn) => fn()); },
    load() { this.loads++; },
    pause() { this.paused = true; },
    play() { this.played++; this.paused = false; return Promise.resolve(); },
  };
  el.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } },
  });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  let css = '';
  Object.defineProperty(el.style, 'cssText', { get() { return css; }, set(v) { css = v; } });
  return el;
}

function load(opts = {}) {
  const timers = [];
  let id = 0;
  const sandbox = {
    console, Date, JSON, Math, Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, id: ++id }); return id; },
    clearTimeout() {}, setInterval: () => ++id, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
  };
  const created = [];
  sandbox.document = {
    createElement: (tag) => { const e = makeEl(tag); created.push(e); return e; },
    getElementById: () => null, body: makeEl('body'),
  };
  sandbox.window = sandbox;
  if (opts.webapis) sandbox.webapis = opts.webapis;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'player.js' });
  return { sb: sandbox, timers, created };
}

const song = (extra = {}) => Object.assign({ content_id: 'song', mime_type: 'audio/mpeg', filename: 'Lobby mix.mp3', duration_sec: 10, content_duration: 200 }, extra);
const pic = { content_id: 'pic', mime_type: 'image/png', duration_sec: 10 };

function fullScreen(items, setup) {
  const h = load(setup && setup.load);
  const stage = makeEl('div');
  const p = new h.sb.PlaylistPlayer(stage, () => 'http://srv', () => 'dev1');
  p.items = items;
  p.index = 0;
  if (setup && setup.before) setup.before(p);
  p.playCurrent();
  const media = stage.children.filter((c) => c.tag === 'video');
  return { h, p, stage, v: media[0], card: stage.children.find((c) => c.tag === 'div') };
}

test('full screen: every uploadable audio type plays on a media element instead of skipping', () => {
  for (const m of AUDIO_MIMES) {
    const { p, v, h } = fullScreen([song({ mime_type: m }), pic]);
    assert.ok(v, m + ' mounted a media element');
    assert.equal(v.src, 'http://srv/api/content/song/file');
    assert.equal(p.getCurrentVideo(), v, 'live mute / volume keys / wall relay reach it');
    assert.ok(v.played > 0);
    assert.ok(!h.timers.some((t) => t.ms === 2000), m + ' was not treated as unknown -> skip');
  }
});

test('full screen: the now-playing card shows a note and the filename without extension; the element has no picture', () => {
  const { card, v } = fullScreen([song(), pic]);
  assert.ok(card, 'card mounted');
  assert.equal(card.children[0].textContent, '♪');
  assert.equal(card.children[1].textContent, 'Lobby mix');
  assert.match(v.style.cssText, /width:1px;height:1px;opacity:0/);
});

test('full screen: advances on end, safety net from the track length, error -> skip', () => {
  const { p, v, h } = fullScreen([song(), pic]);
  assert.equal(v.loop, false);
  assert.ok(h.timers.some((t) => t.ms === 205000), 'safety net = content_duration + 5s');
  let advanced = 0;
  p.advance = () => { advanced++; };
  v.onended();
  assert.equal(advanced, 1);
  let skipped = 0;
  p.skipSoon = () => { skipped++; };
  v.onerror();
  assert.equal(skipped, 1);
});

test('full screen: a single-item playlist loops and arms no advance timer', () => {
  const { v, h, p } = fullScreen([song()]);
  assert.equal(v.loop, true);
  let advanced = 0;
  p.advance = () => { advanced++; };
  v.onended();
  assert.equal(advanced, 0);
  assert.ok(!h.timers.some((t) => t.ms === 205000));
});

test('full screen: per-item mute after warm-muted start, live mute reaches it, wall followers stay silent', () => {
  let r = fullScreen([song(), pic]);
  assert.equal(r.v.muted, true, 'warm muted so autoplay cannot be blocked');
  r.v.fire('playing');
  assert.equal(r.v.muted, false, 'unmuted item makes sound');
  r.p.getCurrentVideo().muted = true;   // what app.js device:mute-changed does
  assert.equal(r.v.muted, true);

  r = fullScreen([song({ muted: 1 }), pic]);
  r.v.fire('playing');
  assert.equal(r.v.muted, true, 'muted item stays muted');

  r = fullScreen([song(), pic], { before: (p) => { p.wallFollower = true; } });
  r.v.fire('playing');
  assert.equal(r.v.muted, true, 'wall follower is silent');
  assert.equal(r.v.loop, true, 'a follower holds the item (single)');
});

test('full screen portrait: audio never goes to AVPlay (no picture to rotate), still the HTML element', () => {
  const calls = [];
  const avplay = new Proxy({}, { get: (_, k) => () => { calls.push(k); } });
  const { v } = fullScreen([song(), pic], { load: { webapis: { avplay } }, before: (p) => p.setOrientation('portrait') });
  assert.ok(v, 'media element mounted');
  assert.deepEqual(calls, [], 'no AVPlay session opened');
});

test('preload: an audio next item warms nothing (no hidden decoder held for it)', () => {
  const h = load();
  const p = new h.sb.PlaylistPlayer(makeEl('div'), () => 'http://srv');
  p.items = [pic, song()];
  const before = h.created.length;
  p.preloadVideo(1);
  assert.equal(h.created.length, before);
  assert.equal(p.preloadEl, null);
  assert.equal(p._videoWillComposite(song({ transition: { effects: [{ type: 'fade' }] } })), false, 'never composites');
});

test('zone: audio plays with no picture and is heard in the first zone only (warms muted, then the item mute), advances on end', () => {
  const h = load();
  const zr = new h.sb.ZoneRenderer(makeEl('div'), () => 'http://srv');
  const div = makeEl('div');
  const zone = { id: 'z1', el: div };
  const list = [song(), pic];
  zr.showItem(zone, list, 0);
  const v = div.children[0];
  assert.equal(v.tag, 'video', 'audio must not fall through to an empty zone');
  assert.equal(v.src, 'http://srv/api/content/song/file');
  assert.match(v.style.cssText, /width:1px;height:1px/);
  assert.equal(v.muted, true, 'warms muted for TV autoplay');
  v.fire('playing');
  assert.equal(v.muted, false, 'zone audio is heard once playing');
  assert.equal(v.loop, false);
  assert.ok(h.timers.some((t) => t.ms === 205000), 'safety net');
  v.onended();
  assert.equal(div.children[0].tag, 'img', 'moved on to the next item');

  const one = makeEl('div');
  zr.showItem({ id: 'z2', el: one }, [song()], 0);
  assert.equal(one.children[0].loop, true, 'a one-item zone loops');

  const m = makeEl('div');
  zr.showItem({ id: 'z3', el: m }, [song({ muted: 1 })], 0);
  m.children[0].fire('playing');
  assert.equal(m.children[0].muted, true, 'a muted item stays silent');

  const second = makeEl('div');
  zr.showItem({ id: 'z5', el: second, sort: 1 }, [song()], 0);
  second.children[0].fire('playing');
  assert.equal(second.children[0].muted, true, 'only the first zone sounds, as on the web player');

  const vid = makeEl('div');
  zr.showItem({ id: 'z4', el: vid }, [{ content_id: 'clip', mime_type: 'video/mp4', duration_sec: 10 }], 0);
  vid.children[0].fire('playing');
  assert.equal(vid.children[0].muted, true, 'zone VIDEO is still muted on this player');
});

test('wall zone: audio is a clip with no picture, voiced only by its audio zone, no frozen frame', () => {
  const h = load();
  const z = (id, x) => ({ id, x_percent: x, y_percent: 0, width_percent: 50, height_percent: 100, z_index: 0, fit_mode: 'contain' });
  const layout = { id: 'L', zones: [z('a', 0), z('b', 50)] };
  const items = [song({ zone_id: 'a', duration_sec: 30 }), song({ content_id: 's2', zone_id: 'b', duration_sec: 30 })];
  const stage = makeEl('div');
  const wz = new h.sb.WallZoneRenderer(stage, () => 'http://srv', () => 'dev1', () => 0);
  const full = { x: 0, y: 0, w: 1920, h: 1080 };
  wz.render(layout, items, { wall_id: 'w1', canvas_layout: true, screen_rect: full, player_rect: full, audio_zones: ['a'] });
  const [za, zb] = wz.zones;
  const va = za.div.children[0], vb = zb.div.children[0];
  assert.equal(va.tag, 'video'); assert.equal(vb.tag, 'video');
  assert.equal(za.video, va, 'clock-aligned like a clip');
  assert.match(va.style.cssText, /width:1px;height:1px/);
  assert.equal(va.muted, false, 'the audio zone sounds');
  assert.equal(vb.muted, true, 'any other zone is silent');
  assert.match(za.key, /\|c0$/, 'remounts each pass like a clip');
  assert.equal(wz.element(za, items[0], { frozenAtEnd: true }), null, 'a freeze after audio shows the background');
});

test('player.js stays ES5 (old Tizen Chromium)', () => {
  assert.doesNotThrow(() => new vm.Script(SRC));
  const added = SRC.slice(SRC.indexOf('function stIsAudio('), SRC.indexOf('function stAudioCard(') + 1200);
  assert.ok(!/=>|\blet\b|\bconst\b|`|\.startsWith\(/.test(added), 'no ES2015 syntax in the audio helpers');
});
