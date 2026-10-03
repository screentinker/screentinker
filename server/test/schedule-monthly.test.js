'use strict';
// FREQ=MONTHLY on the PANEL, not just on the calendar.
//
// isScheduleActiveNow never branched on FREQ. It honours BYDAY, the date window and
// recurrence_end, so a monthly rule had no filter at all and played every single day, while the
// calendar's expandSchedule (which does compare the day-of-month) drew it once a month. The
// dashboard now offers Monthly, so the two must agree, or the operator schedules "the 9th" and gets
// every day. The old form never offered MONTHLY, so no existing row changes behaviour here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-monthly-'));
process.env.DATA_DIR = tmp;

const { isScheduleActiveNow } = require('../services/scheduler');

const TZ = 'UTC';
const at = (iso) => new Date(iso);
// Runs 09:00-17:00 on the 9th of every month, from August.
const MONTHLY = { recurrence: 'FREQ=MONTHLY', start_time: '2026-08-09T09:00:00', end_time: '2026-08-09T17:00:00' };

test('a monthly schedule fires on its day of the month, inside its hours', () => {
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-09-09T12:00:00Z'), TZ), true, 'Sep 9, midday');
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-10-09T09:30:00Z'), TZ), true, 'Oct 9 too');
});

test('THE BUG: it does NOT fire on every other day of the month', () => {
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-09-10T12:00:00Z'), TZ), false, 'the 10th');
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-09-08T12:00:00Z'), TZ), false, 'the 8th');
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-09-23T12:00:00Z'), TZ), false, 'two weeks later');
});

test('and still respects its hours and its start date', () => {
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-09-09T18:00:00Z'), TZ), false, 'right day, after hours');
  assert.equal(isScheduleActiveNow(MONTHLY, at('2026-07-09T12:00:00Z'), TZ), false, 'the month BEFORE it began');
});

test('the check is scoped to MONTHLY: daily and weekly rules are untouched', () => {
  const daily = { recurrence: 'FREQ=DAILY', start_time: '2026-08-09T09:00:00', end_time: '2026-08-09T17:00:00' };
  assert.equal(isScheduleActiveNow(daily, at('2026-09-10T12:00:00Z'), TZ), true);
  const weekly = { recurrence: 'FREQ=WEEKLY;BYDAY=TH', start_time: '2026-08-06T09:00:00', end_time: '2026-08-06T17:00:00' };
  assert.equal(isScheduleActiveNow(weekly, at('2026-09-10T12:00:00Z'), TZ), true, 'Sep 10 2026 is a Thursday');
  assert.equal(isScheduleActiveNow(weekly, at('2026-09-09T12:00:00Z'), TZ), false, 'a Wednesday');
});
