'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { Server } = require('socket.io');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-offline-plan-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
const { build, buildCached, clearCache } = require('../lib/offline-schedule-plan');
const { makeClock } = require('../lib/local-clock');
const { db } = require('../db/database');
const fixture = require('./helpers/simulate-fixture');
const setupDeviceSocket = require('../ws/deviceSocket');

const H = 60 * 60 * 1000;
const at = (hour, minute = 0) => Date.UTC(2026, 0, 1, hour, minute);
function pick(schedules, now) {
  const m = now.getUTCMinutes() + now.getUTCHours() * 60;
  return schedules.find((s) => m >= s.start && m < s.end) || null;
}

test('offline schedule plan is half-open and includes a future scheduled playlist', () => {
  const plan = build({
    schedules: [
      { id: 'a', playlist_id: 'playlist-a', start: 9 * 60, end: 10 * 60 },
      { id: 'b', playlist_id: 'playlist-b', start: 10 * 60, end: 12 * 60 },
    ],
    timezone: 'UTC', now: at(9, 30), horizonMs: 3 * H, pick,
  });
  assert.deepEqual(plan.intervals.map((x) => [x.start_utc_ms, x.end_utc_ms, x.schedule_id]), [
    [at(9, 30), at(10), 'a'], [at(10), at(12), 'b'], [at(12), at(12, 30), null],
  ]);
});

test('offline schedule plan coalesces unchanged minutes and never carries content past its end', () => {
  const plan = build({ schedules: [{ id: 'a', playlist_id: 'p', start: 9 * 60, end: 10 * 60 }], timezone: 'UTC', now: at(9), horizonMs: H, pick });
  assert.equal(plan.intervals.length, 1);
  assert.equal(plan.intervals[0].end_utc_ms, at(10));
  assert.equal(plan.intervals[0].schedule_id, 'a');
});

test('14-day planning uses pre-resolved local parts instead of the blocking Date/Intl picker', () => {
  const schedules = [{ id: 'daily', playlist_id: 'p', start: 9 * 60, end: 17 * 60, start_time: '2026-10-25T09:00:00', end_time: '2026-10-25T17:00:00' }];
  let fastCalls = 0;
  const plan = build({
    schedules,
    timezone: 'Africa/Cairo',
    now: Date.UTC(2026, 9, 25),
    pick() {
      assert.fail('the Date/Intl picker must not run when a local-parts picker is supplied');
    },
    clock: makeClock('Africa/Cairo'),
    pickAt(rows, local) {
      fastCalls++;
      return rows.find((s) => local.min >= s.start && local.min < s.end) || null;
    },
  });
  assert.ok(fastCalls < 100, 'only schedule transition candidates are evaluated, not every horizon minute');
  assert.ok(plan.intervals.some((x) => x.schedule_id === 'daily'));
  assert.ok(plan.intervals.some((x) => x.schedule_id === null));
  assert.equal(plan.valid_until_utc_ms - plan.generated_at_utc_ms, 14 * 24 * H);
});

test('an incomplete accelerated picker is rejected instead of silently changing semantics', () => {
  assert.throws(
    () => build({ schedules: [], pickAt() {}, now: at(0), horizonMs: H }),
    /requires pick, or pickAt with a clock/,
  );
});

test('an unchanged device plan is cached across reconnect payloads and clipped at now', () => {
  clearCache();
  let calls = 0;
  const options = {
    key: 'device-a/revision-1', schedules: [{ id: 'a', playlist_id: 'p', start: 9 * 60, end: 10 * 60 }], timezone: 'UTC', horizonMs: 2 * H,
    pick(rows, now) { calls++; return pick(rows, now); },
  };
  const first = buildCached({ ...options, now: at(9, 30) });
  const afterFirst = calls;
  const second = buildCached({ ...options, now: at(9, 45) });
  assert.equal(calls, afterFirst, 'the second payload reuses the hour-aligned timeline');
  assert.equal(second.intervals[0].start_utc_ms, at(9, 45), 'the cached source is clipped, never replayed from the hour');
  assert.equal(first.intervals[0].schedule_id, second.intervals[0].schedule_id);
});

