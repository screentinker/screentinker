'use strict';

/*
 * A plain video wall (no wall layout) went BLACK on every panel at every item switch.
 *
 * The solo buffered swaps exclude walls, so a wall member fell to the legacy branch of renderContent,
 * which empties the stage with teardownCurrentMedia() and only then starts loading the next item.
 * Seen on a 2-panel web-player wall in a live demo: a black frame across the whole wall each switch.
 *
 * renderWallBuffered mounts the next item in a hidden wall-stage ON TOP and releases the outgoing
 * stage only once the new one has a decoded image or a presented video frame. These tests run the
 * real functions against a small fake DOM.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SRC = PLAYER.slice(PLAYER.indexOf('const WALL_SWAP_TIMEOUT_MS'), PLAYER.indexOf('// #74/#75 zone-level schedule helpers.'));

// ---------------------------------------------------------------- a fake DOM, just enough
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.style = {};
    this.listeners = {}; this.attrs = {}; this.paused = true; this.className = '';
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.isRoot === true; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (c.tagName === sel.toUpperCase()) out.push(c); walk(c); });
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev) { const l = this.listeners[ev] || []; this.listeners[ev] = []; l.forEach((f) => f()); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  removeAttribute(k) { if (k === 'src') this.src = ''; }
  decode() { return Promise.resolve(); }
}

function harness({ wall = { is_leader: true }, zones = false, group = null, playlistLen = 3 } = {}) {
  const container = new El('div'); container.isRoot = true;
  const timers = new Map(); let tid = 0;
  const calls = { advance: [], skip: [], wired: [] };
  const state = { renderSeq: 1, currentVideoEl: null };
  const env = {
    document: { getElementById: () => container, createElement: (t) => new El(t) },
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    wallConfig: wall, groupSync: group, wallZonesActive: () => zones,
    LIVE_MIME: 'video/hls',
    playlist: { length: playlistLen },
    isWallFollower: () => !!(wall && !wall.is_leader),
    mediaUrl: (it) => '/media/' + it.id,
    styleWallStage: (s) => { s.style.left = '0vw'; },
    hideStatus: () => {}, discardPendingSwap: () => {}, clearZoneTimers: () => {}, stopWallZones: () => {},
    destroyHls: () => {}, attachSubtitleTrack: () => {},
    scheduleAdvance: (fn, ms) => calls.advance.push(ms),
    nextItem: () => {},
    mediaFailureSkip: (el, label, src, may) => calls.skip.push({ label, may }),
    wireSoloVideoPlayback: (v, item, src, o) => { calls.wired.push(o); v.loop = !!o.loop; v.muted = !!o.forceMuted; v.onerror = () => {}; },
  };
  const names = Object.keys(env);
  const body = `let ytSafetyNet = null;
    let renderSeq = __s.renderSeq; let currentVideoEl = __s.currentVideoEl;
    ${SRC}
    return {
      isWallSwappable, renderWallBuffered,
      get currentVideoEl() { return currentVideoEl; }, set currentVideoEl(v) { currentVideoEl = v; },
      bump() { renderSeq++; },
    };`;
  const api = new Function(...names, '__s', body)(...names.map((n) => env[n]), state);
  return {
    api, container, calls, timers,
    fireTimers(minMs = 0) { for (const [id, t] of [...timers]) if (t.ms >= minMs) { timers.delete(id); t.fn(); } },
  };
}

const flush = () => new Promise((r) => setImmediate(r));
function outgoingStage(h, withVideo) {
  const stage = new El('div'); stage.className = 'wall-stage';
  if (withVideo) { const v = new El('video'); v.paused = false; v.onended = () => { throw new Error('old clip advanced'); }; stage.appendChild(v); h.api.currentVideoEl = v; }
  h.container.appendChild(stage);
  return stage;
}

// ---------------------------------------------------------------- routing

test('renderContent sends a plain wall item to the buffered wall swap BEFORE the legacy teardown', () => {
  const rc = PLAYER.slice(PLAYER.indexOf('function renderContent(item)'), PLAYER.indexOf('// In wall mode, mount content into a stage'));
  const swap = rc.indexOf('if (isWallSwappable(item))');
  const teardown = rc.indexOf('teardownCurrentMedia();\n\n      const container');
  assert.ok(swap > 0, 'renderContent checks isWallSwappable');
  assert.ok(teardown > swap, 'and does so before the teardown that blanked the wall');
});

test('which items take the swap: images and plain videos on a plain wall only', () => {
  const h = harness();
  assert.equal(h.api.isWallSwappable({ mime_type: 'image/jpeg' }), true);
  assert.equal(h.api.isWallSwappable({ mime_type: 'video/mp4' }), true);
  for (const m of ['video/youtube', 'video/hls', 'video/hdmi-in', 'application/x-st-hold']) {
    assert.equal(h.api.isWallSwappable({ mime_type: m }), false, m);
  }
  assert.equal(h.api.isWallSwappable({ mime_type: 'image/png', widget_id: 'w1' }), false, 'widgets keep their own path');
  assert.equal(harness({ wall: null }).api.isWallSwappable({ mime_type: 'image/png' }), false, 'not a wall');
  assert.equal(harness({ zones: true }).api.isWallSwappable({ mime_type: 'image/png' }), false, 'wall zones have their own renderer');
  assert.equal(harness({ group: { id: 'g' } }).api.isWallSwappable({ mime_type: 'image/png' }), false, 'group sync is unchanged');
});

// ---------------------------------------------------------------- the swap itself

test('an image: the outgoing stage stays on screen until the new image has decoded', async () => {
  const h = harness();
  const old = outgoingStage(h, false);
  h.api.renderWallBuffered({ id: 'a', mime_type: 'image/jpeg', duration_sec: 8 });
  const fresh = h.container.children[1];
  assert.equal(h.container.children.length, 2, 'both stages exist while the image loads');
  assert.equal(fresh.style.visibility, 'hidden');
  assert.equal(fresh.className, 'wall-stage');
  assert.equal(fresh.style.left, '0vw', 'styled as this panel\'s slice of the wall');
  fresh.children[0].onload();
  await flush();
  assert.deepEqual(h.container.children, [fresh], 'the old stage is released only now');
  assert.equal(fresh.style.visibility, '');
  assert.deepEqual(h.calls.advance, [8000], 'the leader arms the advance exactly as before');
  assert.equal(old.parent, null);
});

test('a video: the outgoing clip is frozen and disarmed, and drift correction binds to the NEW element once it shows a frame', () => {
  const h = harness({ wall: { is_leader: false } });
  const old = outgoingStage(h, true);
  const oldVideo = old.children[0];
  h.api.renderWallBuffered({ id: 'b', mime_type: 'video/mp4' });
  assert.equal(oldVideo.paused, true, 'outgoing clip paused on its frame');
  assert.equal(oldVideo.onended, null, 'and cannot advance the playlist when it ends');
  assert.equal(h.api.currentVideoEl, null, 'no drift correction against the frozen clip meanwhile');
  const newVideo = h.container.children[1].children[0];
  assert.deepEqual(h.calls.wired[0], { forceMuted: true, mayAdvance: false, loop: false, role: 'follower' }, 'follower: muted, no own advance');
  assert.equal(h.calls.advance.length, 0);
  newVideo.fire('playing');
  h.fireTimers(0);
  assert.equal(h.api.currentVideoEl, newVideo, 'wall:sync drift correction now finds the new clip');
  assert.equal(h.container.children.length, 1);
  assert.equal(oldVideo.src, '', 'old clip released');
});

test('a single-item playlist still loops natively (no switch, so nothing to swap)', () => {
  const h = harness({ playlistLen: 1 });
  h.api.renderWallBuffered({ id: 'c', mime_type: 'video/mp4' });
  assert.equal(h.calls.wired[0].loop, true);
  assert.equal(h.calls.wired[0].role, 'leader');
});

test('a render superseded while loading never reveals over the newer one', async () => {
  const h = harness();
  outgoingStage(h, false);
  h.api.renderWallBuffered({ id: 'a', mime_type: 'image/jpeg' });
  const fresh = h.container.children[1];
  h.api.bump();   // a newer renderContent / teardown happened
  fresh.children[0].onload();
  await flush();
  assert.equal(fresh.parent, null, 'the stale stage is dropped');
  assert.equal(h.container.children.length, 1, 'and what was on screen is left alone');
});

test('a broken image holds the previous picture and skips, rather than revealing an empty stage', () => {
  const h = harness();
  const old = outgoingStage(h, false);
  h.api.renderWallBuffered({ id: 'x', mime_type: 'image/jpeg' });
  h.container.children[1].children[0].onerror();
  assert.deepEqual(h.container.children, [old]);
  assert.deepEqual(h.calls.skip, [{ label: 'image', may: true }]);
});

test('a load that never finishes is revealed by the watchdog, so a wall can never freeze', () => {
  const h = harness();
  outgoingStage(h, false);
  h.api.renderWallBuffered({ id: 'slow', mime_type: 'video/mp4' });
  h.fireTimers(4000);
  assert.equal(h.container.children.length, 1);
  assert.equal(h.container.children[0].style.visibility, '');
  assert.ok(h.api.currentVideoEl, 'and the clip is the one being synced');
});
