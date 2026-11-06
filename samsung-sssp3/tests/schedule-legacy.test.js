'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// schedule-eval is deliberately generated from server/lib during package
// preparation.  Exercise the generated Orsay adapter, never a deleted copy
// from app/, so this test catches a broken source transformation in CI.
const packageRoot = path.join(__dirname, '..');
const generatedScheduleEval = path.join(packageRoot, 'dist', 'schedule-eval.js');
execFileSync(process.execPath, [path.join(packageRoot, 'prepare.js')], { stdio: 'inherit' });
function loadScheduleEval(context) {
  vm.runInNewContext(fs.readFileSync(generatedScheduleEval, 'utf8'), context);
}
test('UTC schedules honor boundaries even when Intl is unavailable', () => {
  const context = { module: { exports: {} }, Intl: undefined, Date };
  loadScheduleEval(context);
  const schedule = [{ days: [1], start: '09:00', end: '10:00' }];
  const active = context.module.exports.isItemActiveNow;
  assert.equal(active(schedule, Date.parse('2025-01-06T08:59:00Z'), 'UTC'), false);
  assert.equal(active(schedule, Date.parse('2025-01-06T09:00:00Z'), 'UTC'), true);
  assert.equal(active(schedule, Date.parse('2025-01-06T10:00:00Z'), 'UTC'), false);
});
test('offline local schedule uses cached timezone transitions without Intl', () => {
  const context = { module: { exports: {} }, Intl: undefined, Date };
  loadScheduleEval(context);
  const api = context.module.exports;
  api.setTimezoneTable({ zone: 'Africa/Cairo', spans: [{ from_ms: 0, offset_min: 120 }, { from_ms: Date.parse('2025-04-25T00:00:00Z'), offset_min: 180 }] });
  const schedule = [{ days: [5], start: '03:00', end: '04:00' }];
  assert.equal(api.isItemActiveNow(schedule, Date.parse('2025-04-25T00:30:00Z'), 'Africa/Cairo'), true);
  assert.equal(api.isItemActiveNow(schedule, Date.parse('2025-04-25T01:00:00Z'), 'Africa/Cairo'), false);
});
test('offline fallback preserves the legacy inclusive end for one-off schedules', () => {
  const context = { Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/offline-schedule.js'), 'utf8'), context);
  const meta = { schedule: { start_time: '2025-01-06T10:00', end_time: '2025-01-06T11:00' }, table: { spans: [{ from_ms: 0, offset_min: 120 }] } };
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2025-01-06T08:00:00Z')), true);
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2025-01-06T08:59:59Z')), true);
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2025-01-06T09:00:00Z')), true);
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2025-01-06T09:01:00Z')), false);
});

test('offline fallback keeps an overnight recurring schedule on its prior start date', () => {
  const context = { Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/offline-schedule.js'), 'utf8'), context);
  const meta = {
    schedule: {
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2',
      start_time: '2026-11-02T23:00:00', end_time: '2026-11-03T01:00:00',
    },
    table: { spans: [{ from_ms: 0, offset_min: 0 }] },
  };
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2026-11-03T00:30:00Z')), true,
    'Tuesday 00:30 is Monday night\'s occurrence');
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2026-11-10T00:30:00Z')), false,
    'the following Tuesday belongs to a skipped Monday under INTERVAL=2');
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2026-11-17T00:30:00Z')), true);
});


test('offline fallback retains the server behaviour for an unknown recurrence frequency', () => {
  const context = { Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/offline-schedule.js'), 'utf8'), context);
  const meta = {
    schedule: { recurrence: 'FREQ=YEARLY', start_time: '2025-01-06T10:00', end_time: '2025-01-06T11:00' },
    table: { spans: [{ from_ms: 0, offset_min: 0 }] },
  };
  assert.equal(context.STOfflineSchedule.active(meta, Date.parse('2025-01-06T10:30:00Z')), true);
});
