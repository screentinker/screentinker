'use strict';

/*
 * A media error used to advance the playlist once PER ERROR EVENT.
 *
 * Found on a BrightSign XT245 the day the live debug log started working, which is the only reason
 * anyone saw it: a 40s clip on a SINGLE-item playlist logged four `Video error` events at each loop
 * boundary and then three back-to-back "Playing:" lines, with `play() rejected AbortError` and
 * `muted-fallback play() also failed` in between as the second mount aborted the first. On a
 * one-item playlist that just re-plays the same file, so it looked like nothing.
 *
 * On a REAL playlist the identical storm skips one item per surplus event. Silently. The operator
 * sees a playlist that drops content and nothing anywhere says why.
 *
 * Two independent defects produced it:
 *
 *   1. `video.onerror` had no once-guard (its sibling in the buffered path has `if (done) return`),
 *      so every event scheduled its own `nextItem`.
 *   2. Every call site wrote `advanceTimer = setTimeout(...)` DIRECTLY. A second write before the
 *      first fired ORPHANED the earlier timer rather than cancelling it — still pending, no longer
 *      referenced, so `renderContent`'s `clearTimeout(advanceTimer)` could only ever cancel the
 *      last one. All the others fired.
 *
 * (2) is the more dangerous half: it made every one of a dozen call sites capable of leaking a
 * timer, not just the error handlers.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PLAYER = fs.readFileSync(path.join(ROOT, 'server/player/index.html'), 'utf8');

/*
 * Run the real helpers with a fake clock, so "how many advances happened" is a fact rather than a
 * reading of the source.
 */
function harness() {
  const src = PLAYER.slice(PLAYER.indexOf('let advanceTimer = null;'), PLAYER.indexOf('// Buffered widget swap'));
  const timers = new Map();
  let seq = 0;
  const advances = [];
  const logs = [];
  const env = {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },   // seq = total ever armed
    clearTimeout: (id) => { timers.delete(id); },
    nextItem: () => advances.push(true),
    console: { error: (m) => logs.push(['e', m]), warn: (m) => logs.push(['w', m]), log: (m) => logs.push(['i', m]) },
  };
  const api = new Function(
    'setTimeout', 'clearTimeout', 'nextItem', 'console',
    `${src}; return { scheduleAdvance, mediaFailureSkip, pending: () => arguments };`,
  )(env.setTimeout, env.clearTimeout, env.nextItem, env.console);

  return {
    ...api,
    advances,
    logs,
    fireAll() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
    pendingCount: () => timers.size,
    armedEver: () => seq,
  };
}

const mediaError = (code) => ({ code, message: '' });

test('four error events on one clip cause ONE advance, not four', () => {
  // The exact sequence the XT245 produced.
  const h = harness();
  const video = { error: mediaError(3), readyState: 0 };
  for (let i = 0; i < 4; i++) h.mediaFailureSkip(video, 'video', 'clip.mp4');
  assert.equal(h.pendingCount(), 1, 'only one advance may be pending');
  h.fireAll();
  assert.equal(h.advances.length, 1, `four errors advanced the playlist ${h.advances.length} times`);
});

test('...which is what stops a real playlist silently dropping items', () => {
  // Stated separately because this is the customer-visible consequence, and it is the reason the
  // one-item repro was worth chasing at all.
  const h = harness();
  const video = { error: mediaError(2), readyState: 0 };
  for (let i = 0; i < 7; i++) h.mediaFailureSkip(video, 'video', 'clip.mp4');
  h.fireAll();
  assert.equal(h.advances.length, 1, 'a 10-item playlist would otherwise skip 6 items');
});

test('the FIRST failure wins: later events cannot postpone the skip', () => {
  /*
   * This is what the once-guard buys that clear-before-arm does not.
   *
   * `scheduleAdvance` cancels the outgoing timer, so N errors already collapse to ONE advance. But
   * without the guard, each error also RE-ARMS the 3s skip — so a clip erroring faster than every
   * 3 seconds pushes its own skip out forever and wedges the playlist on a broken item, which is
   * the exact failure the 3s skip exists to prevent. Counting armings, not advances, is the only
   * assertion that can tell those two implementations apart.
   */
  const h = harness();
  const video = { error: mediaError(3), readyState: 0 };
  for (let i = 0; i < 4; i++) h.mediaFailureSkip(video, 'video', 'clip.mp4');
  assert.equal(h.armedEver(), 1, `the skip must be armed once, not re-armed per event (armed ${h.armedEver()}x)`);
});

test('and it is reported once, not once per event', () => {
  // The live debug log is fed by console.*, so a handler that logs per event turns one broken clip
  // into a flood in the panel an operator opened to find it.
  const h = harness();
  const video = { error: mediaError(3), readyState: 0 };
  for (let i = 0; i < 6; i++) h.mediaFailureSkip(video, 'video', 'clip.mp4');
  assert.equal(h.logs.filter(([lv]) => lv === 'e').length, 1);
});

