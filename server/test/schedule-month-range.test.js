'use strict';
// The month view asks /schedules/week for a 42-day window (days=42). Expansion over six weeks has
// to produce every instance the grid will draw, for each rule the editor can write. A miss here is
// a month grid with blank days that the panel will nonetheless play.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-monthrange-'));
process.env.DATA_DIR = tmp;

const { expandSchedule } = require('../routes/schedules');

// The grid that shows September 2026: six weeks from Sunday 30 Aug, exclusive end.
const GRID_START = new Date(2026, 7, 30, 0, 0, 0);
const GRID_END = new Date(GRID_START.getTime() + 42 * 24 * 60 * 60 * 1000);
const sched = (recurrence, start = '2026-08-09T09:00:00', end = '2026-08-09T17:00:00', extra = {}) =>
  ({ id: 'x', recurrence, start_time: start, end_time: end, ...extra });
const dates = (evs) => evs.map((e) => e.instance_start.slice(0, 10));

test('a daily rule fills every one of the 42 days', () => {
  assert.equal(expandSchedule(sched('FREQ=DAILY'), GRID_START, GRID_END).length, 42);
});

test('a weekly rule lands on its weekday in each of the six weeks', () => {
  const evs = expandSchedule(sched('FREQ=WEEKLY;BYDAY=MO'), GRID_START, GRID_END);
  assert.equal(evs.length, 6);
  assert.ok(evs.every((e) => new Date(e.instance_start).getDay() === 1));
});

test('a monthly rule appears once per month that the grid touches, on its day', () => {
  const evs = expandSchedule(sched('FREQ=MONTHLY'), GRID_START, GRID_END);
  assert.deepEqual(dates(evs), ['2026-09-09', '2026-10-09'], 'Sep 9 and Oct 9 are both inside a grid that runs to Oct 10');
});

test('recurrence_end cuts the series off inside the grid', () => {
  const evs = expandSchedule(sched('FREQ=DAILY', undefined, undefined, { recurrence_end: '2026-09-05' }), GRID_START, GRID_END);
  assert.equal(evs.length, 7, 'Aug 30 through Sep 5 inclusive');
  assert.equal(dates(evs).at(-1), '2026-09-05');
});

test('a one-off inside the window appears exactly once, and one outside not at all', () => {
  assert.equal(expandSchedule(sched(null, '2026-09-15T10:00:00', '2026-09-15T11:00:00'), GRID_START, GRID_END).length, 1);
  assert.equal(expandSchedule(sched(null, '2026-11-01T10:00:00', '2026-11-01T11:00:00'), GRID_START, GRID_END).length, 0);
});
