'use strict';

/*
 * A YouTube item on a video-WALL FOLLOWER (or a synced GROUP member) kept restarting every ~10s.
 *
 * A follower takes its playlist index only from the leader's wall:sync (a group member from the
 * shared clock). But createYoutubeEmbed wired the YouTube end-of-video advance (onStateChange ENDED
 * and the #215 safety-net timer) straight to nextItem with no follower guard — unlike the <video>
 * path, which is gated. So when the follower's YouTube ended (or the net fired; getDuration() is
 * often 0 on a muted, cropped, background embed, so it falls back to duration_sec, 10s by default)
 * the follower advanced its index, diverged from the leader, and the next wall:sync snapped it back
 * by re-mounting the item — which looks exactly like the video restarting on a loop.
 *
 * This drives the real createYoutubeEmbed with a stubbed YouTube IFrame API and asserts that a
 * follower neither arms the safety net nor advances on ENDED, while a leader still does both.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SRC = (() => {
  const a = PLAYER.indexOf('function createYoutubeEmbed');
  const b = PLAYER.indexOf('function loadImageCors', a);
  assert.ok(a > 0 && b > a, 'could not slice createYoutubeEmbed');
  return PLAYER.slice(a, b);
})();

// Build an isolated context that runs the real function with everything it touches stubbed. The
// Proxy with has()=>true keeps any symbol we did not stub from throwing ReferenceError; the paths
// exercised here only need the handful of functions wired below.
function run({ follower = false, group = false }) {
  const calls = { advances: 0, armedMs: [] };
  let ytEvents = null;
  let nowMs = 1_000_000;

  const fakeYtPlayer = {
    playVideo() {}, mute() {}, unMute() {}, setVolume() {}, destroy() {},
    getDuration() { return 0; },           // the follower-restart trigger: duration unknown -> net falls back to duration_sec
    setPlaybackQuality() {}, loadModule() {}, setOption() {},
  };
  const el = () => ({ style: {}, id: '', appendChild() {}, setAttribute() {}, remove() {} });

  const stubs = {
    // gating inputs under test
    isWallFollower: () => follower,
    groupSync: group ? { group_id: 'g1' } : null,
    // the advance sink + the safety-net arm we observe
    nextItem: () => { calls.advances++; },
    setTimeout: (fn, ms) => { calls.armedMs.push(ms); return calls.armedMs.length; },
    clearTimeout() {},
    // YouTube API + loader
    loadYoutubeApi: (cb) => cb(),
    YT: { Player: function (id, cfg) { ytEvents = cfg.events; return fakeYtPlayer; } },
    extractVideoId: () => 'VIDEOID',
    // misc the function reaches for on these paths
    document: { createElement: el },
    window: { location: { origin: 'http://test.local', search: '' } },
    location: { origin: 'http://test.local', search: '' },
    URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    Date: { now: () => nowMs },
    playlist: [{}, {}],                     // length 2 so the single-item loop path is off
    cancelPlaybackResume() {},
    applyMuteWanted: () => true,
    applyMute() {},
    muteState: () => ({}),
    mediaVolume: null,
    userHasInteracted: true,                // so no click-to-unmute overlay path
    // mutable outer vars the function reads/writes
    ytGeneration: 0,
    activeYtPlayer: null,
    ytSafetyNet: null,
  };
  // has()=>true routes every identifier through this Proxy (so unstubbed names don't ReferenceError);
  // get falls back to the real built-ins (Math, Number, Object, ...) for anything we didn't stub.
  const ctx = new Proxy(stubs, { has: () => true, get: (t, k) => (k in t ? t[k] : globalThis[k]) });
  vm.runInNewContext(SRC, ctx);

  const item = { filename: 'clip', mime_type: 'video/youtube', play_to_end: true, duration_sec: 10 };
  ctx.createYoutubeEmbed('https://youtu.be/VIDEOID', item, el(), {});
  assert.ok(ytEvents, 'YT.Player events were not wired');

  // onReady arms the safety net (or not); then simulate a real play -> ended, past the 3s spurious guard.
  ytEvents.onReady({ target: fakeYtPlayer });
  ytEvents.onStateChange({ data: 1 });      // playing: stamps playStartTime = now
  nowMs += 5000;
  ytEvents.onStateChange({ data: 0 });      // ENDED

  return calls;
}

test('a wall follower neither arms the YouTube safety net nor advances on ENDED', () => {
  const r = run({ follower: true });
  assert.equal(r.advances, 0, 'follower must not self-advance (the leader drives the index)');
  assert.ok(!r.armedMs.includes(10000), 'follower must not arm the 10s safety net');
});

test('a synced group member also does not self-advance', () => {
  const r = run({ group: true });
  assert.equal(r.advances, 0, 'group member must not self-advance (the shared clock drives the index)');
  assert.ok(!r.armedMs.includes(10000), 'group member must not arm the safety net');
});

test('a leader (not follower, not group) still arms the net and advances on ENDED', () => {
  const r = run({ follower: false, group: false });
  assert.ok(r.armedMs.includes(10000), 'leader arms the #215 safety net from duration_sec when duration is unknown');
  assert.equal(r.advances, 1, 'leader advances when its YouTube video ends');
});
