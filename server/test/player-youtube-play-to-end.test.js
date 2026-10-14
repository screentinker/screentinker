'use strict';

/*
 * #624 in the web player.
 *
 * Fullscreen YouTube already played to the end (ENDED → nextItem, with getDuration + 3 s as the
 * safety net), so that path only gains a fallback: a play-to-end video whose length never arrives
 * moves on after the item's duration instead of holding the screen.
 *
 * ⚠️ Zones were broken on their own: createYoutubeEmbed was built for fullscreen only, so a zone
 * video that ended advanced the MAIN playlist (nextItem), and a second YouTube zone destroyed the
 * first one's player. In zone mode the embed keeps its state on the zone's element and its end calls
 * the ZONE's advance. These run the real declarations from index.html against fakes.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function fakeEl(extra = {}) {
  return {
    style: {}, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, querySelectorAll: () => [],
    set innerHTML(_v) {}, get innerHTML() { return ''; }, addEventListener() {}, play: () => Promise.resolve(),
    pause() {}, load() {}, removeAttribute() {}, remove() {}, ...extra,
  };
}

// ------------------------------------------------------------------ createYoutubeEmbed itself

function embedHarness({ playlistLength = 3 } = {}) {
  const start = PLAYER.indexOf('    function createYoutubeEmbed(');
  const end = PLAYER.indexOf('    // Stop and release all media in the player.', start);
  assert.ok(start > 0 && end > start, 'createYoutubeEmbed is still in index.html');
  const src = PLAYER.slice(start, end);

  const timeouts = [];
  const players = [];
  const calls = { next: 0 };
  const attached = new Set();
  const env = {
    extractVideoId: () => 'abc123',
    cancelPlaybackResume: () => {},
    document: { createElement: () => fakeEl(), contains: (el) => attached.has(el) },
    window: { location: { origin: 'https://st.example' } },
    muteState: () => ({}), userHasInteracted: true, unlockAudio: () => {}, applyMute: () => {},
    applyMuteWanted: () => true, mediaVolume: null,
    loadYoutubeApi: (cb) => cb(),
    playlist: Array.from({ length: playlistLength }, () => ({})),
    YT: { Player: function (id, cfg) { const p = { id, cfg, destroyed: false, destroy() { this.destroyed = true; } }; players.push(p); return p; } },
    nextItem: () => { calls.next++; },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms, live: true }); return timeouts.length; },
    clearTimeout: (id) => { if (id && timeouts[id - 1]) timeouts[id - 1].live = false; },
    Date,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `let ytGeneration = 0, ytSafetyNet = null, activeYtPlayer = null;\n${src}\nreturn { createYoutubeEmbed, active: () => activeYtPlayer };`);
  const api = make(...names.map((n) => env[n]));
  const zone = () => { const d = fakeEl(); attached.add(d); return d; };
  const fire = (p, kind, data, target = { getDuration: () => 0, playVideo() {}, mute() {}, unMute() {}, setVolume() {} }) =>
    p.cfg.events[kind]({ data, target });
  const liveTimers = () => timeouts.filter((t) => t.live);
  return { api, players, calls, timeouts, liveTimers, zone, fire, attached };
}

const item = (extra = {}) => ({ filename: 'v', duration_sec: 10, ...extra });
const realEnd = (h, p) => {
  // ENDED under 3 s of play is ignored as spurious, so start "playing" well in the past.
  const now = Date.now;
  Date.now = () => now() - 10_000; h.fire(p, 'onStateChange', 1); Date.now = now;
  h.fire(p, 'onStateChange', 0);
};

test('THE ZONE BUG: a zone video that ends moves its ZONE on, never the main playlist', () => {
  const h = embedHarness();
  let zoneAdvances = 0;
  h.api.createYoutubeEmbed('x', item(), h.zone(), { zone: true, loop: false, onEnded: () => { zoneAdvances++; } });
  realEnd(h, h.players[0]);
  assert.equal(zoneAdvances, 1);
  assert.equal(h.calls.next, 0, 'nextItem() was called: the fullscreen playlist moved');
});

test('a second YouTube zone no longer destroys the first one\'s player', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item(), h.zone(), { zone: true, loop: true, onEnded: null });
  h.api.createYoutubeEmbed('x', item(), h.zone(), { zone: true, loop: true, onEnded: null });
  assert.equal(h.players[0].destroyed, false);
});

test('a zone that moved on silences the player it held (token)', () => {
  const h = embedHarness();
  let zoneAdvances = 0;
  const div = h.zone();
  h.api.createYoutubeEmbed('x', item(), div, { zone: true, loop: false, onEnded: () => { zoneAdvances++; } });
  div.__stYtToken += 1;   // what showZoneItem does when the zone shows its next item
  realEnd(h, h.players[0]);
  assert.equal(zoneAdvances, 0);
});

test('a zone without play to end loops and leaves the moving on to the zone timer', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item(), h.zone(), { zone: true, loop: true, onEnded: null });
  const vars = h.players[0].cfg.playerVars;
  assert.equal(vars.loop, 1);
  realEnd(h, h.players[0]);
  assert.equal(h.calls.next, 0);
});

test('zone safety net: the reported length + 3 s, firing the zone\'s advance', () => {
  const h = embedHarness();
  let zoneAdvances = 0;
  h.api.createYoutubeEmbed('x', item(), h.zone(), { zone: true, loop: false, onEnded: () => { zoneAdvances++; } });
  h.fire(h.players[0], 'onReady', undefined, { getDuration: () => 95, playVideo() {}, mute() {}, unMute() {}, setVolume() {} });
  const t = h.liveTimers().find((x) => x.ms === 98_000);
  assert.ok(t, 'no length-based safety timer');
  t.fn();
  assert.equal(zoneAdvances, 1);
  assert.equal(h.calls.next, 0);
});

test('fullscreen: a play-to-end video with no reported length falls back to its duration', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1, duration_sec: 40 }), fakeEl());
  h.fire(h.players[0], 'onReady', undefined);   // getDuration() → 0
  const t = h.liveTimers().find((x) => x.ms === 40_000);
  assert.ok(t, 'a video whose ENDED never comes would hold the screen forever');
  t.fn();
  assert.equal(h.calls.next, 1);
});

test('fullscreen without the flag is unchanged: no length, no timer; ENDED still advances', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item(), fakeEl());
  h.fire(h.players[0], 'onReady', undefined);
  assert.equal(h.liveTimers().length, 0);
  realEnd(h, h.players[0]);
  assert.equal(h.calls.next, 1);
});

// ------------------------------------------------------------------ showZoneItem's choice

function zoneHarness() {
  const start = PLAYER.indexOf('    // #74/#75 zone-level schedule helpers.');
  const end = PLAYER.indexOf('    // ==================== Screenshots ====================', start);
  assert.ok(start > 0 && end > start);
  const src = PLAYER.slice(start, end);
  const embeds = [];
  const timeouts = [];
  const env = {
    zoneTimers: {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
    scheduleAllows: () => true,
    itemFit: () => 'contain',
    mediaUrl: () => 'https://www.youtube.com/embed/abc123',
    config: { serverUrl: '', deviceId: 'd1' },
    widgetSandboxAttr: () => '',
    createYoutubeEmbed: (s, a, div, opts) => { embeds.push({ a, div, opts }); },
    addWebpageNote: () => {},
    PREVIEW_MODE: false,
    document: { createElement: () => fakeEl() },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `${src}; return { showZoneItem };`);
  return { api: make(...names.map((n) => env[n])), env, embeds, timeouts };
}

const yt = (extra = {}) => ({ mime_type: 'video/youtube', remote_url: 'https://www.youtube.com/embed/abc123', duration_sec: 10, ...extra });

test('a play-to-end YouTube zone item ends on the video, with no 10 s zone timer', () => {
  const h = zoneHarness();
  h.api.showZoneItem({ id: 'z' }, fakeEl(), [yt({ play_to_end: 1 }), yt()], 0);
  const e = h.embeds[0];
  assert.equal(e.opts.zone, true);
  assert.equal(e.opts.loop, false);
  assert.equal(typeof e.opts.onEnded, 'function', 'the zone\'s advance is handed to the embed');
  assert.equal(h.env.zoneTimers.z, undefined, 'a fixed timer would still cut the video at 10 s');
});

test('without the flag a YouTube zone item loops and moves on at its duration, as before', () => {
  const h = zoneHarness();
  h.api.showZoneItem({ id: 'z' }, fakeEl(), [yt(), yt()], 0);
  const e = h.embeds[0];
  assert.equal(e.opts.loop, true);
  assert.equal(e.opts.onEnded, null);
  assert.ok(h.env.zoneTimers.z, 'the zone timer is still set');
  assert.equal(h.timeouts[h.env.zoneTimers.z - 1].ms, 10_000);
});

test('a one-item zone keeps looping even with the flag', () => {
  const h = zoneHarness();
  h.api.showZoneItem({ id: 'z' }, fakeEl(), [yt({ play_to_end: 1 })], 0);
  assert.equal(h.embeds[0].opts.loop, true);
  assert.equal(h.embeds[0].opts.onEnded, null);
});

test('every new zone item invalidates the YouTube player the zone held', () => {
  const h = zoneHarness();
  const div = fakeEl();
  h.api.showZoneItem({ id: 'z' }, div, [yt({ play_to_end: 1 }), yt()], 0);
  const t1 = div.__stYtToken;
  h.api.showZoneItem({ id: 'z' }, div, [yt({ play_to_end: 1 }), yt()], 1);
  assert.ok(div.__stYtToken > t1);
});
