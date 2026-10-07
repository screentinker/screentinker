'use strict';

// Wall zones + hold items on the TIZEN player (tizen/js/player.js WallZoneRenderer, renderHold, the
// ZoneRenderer hold branch, WallController zones mode; app.js wiring; css; capabilities). The web
// player (server/player/index.html renderWallZones / wallZoneTick / mountWallZoneItem / renderHold)
// is the behavioural reference; the server half is lib/wall-layout.js + the wall block in
// ws/deviceSocket.js.
//
// Same harness as tizen-multitasking-resume.test.js: the REAL player.js in a node:vm context with a
// small hand-rolled DOM shim (no jsdom in the repo) and captured timers. What this cannot prove is
// anything the TV's video pipeline does — see the report for the on-panel checks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));   // vm-realm arrays/objects -> host (deepStrictEqual checks prototypes)

// ---------------------------------------------------------------- DOM shim
function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(), tag, style: {}, className: '', attrs: {}, children: [], parentNode: null,
    _html: '', _src: '', paused: true, ended: false, loop: false, muted: false, autoplay: false,
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
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
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
  return el;
}

function load(opts = {}) {
  const timers = { timeouts: [], intervals: [], cleared: [] };
  let id = 0;
  const sandbox = {
    console, Date, JSON, Math, Promise,
    setTimeout: (fn, ms) => { timers.timeouts.push({ fn, ms, id: ++id }); return id; },
    clearTimeout: (t) => { timers.cleared.push(t); },
    setInterval: (fn, ms) => { timers.intervals.push({ fn, ms, id: ++id }); return id; },
    clearInterval: (t) => { timers.cleared.push(t); },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
  };
  sandbox.document = { createElement: (tag) => makeEl(tag), getElementById: () => null, body: makeEl('body') };
  sandbox.window = sandbox;
  if (opts.webapis) sandbox.webapis = opts.webapis;
  vm.createContext(sandbox);
  vm.runInContext(read('tizen/js/player.js'), sandbox, { filename: 'player.js' });
  sandbox.__timers = timers;
  return sandbox;
}

// ---------------------------------------------------------------- fixtures
// A 2x1 wall: canvas 3840x1080, this panel is the LEFT 1920x1080; the player rect is the whole wall.
const PLAYER = { x: 0, y: 0, w: 3840, h: 1080 };
const LEFT = { x: 0, y: 0, w: 1920, h: 1080 };
const RIGHT = { x: 1920, y: 0, w: 1920, h: 1080 };
const zone = (id, x, y, w, h, extra = {}) => Object.assign({ id, x_percent: x, y_percent: y, width_percent: w, height_percent: h, z_index: 0, fit_mode: 'contain' }, extra);
const vid = (cid, zid, dur, extra = {}) => Object.assign({ content_id: cid, zone_id: zid, mime_type: 'video/mp4', duration_sec: dur, sort_order: 0 }, extra);
const img = (cid, zid, dur, extra = {}) => Object.assign({ content_id: cid, zone_id: zid, mime_type: 'image/jpeg', duration_sec: dur, sort_order: 0 }, extra);
const hold = (mode, zid, dur, extra = {}) => Object.assign({ content_id: 'h-' + mode, zone_id: zid, mime_type: 'application/x-st-hold', remote_url: 'hold://' + mode, duration_sec: dur, sort_order: 0 }, extra);

function wall(sb, { layout, items, config, now = 0 }) {
  const stage = makeEl('div');
  let clock = now;
  const wz = new sb.WallZoneRenderer(stage, () => 'http://srv', () => 'dev1', () => clock);
  wz.render(layout, items, Object.assign({ wall_id: 'w1', canvas_layout: true, screen_rect: LEFT, player_rect: PLAYER, audio_zones: [] }, config || {}));
  return { stage, wz, setNow: (t) => { clock = t; } };
}

// ================================================================ clock maths
test('slots use the canonical rule: max(1, duration_sec || 10) s, schedule-filtered, dwell-0 live skipped', () => {
  const sb = load();
  const items = [
    { mime_type: 'image/png', duration_sec: 0 },          // 0 -> 10s (|| 10)
    { mime_type: 'image/png', duration_sec: 0.4 },        // -> 1s floor, NOT durationMs()'s 3s
    { mime_type: 'video/hls', duration_sec: 0 },          // infinite dwell: no slot
    { mime_type: 'video/hls', duration_sec: 5 },          // finite live dwell: a slot
    { mime_type: 'image/png', duration_sec: 7, skip: true },
    { mime_type: 'image/png', duration_sec: 'abc' },      // junk -> 10s
  ];
  const r = sb.stClockSlots(items, (it) => !it.skip);
  assert.deepEqual(JSON.parse(JSON.stringify(r.slots)), [
    { index: 0, start: 0, dur: 10000 }, { index: 1, start: 10000, dur: 1000 },
    { index: 3, start: 11000, dur: 5000 }, { index: 5, start: 16000, dur: 10000 },
  ]);
  assert.equal(r.period, 26000);
});

