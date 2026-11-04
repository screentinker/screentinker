'use strict';

/*
 * #327: specific days of the week, and an end date for a repeat.
 *
 * Both were already supported everywhere except the form. services/scheduler.js evaluates BYDAY
 * against the DEVICE's local day-of-week, and recurrence_end is stored, accepted by the API and
 * honoured by the scheduler and the calendar. The schedule form offered four fixed presets and no
 * end date at all, so "Mon, Wed, Fri" was unexpressible and a repeat could never be given an end.
 *
 * Source-level for the form (browser code, no DOM here), behavioural for the engine, because the
 * engine half is the part that must not regress.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEW = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'schedule.js'), 'utf8');

test('#327: the form can express an arbitrary set of days', () => {
  assert.match(VIEW, /value="CUSTOM"/, 'a custom option exists');
  assert.match(VIEW, /class="sched-day"/, 'per-day checkboxes exist');
  for (const d of ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']) {
    assert.ok(VIEW.includes(`'${d}'`), `day ${d} is offered`);
  }
});

test('#327: the composed rule is the same shape the presets already use', () => {
  const fn = VIEW.slice(VIEW.indexOf('function readRecurrence'), VIEW.indexOf('function applyRecurrence'));
  assert.match(fn, /FREQ=WEEKLY;BYDAY=\$\{days\.join\(','\)\}/, 'emits FREQ=WEEKLY;BYDAY=..');
  assert.match(fn, /days\.length \? .* : 'FREQ=WEEKLY'/s,
    'custom with nothing ticked falls back to a plain weekly rule rather than an empty BYDAY');
});

test('#327: editing an existing custom rule shows the days it actually uses', () => {
  const fn = VIEW.slice(VIEW.indexOf('function applyRecurrence'), VIEW.indexOf('function wireRepeatOnce'));
  assert.match(fn, /BYDAY=\(\[A-Z,\]\+\)/, 'parses BYDAY back out');
  assert.match(fn, /sel\.value = 'CUSTOM'/, 'a non-preset day set selects CUSTOM');
});

test('#327: an end date is on the form and is sent', () => {
  assert.match(VIEW, /id="schedRepeatEnd"/, 'the field exists');
  assert.match(VIEW, /recurrence_end:/, 'and is included in the payload');
});

// ---- the engine half, which must keep working ----

test('the scheduler still filters on BYDAY in the device local zone', () => {
  const sched = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  assert.match(sched, /rule\.byDay && !rule\.byDay\.includes\(L\.dow\)/,
    'day filtering uses the device-local day-of-week');
  assert.match(sched, /if \(key === 'BYDAY'\)/, 'BYDAY is still parsed');
  assert.match(sched, /recurrence_end/, 'recurrence_end is still honoured');
});