test('offline plan uses the live scheduler recurrence verdict, including its inclusive end minute', () => {
  const { isScheduleActiveAt } = require('../services/scheduler');
  const schedule = {
    id: 'daily', playlist_id: 'day', layout_id: null,
    recurrence: 'FREQ=DAILY', start_time: '2026-11-02T00:00:00', end_time: '2026-11-02T01:00:00',
  };
  const plan = build({
    schedules: [schedule], timezone: 'UTC', now: Date.parse('2026-11-02T00:30:00Z'), horizonMs: 2 * H,
    pickAt: (rows, local) => rows.find((row) => isScheduleActiveAt(row, local)) || null, clock: makeClock('UTC'),
  });
  assert.deepEqual(plan.intervals.map((x) => [new Date(x.start_utc_ms).toISOString(), new Date(x.end_utc_ms).toISOString(), x.schedule_id]), [
    ['2026-11-02T00:30:00.000Z', '2026-11-02T01:01:00.000Z', 'daily'],
    ['2026-11-02T01:01:00.000Z', '2026-11-02T02:30:00.000Z', null],
  ]);
});

test('plan intervals agree with the live scheduler at every minute across a DST change', () => {
  const { isScheduleActiveAt } = require('../services/scheduler');
  const clock = makeClock('America/New_York');
  const schedule = { id: 'breakfast', playlist_id: 'p', recurrence: 'FREQ=DAILY', start_time: '2026-03-01T07:00:00', end_time: '2026-03-01T08:00:00' };
  const start = Date.parse('2026-03-07T00:00:00Z');
  const plan = build({ schedules: [schedule], timezone: 'America/New_York', now: start, horizonMs: 3 * 24 * H,
    clock, pickAt: (rows, local) => rows.find((row) => isScheduleActiveAt(row, local)) || null });
  for (let ms = start; ms < start + 3 * 24 * H; ms += 60 * 1000) {
    const expected = isScheduleActiveAt(schedule, clock(ms)) ? 'breakfast' : null;
    const actual = plan.intervals.find((interval) => interval.start_utc_ms <= ms && ms < interval.end_utc_ms).schedule_id;
    assert.equal(actual, expected, new Date(ms).toISOString());
  }
});

test('spring-forward activates a skipped local start at the real offset transition', () => {
  const { isScheduleActiveAt } = require('../services/scheduler');
  const clock = makeClock('America/New_York');
  const schedule = { id: 'dst-gap', playlist_id: 'p', recurrence: 'FREQ=DAILY', start_time: '2027-03-01T02:30:00', end_time: '2027-03-01T04:00:00' };
  const start = Date.parse('2027-03-14T06:45:00Z');
  const plan = build({ schedules: [schedule], timezone: 'America/New_York', now: start, horizonMs: 2 * H,
    clock, pickAt: (rows, local) => rows.find((row) => isScheduleActiveAt(row, local)) || null });
  for (const iso of ['2027-03-14T06:59:00Z', '2027-03-14T07:00:00Z', '2027-03-14T07:30:00Z', '2027-03-14T08:01:00Z']) {
    const ms = Date.parse(iso);
    const actual = plan.intervals.find((interval) => interval.start_utc_ms <= ms && ms < interval.end_utc_ms).schedule_id;
    const expected = isScheduleActiveAt(schedule, clock(ms)) ? 'dst-gap' : null;
    assert.equal(actual, expected, iso);
  }
});

test('a truncated plan expires at its last emitted interval', () => {
  const { MAX_INTERVALS, MINUTE_MS } = require('../lib/offline-schedule-plan');
  const plan = build({
    schedules: [], timezone: 'UTC', now: at(0), horizonMs: (MAX_INTERVALS + 10) * MINUTE_MS,
    pick(_rows, now) {
      const minute = Math.floor((now.getTime() - at(0)) / MINUTE_MS);
      return { id: minute % 2 ? 'odd' : 'even', playlist_id: 'p' };
    },
  });
  assert.equal(plan.intervals.length, MAX_INTERVALS);
  assert.equal(plan.valid_until_utc_ms, plan.intervals.at(-1).end_utc_ms);
});

test('only the explicit offline-plan capability gates the payload contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ws/deviceSocket.js'), 'utf8');
  assert.match(source, /capsLib\.supports\(device, 'offline\.schedule_plan'\)/);
  assert.doesNotMatch(source, /capsLib\.supports\(device, 'clock\.tz_table'\)[\s\S]{0,300}offline_schedule/);
  assert.doesNotMatch(source, /offlinePlan !== false && device\?\.playlist_source === 'schedule'/,
    'a future plan must be sent before its first schedule becomes active');
  assert.match(source, /overrideNow \|\| hookNow\) \{\s*assembled\.offline_plan = null;/,
    'an override explicitly clears a previously persisted plan');
  assert.match(source, /scheduler\.isScheduleActiveAt\(schedule, local\)/,
    'the plan uses the live scheduler evaluator rather than a second recurrence implementation');
});