test('target: slot containing (now mod period), posSec, slotSec, prev wraps, negative now is safe', () => {
  const sb = load();
  const items = [{ duration_sec: 10 }, { duration_sec: 20 }, { duration_sec: 30 }];
  let t = sb.stClockTarget(items, 60000 * 5 + 12500, () => true);   // phase 12.5s -> item 1, 2.5s in
  assert.equal(t.index, 1); assert.equal(t.posSec, 2.5); assert.equal(t.slotSec, 20);
  assert.equal(t.prevIndex, 0); assert.equal(t.nextIndex, 2);
  t = sb.stClockTarget(items, 3000, () => true);                       // item 0: prev wraps to the last
  assert.equal(t.index, 0); assert.equal(t.prevIndex, 2);
  t = sb.stClockTarget(items, -1000, () => true);                      // phase 59s -> item 2
  assert.equal(t.index, 2); assert.equal(t.posSec, 29);
  assert.equal(sb.stClockTarget([], 5, () => true), null);
  assert.equal(sb.stClockTarget(items, 5, () => false), null, 'nothing in its daypart -> no target');
});

test('group sync still derives the same target through the shared slot rule', () => {
  const sb = load();
  const player = new sb.PlaylistPlayer(makeEl('div'), () => 'http://srv');
  player.items = [{ duration_sec: 10 }, { mime_type: 'video/hls', duration_sec: 0 }, { duration_sec: 5 }];
  player.scheduleAllows = () => true;
  const g = new sb.GroupSyncController(player, () => 0);
  g.syncedNow = () => 12000;
  const t = g.target();
  assert.equal(t.index, 2); assert.equal(t.posSec, 2); assert.equal(t.nextIndex, 0);
  assert.equal(t.secToBoundary, 3);
  assert.equal(g.slots().period, 15000);
});

test('drift step: align once (seek only if > 0.05s), then seek > 0.3s with a 1.2s cooldown, nudge > 0.05s, else ride 1.0', () => {
  const sb = load();
  const v = { currentTime: 5.0, playbackRate: 1.03 };
  const st = { alignPending: true, lastSeekAt: 0 };
  assert.match(sb.stDriftCorrect(v, 5.03, st, 10000), /^align/);
  assert.equal(v.currentTime, 5.0, 'within 0.05s: no seek on align');
  assert.equal(v.playbackRate, 1.0); assert.equal(st.alignPending, false);

  st.alignPending = true;
  sb.stDriftCorrect(v, 6.0, st, 10000);
  assert.equal(v.currentTime, 6.0, 'align seeks when > 0.05s off'); assert.equal(st.lastSeekAt, 10000);

  v.currentTime = 7.0;   // 1s ahead of 6.0, but we just seeked: cooldown -> nudge, not seek
  assert.match(sb.stDriftCorrect(v, 6.0, st, 10500), /^nudge/);
  assert.equal(v.currentTime, 7.0); assert.equal(v.playbackRate, 0.97);
  assert.match(sb.stDriftCorrect(v, 6.0, st, 11300), /^seek/);
  assert.equal(v.currentTime, 6.0); assert.equal(v.playbackRate, 1.0);

  v.currentTime = 5.9;   // behind -> speed up
  sb.stDriftCorrect(v, 6.0, st, 20000);
  assert.equal(v.playbackRate, 1.03);
  v.currentTime = 6.0;
  assert.equal(sb.stDriftCorrect(v, 6.02, st, 20100), 'hold');
  assert.equal(v.playbackRate, 1.0);
});

// ================================================================ bucketing / geometry / rules
test('bucketing: orphan zone_id -> largest zone, unassigned -> first zone with none of its own, sorted', () => {
  const sb = load();
  const zones = [zone('a', 0, 0, 30, 100), zone('b', 30, 0, 70, 100), zone('c', 0, 0, 10, 10)];
  const items = [
    img('1', 'a', 5, { sort_order: 2 }), img('2', 'a', 5, { sort_order: 1 }),
    img('3', 'gone', 5),                // orphan -> b (largest)
    img('4', null, 5), img('5', '', 5), // unassigned -> c (a and b have their own)
    { zone_id: 'a' },                   // unplayable: dropped
  ];
  const out = plain(sb.WallZoneRenderer.buckets(zones, items));
  assert.deepEqual(out.a.map((x) => x.content_id), ['2', '1']);
  assert.deepEqual(out.b.map((x) => x.content_id), ['3']);
  assert.deepEqual(out.c.map((x) => x.content_id), ['4', '5']);
});

