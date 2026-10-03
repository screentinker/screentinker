'use strict';

/*
 * #314 — a throttled device has to be able to come back.
 *
 * ⚠️ WHY THIS IS A CONTENT BUG AND NOT A RATE-LIMITING DETAIL. A throttled `device:register`
 * returns in ws/deviceSocket.js BEFORE the playlist push, so a device inside the backoff window is
 * not merely slowed down — it is a screen showing "Waiting for content" with every byte of its
 * content already on disk. How long the window lasts IS how long the screen is dark.
 *
 * The original code escalated on every retry INSIDE the window: each attempt bumped the level and
 * recomputed blockedUntil from now. A player reconnects on its own timer (socket.io, 1s and
 * climbing) and has no idea it is pushing its own release away, so the state was self-sustaining —
 * measured on a live server as still-throttled after 70 seconds of total silence, having been told
 * to retry after 60. Reported from a real fleet after an OTA, where the post-update relaunch
 * cascade supplies the reconnect burst.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const throttle = require('../lib/reconnect-throttle');
const config = require('../config');

const MAX = config.reconnectBaseMax;

/*
 * ⚠️ EVERY CLOCK HERE STARTS PAST THE WARM-UP. During reconnectWarmupMs after process start only
 * the hard ceiling applies — deliberately, so a server restart does not throttle the fleet that is
 * reconnecting because of it. A test that uses the real `now` therefore never trips the rate limit
 * and passes while asserting nothing, which is exactly how this file failed first time.
 */
const BASE = () => Date.now() + config.reconnectWarmupMs + 60_000;

/*
 * Trip the limiter, returning the verdict AND the instant it was refused. The instant matters: the
 * backoff is measured from the moment of rejection, not from t0, and computing the release without
 * it is off by however many attempts it took to trip — which reads exactly like the bug under test.
 */
function trip(id, t0) {
  let last = null;
  let at = t0;
  for (let i = 0; i <= MAX + 1; i++) { at = t0 + i; last = throttle.check(id, at, 'normal'); }
  assert.equal(last.allow, false, 'precondition: the device is throttled');
  return { v: last, at, releaseAt: at + last.retryAfterMs };
}

test('waiting out the block, and letting the burst drain, gets you back in', () => {
  const id = 'dev-recovers-' + Math.random();
  const t0 = BASE();
  const { v: first } = trip(id, t0);

  /*
   * Two separate clocks have to elapse, and conflating them is easy: `blockedUntil` is the punishment
   * window, while `hits` is a sliding count over reconnectWindowMs. At low escalation levels the
   * backoff is SHORTER than that window, so honouring retry_after alone still lands on the rate path
   * with the original burst not yet aged out. Waiting the longer of the two is what actually recovers.
   */
  const wait = Math.max(first.retryAfterMs, config.reconnectWindowMs) + 1;
  assert.equal(throttle.check(id, t0 + wait, 'normal').allow, true,
    'a device that waited out both windows must be let back in — otherwise the screen never recovers');
});

test('retrying inside the block does not push the release further away', () => {
  const id = 'dev-no-slide-' + Math.random();
  const t0 = BASE();
  const { v: first, at: tripAt, releaseAt } = trip(id, t0);

  /*
   * Probes strictly INSIDE the window — that is the regression. Anything at or past releaseAt is
   * the rate path doing its job, which is a different question and is covered below.
   */
  for (const frac of [0.2, 0.4, 0.6, 0.85]) {
    const at = tripAt + Math.floor(first.retryAfterMs * frac);
    const v = throttle.check(id, at, 'normal');
    assert.equal(v.allow, false, 'inside the window it must still refuse');
    assert.equal(v.reason, 'in-backoff');
    assert.ok(at + v.retryAfterMs <= releaseAt + 1,
      `the release moved from ${releaseAt} to ${at + v.retryAfterMs} — this is the #314 loop`);
  }

  const wait = Math.max(first.retryAfterMs, config.reconnectWindowMs) + 1;
  assert.equal(throttle.check(id, t0 + wait, 'normal').allow, true,
    'hammering during the window must not have extended it');
});

test('the countdown it reports shrinks in step with real time', () => {
  const id = 'dev-countdown-' + Math.random();
  const t0 = BASE();
  const { v: first, at: tripAt } = trip(id, t0);
  const a = Math.floor(first.retryAfterMs * 0.25);
  const b = Math.floor(first.retryAfterMs * 0.75);

  const ra = throttle.check(id, tripAt + a, 'normal').retryAfterMs;
  const rb = throttle.check(id, tripAt + b, 'normal').retryAfterMs;
  assert.ok(rb < ra, `retry_after must count down (${ra} -> ${rb}); a client honouring it needs that`);
  assert.ok(Math.abs((ra - rb) - (b - a)) <= 2, 'it should track the clock, not be recomputed from scratch');
});

/*
 * ...and the protection still has to work. A device that genuinely storms — reconnecting hard the
 * moment each window expires — must still be caught and must still escalate, or fixing the recovery
 * would just remove the defence #142 exists to provide.
 */
test('a device that really is flapping is still caught, and still escalates', () => {
  const id = 'dev-storms-' + Math.random();
  let now = BASE();
  const { v: first } = trip(id, now);
  let level = first.level;

  for (let round = 0; round < 3; round++) {
    now += Math.max(first.retryAfterMs, config.reconnectWindowMs) + 10;                 // wait out the window...
    assert.equal(throttle.check(id, now, 'normal').allow, true, 'one attempt gets through');
    let v = null;                                    // ...then storm again immediately
    for (let i = 1; i <= MAX + 2; i++) v = throttle.check(id, now + i, 'normal');
    assert.equal(v.allow, false, 'a storming device is throttled again');
    assert.ok(v.level >= level, `escalation must not go backwards (${level} -> ${v.level})`);
    level = v.level;
  }
  assert.ok(level > first.level, 'repeat offenders must end up with a longer backoff than a one-off');
});
