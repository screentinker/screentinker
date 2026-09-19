'use strict';

/*
 * #299 stranded-play repair: once per CONNECTION, never once per play.
 *
 * ⚠️ WHY THIS TEST EXISTS, IN NUMBERS. The repair is a correlated self-join of play_logs against
 * play_logs plus a join to content, grouped per row, over the device's whole history. Measured
 * against a copy of a real fleet database — 3.1M rows, 2.7M on the busiest device — it costs
 * **362ms**, and **355ms when there is nothing to close**: the full price is paid whether or not it
 * finds anything. It was called on every play_start, and at roughly one play per second across a
 * 78-panel site that is a ~150ms synchronous block about once a second, permanently.
 *
 * That is not a theory. A 60-second CPU profile from the affected server put **27.1% of all wall
 * time** inside this single call, and it is the whole explanation for a loop whose p50 sat at the
 * 20ms measurement floor while its p99 sat at 130-165ms.
 *
 * A lost play_end comes from a session ending abruptly. The evidence for one is the FIRST play of a
 * NEW connection — inside a healthy session every end arrives normally. So the sweep is armed per
 * socket and disarmed once it runs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');

test('the live repair is armed per connection and disarmed after it runs', () => {
  /*
   * Scale-out C2 moved the handler bodies into EVENT_APPLIERS, callable for a screen behind a
   * replica too. The flag now lives on `ctx.session`, one object per CONNECTION (created inside
   * the connection handler; a mesh-applied event gets a fresh one per write) — still never
   * module-level, which is the property this test exists to hold.
   */
  const conn = SRC.slice(SRC.indexOf("deviceNs.on('connection'"));
  assert.match(conn, /session: \{ strandedSweepDone: false \}/,
    'the flag must be per-socket state — a module-level one would disarm the whole fleet after one device');
  assert.doesNotMatch(SRC.slice(0, SRC.indexOf('const EVENT_APPLIERS')), /strandedSweepDone/,
    'no module-level copy of the flag');

  const guard = SRC.slice(SRC.indexOf('if (!ctx.session.strandedSweepDone)'), SRC.indexOf('if (!ctx.session.strandedSweepDone)') + 280);
  assert.match(guard, /ctx\.session\.strandedSweepDone = true;/, 'it must disarm');
  assert.match(guard, /closeStrandedPlays\(db, device_id\)/, 'and still do the repair');

  // Disarm BEFORE the call: a throw inside the sweep must not re-arm it for every later play.
  assert.ok(guard.indexOf('strandedSweepDone = true;') < guard.indexOf('closeStrandedPlays'),
    'disarm before calling, or a failing sweep runs again on every play — the bug being fixed');
});

test('no unguarded call to the repair survives on the live play path', () => {
  /*
   * The second call site is the offline BACKFILL flush, which is where this work belongs: it runs
   * once per flush against a batch a device just handed over. This asserts the live path has
   * exactly one call and that it is behind the guard.
   */
  const playStart = SRC.slice(SRC.indexOf("if (event === 'play_start')"), SRC.indexOf("dashboard:playback-progress"));
  const calls = (playStart.match(/closeStrandedPlays\(/g) || []).length;
  assert.equal(calls, 1, `expected exactly one repair call on the play path, found ${calls}`);
  assert.match(playStart, /if \(!ctx\.session\.strandedSweepDone\)[\s\S]{0,200}closeStrandedPlays\(/,
    'the call on the play path must be behind the once-per-connection guard');
});

test('the repair itself is unchanged — this fixes cadence, not behaviour', () => {
  const backfill = fs.readFileSync(path.join(__dirname, '..', 'lib', 'play-backfill.js'), 'utf8');
  assert.match(backfill, /function closeStrandedPlays\(db, deviceId/,
    'the repair keeps its signature; only how often it is called changed');
  // The guarantees the query makes are load-bearing and must not have been "optimised" away.
  assert.match(backfill, /n\.zone_id IS p\.zone_id/, 'same-zone matching must survive');
  assert.match(backfill, /nxt\.next_start - nxt\.p_started <= nxt\.allowed/,
    'the per-row ceiling that stops a 20s clip being credited with hours must survive');
});