test('visibility: a zone is built only where its canvas rect meets this panel (seam-straddlers on both)', () => {
  const sb = load();
  const leftOnly = zone('L', 0, 0, 40, 100), straddle = zone('S', 40, 0, 20, 100), rightOnly = zone('R', 60, 0, 40, 100);
  const cfgL = { screen_rect: LEFT, player_rect: PLAYER }, cfgR = { screen_rect: RIGHT, player_rect: PLAYER };
  const V = sb.WallZoneRenderer.zoneVisible;
  assert.deepEqual([V(leftOnly, cfgL), V(straddle, cfgL), V(rightOnly, cfgL)], [true, true, false]);
  assert.deepEqual([V(leftOnly, cfgR), V(straddle, cfgR), V(rightOnly, cfgR)], [false, true, true]);
  // Touching edges do not count (50% of 3840 = 1920 exactly).
  assert.equal(V(zone('E', 50, 0, 50, 100), cfgL), false);
  // The rect is in player-rect space: an offset player rect shifts it.
  assert.equal(V(zone('X', 0, 0, 10, 10), { screen_rect: LEFT, player_rect: { x: 2000, y: 0, w: 1000, h: 1000 } }), false);

  const { stage, wz } = wall(sb, { layout: { id: 'l', zones: [leftOnly, straddle, rightOnly] }, items: [] });
  assert.equal(wz.zones.length, 2);
  assert.deepEqual(plain(wz.zones.map((z) => z.zone.id)), ['L', 'S']);
  assert.equal(stage.children.length, 2);
});

test('zone divs: percent of the wall stage, z-index, background, wall-zone class', () => {
  const sb = load();
  const { stage } = wall(sb, { layout: { zones: [zone('a', 10, 20, 30, 40, { z_index: 3, background_color: '#123456' }), zone('b', 0, 0, 5, 5)] }, items: [] });
  const d = stage.children[0];
  assert.equal(d.className, 'wall-zone');
  assert.deepEqual([d.style.left, d.style.top, d.style.width, d.style.height], ['10%', '20%', '30%', '40%']);
  assert.equal(d.style.zIndex, '3'); assert.equal(d.style.background, '#123456');
  assert.equal(d.style.position, 'absolute'); assert.equal(d.style.overflow, 'hidden');
  assert.equal(stage.children[1].style.background, 'transparent');
});

test('loop only a clip SHORTER than its slot (by > 0.3s); fit is item -> zone -> contain; audio rule', () => {
  const sb = load();
  const W = sb.WallZoneRenderer;
  assert.equal(W.shouldLoop(4, 10), true);
  assert.equal(W.shouldLoop(10, 10), false, 'as long as its slot: must END on its last frame');
  assert.equal(W.shouldLoop(9.8, 10), false);
  assert.equal(W.shouldLoop(9.6, 10), true);
  assert.equal(W.fit({ fit_mode: 'cover' }, { fit_mode: 'fill' }), 'cover');
  assert.equal(W.fit({}, { fit_mode: 'fill' }), 'fill');
  assert.equal(W.fit({}, {}), 'contain');
  assert.equal(W.fit({ fit_mode: 'bogus' }, {}), 'contain');
  assert.equal(W.muted(true, {}), false);
  assert.equal(W.muted(false, {}), true);
  assert.equal(W.muted(true, { muted: 1 }), true, 'a per-item mute still wins');
});

test('wanted only with canvas_layout AND >= 2 zones', () => {
  const sb = load();
  const W = sb.WallZoneRenderer;
  const two = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  assert.equal(W.wanted({ canvas_layout: true }, two), true);
  assert.equal(W.wanted({}, two), false);
  assert.equal(W.wanted({ canvas_layout: true }, { zones: [zone('a', 0, 0, 100, 100)] }), false);
  assert.equal(W.wanted({ canvas_layout: true }, null), false);
  assert.equal(W.wanted(null, two), false);
});

