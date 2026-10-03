'use strict';

// #142 step 3 — deterministic unit tests for the per-device reconnect throttle.
// Pure logic with injected `now` / band; isolate the DB before require (the module
// pulls in services/loop-lag -> db/database which initialises a DB on load).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-thr-unit-' + crypto.randomBytes(4).toString('hex'));

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const throttle = require('../lib/reconnect-throttle');

// config defaults: window=10000, baseMax=5, hardCeiling=20, baseBackoff=1000,
// maxBackoff=60000, releaseMs=30000, warmup=30000, elevMult=2, critMult=4.
const T0 = 1_000_000;            // arbitrary epoch-ms origin for the warm-up clock
const POST = T0 + 40_000;        // safely past the 30s warm-up
const WARM = T0 + 1_000;         // inside the warm-up window

beforeEach(() => throttle.__resetForTest({ startedAt: T0 }));

test('healthy device is never throttled (<= baseMax genuine reconnects)', () => {
  for (let i = 0; i < 5; i++) {
    const v = throttle.check('A', POST + i, 'normal');
    assert.ok(v.allow, `reconnect ${i + 1} (<=baseMax) must be allowed`);
  }
});

test('a per-device storm IS throttled and the backoff GROWS (tighten fast)', () => {
  let v;
  for (let i = 0; i < 5; i++) v = throttle.check('B', POST + i, 'normal'); // 5 allowed
  v = throttle.check('B', POST + 5, 'normal'); // 6th -> flagged
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'rate');
  assert.equal(v.observed, 6);
  assert.equal(v.allowed, 5);
  const b1 = v.retryAfterMs;
  /*
   * ⚠️ ESCALATION IS MEASURED ACROSS WINDOWS, NOT WITHIN ONE (#314).
   *
   * This used to hammer while blocked and assert the backoff grew on every attempt. That WAS the
   * behaviour, and it was the bug: each retry inside the window recomputed blockedUntil from now, so
   * a player reconnecting on its own timer pushed its own release away and never got back in — and
   * since a throttled register returns before the playlist push, "never got back in" is a screen
   * stuck on "Waiting for content" with all of its content already cached.
   *
   * Escalation still happens, and still tightens fast, against the device this defence is aimed at:
   * one that waits out the window and immediately storms again.
   */
  const stormAgain = (at) => {
    let last = null;
    for (let i = 0; i <= 6; i++) last = throttle.check('B', at + i, 'normal');
    return last;
  };
  const s2 = stormAgain(POST + 5 + b1 + 20_000);
  const s3 = stormAgain(POST + 5 + b1 + 20_000 + s2.retryAfterMs + 20_000);
  const b2 = s2.retryAfterMs;
  const b3 = s3.retryAfterMs;
  assert.ok(b2 > b1 && b3 > b2, `backoff must grow across windows: ${b1} < ${b2} < ${b3}`);

  /*
   * ...and within one window it counts DOWN, so the device can actually reach the far side of it.
   * On its own device id: 'B' has since been escalated by the storms above, and probing it at an
   * earlier instant would measure that later, larger window instead of the one under test.
   */
  let c = null;
  for (let i = 0; i <= 5; i++) c = throttle.check('C', POST + i, 'normal');
  assert.equal(c.allow, false, 'precondition: C is inside a window');
  const inside = throttle.check('C', POST + 6, 'normal');
  assert.equal(inside.reason, 'in-backoff');
  assert.ok(inside.retryAfterMs < c.retryAfterMs,
    `a retry inside the window must not extend it (${c.retryAfterMs} -> ${inside.retryAfterMs})`);
});

test('lag band multiplies an already-flagged device\'s backoff (critical > normal)', () => {
  let v;
  for (let i = 0; i < 5; i++) throttle.check('N', POST + i, 'normal');
  v = throttle.check('N', POST + 5, 'normal');
  const normalBackoff = v.retryAfterMs;

  throttle.__resetForTest({ startedAt: T0 });
  for (let i = 0; i < 5; i++) throttle.check('C', POST + i, 'critical');
  v = throttle.check('C', POST + 5, 'critical');
  assert.ok(v.retryAfterMs > normalBackoff, `critical backoff ${v.retryAfterMs} > normal ${normalBackoff}`);
});

test('a healthy device is NOT throttled even when the band is critical (lag never gates the healthy)', () => {
  for (let i = 0; i < 5; i++) {
    const v = throttle.check('H', POST + i, 'critical');
    assert.ok(v.allow, 'healthy device stays allowed regardless of band');
  }
});

test('COLD START: during warm-up, moderate flapping (>baseMax, <ceiling) is NOT throttled', () => {
  for (let i = 0; i < 12; i++) { // 12 > baseMax(5) but < hardCeiling(20)
    const v = throttle.check('W', WARM + i, 'critical'); // band forced normal in warm-up anyway
    assert.ok(v.allow, `warm-up reconnect ${i + 1} must be lenient`);
  }
});

test('HARD CEILING is enforced even during warm-up (slow-ramp cannot train through)', () => {
  let v;
  for (let i = 0; i < 20; i++) {
    v = throttle.check('K', WARM + i, 'normal');
    assert.ok(v.allow, `warm-up reconnect ${i + 1} (<=ceiling) allowed`);
  }
  v = throttle.check('K', WARM + 20, 'normal'); // 21st -> over ceiling(20)
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'hard-ceiling');
});

test('neighbor isolation: one device storming does not throttle another', () => {
  for (let i = 0; i < 10; i++) throttle.check('STORM', POST + i, 'normal'); // STORM gets throttled
  const v = throttle.check('NEIGHBOR', POST + 11, 'normal');
  assert.ok(v.allow, 'a different device must be unaffected');
});

test('release slow: escalation level decays after a calm period', () => {
  let v;
  for (let i = 0; i < 6; i++) v = throttle.check('R', POST + i, 'normal'); // flagged, level 1
  assert.ok(v.level >= 1);
  const peak = v.level;
  // a calm reconnect well past the window AND past releaseMs(30000)
  v = throttle.check('R', POST + 6 + 40_000, 'normal');
  assert.ok(v.allow, 'calm reconnect after the storm is allowed');
  assert.ok(v.level < peak, `level decays after calm: ${v.level} < ${peak}`);
});
