'use strict';

// #624 on Tizen: a YouTube item looped (loop=1&playlist=<id>) until its duration (10 s by default)
// cut it off, in full screen and in zones. With "Play to end" the embed stops looping and the
// player listens to the embed itself (tizen/js/play-to-end.js): the IFrame API's "listening"
// handshake over postMessage, then its length and ENDED. Same contract as Android PlayToEnd.kt and
// native playlist_logic.py. The real player.js runs here in the same vm + DOM-shim harness as
// tizen-multitasking-resume.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const P = require('../../tizen/js/play-to-end.js');
const TIZEN = path.join(__dirname, '..', '..', 'tizen', 'js');

// ------------------------------------------------------------------ the rules (pure)

test('only a flagged YouTube item in a multi-item, unsynced playlist plays to the end', () => {
  const yt = { mime_type: 'video/youtube', play_to_end: 1 };
  assert.equal(P.applies(yt, false, 2), true);
  assert.equal(P.applies({ ...yt, play_to_end: undefined }, false, 2), false, 'opt-in per item');
  assert.equal(P.applies({ ...yt, mime_type: 'video/mp4' }, false, 2), false);
  assert.equal(P.applies({ ...yt, mime_type: 'image/jpeg' }, false, 2), false, 'images keep their duration');
  assert.equal(P.applies(yt, true, 2), false, 'a group or wall keeps the shared clock');
  assert.equal(P.applies(yt, false, 1), false, 'a one-item playlist keeps looping');
});

test('THE BUG: the 10 s default never ends a play-to-end video', () => {
  assert.equal(P.waitMs(10000), P.LENGTH_WAIT_MS);
  assert.equal(P.waitMs(120000), 120000);
  assert.equal(P.safetyMs(212, 2000), 212000 - 2000 + P.SLACK_MS);
  for (const bad of [0, -1, NaN, Infinity, undefined, 'abc']) assert.equal(P.safetyMs(bad, 0), null, String(bad));
  assert.equal(P.safetyMs(30, 45000), P.SLACK_MS, 'a late length never drops below the slack');
  assert.equal(P.endedCounts(500), false);
  assert.equal(P.endedCounts(P.MIN_PLAY_MS), true);
  assert.equal(P.loopParams('abc123', false), '&loop=1&playlist=abc123');
  assert.equal(P.loopParams('abc123', true), '');
});

test('the embed\'s messages: length from infoDelivery, ENDED from onStateChange 0', () => {
  assert.deepEqual(P.parse(JSON.stringify({ event: 'infoDelivery', info: { duration: 95.5, currentTime: 1 } })), { length: 95.5 });
  assert.deepEqual(P.parse({ event: 'initialDelivery', info: { duration: 60 } }), { length: 60 });
  assert.deepEqual(P.parse(JSON.stringify({ event: 'onStateChange', info: 0 })), { ended: true });
  assert.deepEqual(P.parse({ event: 'infoDelivery', info: { playerState: 0 } }), { ended: true });
  assert.equal(P.parse(JSON.stringify({ event: 'onStateChange', info: 1 })), null);
  assert.equal(P.parse({ event: 'infoDelivery', info: { duration: 0 } }), null, '0 before metadata');
  assert.equal(P.parse('not json'), null);
  assert.equal(P.parse(null), null);
});

function fakeWin() {
  const handlers = [];
  return {
    handlers,
    addEventListener: (n, fn) => { if (n === 'message') handlers.push(fn); },
    removeEventListener: (n, fn) => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
    send(source, data) { for (const h of handlers.slice()) h({ source, data: JSON.stringify(data) }); },
  };
}
function fakeIntervals() {
  const t = { fns: [], setInterval(fn) { t.fns.push(fn); return t.fns.length; }, clearInterval(id) { t.fns[id - 1] = null; } };
  t.tick = () => t.fns.forEach((f) => f && f());
  return t;
}

test('listen(): handshakes until the embed answers, then reports once per value, only from its own iframe', () => {
  const win = fakeWin(); const iv = fakeIntervals();
  const posted = [];
  const iframe = { contentWindow: { postMessage: (m, o) => posted.push([JSON.parse(m), o]) } };
  const lengths = []; let ends = 0;
  const stop = P.listen(iframe, (s) => lengths.push(s), () => { ends++; }, { win, ...iv });
  iv.tick(); iv.tick();
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0][0], { event: 'listening', id: 1, channel: 'widget' });

  win.send({ other: true }, { event: 'infoDelivery', info: { duration: 90 } });
  assert.deepEqual(lengths, [], 'a message from another frame is ignored');

  win.send(iframe.contentWindow, { event: 'infoDelivery', info: { duration: 90 } });
  win.send(iframe.contentWindow, { event: 'infoDelivery', info: { duration: 90 } });
  assert.deepEqual(lengths, [90], 'the embed repeats its info; one report per value');
  iv.tick();
  assert.equal(posted.length, 2, 'the handshake stops once the embed answers');

  win.send(iframe.contentWindow, { event: 'onStateChange', info: 0 });
  win.send(iframe.contentWindow, { event: 'infoDelivery', info: { playerState: 0 } });
  assert.equal(ends, 1, 'one end, however many ways the embed says so');

  stop();
  assert.equal(win.handlers.length, 0, 'stop() removes the listener');
});

// ------------------------------------------------------------------ the real player.js

function makeEl(tag) {
  const el = {
    tag, style: {}, attrs: {}, children: [], _html: '', _src: '', contentWindow: null,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    querySelector(sel) { return this.children.find((c) => c.tag === sel) || null; },
    querySelectorAll(sel) { return this.children.filter((c) => c.tag === sel); },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {}, pause() {}, play() { return Promise.resolve(); },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; if (v === '') this.children = []; } });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  if (tag === 'iframe') el.contentWindow = { postMessage() {} };
  return el;
}

