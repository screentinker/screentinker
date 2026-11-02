'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../lib/offline-schedule-plan');
const { makeClock } = require('../lib/local-clock');

const H = 60 * 60 * 1000;
const at = (hour, minute = 0) => Date.UTC(2026, 0, 1, hour, minute);
function pick(schedules, now) {
  const m = now.getUTCMinutes() + now.getUTCHours() * 60;
  return schedules.find((s) => m >= s.start && m < s.end) || null;
}

test('offline schedule plan is half-open and includes a future scheduled playlist', () => {
  const plan = build({
    schedules: [
      { id: 'a', playlist_id: 'playlist-a', start: 9 * 60, end: 10 * 60 },
      { id: 'b', playlist_id: 'playlist-b', start: 10 * 60, end: 12 * 60 },
    ],
    timezone: 'UTC', now: at(9, 30), horizonMs: 3 * H, pick,
  });
  assert.deepEqual(plan.intervals.map((x) => [x.start_utc_ms, x.end_utc_ms, x.schedule_id]), [
    [at(9, 30), at(10), 'a'], [at(10), at(12), 'b'], [at(12), at(12, 30), null],
  ]);
});

test('offline schedule plan coalesces unchanged minutes and never carries content past its end', () => {
  const plan = build({ schedules: [{ id: 'a', playlist_id: 'p', start: 9 * 60, end: 10 * 60 }], timezone: 'UTC', now: at(9), horizonMs: H, pick });
  assert.equal(plan.intervals.length, 1);
  assert.equal(plan.intervals[0].end_utc_ms, at(10));
  assert.equal(plan.intervals[0].schedule_id, 'a');
});

test('14-day planning uses pre-resolved local parts instead of the blocking Date/Intl picker', () => {
  const schedules = [{ id: 'daily', playlist_id: 'p', start: 9 * 60, end: 17 * 60 }];
  let fastCalls = 0;
  const plan = build({
    schedules,
    timezone: 'Africa/Cairo',
    now: Date.UTC(2026, 9, 25),
    pick() {
      assert.fail('the Date/Intl picker must not run when a local-parts picker is supplied');
    },
    clock: makeClock('Africa/Cairo'),
    pickAt(rows, local) {
      fastCalls++;
      return rows.find((s) => local.min >= s.start && local.min < s.end) || null;
    },
  });
  assert.ok(fastCalls > 20_000, 'the full minute-granular horizon was evaluated');
  assert.ok(plan.intervals.some((x) => x.schedule_id === 'daily'));
  assert.ok(plan.intervals.some((x) => x.schedule_id === null));
  assert.equal(plan.valid_until_utc_ms - plan.generated_at_utc_ms, 14 * 24 * H);
});

test('an incomplete accelerated picker is rejected instead of silently changing semantics', () => {
  assert.throws(
    () => build({ schedules: [], pickAt() {}, now: at(0), horizonMs: H }),
    /requires pick, or pickAt with a clock/,
  );
});

test('offline plan uses the same overnight recurrence anchor as the live scheduler', () => {
  const { pickActiveScheduleAt } = require('../services/scheduler');
  const schedule = {
    id: 'overnight', playlist_id: 'night', layout_id: null,
    recurrence: 'FREQ=DAILY', start_time: '2026-11-01T23:00:00', end_time: '2026-11-02T01:00:00',
  };
  const plan = build({
    schedules: [schedule], timezone: 'UTC', now: Date.parse('2026-11-02T00:30:00Z'), horizonMs: 2 * H,
    pickAt: pickActiveScheduleAt, clock: makeClock('UTC'),
  });
  assert.deepEqual(plan.intervals.map((x) => [new Date(x.start_utc_ms).toISOString(), new Date(x.end_utc_ms).toISOString(), x.schedule_id]), [
    ['2026-11-02T00:30:00.000Z', '2026-11-02T01:00:00.000Z', 'overnight'],
    ['2026-11-02T01:00:00.000Z', '2026-11-02T02:30:00.000Z', null],
  ]);
});
