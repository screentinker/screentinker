'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('offline plan uses the live scheduler recurrence verdict, including its inclusive end minute', () => {
  const { isScheduleActiveAt } = require('../services/scheduler');
  const schedule = {
    id: 'daily', playlist_id: 'day', layout_id: null,
    recurrence: 'FREQ=DAILY', start_time: '2026-11-02T00:00:00', end_time: '2026-11-02T01:00:00',
  };
  const plan = build({
    schedules: [schedule], timezone: 'UTC', now: Date.parse('2026-11-02T00:30:00Z'), horizonMs: 2 * H,
    pickAt: (rows, local) => rows.find((row) => isScheduleActiveAt(row, local)) || null, clock: makeClock('UTC'),
  });
  assert.deepEqual(plan.intervals.map((x) => [new Date(x.start_utc_ms).toISOString(), new Date(x.end_utc_ms).toISOString(), x.schedule_id]), [
    ['2026-11-02T00:30:00.000Z', '2026-11-02T01:01:00.000Z', 'daily'],
    ['2026-11-02T01:01:00.000Z', '2026-11-02T02:30:00.000Z', null],
  ]);
});

test('a truncated plan expires at its last emitted interval', () => {
  const { MAX_INTERVALS, MINUTE_MS } = require('../lib/offline-schedule-plan');
  const plan = build({
    schedules: [], timezone: 'UTC', now: at(0), horizonMs: (MAX_INTERVALS + 10) * MINUTE_MS,
    pick(_rows, now) {
      const minute = Math.floor((now.getTime() - at(0)) / MINUTE_MS);
      return { id: minute % 2 ? 'odd' : 'even', playlist_id: 'p' };
    },
  });
  assert.equal(plan.intervals.length, MAX_INTERVALS);
  assert.equal(plan.valid_until_utc_ms, plan.intervals.at(-1).end_utc_ms);
});

test('only the explicit offline-plan capability gates the payload contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ws/deviceSocket.js'), 'utf8');
  assert.match(source, /capsLib\.supports\(device, 'offline\.schedule_plan'\)/);
  assert.doesNotMatch(source, /capsLib\.supports\(device, 'clock\.tz_table'\)[\s\S]{0,300}offline_schedule/);
  assert.doesNotMatch(source, /offlinePlan !== false && device\?\.playlist_source === 'schedule'/,
    'a future plan must be sent before its first schedule becomes active');
  assert.match(source, /overrideNow \|\| hookNow\) \{\s*assembled\.offline_plan = null;/,
    'an override explicitly clears a previously persisted plan');
  assert.match(source, /scheduler\.isScheduleActiveAt\(schedule, local\)/,
    'the plan uses the live scheduler evaluator rather than a second recurrence implementation');
});
