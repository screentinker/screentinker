'use strict';

// THE BUG THIS PINS: "I add a schedule and it shows up on a different day."
//
// expandSchedule had two emit paths that disagreed about the wire format. A one-off passed
// schedule.start_time through untouched - a naive wall-clock string - while a recurring instance
// emitted cursor.toISOString(), an absolute instant. The browser parses the first in its own zone
// (correct) and converts the second out of the server's zone (wrong by the offset between them).
// For an operator in Tokyo against a US-Central server that is 14 hours: a Wednesday 20:00 event
// came back as Thursday 10:00.
//
// The calendar was also the only component doing this. services/scheduler.js compares start_time
// as a STRING and never builds a Date from it, so the drawing disagreed with playback as well as
// with the browser.
//
// These tests assert the PROPERTY the browser depends on - the wire value is wall-clock, and it
// means the same thing regardless of which zone reads it - rather than asserting a literal string,
// which would pass just as happily with the bug present in a differently-configured CI box.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fmt-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-instance-format';

const { expandSchedule } = require('../routes/schedules');

// Wednesday 19 Aug 2026, 20:00 - late enough in the day that a westward server offset pushes it
// over midnight, which is exactly the case that was breaking.
const START = '2026-08-19T20:00:00';
const END   = '2026-08-19T21:00:00';
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const rangeStart = new Date(2026, 7, 16, 0, 0, 0, 0);        // Sun 16 Aug, local
const rangeEnd   = new Date(2026, 7, 23, 0, 0, 0, 0);        // Sun 23 Aug, local

const schedule = (recurrence) => ({
  id: 1, start_time: START, end_time: END, recurrence, recurrence_end: null,
});

/* Run fn with the process in a given zone, restoring exactly what was there before. */
function inTimezone(tz, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    // ⚠️ Assigning `undefined` here would write the STRING "undefined", which Node cannot parse and
    // silently resolves to UTC - quietly changing the zone for every test that runs afterwards in
    // this process. Delete the key instead when it was not set to begin with.
    if (had) process.env.TZ = original;
    else delete process.env.TZ;
  }
}

test('a recurring instance is emitted as wall-clock, not as an absolute instant', () => {
  const events = expandSchedule(schedule('FREQ=WEEKLY;BYDAY=WE'), rangeStart, rangeEnd);
  assert.ok(events.length > 0, 'the rule should draw at least one event');
  for (const ev of events) {
    assert.match(ev.instance_start, WALL_CLOCK,
      `instance_start must be a naive wall-clock string; got ${ev.instance_start}`);
    assert.match(ev.instance_end, WALL_CLOCK,
      `instance_end must be a naive wall-clock string; got ${ev.instance_end}`);
  }
});

test('one-off and recurring agree on the wire format', () => {
  // They are read by the same line of frontend code. If they disagree, one of them is wrong on
  // every client whose zone differs from the server's - and which one is invisible from here.
  const [oneOff] = expandSchedule(schedule(null), rangeStart, rangeEnd);
  const [recurring] = expandSchedule(schedule('FREQ=WEEKLY;BYDAY=WE'), rangeStart, rangeEnd);
  const shape = (v) => (WALL_CLOCK.test(v) ? 'wall-clock' : 'absolute');
  assert.equal(shape(recurring.instance_start), shape(oneOff.instance_start),
    'the two emit paths disagree about the wire format');
});

test('the emitted time is the time the operator chose', () => {
  const [ev] = expandSchedule(schedule('FREQ=WEEKLY;BYDAY=WE'), rangeStart, rangeEnd);
  assert.equal(ev.instance_start.slice(11, 16), '20:00',
    'a 20:00 schedule must draw at 20:00');
  assert.equal(new Date(ev.instance_start).getDay(), 3, 'Wednesday stays Wednesday');
});

test('THE REPORTED BUG: the day survives a server and browser in different zones', () => {
  // Generate as a US-Central server would, then read it as a Tokyo browser would. With the bug,
  // the recurring instance arrives as ...T01:00:00.000Z and Tokyo renders Thursday 10:00.
  const wire = inTimezone('America/Chicago', () => {
    const [ev] = expandSchedule(schedule('FREQ=WEEKLY;BYDAY=WE'), rangeStart, rangeEnd);
    return ev.instance_start;
  });

  inTimezone('Asia/Tokyo', () => {
    const seen = new Date(wire);
    assert.equal(seen.getDay(), 3, `Tokyo should still see Wednesday, saw ${seen.toString()}`);
    assert.equal(seen.getHours(), 20, `Tokyo should still see 20:00, saw ${seen.getHours()}:00`);
  });
});

test('and the same holds when the server is EAST of the browser', () => {
  // The mirror case, so a fix that merely shifts the offset in one direction cannot pass.
  const wire = inTimezone('Asia/Tokyo', () => {
    const [ev] = expandSchedule(schedule('FREQ=WEEKLY;BYDAY=WE'), rangeStart, rangeEnd);
    return ev.instance_start;
  });

  inTimezone('America/Chicago', () => {
    const seen = new Date(wire);
    assert.equal(seen.getDay(), 3, `Chicago should still see Wednesday, saw ${seen.toString()}`);
    assert.equal(seen.getHours(), 20, `Chicago should still see 20:00, saw ${seen.getHours()}:00`);
  });
});
