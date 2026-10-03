'use strict';

/*
 * The display-power window evaluator against its shared contract.
 *
 * shared/power-window-vectors.json is the SAME file the Kotlin player is held to
 * (android/app/src/test/.../power/PowerWindowTest.kt, wired in app/build.gradle.kts). No snapshot
 * is taken on either side: both read the one file, so a change that suits the server and breaks
 * the panel fails here or there in the same commit.
 *
 * The property that matters most is the inverted fail-safe. schedule-eval fails OPEN so content
 * keeps playing; this fails to ON so a screen never goes dark by accident. Those are opposite
 * booleans in adjacent modules, which is exactly the kind of thing that gets "tidied" into
 * agreement by someone reading only one of them — so the vectors assert it, and so does a test
 * below that names it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PowerWindow = require('../lib/power-window');
const ScheduleEval = require('../lib/schedule-eval');

const VECTORS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'power-window-vectors.json'), 'utf8')
);

test('power-window: conforms to every shared vector', () => {
  const failures = [];
  for (const v of VECTORS.vectors) {
    const got = PowerWindow.isOff(
      { enabled: v.enabled, timezone: v.timezone, windows: v.windows },
      v.utc_now
    );
    if (got !== v.expect.off) {
      failures.push(`  ${v.name}\n    utc=${v.utc_now} tz=${v.timezone} -> off=${got}, expected ${v.expect.off}`);
    }
  }
  assert.equal(failures.length, 0, `\n${failures.join('\n')}\n`);
  assert.ok(VECTORS.vectors.length >= 20, 'the contract should not shrink');
});

test('power-window: FAILS TO ON — the inverse of schedule-eval, deliberately', () => {
  /*
   * Named explicitly because the two modules sit next to each other and disagree on purpose.
   * If someone ever "fixes" this to match schedule-eval, a fleet goes dark at the first bad
   * timezone string and every panel looks like dead hardware.
   */
  const alwaysOff = { enabled: true, timezone: 'Not/AZone', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] };
  assert.equal(PowerWindow.isOff(alwaysOff, '2026-09-22T21:00:00Z'), false, 'a bad zone must leave the screen lit');

  // ...whereas the item scheduler, given an equally bad zone, keeps PLAYING. Both are "fail to the
  // visible state"; it is the boolean that differs, not the principle.
  assert.equal(
    ScheduleEval.isItemActiveNow([{ days: [1], start: '00:00', end: '01:00', start_date: null, end_date: null }], '2026-09-22T21:00:00Z', 'Not/AZone'),
    true,
    'schedule-eval still fails open — if this flips, revisit power-window too'
  );

  for (const junk of [undefined, null, 42, 'nonsense', { windows: 'no' }, { windows: [null, 7] }]) {
    assert.equal(PowerWindow.isOff(junk, '2026-09-22T21:00:00Z'), false, `junk schedule ${JSON.stringify(junk)} must be inert`);
  }
  assert.equal(PowerWindow.isOff({ enabled: true, timezone: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] }, 'not-a-date'), false);
});

test('power-window: a malformed window never suppresses a good one beside it', () => {
  const s = {
    enabled: true, timezone: 'America/Chicago',
    windows: [{ days: [2], start: '2500', end: '17:00' }, { days: [2], start: '16:00', end: '17:00' }],
  };
  assert.equal(PowerWindow.isOff(s, '2026-09-22T21:00:00Z'), true);
});

test('power-window: local-parts agree with schedule-eval (the copy cannot drift)', () => {
  /*
   * power-window.js duplicates localParts rather than importing it, so the TV players can load it
   * alone. This is the pin: same instant, same zone, same day-of-week and same minute-of-day.
   */
  const zones = ['America/Chicago', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Chatham', 'UTC'];
  const instants = [
    '2026-09-22T21:00:00Z', '2026-03-08T07:30:00Z', '2026-03-08T08:30:00Z',
    '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z', '2026-01-01T00:00:00Z',
  ];
  for (const tz of zones) {
    for (const iso of instants) {
      const a = PowerWindow._localParts(iso, tz);
      const b = ScheduleEval._localParts(new Date(iso), tz);
      assert.equal(a.dow, b.dow, `dow drift for ${tz} @ ${iso}`);
      assert.equal(a.min, b.min, `minute drift for ${tz} @ ${iso}`);
    }
  }
});

test('power-window: overnight windows anchor to the day they START', () => {
  // The rule an operator relies on: "weekdays 22:00-06:00" is five nights, the last one ending
  // Saturday morning — NOT a sixth window that starts on Saturday night.
  const s = { enabled: true, timezone: 'America/Chicago', windows: [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }] };
  assert.equal(PowerWindow.isOff(s, '2026-09-26T06:00:00Z'), true, 'Sat 01:00 is the tail of Friday night');
  assert.equal(PowerWindow.isOff(s, '2026-09-27T06:00:00Z'), false, 'Sun 01:00 is not, because Saturday never started one');
});

test('power-window: nextEdge is advisory, bounded, and never throws', () => {
  const s = { enabled: true, timezone: 'America/Chicago', windows: [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }] };
  // Local Mon 21:59 -> one minute until it sleeps.
  const e = PowerWindow.nextEdge(s, '2026-09-22T02:59:00Z');
  assert.deepEqual({ at: e.at, to: e.to, minutes_until: e.minutes_until }, { at: '22:00', to: 'scheduled_off', minutes_until: 1 });

  // Inside the window -> the next edge is the wake.
  const w = PowerWindow.nextEdge(s, '2026-09-22T03:00:00Z');
  assert.equal(w.to, 'on');
  assert.equal(w.at, '06:00');

  // Degenerate schedules have no edge, and say so rather than scanning forever.
  assert.equal(PowerWindow.nextEdge({ enabled: true, timezone: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] }, '2026-09-22T21:00:00Z'), null);
  assert.equal(PowerWindow.nextEdge({ enabled: false, windows: [] }, '2026-09-22T21:00:00Z'), null);
  assert.equal(PowerWindow.nextEdge(null, '2026-09-22T21:00:00Z'), null);
  assert.equal(PowerWindow.nextEdge({ enabled: true, timezone: 'Not/AZone', windows: [{ days: [1], start: '01:00', end: '02:00' }] }, '2026-09-22T21:00:00Z'), null);
});

test('power-window: stateOf gives the two telemetry strings and only those', () => {
  const off = { enabled: true, timezone: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] };
  assert.equal(PowerWindow.stateOf(off, '2026-09-22T21:00:00Z'), 'scheduled_off');
  assert.equal(PowerWindow.stateOf({ enabled: false }, '2026-09-22T21:00:00Z'), 'on');
});