test('a device without offline.schedule_plan receives a byte-identical normal payload', () => {
  const f = fixture.build(db);
  const io = new Server(http.createServer());
  setupDeviceSocket(io);
  try {
    const current = JSON.parse(db.prepare('SELECT capabilities FROM devices WHERE id = ?').get(f.devices.own).capabilities);
    db.prepare('UPDATE devices SET capabilities = ? WHERE id = ?').run(JSON.stringify([...current, 'clock.tz_table']), f.devices.own);
    const before = JSON.parse(JSON.stringify(setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own)));
    const after = JSON.parse(JSON.stringify(setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own)));
    assert.deepEqual(after, before, 'timezone support alone must not opt a player into offline plans');
    assert.equal(Object.hasOwn(after, 'offline_plan'), false);
  } finally {
    io.close();
  }
});

test('capable devices receive a normal gap state, while a corporate mandate explicitly clears plans', () => {
  const f = fixture.build(db);
  const io = new Server(http.createServer());
  setupDeviceSocket(io);
  const enablePlan = (id) => {
    const caps = JSON.parse(db.prepare('SELECT capabilities FROM devices WHERE id = ?').get(id).capabilities || '[]');
    db.prepare('UPDATE devices SET capabilities = ? WHERE id = ?').run(JSON.stringify([...caps, 'offline.schedule_plan']), id);
  };
  try {
    enablePlan(f.devices.own);
    const own = setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own);
    assert.ok(own.offline_plan && Array.isArray(own.offline_plan.states));
    assert.ok(own.offline_plan.states.some((state) => state.schedule_id === null), 'a schedule gap carries the ordinary unscheduled payload');

    enablePlan(f.devices.mandated);
    const mandated = setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.mandated);
    assert.equal(mandated.offline_plan, null, 'a mandate clears any stale offline schedule plan');
  } finally {
    io.close();
  }
});

test('a same-ID published playlist change invalidates cached future nested state', () => {
  const f = fixture.build(db);
  const io = new Server(http.createServer());
  setupDeviceSocket(io);
  try {
    const caps = JSON.parse(db.prepare('SELECT capabilities FROM devices WHERE id = ?').get(f.devices.own).capabilities || '[]');
    db.prepare('UPDATE devices SET capabilities = ? WHERE id = ?').run(JSON.stringify([...caps, 'offline.schedule_plan']), f.devices.own);
    const before = setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own);
    const breakfast = before.offline_plan.states.find((state) => state.schedule_id === f.schedules.breakfast);
    assert.ok(breakfast && breakfast.payload.assignments.length);
    const replacement = [{ content_id: f.content['b.mp4'], filename: 'b.mp4', mime_type: 'video/mp4', filepath: `/uploads/${f.content['b.mp4']}.bin`, duration_sec: 17, sort_order: 0, zone_id: null }];
    db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(replacement), f.playlists.Breakfast);
    const after = setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own);
    const refreshed = after.offline_plan.states.find((state) => state.schedule_id === f.schedules.breakfast);
    assert.deepEqual(refreshed.payload.assignments.map((item) => item.content_id), [f.content['b.mp4']], 'a same-ID publish must rebuild future offline state');
  } finally {
    io.close();
  }
});

test('a content replacement invalidates a cached future nested state without a playlist republish', () => {
  const f = fixture.build(db);
  const io = new Server(http.createServer());
  setupDeviceSocket(io);
  try {
    const caps = JSON.parse(db.prepare('SELECT capabilities FROM devices WHERE id = ?').get(f.devices.own).capabilities || '[]');
    db.prepare('UPDATE devices SET capabilities = ? WHERE id = ?').run(JSON.stringify([...caps, 'offline.schedule_plan']), f.devices.own);
    const before = setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own);
    const original = before.offline_plan.states.find((state) => state.schedule_id === f.schedules.breakfast);
    const oldItem = original.payload.assignments.find((item) => item.content_id === f.content['b.mp4']);
    assert.ok(oldItem);

    // Replacement keeps the content and playlist ids stable.  A future plan must
    // nevertheless be rebuilt with the new player URL/revision.
    db.prepare("UPDATE content SET filepath = ?, updated_at = COALESCE(updated_at, 0) + 1 WHERE id = ?")
      .run('/uploads/replaced-b.mp4', f.content['b.mp4']);
    const after = setupDeviceSocket.buildPlaylistPayloadUnchecked(f.devices.own);
    const refreshed = after.offline_plan.states.find((state) => state.schedule_id === f.schedules.breakfast);
    const newItem = refreshed.payload.assignments.find((item) => item.content_id === f.content['b.mp4']);
    assert.ok(newItem);
    assert.notEqual(newItem.filepath, oldItem.filepath, 'replacement must not reuse a stale nested state');
  } finally {
    io.close();
  }
});
