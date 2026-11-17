'use strict';

/*
 * A YouTube item must never stall the playlist when the IFrame API or the embed cannot load.
 *
 * Every advance for a YouTube item (the duration timer, the #215 safety net, ENDED) used to be armed
 * inside the loadYoutubeApi callback or YT onReady. renderContent clears advanceTimer before the
 * embed, so if https://www.youtube.com/iframe_api failed to load (offline, blocked) the callback
 * never ran and the screen held the item forever. The failed <script id="yt-api-script"> also stayed
 * in the DOM, so no later item ever retried. And with the API loaded but the embed iframe unable to
 * load, onReady never fired, so a play-to-end item had no timer at all.
 *
 * These run the real loadYoutubeApi / createYoutubeEmbed from index.html against fakes.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function fakeEl(extra = {}) {
  return {
    style: {}, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, querySelectorAll: () => [],
    set innerHTML(_v) {}, get innerHTML() { return ''; }, addEventListener() {}, remove() {}, ...extra,
  };
}

function fakeTimers() {
  const timeouts = [];
  return {
    timeouts,
    live: () => timeouts.filter((t) => t.live),
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms, live: true }); return timeouts.length; },
    clearTimeout: (id) => { if (id && timeouts[id - 1]) timeouts[id - 1].live = false; },
  };
}

// ------------------------------------------------------------------ loadYoutubeApi

function loaderHarness() {
  const start = PLAYER.indexOf('    function loadYoutubeApi(');
  const end = PLAYER.indexOf('    /*\n     * opts.zone (#624)', start);
  assert.ok(start > 0 && end > start, 'loadYoutubeApi is still in index.html');
  const src = PLAYER.slice(start, end);
  const t = fakeTimers();
  const head = [];
  const document = {
    head: { appendChild(el) { el.isConnected = true; head.push(el); } },
    createElement: () => {
      const el = fakeEl();
      el.remove = () => { el.isConnected = false; const i = head.indexOf(el); if (i >= 0) head.splice(i, 1); };
      return el;
    },
    getElementById: (id) => head.find((el) => el.id === id) || null,
  };
  const window = {};
  const env = { document, window, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, console: { log() {}, warn() {}, error() {} } };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `let ytApiReady = false, ytApiCallbacks = [];\n${src}\nreturn { loadYoutubeApi, pending: () => ytApiCallbacks.length };`);
  return { api: make(...names.map((n) => env[n])), head, window, timers: t };
}

test('a script that fails to load fails the waiting embeds and is removed, so the next item retries', () => {
  const h = loaderHarness();
  let ok = 0, failed = 0;
  h.api.loadYoutubeApi(() => { ok++; }, () => { failed++; });
  h.api.loadYoutubeApi(() => { ok++; }, () => { failed++; });
  assert.equal(h.head.length, 1);
  h.head[0].onerror();
  assert.equal(failed, 2, 'the pending embeds were never told the API is not coming');
  assert.equal(ok, 0);
  assert.equal(h.api.pending(), 0, 'ytApiCallbacks grows on every YouTube item');
  assert.equal(h.head.length, 0, 'the failed <script id="yt-api-script"> stays and blocks every retry');
  h.api.loadYoutubeApi(() => { ok++; }, () => { failed++; });
  assert.equal(h.head.length, 1, 'a later item retries the load');
  h.window.onYouTubeIframeAPIReady();
  assert.equal(ok, 1);
  assert.equal(failed, 2);
});

test('a load that never becomes ready times out the same way', () => {
  const h = loaderHarness();
  let failed = 0;
  h.api.loadYoutubeApi(() => {}, () => { failed++; });
  const t = h.timers.live();
  assert.equal(t.length, 1, 'no timeout on the API load');
  t[0].fn();
  assert.equal(failed, 1);
  assert.equal(h.head.length, 0);
  assert.equal(h.api.pending(), 0);
  // A ready that arrives late after the timeout does not re-run the failed callbacks.
  h.window.onYouTubeIframeAPIReady && h.window.onYouTubeIframeAPIReady();
  assert.equal(failed, 1);
});

test('a ready API clears the timeout and later calls run at once', () => {
  const h = loaderHarness();
  let ok = 0, failed = 0;
  h.api.loadYoutubeApi(() => { ok++; }, () => { failed++; });
  h.window.onYouTubeIframeAPIReady();
  assert.equal(ok, 1);
  assert.equal(h.timers.live().length, 0, 'the load timeout is still armed after ready');
  h.api.loadYoutubeApi(() => { ok++; }, () => { failed++; });
  assert.equal(ok, 2);
  assert.equal(failed, 0);
});

// ------------------------------------------------------------------ createYoutubeEmbed

function embedHarness({ playlistLength = 3, api = 'hang' } = {}) {
  const start = PLAYER.indexOf('    function createYoutubeEmbed(');
  const end = PLAYER.indexOf('    // Stop and release all media in the player.', start);
  assert.ok(start > 0 && end > start, 'createYoutubeEmbed is still in index.html');
  const src = PLAYER.slice(start, end);
  const t = fakeTimers();
  const players = [];
  const calls = { next: 0 };
  const loader = { ok: null, fail: null };
  const env = {
    extractVideoId: () => 'abc123',
    cancelPlaybackResume: () => {},
    document: { createElement: () => fakeEl(), contains: () => true },
    window: { location: { origin: 'https://st.example' } },
    muteState: () => ({}), userHasInteracted: true, unlockAudio: () => {}, applyMute: () => {},
    applyMuteWanted: () => true, mediaVolume: null,
    // 'hang': the script never loads and never errors; 'ready': loaded (but the embed never readies).
    loadYoutubeApi: (cb, onFail) => { loader.ok = cb; loader.fail = onFail; if (api === 'ready') cb(); },
    playlist: Array.from({ length: playlistLength }, () => ({})),
    YT: { Player: function (id, cfg) { const p = { id, cfg, destroy() {} }; players.push(p); return p; } },
    nextItem: () => { calls.next++; },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
    Date,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `let ytGeneration = 0, ytSafetyNet = null, activeYtPlayer = null;\n${src}\nreturn { createYoutubeEmbed };`);
  return { api: make(...names.map((n) => env[n])), players, calls, timers: t, loader };
}

const item = (extra = {}) => ({ filename: 'v', duration_sec: 10, ...extra });
const fireAll = (h) => { for (const t of h.timers.live()) t.fn(); };

test('API never loads: a duration item still moves on at its duration', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item({ duration_sec: 25 }), fakeEl());
  assert.deepEqual(h.timers.live().map((t) => t.ms), [25_000], 'no advance armed while the API loads');
  fireAll(h);
  assert.equal(h.calls.next, 1);
});

test('API never loads: a play-to-end item still has a generous cap', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1, duration_sec: 10 }), fakeEl());
  const live = h.timers.live();
  assert.equal(live.length, 1, 'a play-to-end item holds the screen forever');
  assert.ok(live[0].ms >= 30_000, 'the cap must leave room for a slow API/embed load');
  fireAll(h);
  assert.equal(h.calls.next, 1);
});

test('API load fails: the item is skipped like an unplayable video', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1 }), fakeEl());
  assert.equal(typeof h.loader.fail, 'function', 'createYoutubeEmbed hands loadYoutubeApi no failure path');
  h.loader.fail();
  assert.deepEqual(h.timers.live().map((t) => t.ms), [2000]);
  fireAll(h);
  assert.equal(h.calls.next, 1);
});

test('API load fails for a superseded embed: nothing advances', () => {
  const h = embedHarness();
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1 }), fakeEl());
  const staleFail = h.loader.fail;
  h.api.createYoutubeEmbed('x', item({ duration_sec: 20 }), fakeEl());
  staleFail();
  assert.deepEqual(h.timers.live().map((t) => t.ms), [20_000], 'the stale failure replaced the new item\'s timer');
});

test('a one-item playlist keeps looping: no cap, no skip on API failure', () => {
  const h = embedHarness({ playlistLength: 1 });
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1 }), fakeEl());
  h.loader.fail();
  assert.equal(h.timers.live().length, 0);
  assert.equal(h.calls.next, 0);
});

test('API loaded but the embed never readies (offline iframe): a play-to-end item still moves on', () => {
  const h = embedHarness({ api: 'ready' });
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1, duration_sec: 10 }), fakeEl());
  assert.equal(h.players.length, 1);
  assert.equal(h.timers.live().length, 1, 'onReady never fires and no timer was armed');
  fireAll(h);
  assert.equal(h.calls.next, 1);
});

test('onReady replaces the cap with the real length + 3 s', () => {
  const h = embedHarness({ api: 'ready' });
  h.api.createYoutubeEmbed('x', item({ play_to_end: 1, duration_sec: 10 }), fakeEl());
  h.players[0].cfg.events.onReady({ target: { getDuration: () => 600, playVideo() {}, mute() {}, unMute() {}, setVolume() {} } });
  assert.deepEqual(h.timers.live().map((t) => t.ms), [603_000]);
});