function load() {
  const timers = [];
  const win = fakeWin();
  const sandbox = {
    console, Date, JSON, Math, isFinite,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; },
    setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
    addEventListener: win.addEventListener, removeEventListener: win.removeEventListener,
  };
  sandbox.document = { createElement: (tag) => makeEl(tag), getElementById: () => null, querySelector: () => null };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['play-to-end.js', 'player.js']) {
    vm.runInContext(fs.readFileSync(path.join(TIZEN, f), 'utf8'), sandbox, { filename: f });
  }
  const live = () => timers.filter((t) => t.live);
  return { sb: sandbox, win, timers, live };
}

const ytItem = (extra = {}) => ({ id: 1, content_id: 'c1', mime_type: 'video/youtube', filename: 'Talk',
  remote_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', duration_sec: 10, ...extra });

function fullscreen(items, setup) {
  const h = load();
  const stage = makeEl('div');
  const player = new h.sb.PlaylistPlayer(stage, () => 'http://server');
  player._logPlay = () => {};
  if (setup) setup(player);
  player.items = items;
  player.index = 0;
  player.playCurrent();
  const frame = stage.children.find((c) => c.tag === 'iframe');
  return { ...h, stage, player, frame };
}

test('full screen: a play-to-end item stops looping, and its end moves the playlist on', () => {
  const f = fullscreen([ytItem({ play_to_end: 1 }), ytItem({ id: 2, content_id: 'c2' })]);
  assert.ok(f.frame, 'the embed is on the stage');
  assert.ok(!/loop=1/.test(f.frame.src), f.frame.src);
  assert.match(f.frame.src, /enablejsapi=1/);
  assert.ok(f.live().some((t) => t.ms === 30000), 'the fallback is the wait, not the 10 s duration');
  assert.ok(!f.live().some((t) => t.ms === 10000), 'THE BUG: a 10 s timer would cut the video');

  const now = Date.now; Date.now = () => now() + 60000;            // well past the spurious-ENDED window
  try { f.win.send(f.frame.contentWindow, { event: 'onStateChange', info: 0 }); } finally { Date.now = now; }
  assert.equal(f.player.index, 1, 'the end of the video advanced the playlist');
});

test('full screen: the reported length re-arms the timer to the rest of the video + slack', () => {
  const f = fullscreen([ytItem({ play_to_end: 1 }), ytItem({ id: 2, content_id: 'c2' })]);
  f.win.send(f.frame.contentWindow, { event: 'infoDelivery', info: { duration: 212 } });
  const t = f.live().find((x) => x.ms > 200000);
  assert.ok(t, 'no length-based timer');
  assert.ok(Math.abs(t.ms - (212000 + P.SLACK_MS)) < 2000, String(t.ms));
});

test('full screen without the flag, or in a sync group, is unchanged: loop + the 10 s timer', () => {
  for (const setup of [null, (p) => { p.scheduleDriven = true; }, (p) => { p.wallActive = () => true; }]) {
    const f = fullscreen([ytItem(setup ? { play_to_end: 1 } : {}), ytItem({ id: 2, content_id: 'c2' })], setup);
    assert.match(f.frame.src, /loop=1&playlist=dQw4w9WgXcQ/);
    assert.ok(f.live().some((t) => t.ms === 10000));
  }
});

test('a one-item playlist keeps looping even with the flag', () => {
  const f = fullscreen([ytItem({ play_to_end: 1 })]);
  assert.match(f.frame.src, /loop=1&playlist=dQw4w9WgXcQ/);
});

test('zones: a play-to-end YouTube item moves its zone on when the video ends', () => {
  const h = load();
  const zr = new h.sb.ZoneRenderer(makeEl('div'), () => 'http://server');
  const zoneEl = makeEl('div');
  const zone = { id: 'z1', el: zoneEl };
  const list = [ytItem({ play_to_end: 1, zone_id: 'z1' }), ytItem({ id: 2, content_id: 'c2', zone_id: 'z1' })];
  const shown = [];
  const real = zr.showItem.bind(zr);
  zr.showItem = (z, l, i) => { shown.push(i); return real(z, l, i); };
  zr.showItem(zone, list, 0);
  const frame = zoneEl.children.find((c) => c.tag === 'iframe');
  assert.ok(!/loop=1/.test(frame.src), frame.src);
  assert.match(frame.src, /enablejsapi=1/);
  assert.equal(h.timers[zr.timers.z1 - 1].ms, 30000, 'the fallback is the wait, not the 10 s duration');

  const now = Date.now; Date.now = () => now() + 60000;
  try { h.win.send(frame.contentWindow, { event: 'onStateChange', info: 0 }); } finally { Date.now = now; }
  assert.deepEqual(shown, [0, 1], 'the end of the video moved the zone to its next item');

  // The zone moved on: the old embed's late messages change nothing.
  h.win.send(frame.contentWindow, { event: 'onStateChange', info: 0 });
  assert.deepEqual(shown, [0, 1]);
});

test('zones without the flag still loop and move on at the duration', () => {
  const h = load();
  const zr = new h.sb.ZoneRenderer(makeEl('div'), () => 'http://server');
  const zoneEl = makeEl('div');
  zr.showItem({ id: 'z1', el: zoneEl }, [ytItem(), ytItem({ id: 2, content_id: 'c2' })], 0);
  const frame = zoneEl.children.find((c) => c.tag === 'iframe');
  assert.match(frame.src, /loop=1&playlist=dQw4w9WgXcQ/);
  assert.equal(h.timers[zr.timers.z1 - 1].ms, 10000);
});
