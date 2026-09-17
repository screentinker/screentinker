'use strict';

// #144 — OTA-check circuit-breaker + phantom guard. Deterministic unit tests with
// injected `now` (no waiting), covering the required cases (a)-(f). No DB/socket;
// the breaker module is pure + in-memory.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ota = require('../lib/ota-breaker');

const LATEST = '1.9.2-beta4';   // simulate the beta4 server
const T0 = 1_000_000;
beforeEach(() => ota.reset());

test('semver comparator: real-older < latest, same-core beta order, equal/newer', () => {
  assert.equal(ota.cmp('1.7.12', LATEST) < 0, true, '1.7.12 older');
  assert.equal(ota.cmp('1.9.2-beta3', LATEST) < 0, true, 'beta3 < beta4 (same core)');
  assert.equal(ota.cmp('1.9.2-beta4', LATEST), 0, 'equal');
  assert.equal(ota.cmp('1.9.3', LATEST) > 0, true, 'newer core');
  assert.equal(ota.cmp('banana', LATEST), null, 'garbage unparseable');
});

test('(a) PHANTOM/unrecognized -> instant no-offer, no grace, no rate state', () => {
  // superseded old-core prerelease (strobe's 1.9.1-beta4) — caught on the FIRST check
  let v = ota.decide('1.9.1-beta4', LATEST, null, T0);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'superseded-prerelease');
  // garbage string
  v = ota.decide('banana', LATEST, null, T0);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'unrecognized-version');
  // never offer a downgrade
  assert.equal(ota.decide('1.9.3', LATEST, null, T0).update_available, false);
});

test('(b) fast loop (every 15s) trips within ~3 checks / ~45s, NOT minutes', () => {
  const r = (dt) => ota.decide('1.7.12', LATEST, null, T0 + dt);
  assert.equal(r(0).update_available, true, 'check1 offered');
  assert.equal(r(15_000).update_available, true, 'check2 offered');
  assert.equal(r(30_000).update_available, true, 'check3 offered');
  const trip = r(45_000);
  assert.equal(trip.update_available, false, 'check4 (~45s) trips');
  assert.equal(trip.reason, 'rate-backoff');
  assert.ok(trip.retry_after_seconds >= 1, 'backoff has a retry hint');
});

test('(c) healthy straggler on beta3, polling every 12 min, is ALWAYS offered beta4 (rollout NOT throttled)', () => {
  for (let i = 0; i < 6; i++) {
    const v = ota.decide('1.9.2-beta3', LATEST, null, T0 + i * 12 * 60_000);
    assert.equal(v.update_available, true, `12-min poll #${i + 1} still offered`);
    assert.equal(v.reason, 'offer');
  }
});

test('(d) a device that APPLIES the update (version advances) is never throttled', () => {
  // it was looping/being offered on the old version...
  ota.decide('1.7.12', LATEST, 'devX', T0);
  ota.decide('1.7.12', LATEST, 'devX', T0 + 1000);
  // ...then it applies -> now reports latest
  const v = ota.decide(LATEST, LATEST, 'devX', T0 + 2000);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'up-to-date');     // up-to-date, NOT rate-backoff
});

test('(e) device_id looping is throttled PER-DEVICE; another device on the same version is unaffected', () => {
  const loopA = (dt) => ota.decide('1.7.12', LATEST, 'A', T0 + dt);
  loopA(0); loopA(15_000); loopA(30_000);
  assert.equal(loopA(45_000).update_available, false, 'device A trips');
  // device B, same version, checking normally -> its own key, still offered
  assert.equal(ota.decide('1.7.12', LATEST, 'B', T0 + 46_000).update_available, true, 'device B unaffected');
});

test('(f) legacy client without device_id is caught by the version-keyed path (and lumps per version)', () => {
  // two legacy devices, no device_id, same version -> share the v:1.7.12 bucket
  const v = (dt) => ota.decide('1.7.12', LATEST, null, T0 + dt);
  assert.equal(v(0).update_available, true);
  assert.equal(v(10_000).update_available, true);
  assert.equal(v(20_000).update_available, true);
  assert.equal(v(30_000).update_available, false, 'combined version-keyed rate trips without any device_id');
});

test('(scope) slow drip: offered a bounded number of times, then held off (#144 option-3, added for #341)', () => {
  /*
   * SCOPE CHANGED. #144 shipped fast-flood + phantom protection only and recorded here that the
   * slow drip "needs #144 option-3 skip-after-N, not included here". #341 is the field evidence
   * that it was needed: two displays polling every ~15 min reinstalled the same APK 493 times
   * across five days, far under the rate threshold, with nothing failing anywhere to back it off.
   *
   * So a slow poller is still offered - a rollout is not throttled - but not forever.
   */
  for (let i = 0; i < 6; i++) {
    const v = ota.decide('1.7.12', LATEST, null, T0 + i * 12 * 60_000);
    assert.equal(v.update_available, true, `12-min drip poll #${i + 1} still offered`);
    assert.equal(v.reason, 'offer');
  }
  const held = ota.decide('1.7.12', LATEST, null, T0 + 6 * 12 * 60_000);
  assert.equal(held.update_available, false, 'the same target stops being offered once it plainly is not landing');
  assert.equal(held.reason, 'no-progress');
});

