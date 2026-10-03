'use strict';
// The Outlook-style calendar's view model. Pure functions in frontend/js/lib/schedule-calendar.js,
// pinned here because each one fails quietly: a month grid one week short, a period that fetches a
// different window than it draws, two overlapping blocks stacked so the lower one cannot be
// clicked, or a recurrence written in a form the engine plays differently from how it is drawn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'schedule-calendar.js')).href;
let C;
test('load the module', async () => { C = await import(MOD); assert.ok(C.VIEWS.includes('month')); });

const WED = new Date(2026, 8, 9);   // Wed 9 Sep 2026, local

test('the week starts on Sunday, matching what /schedules/week snaps to', async () => {
  assert.equal(C.startOfWeek(WED).getDay(), 0);
  assert.equal(C.ymd(C.startOfWeek(WED)), '2026-09-06');
  assert.equal(C.startOfWeek(new Date(2026, 8, 6)).getDate(), 6, 'a Sunday is its own week start');
});

test('each view draws the days it fetches, and day/work-week reuse the week fetch', async () => {
  const day = C.periodRange('day', WED);
  assert.equal(day.days.length, 1); assert.equal(C.ymd(day.fetchStart), '2026-09-06'); assert.equal(day.fetchDays, 7);
  const ww = C.periodRange('workweek', WED);
  assert.deepEqual(ww.days.map((d) => d.getDay()), [1, 2, 3, 4, 5], 'Mon..Fri');
  assert.equal(C.ymd(ww.fetchStart), '2026-09-06');
  const wk = C.periodRange('week', WED);
  assert.equal(wk.days.length, 7); assert.equal(wk.days[0].getDay(), 0); assert.equal(wk.days[6].getDay(), 6);
  const mo = C.periodRange('month', WED);
  assert.equal(mo.days.length, 42, 'six weeks, always');
  assert.equal(mo.days[0].getDay(), 0);
  assert.equal(C.ymd(mo.fetchStart), C.ymd(mo.days[0]), 'the month fetch starts where the grid starts');
  assert.equal(mo.fetchDays, 42);
});

test('the month grid pads to six full weeks and marks which cells are in the month', async () => {
  const g = C.monthGrid(WED);
  assert.equal(g.weeks.length, 6);
  assert.ok(g.weeks.every((w) => w.length === 7));
  assert.equal(g.weeks[0][0].date.getDay(), 0);
  const inMonth = g.weeks.flat().filter((c) => c.inMonth).length;
  assert.equal(inMonth, 30, 'September has 30 days');
  assert.equal(g.weeks[0][0].inMonth, false, 'Sep 2026 starts on a Tuesday, so the Sunday before is padding');
});

test('prev/next step by the unit the view shows, and a month step never spills over', async () => {
  assert.equal(C.ymd(C.stepAnchor('day', WED, 1)), '2026-09-10');
  assert.equal(C.ymd(C.stepAnchor('week', WED, -1)), '2026-09-02');
  assert.equal(C.ymd(C.stepAnchor('workweek', WED, 1)), '2026-09-16');
  assert.equal(C.ymd(C.stepAnchor('month', WED, 1)), '2026-10-09');
  // Jan 31 forward is Feb 28, not Mar 3.
  assert.equal(C.ymd(C.stepAnchor('month', new Date(2026, 0, 31), 1)), '2026-02-28');
});

test('a whole-day schedule is recognised in both of the forms the engine treats as 24 hours', async () => {
  assert.equal(C.isAllDay(0, 24 * 60), true, '00:00 to 24:00');
  assert.equal(C.isAllDay(9 * 60, 9 * 60), true, 'a wrap whose end equals its start runs all day');
  assert.equal(C.isAllDay(9 * 60, 17 * 60), false);
  assert.equal(C.isAllDay(0, 23 * 60), false, 'ending an hour early is not all day');
});

test('overlapping blocks share the width side by side; a lone block keeps all of it', async () => {
  const a = { id: 'a', startMin: 540, endMin: 660 };    // 9-11
  const b = { id: 'b', startMin: 600, endMin: 720 };    // 10-12  overlaps a
  const c = { id: 'c', startMin: 780, endMin: 840 };    // 13-14  alone
  const out = C.packColumns([c, b, a]);
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.equal(by.a.cols, 2); assert.equal(by.b.cols, 2);
  assert.notEqual(by.a.col, by.b.col, 'overlapping blocks take different columns');
  assert.equal(by.c.cols, 1); assert.equal(by.c.col, 0, 'no overlap, full width');
});

test('packing reuses a column once its occupant has ended', async () => {
  // 9-10 and 10-11 do not overlap, so they can share column 0 even though both overlap 9-11.
  const items = [
    { id: 'long', startMin: 540, endMin: 660 },
    { id: 'p', startMin: 540, endMin: 600 },
    { id: 'q', startMin: 600, endMin: 660 },
  ];
  const by = Object.fromEntries(C.packColumns(items).map((x) => [x.id, x]));
  assert.equal(by.long.cols, 2);
  assert.equal(by.p.col, by.q.col, 'sequential blocks share a column');
  assert.notEqual(by.long.col, by.p.col);
});

