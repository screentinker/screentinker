'use strict';

// The live scheduler and the offline-plan generator share isScheduleActiveNow.
// A recurring 23:00–01:00 window used a same-day HH:MM comparison, so it never
// selected any content and the generated offline plan had the same blind spot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-recurring-overnight-'));
process.env.DATA_DIR = tmp;

const { isScheduleActiveNow } = require('../services/scheduler');

const daily = {
  recurrence: 'FREQ=DAILY',
  start_time: '2026-11-01T23:00:00',
  end_time: '2026-11-02T01:00:00',
};

test('a daily recurring window remains active after midnight until its end', () => {
  assert.equal(isScheduleActiveNow(daily, new Date('2026-11-02T00:30:00Z'), 'UTC'), true);
  assert.equal(isScheduleActiveNow(daily, new Date('2026-11-02T01:00:00Z'), 'UTC'), false,
    'the end remains exclusive');
  assert.equal(isScheduleActiveNow(daily, new Date('2026-11-02T22:59:00Z'), 'UTC'), false);
  assert.equal(isScheduleActiveNow(daily, new Date('2026-11-02T23:00:00Z'), 'UTC'), true);
});

test('the carry-over belongs to the prior weekly occurrence, not every next day', () => {
  const weekly = { ...daily, recurrence: 'FREQ=WEEKLY;BYDAY=MO' };
  assert.equal(isScheduleActiveNow(weekly, new Date('2026-11-03T00:30:00Z'), 'UTC'), true,
    'Tuesday 00:30 continues Monday\'s selected occurrence');
  assert.equal(isScheduleActiveNow(weekly, new Date('2026-11-04T00:30:00Z'), 'UTC'), false,
    'Wednesday is not a carry-over from a selected day');
});

test('recurrence intervals are honoured by the live evaluator', () => {
  const everyOtherDay = { ...daily, recurrence: 'FREQ=DAILY;INTERVAL=2' };
  assert.equal(isScheduleActiveNow(everyOtherDay, new Date('2026-11-03T23:30:00Z'), 'UTC'), true);
  assert.equal(isScheduleActiveNow(everyOtherDay, new Date('2026-11-04T23:30:00Z'), 'UTC'), false);

  const everyOtherWeek = {
    ...daily,
    start_time: '2026-11-02T23:00:00', end_time: '2026-11-03T01:00:00',
    recurrence: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2',
  };
  assert.equal(isScheduleActiveNow(everyOtherWeek, new Date('2026-11-02T23:30:00Z'), 'UTC'), true);
  assert.equal(isScheduleActiveNow(everyOtherWeek, new Date('2026-11-09T23:30:00Z'), 'UTC'), false);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
