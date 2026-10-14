'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../player/index.html'), 'utf8');

function harness(overrides = {}) {
  const handlers = {};
  const timers = new Map();
  let timerId = 0;
  let plays = 0;
  let state = 2;
  const videos = [];
  const iframe = {};
  const player = { getIframe: () => iframe, getPlayerState: () => state, playVideo: () => { plays++; } };
  const ctx = {
    document: { visibilityState: 'visible', hidden: false,
      contains: el => el === iframe || videos.includes(el),
      querySelectorAll: () => videos,
      addEventListener: (name, fn) => (handlers[name] ||= []).push(fn) },
    window: { addEventListener: (name, fn) => (handlers[name] ||= []).push(fn) },
    activeYtPlayer: player, ytGeneration: 1, playbackResumeTimer: null, suspendedPlayback: null, renderSeq: 1,
    talkDucking: false,
    getComputedStyle: el => el.style || {},
    isPlaying: true, screenIsOff: false, kiosk: { isShowing: () => false },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    requestWakeLock() {}, verifyLivenessSoon() {}, emitDeviceEvent() {}, glTxAbort: null,
    console,
    ...overrides,
  };
  // Run the production recovery functions and lifecycle handlers, replacing only browser/API boundaries.
  const helperStart = html.indexOf('    function cancelPlaybackResume(');
  if (helperStart >= 0) {
    const helperEnd = html.indexOf('    // v4 browser half-open triggers:', helperStart);
    vm.runInNewContext(html.slice(helperStart, helperEnd), ctx);
  }
  const start = html.indexOf("    document.addEventListener('visibilitychange', () => {", html.indexOf('    // v4 browser half-open triggers:'));
  const end = html.indexOf('    // feat/offline-cause-log: browser-side offline', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end), ctx);
  return {
    ctx, player, videos,
    get plays() { return plays; },
    get pending() { return timers.size; },
    set state(value) { state = value; },
    visibility(value) {
      ctx.document.visibilityState = value; ctx.document.hidden = value === 'hidden';
      handlers.visibilitychange.forEach(fn => fn());
    },
    pageshow(persisted) { handlers.pageshow.forEach(fn => fn({ persisted })); },
    pagehide(persisted) { (handlers.pagehide || []).forEach(fn => fn({ persisted })); },
    tick() {
      const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn());
    },
  };
}

test('Home then reopen resumes the retained paused YouTube embed', () => {
  const h = harness();
  h.visibility('hidden');
  assert.equal(h.plays, 0);
  h.visibility('visible');
  assert.equal(h.plays, 1);
  assert.equal(h.ctx.activeYtPlayer, h.player, 'resume keeps the existing embed');
});

function video(overrides = {}) {
  return { paused: false, ended: false, error: null, style: {}, currentTime: 12, plays: 0,
    play() { this.plays++; this.paused = false; return Promise.resolve(); }, ...overrides };
}

test('regular and zone videos resume in place after Home, without altering mute', () => {
  const h = harness({ activeYtPlayer: null });
  const a = video({ muted: false });
  const b = video({ muted: true });
  h.videos.push(a, b);
  h.visibility('hidden'); a.paused = true; b.paused = true;
  h.visibility('visible');
  assert.equal(a.plays, 1); assert.equal(b.plays, 1);
  assert.equal(a.currentTime, 12); assert.equal(b.currentTime, 12);
  assert.equal(a.muted, false); assert.equal(b.muted, true);
});

test('user-paused, frozen, ended, errored, and hidden buffered videos stay untouched', () => {
  const h = harness({ activeYtPlayer: null });
  h.videos.push(video({ paused: true }), video({ ended: true }), video({ error: {} }),
    video({ style: { visibility: 'hidden' } }), video({ parentElement: { style: { opacity: '0' } } }));
  h.visibility('hidden'); h.videos.forEach(v => { v.paused = true; });
  h.visibility('visible'); h.tick();
  assert.ok(h.videos.every(v => v.plays === 0));
});

