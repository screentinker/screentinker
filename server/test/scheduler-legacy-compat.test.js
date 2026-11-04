'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scheduler-compat-'));
const { isScheduleActiveNow } = require('../services/scheduler');
const at = (iso) => new Date(iso);

test('online scheduler preserves the established inclusive final minute', () => {
  const schedule = { recurrence: 'FREQ=DAILY', start_time: '2026-11-01T09:00:00', end_time: '2026-11-01T10:00:00' };
  assert.equal(isScheduleActiveNow(schedule, at('2026-11-02T10:00:00Z'), 'UTC'), true);
});

test('online scheduler preserves its established overnight behavior', () => {
  const schedule = { recurrence: 'FREQ=DAILY', start_time: '2026-11-01T23:00:00', end_time: '2026-11-02T01:00:00' };
  assert.equal(isScheduleActiveNow(schedule, at('2026-11-02T00:30:00Z'), 'UTC'), false);
});

test('online scheduler preserves its established INTERVAL behavior', () => {
  const schedule = { recurrence: 'FREQ=DAILY;INTERVAL=2', start_time: '2026-11-01T09:00:00', end_time: '2026-11-01T10:00:00' };
  assert.equal(isScheduleActiveNow(schedule, at('2026-11-02T09:30:00Z'), 'UTC'), true);
});

test('online weekly recurrence without BYDAY preserves daily-like behavior', () => {
  const schedule = { recurrence: 'FREQ=WEEKLY', start_time: '2026-11-02T09:00:00', end_time: '2026-11-02T10:00:00' };
  assert.equal(isScheduleActiveNow(schedule, at('2026-11-03T09:30:00Z'), 'UTC'), true);
});

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
