'use strict';

/*
 * A NEW SCHEDULE FROM THE DASHBOARD SHOWS SOMETHING.
 *
 * A schedule does its work by pointing a screen at a playlist, a layout or a single item for a
 * window of time. The dialog saved with none of the three chosen: "Schedule saved", and a 09:00 to
 * 17:00 block labelled "Scheduled" on the calendar that puts nothing on the screen (and, being
 * active, can stand in front of a real schedule in the same slot).
 *
 * The invariant: the two dashboard forms that create a schedule refuse to create one with nothing
 * to show, and say what is missing. Editing a schedule that already exists is not blocked, and the
 * API is unchanged (an integration may create a window first and fill it afterwards).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'js');
const view = fs.readFileSync(path.join(ROOT, 'views', 'schedule.js'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'i18n', 'en.js'), 'utf8');

test('the schedule dialog refuses a new schedule with no playlist, layout or item', () => {
  const save = view.slice(view.indexOf("document.getElementById('saveScheduleBtn').onclick"), view.indexOf('// ---------------------------------------------------------------- #796 the schedule library'));
  const guardAt = save.search(/if \(!editingId && !contentId && !playlistId && !layoutId\)/);
  assert.ok(guardAt > 0, 'the guard exists');
  assert.match(save.slice(guardAt, guardAt + 200), /showToast\(t\('schedule\.toast\.nothing_to_show'\), 'error'\); return;/);
  assert.ok(guardAt < save.indexOf("await API('/schedules'"), 'and runs before anything is sent');
  assert.ok(guardAt < save.indexOf('pendingCreateDate = null'), 'and before the pending date is consumed, so a retry keeps the day that was clicked');
});

test('the quick-create popover refuses the same', () => {
  const pop = view.slice(view.indexOf('const readForm = () => {'), view.indexOf("await API('/schedules', { method: 'POST', body: JSON.stringify(data) });"));
  assert.match(pop, /if \(!f\.playlistId\) \{ showToast\(t\('schedule\.toast\.nothing_to_show'\), 'error'\); return; \}/);
});

test('the message has English text', () => {
  assert.match(en, /'schedule\.toast\.nothing_to_show': '[^']{10,}'/);
});