test('the MediaError code is reported, because "Video error" alone explains nothing', () => {
  // The original line logged the DOM event ({"isTrusted":true}) and never touched el.error, so the
  // live log could say a video failed but never why.
  const h = harness();
  h.mediaFailureSkip({ error: mediaError(3), readyState: 0 }, 'video', 'clip.mp4');
  const line = h.logs.find(([lv]) => lv === 'e')[1];
  assert.match(line, /code=3/);
  assert.match(line, /DECODE/, 'the code must be named — nobody remembers the MediaError numbers');
  assert.match(line, /clip\.mp4/);
});

test('a playable element that raises a bare error is NOT thrown away', () => {
  // `error` fires with el.error set. An event carrying no MediaError against an element with
  // frames buffered ahead of it did not fail at anything, and discarding a healthy item on that
  // basis is worse than the event being reacted to.
  const h = harness();
  h.mediaFailureSkip({ error: null, readyState: 4 }, 'video', 'clip.mp4');
  h.fireAll();
  assert.equal(h.advances.length, 0, 'a still-playing video must not be skipped');
  assert.match(h.logs.find(([lv]) => lv === 'w')[1], /no MediaError while playable/, 'but it must be visible');
});

test('THE BICONDITIONAL: something genuinely unplayable is still skipped', () => {
  // The guard above must not become a way for a broken clip to stall the playlist forever. No
  // MediaError AND nothing decoded is a failure.
  const h = harness();
  h.mediaFailureSkip({ error: null, readyState: 0 }, 'video', 'clip.mp4');
  h.fireAll();
  assert.equal(h.advances.length, 1, 'an undecodable clip must never wedge the playlist');
});

test('the load/watchdog path has no element and still skips', () => {
  const h = harness();
  h.mediaFailureSkip(null, 'image', 'broken.png');
  h.fireAll();
  assert.equal(h.advances.length, 1);
});

test('a follower is told nothing to advance — the leader drives it', () => {
  const h = harness();
  h.mediaFailureSkip({ error: mediaError(4), readyState: 0 }, 'video', 'clip.mp4', false);
  h.fireAll();
  assert.equal(h.advances.length, 0, 'a follower advancing itself would desync the wall');
  assert.ok(h.logs.some(([lv]) => lv === 'e'), 'but the failure is still reported');
});

// ---------------------------------------------------------------- the orphaned-timer class

test('arming twice cancels the first timer instead of orphaning it', () => {
  const h = harness();
  h.scheduleAdvance(() => {}, 1000);
  h.scheduleAdvance(() => {}, 2000);
  assert.equal(h.pendingCount(), 1, 'the first timer must be cancelled, not abandoned still-pending');
});

test('every call site goes through the helper — one leak is enough to bring the bug back', () => {
  // The generic fix. A dozen sites wrote the timer directly; any one of them re-introduced by hand
  // restores a timer that renderContent cannot cancel.
  const body = PLAYER.slice(PLAYER.indexOf('function scheduleAdvance'));
  const direct = body.split('\n').filter((l) => /advanceTimer\s*=\s*setTimeout\(/.test(l));
  assert.equal(direct.length, 1, `only scheduleAdvance itself may assign the timer; found ${direct.length}:\n${direct.join('\n')}`);
  assert.match(PLAYER.slice(PLAYER.indexOf('function scheduleAdvance'), PLAYER.indexOf('const MEDIA_ERR_NAME')),
    /if \(advanceTimer\) clearTimeout\(advanceTimer\)/, 'the helper must clear before it arms');
});

test('every media error handler goes through the shared skip', () => {
  // Four handlers existed (buffered + non-buffered, video + image) and they had drifted apart:
  // only one carried a once-guard. Four copies is how they drifted in the first place.
  // (The two video copies have since merged into wireSoloVideoPlayback; the marker below is its
  // shared wiring — the assertion is still that no handler skips mediaFailureSkip.)
  for (const marker of ["video.onerror = () => mediaFailureSkip(video, 'video', src, o.mayAdvance)",
                        "img.onerror = () => mediaFailureSkip(img, 'image', src, !isFollower)",
                        "mediaFailureSkip(video, 'video(buffered)', src)",
                        "mediaFailureSkip(null, 'image', src)"]) {
    assert.ok(PLAYER.includes(marker), `handler not routed through the shared skip: ${marker}`);
  }
  assert.ok(!/console\.error\('Video error:'/.test(PLAYER), 'the old unguarded handler must be gone');
  assert.ok(!/console\.error\('Image error'\)/.test(PLAYER), 'and its image twin');
});
