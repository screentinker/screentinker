'use strict';

// #87: unit tests for the pairing brute-force hardening (lockout + code expiry). Pure
// logic with injected time - deterministic and free of the /api/provision rate-limit's
// 5/min interference, which is the right level to assert this security behaviour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lk = require('../lib/pair-lockout');

const ip = () => 'test-' + crypto.randomUUID(); // unique IP per test (the map is module-level)

test('lockout: an IP is not locked until MAX_FAILS failed attempts', () => {
  const a = ip();
  assert.equal(lk.isLocked(a, 1000), false);
  for (let i = 0; i < lk.MAX_FAILS - 1; i++) lk.recordFailure(a, 1000);
  assert.equal(lk.isLocked(a, 1000), false, `still open after ${lk.MAX_FAILS - 1} fails`);
  lk.recordFailure(a, 1000); // the MAX_FAILS-th
  assert.equal(lk.isLocked(a, 1000), true, 'locked at MAX_FAILS');
});

test('lockout: the block lifts after LOCKOUT_MS', () => {
  const a = ip();
  for (let i = 0; i < lk.MAX_FAILS; i++) lk.recordFailure(a, 1000);
  assert.equal(lk.isLocked(a, 1000 + lk.LOCKOUT_MS - 1), true, 'still locked just before the window ends');
  assert.equal(lk.isLocked(a, 1000 + lk.LOCKOUT_MS + 1), false, 'unlocked after the window');
});

test('lockout: a successful pair forgives ONE failure, not the whole count (decoy bypass)', () => {
  // The bypass: claim a code of your own between guesses. Four guesses + one decoy success, over
  // and over, used to never lock because a success wiped the count.
  const a = ip();
  let guesses = 0;
  for (let round = 0; round < 10 && !lk.isLocked(a, 1000); round++) {
    for (let i = 0; i < lk.MAX_FAILS - 1 && !lk.isLocked(a, 1000); i++) { lk.recordFailure(a, 1000); guesses++; }
    lk.noteSuccess(a);
  }
  assert.equal(lk.isLocked(a, 1000), true, 'decoy successes no longer keep the IP open');
  assert.ok(guesses < 2 * lk.MAX_FAILS + 2, `locked after ${guesses} guesses`);
});

test('lockout: failures older than the window are forgotten', () => {
  const a = ip();
  for (let i = 0; i < lk.MAX_FAILS - 1; i++) lk.recordFailure(a, 1000);
  lk.recordFailure(a, 1000 + lk.LOCKOUT_MS + 1);
  assert.equal(lk.isLocked(a, 1000 + lk.LOCKOUT_MS + 1), false);
});

test('expiry: a code is claimable inside the TTL and expired after it', () => {
  const now = 1_000_000_000_000; // fixed ms
  const nowSec = Math.floor(now / 1000);
  assert.equal(lk.isCodeExpired(nowSec, now), false, 'a fresh code is valid');
  assert.equal(lk.isCodeExpired(nowSec - (lk.PAIRING_TTL_SEC - 5), now), false, 'still valid just inside the TTL');
  assert.equal(lk.isCodeExpired(nowSec - (lk.PAIRING_TTL_SEC + 5), now), true, 'expired just past the TTL');
});

test('lockout: a bulk rollout from one IP never locks (each successful pair forgives a typo)', () => {
  // The roofing-office scenario: many displays paired from one shared-NAT IP, with a fat-fingered
  // code before each, never trips the 5-fail lockout because each success forgives one failure.
  // (Expired codes don't count toward the lockout at all - see the /pair handler.)
  const office = ip();
  for (let i = 0; i < 20; i++) {
    lk.recordFailure(office, 1000); // a mistype before this display
    assert.equal(lk.isLocked(office, 1000), false, `display ${i}: still open after a mistype`);
    lk.noteSuccess(office); // the correct code pairs
  }
  assert.equal(lk.isLocked(office, 1000), false, 'all 20 displays paired, the IP never locked');
});
