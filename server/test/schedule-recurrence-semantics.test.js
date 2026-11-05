'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-recurrence-v2-'));
const { isScheduleActiveNow } = require('../services/scheduler');
const active = (schedule, iso, zone = 'UTC') => isScheduleActiveNow(schedule, new Date(iso), zone);
const base = { recurrence: 'FREQ=DAILY', start_time: '2026-11-01T09:00:00', end_time: '2026-11-01T10:00:00' };

test('one-off windows retain the established inclusive final minute', () => {
  const once = { recurrence: null, start_time: '2026-11-01T09:00:00', end_time: '2026-11-01T10:00:00' };
  assert.equal(active(once, '2026-11-01T10:00:00Z'), true);
});

test('known recurring windows preserve the established inclusive final minute', () => {
  assert.equal(active(base, '2026-11-02T09:59:00Z'), true);
  assert.equal(active(base, '2026-11-02T10:00:00Z'), true);
  assert.equal(active(base, '2026-11-02T10:01:00Z'), false);
});

test('overnight daily and weekly occurrences remain anchored to their start day', () => {
  const daily = { ...base, start_time: '2026-11-01T23:00:00', end_time: '2026-11-02T01:00:00' };
  assert.equal(active(daily, '2026-11-02T00:30:00Z'), true);
  const weekly = { ...daily, recurrence: 'FREQ=WEEKLY;BYDAY=MO' };
  assert.equal(active(weekly, '2026-11-03T00:30:00Z'), true);
  assert.equal(active(weekly, '2026-11-04T00:30:00Z'), false);
});

test('daily, weekly and monthly INTERVAL values are honored', () => {
  assert.equal(active({ ...base, recurrence: 'FREQ=DAILY;INTERVAL=2' }, '2026-11-03T09:30:00Z'), true);
  assert.equal(active({ ...base, recurrence: 'FREQ=DAILY;INTERVAL=2' }, '2026-11-04T09:30:00Z'), false);
  const weekly = { ...base, start_time: '2026-11-02T09:00:00', end_time: '2026-11-02T10:00:00', recurrence: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2' };
  assert.equal(active(weekly, '2026-11-09T09:30:00Z'), false);
  assert.equal(active(weekly, '2026-11-16T09:30:00Z'), true);
  const monthly = { ...base, recurrence: 'FREQ=MONTHLY;INTERVAL=2' };
  assert.equal(active(monthly, '2026-12-01T09:30:00Z'), false);
  assert.equal(active(monthly, '2027-01-01T09:30:00Z'), true);
});

test('weekly without BYDAY uses the start weekday', () => {
  const weekly = { ...base, start_time: '2026-11-02T09:00:00', end_time: '2026-11-02T10:00:00', recurrence: 'FREQ=WEEKLY' };
  assert.equal(active(weekly, '2026-11-02T09:30:00Z'), true);
  assert.equal(active(weekly, '2026-11-03T09:30:00Z'), false);
});

test('timezone and DST conversion still occur before recurrence evaluation', () => {
  const sunday = { ...base, start_time: '2026-03-01T01:00:00', end_time: '2026-03-01T03:00:00', recurrence: 'FREQ=WEEKLY;BYDAY=SU' };
  assert.equal(active(sunday, '2026-03-08T06:30:00Z', 'America/New_York'), true);
  assert.equal(active(sunday, '2026-03-08T07:00:00Z', 'America/New_York'), true);
});

test('unknown recurrence kinds retain the legacy daily-like inclusive fallback', () => {
  const unknown = { ...base, recurrence: 'FREQ=YEARLY' };
  assert.equal(active(unknown, '2026-11-02T10:00:00Z'), true);
});

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