test('bfcache preserves regular video playback intent', () => {
  const h = harness({ activeYtPlayer: null });
  const v = video(); h.videos.push(v);
  h.pagehide(true); v.paused = true;
  h.pageshow(true);
  assert.equal(v.plays, 1);
});

test('image foregrounding preserves the existing image and its advance timer', () => {
  const h = harness({ activeYtPlayer: null, currentItemStartedAt: 123 });
  let advances = 0;
  const timer = h.ctx.advanceTimer = h.ctx.setTimeout(() => { advances++; });
  h.visibility('hidden'); h.visibility('visible');
  assert.equal(h.pending, 1, 'the existing image timer survives foregrounding');
  assert.equal(h.ctx.advanceTimer, timer);
  assert.equal(h.ctx.currentItemStartedAt, 123);
  h.tick(); assert.equal(advances, 1);
});

test('a running clip changed to a frozen hold while hidden is not resumed', () => {
  const h = harness({ activeYtPlayer: null });
  const v = video(); h.videos.push(v);
  h.visibility('hidden');
  h.ctx.renderSeq++; v.paused = true;
  h.visibility('visible'); h.tick();
  assert.equal(v.plays, 0);
});

test('a replacement video is not restarted by a retry for its predecessor', () => {
  const h = harness({ activeYtPlayer: null });
  const old = video({ play() { this.plays++; return Promise.reject(new Error('blocked')); } });
  h.videos.push(old); h.visibility('hidden'); old.paused = true; h.visibility('visible');
  const next = video({ paused: true }); h.videos.splice(0, 1, next);
  h.ctx.renderSeq++;
  h.tick();
  assert.equal(next.plays, 0);
});

test('bfcache restore resumes playback; initial pageshow does not', () => {
  const h = harness();
  h.pageshow(false); assert.equal(h.plays, 0);
  h.pageshow(true); assert.equal(h.plays, 1);
});

test('a delayed WebView resume retries, then stops once YouTube is playing', () => {
  const h = harness();
  h.visibility('visible');
  h.tick(); assert.equal(h.plays, 2);
  h.state = 1;
  h.tick(); assert.equal(h.plays, 2);
  assert.equal(h.pending, 0);
});

test('a blocked player receives only three attempts', () => {
  const h = harness();
  h.visibility('visible');
  for (let i = 0; i < 10; i++) h.tick();
  assert.equal(h.plays, 3);
  assert.equal(h.pending, 0);
});

test('hiding again cancels pending recovery', () => {
  const h = harness();
  h.visibility('visible');
  h.visibility('hidden');
  assert.equal(h.pending, 0);
  h.tick(); assert.equal(h.plays, 1);
});

test('content replacement prevents a retry from restarting an old player', () => {
  const h = harness();
  h.visibility('visible');
  h.ctx.ytGeneration++;
  h.tick(); assert.equal(h.plays, 1);
  assert.equal(h.pending, 0);
});

test('foreground recovery respects idle, screen off, kiosk, and absent embeds', () => {
  for (const overrides of [{ isPlaying: false }, { screenIsOff: true },
    { kiosk: { isShowing: () => true } }, { activeYtPlayer: null }]) {
    const h = harness(overrides);
    h.visibility('visible'); h.tick();
    assert.equal(h.plays, 0);
    assert.equal(h.pending, 0);
  }
});

test('playing and ended embeds are not restarted', () => {
  for (const state of [0, 1]) {
    const h = harness(); h.state = state;
    h.visibility('visible'); h.tick();
    assert.equal(h.plays, 0);
    assert.equal(h.pending, 0);
  }
});

test('a stale YouTube handle after switching to other content is ignored', () => {
  const h = harness();
  h.ctx.document.contains = () => false;
  h.visibility('visible'); h.tick();
  assert.equal(h.plays, 0);
  assert.equal(h.pending, 0);
});