test('a rule parses to the subset the engine evaluates, dropping tokens it would silently ignore', async () => {
  assert.deepEqual(C.parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR'), { freq: 'WEEKLY', byDay: ['MO', 'WE', 'FR'], interval: 1 });
  assert.deepEqual(C.parseRRule('FREQ=DAILY;INTERVAL=2').interval, 2);
  assert.equal(C.parseRRule(''), null);
  assert.equal(C.parseRRule(null), null);
  // "1MO" is an nth-weekday token both server parsers drop; keep the parse honest about that.
  assert.deepEqual(C.parseRRule('FREQ=MONTHLY;BYDAY=1MO').byDay, []);
});

test('THE ENGINE TRAP: weekly always writes an explicit BYDAY', async () => {
  // The engine ignores FREQ. A bare FREQ=WEEKLY has no BYDAY filter and plays EVERY day, while the
  // calendar draws it once a week. Writing the weekday makes the panel and the calendar agree.
  assert.equal(C.composeRRule({ freq: 'WEEKLY', startDate: WED }), 'FREQ=WEEKLY;BYDAY=WE');
  assert.equal(C.composeRRule({ freq: 'WEEKLY', byDay: ['FR', 'MO'] }), 'FREQ=WEEKLY;BYDAY=MO,FR', 'days come out in week order');
  assert.equal(C.composeRRule({ freq: 'DAILY' }), 'FREQ=DAILY');
  assert.equal(C.composeRRule({ freq: 'MONTHLY' }), 'FREQ=MONTHLY');
  assert.equal(C.composeRRule({ freq: 'NONE' }), null);
  assert.equal(C.composeRRule({}), null);
});

test('an existing rule opens on the preset that describes what it actually does', async () => {
  assert.equal(C.presetFor('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR').preset, 'weekdays');
  assert.equal(C.presetFor('FREQ=WEEKLY;BYDAY=SA,SU').preset, 'weekends');
  assert.deepEqual(C.presetFor('FREQ=WEEKLY;BYDAY=MO,WE'), { preset: 'weekly', byDay: ['MO', 'WE'] });
  // A bare WEEKLY from the old form: shown on the start's weekday, which is what the calendar draws.
  assert.deepEqual(C.presetFor('FREQ=WEEKLY', WED), { preset: 'weekly', byDay: ['WE'] });
  assert.equal(C.presetFor('FREQ=MONTHLY').preset, 'monthly');
  assert.equal(C.presetFor(null).preset, 'none');
});

test('the summary is data, so the view can phrase it in any locale', async () => {
  const d = C.describeRecurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR');
  assert.equal(d.kind, 'weekly'); assert.deepEqual(d.days, ['MO', 'WE', 'FR']);
  assert.equal(C.describeRecurrence('FREQ=MONTHLY', { startDate: WED }).dayOfMonth, 9);
  assert.equal(C.describeRecurrence(null).kind, 'none');
});

// ---------------------------------------------------------------- "this occurrence only"

const SERIES = {
  id: 's1', device_id: 'dev', title: 'Lobby loop', playlist_id: 'pl', priority: 2, color: '#123456',
  recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  start_time: '2026-09-01T09:00:00', end_time: '2026-09-01T17:00:00', recurrence_end: '2026-09-30',
};

test('editing a MIDDLE occurrence splits the series into head, single and tail', async () => {
  const occ = new Date(2026, 8, 16);   // Wed 16 Sep
  const plan = C.planOccurrenceEdit(SERIES, occ, { startMin: 10 * 60, endMin: 12 * 60 });
  assert.deepEqual(plan.update, { recurrence_end: '2026-09-15' }, 'the existing row stops the day before');
  assert.equal(plan.delete, false);
  assert.equal(plan.create.length, 2);
  const [single, tail] = plan.create;
  assert.equal(single.start_time, '2026-09-16T10:00:00'); assert.equal(single.end_time, '2026-09-16T12:00:00');
  assert.equal(single.recurrence, null, 'the occurrence becomes a one-off');
  assert.equal(single.device_id, 'dev'); assert.equal(single.playlist_id, 'pl'); assert.equal(single.priority, 2);
  assert.equal(tail.start_time, '2026-09-17T09:00:00', 'the rule resumes the day after, at the ORIGINAL time');
  assert.equal(tail.recurrence, SERIES.recurrence);
  assert.equal(tail.recurrence_end, '2026-09-30', 'and keeps the original end');
});

test('editing the FIRST occurrence has no head: the existing row becomes the tail', async () => {
  const plan = C.planOccurrenceEdit(SERIES, new Date(2026, 8, 1), { startMin: 8 * 60, endMin: 9 * 60 });
  assert.deepEqual(plan.update, { start_time: '2026-09-02T09:00:00', end_time: '2026-09-02T17:00:00' });
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].start_time, '2026-09-01T08:00:00');
  assert.equal(plan.delete, false);
});

test('editing the LAST occurrence has no tail', async () => {
  const plan = C.planOccurrenceEdit(SERIES, new Date(2026, 8, 30), { startMin: 9 * 60, endMin: 10 * 60 });
  assert.deepEqual(plan.update, { recurrence_end: '2026-09-29' });
  assert.equal(plan.create.length, 1, 'just the single; nothing resumes after the end date');
});

test('a one-day series edited on that day is simply replaced', async () => {
  const one = { ...SERIES, start_time: '2026-09-16T09:00:00', end_time: '2026-09-16T17:00:00', recurrence_end: '2026-09-16' };
  const plan = C.planOccurrenceEdit(one, new Date(2026, 8, 16), { startMin: 9 * 60, endMin: 10 * 60 });
  assert.equal(plan.update, null); assert.equal(plan.delete, true); assert.equal(plan.create.length, 1);
});

test('an open-ended series always gets a tail, and a moved day is honoured', async () => {
  const open = { ...SERIES, recurrence_end: null };
  const plan = C.planOccurrenceEdit(open, new Date(2026, 8, 16), { date: new Date(2026, 8, 18), startMin: 9 * 60, endMin: 17 * 60 });
  assert.equal(plan.create.length, 2);
  assert.equal(plan.create[0].start_time, '2026-09-18T09:00:00', 'the single lands on the day it was dragged to');
  assert.equal(plan.create[1].recurrence_end, null, 'the tail stays open-ended');
});