// ================================================================ rendering on the clock
test('each zone mounts the item the CLOCK says, at the clock position; audio only where listed', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100, { fit_mode: 'cover' }), zone('b', 50, 0, 50, 100)] };
  // Straddle-free 2-zone layout seen from a single 1-panel "wall" so both zones are visible.
  const items = [vid('v1', 'a', 10), vid('v2', 'a', 10), img('i1', 'b', 4), img('i2', 'b', 4)];
  const { wz } = wall(sb, { layout, items, now: 13500, config: { screen_rect: PLAYER, audio_zones: ['a'] } });
  const [za, zb] = wz.zones;
  const va = za.div.children[0];
  assert.equal(va.tag, 'video');
  assert.equal(va.src, 'http://srv/api/content/v2/file', 'zone a: 13.5s into a 20s period -> item 2');
  assert.equal(va.muted, false, 'zone a is in audio_zones');
  assert.equal(va.className, 'cover'); assert.equal(va.style.objectFit, 'cover');
  assert.equal(va.style.opacity, '0', 'buffered: hidden until it has a frame');
  const ib = zb.div.children[0];
  assert.equal(ib.tag, 'img'); assert.equal(ib.src, 'http://srv/api/content/i2/file', 'zone b: 13.5 mod 8 = 5.5 -> item 2');
  assert.equal(ib.className, 'contain');

  // Metadata: seek to the clock position (+ time since mount), loop decided by clip vs slot.
  va.duration = 10; va.fire('loadedmetadata');
  assert.ok(va.currentTime >= 3.5 && va.currentTime < 3.7, 'joined 3.5s into the clip: ' + va.currentTime);
  assert.equal(va.loop, false, '10s clip in a 10s slot does not loop');
  va.fire('loadeddata');
  assert.equal(va.style.opacity, '1');
  assert.equal(za.video, va);
});

test('a zone video is muted when this panel does not voice the zone', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const { wz } = wall(sb, { layout, items: [vid('v1', 'a', 10), vid('v2', 'b', 10, { muted: 1 })], config: { screen_rect: PLAYER, audio_zones: ['b'] } });
  assert.equal(wz.zones[0].div.children[0].muted, true, 'zone a: not in audio_zones');
  assert.equal(wz.zones[1].div.children[0].muted, true, 'zone b: voiced, but the item is muted');
});

test('drift is corrected per zone against posSec % duration; a non-looping clip past its end is left alone', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [vid('short', 'a', 20), vid('full', 'b', 10)], now: 0, config: { screen_rect: PLAYER } });
  const [za, zb] = h.wz.zones;
  const vs = za.div.children[0], vf = zb.div.children[0];
  vs.duration = 4; vs.fire('loadedmetadata'); assert.equal(vs.loop, true, '4s clip in a 20s slot loops');
  vf.duration = 9.9; vf.fire('loadedmetadata'); assert.equal(vf.loop, false, '9.9s clip in a 10s slot: within 0.3s, no loop');

  h.setNow(9000);                // short: 9 % 4 = 1.0 ; full: 9.0
  vs.currentTime = 1.5; vf.currentTime = 9.0;
  h.wz.tick();
  assert.equal(vs.currentTime, 1.0, 'first tick after mount aligns');
  assert.equal(za.alignPending, false);

  h.setNow(9950);                // full ended at 9.9s and does not loop; the slot runs to 10s
  vf.currentTime = 9.9; vf.paused = true; vf.ended = true;
  h.wz.tick();
  assert.equal(vf.currentTime, 9.9, 'stays on its last frame; posSec % duration (0.05) would pull it back to the start');
  assert.equal(vf.playbackRate, 1, 'not even nudged');
});

test('a zone index change remounts that zone only, through the buffered swap', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [img('1', 'a', 5), img('2', 'a', 5), img('3', 'b', 100)], now: 1000, config: { screen_rect: PLAYER } });
  const [za, zb] = h.wz.zones;
  const first = za.div.children[0]; first.onload();
  const bEl = zb.div.children[0];
  h.setNow(6000); h.wz.tick();
  assert.equal(za.div.children.length, 2, 'new image underneath, old still up');
  const second = za.div.children[1];
  assert.equal(second.src, 'http://srv/api/content/2/file');
  second.onload();
  assert.deepEqual(za.div.children, [second], 'old one removed once the new one has loaded');
  assert.equal(zb.div.children[0], bEl, 'zone b untouched');
});

// ================================================================ holds in wall zones
test('wall hold://blank releases the zone media and shows its background', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100, { background_color: '#222' }), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [vid('v', 'a', 10), hold('blank', 'a', 10)], now: 1000, config: { screen_rect: PLAYER } });
  const za = h.wz.zones[0];
  const v = za.div.children[0];
  v.paused = false;
  h.setNow(12000); h.wz.tick();
  assert.equal(za.div.children.length, 0);
  assert.equal(v.paused, true); assert.equal(v.src, '', 'src dropped so the decoder is freed');
  assert.equal(za.div.style.background, '#222');
});

