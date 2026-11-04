'use strict';

// The calendar is the operator's only view of what is scheduled, and it disagreed with the engine
// in both directions for the two most-used repeat presets.
//
// The old expansion stepped by the recurrence unit from the schedule's original start:
//   - WEEKLY advanced a whole week at a time, so dayOfWeek never changed and a
//     FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR rule matched only its start day. Created on a Monday it drew
//     one event a week; created on a Saturday it drew nothing at all.
//   - The walk began at the original start under a 366-iteration cap, so a schedule begun more than
//     a year ago never reached the current week and drew nothing.
// Meanwhile the engine evaluates day-of-week directly, so those schedules ran Mon-Fri the whole
// time. Screens were switching content that the calendar said was not scheduled.
//
// The invariant: the calendar draws an event on every day the schedule actually fires.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cal-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-calendar';

const { expandSchedule, parseCalendarDate } = require('../routes/schedules');

// A Monday-to-Sunday window well clear of the schedules' start dates.
const WEEK_START = new Date('2026-08-03T00:00:00');   // Monday
const WEEK_END = new Date('2026-08-09T23:59:59');     // Sunday

const mk = (recurrence, startISO, recurrenceEnd = null) => ({
  id: 's', recurrence, recurrence_end: recurrenceEnd,
  start_time: startISO,
  end_time: new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString(),
});
const weekdaysOf = (events) => events.map(e => new Date(e.instance_start).getDay()).sort();

test('a date-only week anchor retains its calendar day west of UTC', () => {
  // ⚠️ Record WHETHER it was set, not just its value. `process.env.TZ = undefined` writes the
  // STRING "undefined", which Node cannot parse and silently resolves to UTC - changing the zone
  // for every test that runs after this one in this file, all of which are date arithmetic.
  const hadTz = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // new Date('2026-08-09') is UTC midnight, so it is still Saturday on a US server.
    // The calendar date parser must retain the Sunday the browser selected.
    assert.equal(new Date('2026-08-09').getDay(), 6, 'the legacy parser sees Saturday');
    const selected = parseCalendarDate('2026-08-09');
    assert.equal(selected.getFullYear(), 2026);
    assert.equal(selected.getMonth(), 7);
    assert.equal(selected.getDate(), 9);
    assert.equal(selected.getDay(), 0, 'Sunday remains Sunday');
  } finally {
    if (hadTz) process.env.TZ = originalTz;
    else delete process.env.TZ;
  }
});

test('THE BUG: a Mon-Fri rule draws five events, not one', () => {
  const ev = expandSchedule(mk('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-07-27T09:00:00'), WEEK_START, WEEK_END);
  assert.equal(ev.length, 5);
  assert.deepEqual(weekdaysOf(ev), [1, 2, 3, 4, 5], 'Mon..Fri');
});

test('...and it does not matter which day the rule was created on', () => {
  // Created on a Saturday, the old code drew nothing whatsoever.
  const ev = expandSchedule(mk('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-08-01T09:00:00'), WEEK_START, WEEK_END);
  assert.equal(ev.length, 5);
  assert.deepEqual(weekdaysOf(ev), [1, 2, 3, 4, 5]);
});

test('a DAILY schedule older than a year still draws', () => {
  // The 366-iteration cap meant the walk never reached the visible window.
  const ev = expandSchedule(mk('FREQ=DAILY', '2024-05-01T09:00:00'), WEEK_START, WEEK_END);
  assert.equal(ev.length, 7, 'every day of the week');
});

test('WEEKLY without byDay still means "the same weekday as the start"', () => {
  const ev = expandSchedule(mk('FREQ=WEEKLY', '2026-07-27T09:00:00'), WEEK_START, WEEK_END);  // a Monday
  assert.equal(ev.length, 1);
  assert.deepEqual(weekdaysOf(ev), [1]);
});

test('a DAILY interval is honoured rather than drawn every day', () => {
  const ev = expandSchedule(mk('FREQ=DAILY;INTERVAL=2', '2026-08-03T09:00:00'), WEEK_START, WEEK_END);
  assert.equal(ev.length, 4, 'Mon, Wed, Fri, Sun');
});

test('recurrence_end stops the drawing', () => {
  const ev = expandSchedule(
    mk('FREQ=DAILY', '2026-07-27T09:00:00', '2026-08-05T23:59:59'), WEEK_START, WEEK_END);
  assert.equal(ev.length, 3, 'Mon, Tue, Wed then it ends');
});

test('a one-off schedule is unaffected', () => {
  const ev = expandSchedule(
    { id: 's', recurrence: null, start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T10:00:00' },
    WEEK_START, WEEK_END);
  assert.equal(ev.length, 1);
});

test('each drawn event keeps the schedule duration', () => {
  const ev = expandSchedule(mk('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-07-27T09:00:00'), WEEK_START, WEEK_END);
  for (const e of ev) {
    const mins = (new Date(e.instance_end) - new Date(e.instance_start)) / 60000;
    assert.equal(mins, 60);
  }
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
