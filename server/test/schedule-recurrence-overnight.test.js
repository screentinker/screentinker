'use strict';

// The offline-plan evaluator resolves recurrence into half-open UTC intervals.
// It intentionally does not change the established online scheduler contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-recurring-overnight-'));
process.env.DATA_DIR = tmp;

const { _localParts } = require('../lib/schedule-eval');
const { isActiveAt } = require('../lib/offline-schedule-eval');
const active = (schedule, iso) => isActiveAt(schedule, _localParts(new Date(iso), 'UTC'));

const daily = {
  recurrence: 'FREQ=DAILY',
  start_time: '2026-11-01T23:00:00',
  end_time: '2026-11-02T01:00:00',
};

test('a daily recurring window remains active after midnight until its end', () => {
  assert.equal(active(daily, '2026-11-02T00:30:00Z'), true);
  assert.equal(active(daily, '2026-11-02T01:00:00Z'), false,
    'the end remains exclusive');
  assert.equal(active(daily, '2026-11-02T22:59:00Z'), false);
  assert.equal(active(daily, '2026-11-02T23:00:00Z'), true);
});

test('the carry-over belongs to the prior weekly occurrence, not every next day', () => {
  const weekly = { ...daily, recurrence: 'FREQ=WEEKLY;BYDAY=MO' };
  assert.equal(active(weekly, '2026-11-03T00:30:00Z'), true,
    'Tuesday 00:30 continues Monday\'s selected occurrence');
  assert.equal(active(weekly, '2026-11-04T00:30:00Z'), false,
    'Wednesday is not a carry-over from a selected day');
});

test('recurrence intervals are honoured by the offline evaluator', () => {
  const everyOtherDay = { ...daily, recurrence: 'FREQ=DAILY;INTERVAL=2' };
  assert.equal(active(everyOtherDay, '2026-11-03T23:30:00Z'), true);
  assert.equal(active(everyOtherDay, '2026-11-04T23:30:00Z'), false);

  const everyOtherWeek = {
    ...daily,
    start_time: '2026-11-02T23:00:00', end_time: '2026-11-03T01:00:00',
    recurrence: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2',
  };
  assert.equal(active(everyOtherWeek, '2026-11-02T23:30:00Z'), true);
  assert.equal(active(everyOtherWeek, '2026-11-09T23:30:00Z'), false);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