test('wall hold://freeze keeps the current picture, paused, no longer clock-aligned', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [vid('v', 'a', 10), hold('freeze', 'a', 10)], now: 1000, config: { screen_rect: PLAYER } });
  const za = h.wz.zones[0];
  const v = za.div.children[0];
  v.duration = 10; v.fire('loadedmetadata'); v.paused = false;
  h.setNow(12000); h.wz.tick();
  assert.deepEqual(za.div.children, [v], 'same element still up');
  assert.equal(v.paused, true);
  assert.equal(za.video, null, 'no drift correction can seek a frozen frame');
  const ct = v.currentTime;
  h.setNow(15000); h.wz.tick();
  assert.equal(v.currentTime, ct);
});

test('a panel that joins MID-FREEZE builds the previous slot\'s item, paused at its last frame', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [vid('prev', 'a', 10), hold('freeze', 'a', 10)], now: 14000, config: { screen_rect: PLAYER } });
  const za = h.wz.zones[0];
  const v = za.div.children[0];
  assert.equal(v.tag, 'video'); assert.equal(v.src, 'http://srv/api/content/prev/file');
  assert.equal(v.autoplay, false); assert.equal(v.muted, true);
  v.duration = 8; v.fire('loadedmetadata');
  assert.ok(Math.abs(v.currentTime - 7.95) < 1e-9); assert.equal(v.paused, true);
  assert.equal(za.video, null);
});

test('a hold is never given a URL: nothing in a wall zone, the fullscreen player or a zone src=hold://', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const { stage } = wall(sb, { layout, items: [hold('blank', 'a', 10), hold('freeze', 'b', 10)], config: { screen_rect: PLAYER } });
  const all = stage.querySelectorAll('video, img, iframe');
  assert.equal(all.length, 0);
});

// ================================================================ AVPlay never in a wall zone
test('wall zone video is ALWAYS <video>, never AVPlay — even on a portrait-oriented player', () => {
  const calls = [];
  const avplay = new Proxy({}, { get: (_, k) => () => { calls.push(k); } });
  const sb = load({ webapis: { avplay } });
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const { stage } = wall(sb, { layout, items: [vid('v1', 'a', 10), vid('v2', 'b', 10, { mime_type: 'video/hls', remote_url: 'http://x/live.m3u8' })], config: { screen_rect: PLAYER } });
  assert.equal(stage.querySelectorAll('video').length, 2);
  assert.deepEqual(calls, [], 'webapis.avplay untouched');
  // And statically: the renderer has no path to it.
  const src = read('tizen/js/player.js');
  const body = src.slice(src.indexOf('function WallZoneRenderer('));
  assert.doesNotMatch(body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /avplay|renderVideoAv|setDisplayRect/i);
});

// ================================================================ lifecycle
test('clear() tears down timers, zone media and the stage; a changed audio_zones / canvas key rebuilds', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [vid('v1', 'a', 10)], config: { screen_rect: PLAYER, audio_zones: [] } });
  const timer = sb.__timers.intervals.find((t) => t.ms === 250);
  assert.ok(timer, '4 Hz tick armed');
  const v = h.wz.zones[0].div.children[0];
  assert.equal(v.muted, true);

  // Same payload again: nothing rebuilt.
  h.wz.render(layout, [vid('v1', 'a', 10)], h.wz.config);
  assert.equal(h.wz.zones[0].div.children[0], v);

  // This panel now voices zone a: the zones are rebuilt (the item list did not change).
  h.wz.render(layout, [vid('v1', 'a', 10)], Object.assign({}, h.wz.config, { audio_zones: ['a'] }));
  const v2 = h.wz.zones[0].div.children[0];
  assert.notEqual(v2, v);
  assert.equal(v2.muted, false);
  assert.equal(v.paused, true); assert.equal(v.src, '');

  h.wz.clear();
  assert.equal(h.stage.children.length, 0);
  assert.equal(h.wz.active(), false);
  assert.equal(v2.src, '');
  assert.ok(sb.__timers.cleared.length >= 2, 'interval(s) cleared');
  // A stray tick after teardown is inert.
  h.wz.tick();
  assert.equal(h.stage.children.length, 0);
});

