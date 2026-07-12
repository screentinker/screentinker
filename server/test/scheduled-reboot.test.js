// #12 scheduled reboot: the pure `rebootDue` decision. Verifies the daily fire, the
// once-per-day guard, the 5-minute catch window (robust to 60s-tick drift), timezone
// evaluation (device-local, not server-local), and off/invalid schedules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rebootDue } = require('../services/scheduler');

// Build a UTC instant. rebootDue evaluates it in the DEVICE's tz.
const at = (iso) => new Date(iso);

test('fires when local clock is at the scheduled minute, not yet fired today', () => {
  // 03:00 UTC, schedule 03:00, no tz override -> server/UTC local.
  const r = rebootDue('03:00', 'UTC', at('2026-07-11T03:00:00Z'), null);
  assert.equal(r.due, true);
  assert.equal(r.today, '2026-07-11');
});

test('once-per-day guard: does not re-fire after already firing today', () => {
  const r = rebootDue('03:00', 'UTC', at('2026-07-11T03:01:00Z'), '2026-07-11');
  assert.equal(r.due, false);
});

test('catch window: still fires up to 4 min late (tick drift), not at +5', () => {
  assert.equal(rebootDue('03:00', 'UTC', at('2026-07-11T03:04:00Z'), null).due, true);
  assert.equal(rebootDue('03:00', 'UTC', at('2026-07-11T03:05:00Z'), null).due, false);
});

test('not due before the scheduled minute', () => {
  assert.equal(rebootDue('03:00', 'UTC', at('2026-07-11T02:59:00Z'), null).due, false);
});

test('evaluated in the device timezone, not the server clock', () => {
  // 07:00 UTC == 03:00 America/New_York (EDT, UTC-4 in July). Schedule 03:00 local should fire.
  const r = rebootDue('03:00', 'America/New_York', at('2026-07-11T07:00:00Z'), null);
  assert.equal(r.due, true);
  assert.equal(r.today, '2026-07-11'); // local date matches (still the 11th at 3am EDT)
  // At 07:00 UTC the server clock is 07:00 — a 07:00 schedule evaluated in the device zone is
  // 03:00 local, NOT 07:00, so it must NOT fire — proving we used the device zone.
  assert.equal(rebootDue('07:00', 'America/New_York', at('2026-07-11T07:00:00Z'), null).due, false);
});

test('local-date rollover: a fire just after local midnight stamps the new day', () => {
  // 04:30 UTC == 00:30 EDT on 2026-07-11; schedule 00:30 local.
  const r = rebootDue('00:30', 'America/New_York', at('2026-07-11T04:30:00Z'), '2026-07-10');
  assert.equal(r.due, true);
  assert.equal(r.today, '2026-07-11');
});

test('off / invalid schedules are never due', () => {
  for (const s of [null, '', undefined, '25:00', '3:00', 'abc', '03:60']) {
    assert.equal(rebootDue(s, 'UTC', at('2026-07-11T03:00:00Z'), null).due, false);
  }
});
