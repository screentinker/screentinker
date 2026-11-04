'use strict';

// A recurring schedule ran forever. The engine compared weekday and HH:MM and dropped the date
// component entirely, so it never read recurrence_end — a campaign set to finish on the 1st was
// still switching screens weeks later. The calendar does read recurrence_end, so it showed the
// campaign as stopped while the screens kept obeying it; that disagreement is what made it hard to
// see. The end date is offered on the form, so it has to mean something.
//
// The same omission made a recurring schedule live BEFORE its start date, for the same reason.
//
// The invariant: a recurring schedule fires on and between its dates, inclusive, and never outside
// them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-recend-'));
process.env.DATA_DIR = tmp;

const { isScheduleActiveNow } = require('../services/scheduler');

const TZ = 'UTC';
// A weekday 09:00-17:00 recurring schedule that ran from the 1st to the 5th of August.
const CAMPAIGN = {
  recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  start_time: '2026-08-03T09:00:00',
  end_time: '2026-08-03T17:00:00',
  recurrence_end: '2026-08-07T23:59:59',
};
const at = (iso) => new Date(iso);

test('THE BUG: it must stop after its end date', () => {
  // A Monday, inside the daily window, weeks after the campaign ended.
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-09-07T12:00:00Z'), TZ), false,
    'a finished campaign must not still be switching screens');
});

test('the final day still runs, to its normal end time', () => {
  // Inclusive end: Friday the 7th is the last day and behaves like any other.
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-08-07T12:00:00Z'), TZ), true);
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-08-07T18:00:00Z'), TZ), false, 'outside the daily window');
});

test('it does not run before its start date either', () => {
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-07-29T12:00:00Z'), TZ), false, 'a Wednesday, but before it begins');
});

test('inside the window it behaves exactly as before', () => {
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-08-05T12:00:00Z'), TZ), true, 'Wednesday, midday');
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-08-05T08:00:00Z'), TZ), false, 'before the daily start');
  assert.equal(isScheduleActiveNow(CAMPAIGN, at('2026-08-08T12:00:00Z'), TZ), false, 'Saturday is not in byDay');
});

test('a recurring schedule with NO end date still runs indefinitely', () => {
  // This is the normal case and must not be broken by the fix.
  const openEnded = { ...CAMPAIGN, recurrence_end: null };
  assert.equal(isScheduleActiveNow(openEnded, at('2027-03-10T12:00:00Z'), TZ), true, 'a Wednesday, years later');
});

test('a one-off schedule is unaffected', () => {
  const oneOff = { recurrence: null, start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T17:00:00' };
  assert.equal(isScheduleActiveNow(oneOff, at('2026-08-05T12:00:00Z'), TZ), true);
  assert.equal(isScheduleActiveNow(oneOff, at('2026-08-06T12:00:00Z'), TZ), false);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