test('signature carries canvas_layout and audio_zones (the "did the wall config change" key)', () => {
  const sb = load();
  const wz = new sb.WallZoneRenderer(makeEl('div'), () => '', () => '', () => 0);
  const L = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const base = { wall_id: 'w', screen_rect: LEFT, player_rect: PLAYER, canvas_layout: true, audio_zones: ['a'] };
  const s0 = wz.signature(L, base);
  assert.notEqual(wz.signature(L, Object.assign({}, base, { audio_zones: [] })), s0);
  assert.notEqual(wz.signature(L, Object.assign({}, base, { canvas_layout: false })), s0);
  assert.notEqual(wz.signature(L, Object.assign({}, base, { rotation: 90 })), s0);
  assert.notEqual(wz.signature(L, Object.assign({}, base, { screen_rect: RIGHT })), s0);
  assert.equal(wz.signature(L, Object.assign({}, base, { audio_zones: ['a'] })), s0);
});

test('WallController in zones mode: the leader emits no wall:sync and a follower ignores one', () => {
  const sb = load();
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://srv');
  const emitted = [];
  const sock = { emit: (e, d) => emitted.push(e) };
  player.items = [vid('v', null, 10)]; player.index = 0;
  const wc = new sb.WallController(stage, player, () => sock, () => 'd', () => true);
  wc.apply({ wall_id: 'w', is_leader: true, screen_rect: LEFT, player_rect: PLAYER, canvas_layout: true }, { zones: true });
  assert.equal(sb.__timers.intervals.filter((t) => t.ms === 250).length, 0, 'no relay timer');
  wc.emitSync(); wc.onSyncRequest({ wall_id: 'w' });
  assert.deepEqual(emitted, []);

  let jumped = 0;
  player.gotoIndex = () => { jumped++; };
  wc.apply({ wall_id: 'w', is_leader: false, screen_rect: LEFT, player_rect: PLAYER, canvas_layout: true }, { zones: true });
  assert.deepEqual(emitted, [], 'a zones follower does not even ask for a position');
  wc.onSync({ wall_id: 'w', current_index: 3, position_sec: 1 });
  assert.equal(jumped, 0);

  // Back to a plain wall: the relay works again.
  wc.apply({ wall_id: 'w', is_leader: false, screen_rect: LEFT, player_rect: PLAYER });
  assert.deepEqual(emitted, ['wall:sync-request']);
  wc.onSync({ wall_id: 'w', current_index: 3, position_sec: 1 });
  assert.equal(jumped, 1);
});

// ================================================================ holds outside wall zones
function soloPlayer(sb, items) {
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://srv');
  player.items = items; player.index = 0; player.sig = 'x';
  return { stage, player };
}

test('fullscreen hold://freeze keeps the outgoing frame paused, lets go of currentVideoEl, advances after max(1,dur||10)s', () => {
  const sb = load();
  const { stage, player } = soloPlayer(sb, [vid('v', null, 10), hold('freeze', null, 0)]);
  const v = makeEl('video'); v.paused = false; stage.appendChild(v);
  player.currentVideoEl = v;
  player.index = 1;
  player.playCurrent();
  assert.deepEqual(stage.children, [v], 'frame kept');
  assert.equal(v.paused, true);
  assert.equal(player.getCurrentVideo(), null, 'nothing drift-corrects (seeks) the frozen frame');
  assert.equal(stage.querySelectorAll('iframe').length, 0, 'not routed to the remote_url iframe fallback');
  const adv = sb.__timers.timeouts.at(-1);
  assert.equal(adv.ms, 10000, 'duration 0 -> 10s');
  assert.equal(player.hasContentOnScreen(), true);
});

test('fullscreen hold://blank clears to the background; the duration floor is 1s, not durationMs()\'s 3s', () => {
  const sb = load();
  const { stage, player } = soloPlayer(sb, [img('i', null, 10), hold('blank', null, 1)]);
  const i = makeEl('img'); stage.appendChild(i);
  player.index = 1;
  player.playCurrent();
  assert.equal(stage.children.length, 0);
  assert.equal(sb.__timers.timeouts.at(-1).ms, 1000);
  assert.equal(player.hasContentOnScreen(), true, 'a blank hold still counts as on screen (continuity)');
});

test('schedule-driven (group member / wall follower): a hold arms NO timer — the tick moves on', () => {
  const sb = load();
  const { stage, player } = soloPlayer(sb, [vid('v', null, 10), hold('freeze', null, 5)]);
  player.setWallFollower(true);
  const before = sb.__timers.timeouts.length;
  player.index = 1;
  player.playCurrent();
  assert.equal(sb.__timers.timeouts.length, before);
  assert.equal(player.getCurrentVideo(), null);
  void stage;
});