test('(scope) progress resets the budget: a device that moves version is never held off', () => {
  for (let i = 0; i < 8; i++) ota.decide('1.7.12', LATEST, 'devP', T0 + i * 12 * 60_000);
  assert.equal(ota.decide('1.7.12', LATEST, 'devP', T0 + 8 * 12 * 60_000).reason, 'no-progress');
  // The operator corrects the served APK, so the advertised target changes: budget resets.
  const v = ota.decide('1.7.12', '1.9.3', 'devP', T0 + 9 * 12 * 60_000);
  assert.equal(v.update_available, true); assert.equal(v.reason, 'offer');
});

test('state Map is bounded: sweep() evicts idle buckets, keeps recent', () => {
  ota.decide('1.7.12', LATEST, 'old', T0);                 // bucket d:old, lastSeen=T0
  const now = T0 + 2 * 60 * 60_000;                        // 2h later
  ota.decide('1.7.12', LATEST, 'recent', now - 60_000);   // bucket d:recent, lastSeen=now-1min
  assert.equal(ota._size(), 2, 'two buckets');
  const removed = ota.sweep(now);
  assert.equal(removed, 1, 'the 2h-idle bucket is evicted');
  assert.equal(ota._size(), 1, 'the recent bucket is kept (no unbounded growth)');
});

test('exponential backoff escalates across cooldowns (30s -> 2m)', () => {
  const r = (dt) => ota.decide('1.7.12', LATEST, 'esc', T0 + dt);
  r(0); r(15_000); r(30_000);
  const t1 = r(45_000);                 // first trip
  assert.equal(t1.retry_after_seconds, 30, 'first cooldown 30s');
  // after the 30s cooldown elapses, flood again -> next cooldown (2m)
  const base = 45_000 + 31_000;
  r(base); r(base + 1000); r(base + 2000);
  const t2 = r(base + 3000);
  assert.equal(t2.update_available, false);
  assert.equal(t2.retry_after_seconds, 120, 'second cooldown escalates to 2m');
});

// ---- follow-up: a stranded diag/prerelease build must be rescuable by FORCE (auto-holds intact) ----
//
// A device on 1.9.10-diag1 while prod ships 2.1.0 hit reason 'superseded-prerelease' and could not
// self-recover: even the dashboard "force update" silently reported "already latest", because the
// client's forced check hit this same endpoint and got the same hold. #144's automatic phantom
// protection is deliberate (don't chase abandoned betas), so the fix is the ESCAPE HATCH, not
// removing the hold: an operator-forced check overrides the holds for a genuine upgrade.

const REL = '2.1.0';   // a clean RELEASE latest (prod)

test('an old prerelease is STILL held automatically (phantom protection unchanged)', () => {
  // Auto-check: 1.9.10-diag1 vs stable 2.1.0 is held, exactly as before this change.
  const v = ota.decide('1.9.10-diag1', REL, null, T0);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'superseded-prerelease');
});

test('FORCED overrides the superseded-prerelease hold for a genuine upgrade', () => {
  // The field case, forced: 1.9.10-diag1 -> 2.1.0 now offers instead of the silent no-op.
  const v = ota.decide('1.9.10-diag1', REL, null, T0, false, false, /*forced*/ true);
  assert.equal(v.update_available, true, 'force update rescues a stranded diag build');
  assert.equal(v.reason, 'forced-override');
});

test('FORCED also beats a rate-backoff, but never a downgrade or a same-version reinstall', () => {
  // Trip the breaker, confirm it holds, then force through it.
  const key = 'devF';
  for (let i = 0; i < 6; i++) ota.decide('1.7.12', LATEST, key, T0 + i * 1000);   // flood -> backoff
  assert.equal(ota.decide('1.7.12', LATEST, key, T0 + 7000).reason, 'rate-backoff');
  const forcedThrough = ota.decide('1.7.12', LATEST, key, T0 + 8000, false, false, true);
  assert.equal(forcedThrough.update_available, true, 'a human force-update beats the backoff');
  assert.equal(forcedThrough.reason, 'forced-override');

  // Forced does NOT push a downgrade (client genuinely newer on a release).
  assert.equal(ota.decide('2.2.0', REL, null, T0, false, false, true).update_available, false, 'no forced downgrade');
  // Forced on the current version is still nothing-to-do (never a same-version reinstall loop).
  assert.equal(ota.decide(REL, REL, null, T0, false, false, true).reason, 'up-to-date');
  // Forced cannot conjure an offer from an unparseable version.
  assert.equal(ota.decide('banana', REL, null, T0, false, false, true).update_available, false);
});