test('portrait (AVPlay) freeze pauses the hardware session in place', () => {
  const calls = [];
  const sb = load({ webapis: { avplay: { pause: () => calls.push('pause'), stop: () => calls.push('stop'), close: () => calls.push('close') } } });
  const { player } = soloPlayer(sb, [vid('v', null, 10), hold('freeze', null, 5)]);
  player.avActive = true;
  player.index = 1;
  player.playCurrent();
  assert.deepEqual(calls, ['pause']);
});

test('normal zones: freeze pauses the zone media and keeps it; blank clears; both advance after the hold', () => {
  const sb = load();
  const stage = makeEl('div');
  const zr = new sb.ZoneRenderer(stage, () => 'http://srv');
  zr.render({ zones: [zone('a', 0, 0, 100, 100)] }, [vid('v', 'a', 10, { sort_order: 0 }), hold('freeze', 'a', 4, { sort_order: 1 }), hold('blank', 'a', 0, { sort_order: 2 })]);
  const za = zr.zones[0];
  const v = za.el.children[0];
  assert.equal(v.tag, 'video');
  v.paused = false;
  v.onended();                          // clip ends -> next is the freeze
  assert.deepEqual(za.el.children, [v], 'kept');
  assert.equal(v.paused, true);
  assert.equal(v.onended, null, 'a frozen clip can no longer advance the zone');
  const t1 = sb.__timers.timeouts.at(-1);
  assert.equal(t1.ms, 4000);
  t1.fn();                              // -> blank
  assert.equal(za.el.children.length, 0);
  assert.equal(sb.__timers.timeouts.at(-1).ms, 10000, 'blank with duration 0 -> 10s');
});

// ================================================================ CSS / caps / wiring (static)
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length;
  const tags = sel.replace(/[#.][\w-]+/g, ' ').split(/[\s>+~]+/).filter((t) => /^[a-z]+$/i.test(t)).length;
  return ids * 10000 + classes * 100 + tags;
}

test('CSS: the wall-mode fill rule no longer wins inside a wall zone (zones keep their own fit)', () => {
  const css = read('tizen/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  css.replace(/([^{}]+)\{([^}]*)\}/g, (_, sels, body) => {
    const m = /object-fit:\s*(\w+)/.exec(body);
    if (m) sels.split(',').forEach((s) => rules.push({ sel: s.replace(/\/\*[\s\S]*?\*\//g, '').trim(), fit: m[1] }));
    return '';
  });
  const fillAll = rules.find((r) => r.sel === '.stage.wall-mode video');
  assert.ok(fillAll && fillAll.fit === 'fill', 'plain wall media still stretched to fill (seam alignment)');
  for (const fit of ['contain', 'cover', 'fill']) {
    for (const tag of ['img', 'video']) {
      const r = rules.find((x) => x.sel === `.stage.wall-mode .wall-zone ${tag}.${fit}`);
      assert.ok(r, `missing .stage.wall-mode .wall-zone ${tag}.${fit}`);
      assert.equal(r.fit, fit);
      assert.ok(specificity(r.sel) > specificity(`.stage.wall-mode ${tag}`), 'override must out-rank the descendant fill rule');
    }
  }
});

test('capabilities: playback.hold and playback.wall_zones are declared, and in the server vocabulary', () => {
  const src = read('tizen/js/capabilities.js');
  assert.match(src, /'playback\.hold'/);
  assert.match(src, /'playback\.wall_zones'/);
  const caps = require('../lib/player-capabilities');
  const vocab = caps.VOCABULARY || caps.CAPABILITIES || caps.ALL || null;
  if (vocab) {
    const list = Array.isArray(vocab) ? vocab : Object.keys(vocab);
    assert.ok(list.includes('playback.hold') && list.includes('playback.wall_zones'));
  }
});

test('app.js: a canvas-layout wall goes to WallZoneRenderer BEFORE the plain wall path (which loads the player)', () => {
  const src = read('tizen/js/app.js');
  const zonesAt = src.indexOf('WallZoneRenderer.wanted(payload.wall_config, payload.layout)');
  const plainAt = src.indexOf("if (payload.wall_config) {\n      // Video wall:");
  assert.ok(zonesAt > 0 && plainAt > zonesAt, 'zones branch precedes the plain wall branch');
  const branch = src.slice(zonesAt, plainAt);
  assert.match(branch, /wallController\.apply\(payload\.wall_config, \{ zones: true \}\)/);
  assert.match(branch, /wallZones\.render\(payload\.layout/);
  assert.doesNotMatch(branch, /player\.load\(/, 'the single-zone player does not render a wall layout');
  assert.ok(branch.indexOf('wallController.apply') < branch.indexOf('wallZones.render'), 'stage positioned before zones are drawn');
  // Leaving wall-zone mode tears it down on every other path, and on suspension / session teardown.
  assert.match(src.slice(plainAt - 200, plainAt), /wallZones\.clear\(\)/);
  assert.match(src, /player\.stop\(\);\s*zoneRenderer\.clear\(\);\s*wallZones\.clear\(\);\s*wallController\.exit\(\);/);
  assert.match(src, /function teardownSession\(\)[\s\S]{0,300}wallZones\.clear\(\)/);
  // The wall clock is the group-sync clock.
  assert.match(src, /new WallZoneRenderer\(.*return syncedNow\(\)/);
});

test('cold boot: the whole payload (wall_config + layout) is cached before render and replayed before connect', () => {
  const src = read('tizen/js/app.js');
  const onPl = src.slice(src.indexOf('function onPlaylist(payload)'));
  assert.ok(onPl.indexOf('set(LS.payload, JSON.stringify(payload))') < onPl.indexOf('WallZoneRenderer.wanted'), 'cached before the wall branch');
  const boot = src.slice(src.indexOf('if (serverUrl && deviceId && deviceToken) {'));
  assert.ok(boot.indexOf('onPlaylist(JSON.parse(_cp))') < boot.indexOf('connect();'), 'replayed before the socket connects');
});

test('media cache never fetches a hold (no bytes behind hold://)', async () => {
  const MediaCache = require(path.join(ROOT, 'tizen', 'js', 'media-cache.js'));
  let requests = 0;
  const backend = {
    available: () => true, loadIndex: () => ({}), saveIndex() {},
    httpRange() { requests++; throw new Error('no'); },
    appendPart: () => 0, promotePart: () => null, remove() {},
  };
  const mc = new MediaCache(backend);
  await mc.sync([
    { content_id: 'h1', mime_type: 'application/x-st-hold', remote_url: 'hold://blank' },
    { content_id: 'h2', mime_type: 'application/x-st-hold' },   // even bare
  ], (it) => 'http://s/api/content/' + it.content_id + '/file');
  assert.equal(requests, 0);
});

// ================================================================ spec addendum
test('MOUNTING after a non-looping clip has ended (panel joins late in its slot): last frame, paused', () => {
  const sb = load();
  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  // An 11.8s clip in a 12s slot does NOT loop (within 0.3s); this panel joins at 11.9s.
  const h = wall(sb, { layout, items: [vid('c', 'a', 12)], now: 11900, config: { screen_rect: PLAYER } });
  const za = h.wz.zones[0];
  const v = za.div.children[0];
  v.duration = 11.8; v.fire('loadedmetadata');
  assert.equal(v.loop, false);
  assert.ok(Math.abs(v.currentTime - 11.75) < 1e-9, 'seeked to duration - 0.05, not posSec % duration: ' + v.currentTime);
  assert.equal(v.paused, true);
  // ...and the following ticks leave it there.
  v.currentTime = 11.75;
  h.setNow(11950); h.wz.tick();
  assert.equal(v.currentTime, 11.75);
});

test('a ONE-slot zone remounts its video clip every pass of the loop (cycle in the key), not an image', () => {
  const sb = load();
  const t0 = sb.stClockTarget([{ duration_sec: 10 }], 25000, () => true);
  assert.equal(t0.cycle, 2); assert.equal(t0.period, 10000);

  const layout = { zones: [zone('a', 0, 0, 50, 100), zone('b', 50, 0, 50, 100)] };
  const h = wall(sb, { layout, items: [vid('only', 'a', 10), img('still', 'b', 10)], now: 1000, config: { screen_rect: PLAYER } });
  const [za, zb] = h.wz.zones;
  const v1 = za.div.children[0], i1 = zb.div.children[0];
  v1.duration = 10; v1.fire('loadedmetadata'); v1.fire('loadeddata'); i1.onload();
  h.setNow(9990); h.wz.tick();
  assert.deepEqual(za.div.children, [v1], 'same pass: no remount');
  h.setNow(10100); h.wz.tick();                 // next pass: index is still 0
  assert.equal(za.div.children.length, 2, 'the clip is mounted again for the new pass');
  const v2 = za.div.children[1];
  assert.notEqual(v2, v1);
  assert.equal(v2.src, 'http://srv/api/content/only/file');
  v2.fire('loadeddata');
  assert.deepEqual(za.div.children, [v2], 'buffered swap completes');
  assert.deepEqual(zb.div.children, [i1], 'an image in a one-slot zone is NOT remounted each pass');
});
