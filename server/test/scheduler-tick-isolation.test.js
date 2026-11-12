'use strict';

/*
 * ONE SCREEN'S BAD DATA MUST NOT STOP THE SCHEDULER FOR EVERYONE.
 *
 * The scheduler tick walks every online screen once a minute. A recurrence string and a time zone
 * are both stored as received (the zone can even come from the player's own report), and both are
 * parsed inside that walk. The server treats an uncaught exception as fatal by design, so a throw
 * anywhere in the walk is not "this screen's schedule did not apply": it is the process exiting,
 * every minute, for every tenant, with every screen reconnecting each time.
 *
 * The invariant: the tick never throws, a screen with unreadable schedule data is skipped (it keeps
 * playing what it had), and every other screen is still evaluated in the same tick.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-schedisol-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const scheduler = require('../services/scheduler');

const id = () => crypto.randomUUID();
const fakeIo = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) };
let userId, playlist;

const stamp = (dayOffset) => `${new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10)}T00:00`;

function screen({ timezone = 'UTC', reported = null } = {}) {
  const d = id();
  db.prepare(`INSERT INTO devices (id, user_id, name, pairing_code, status, playlist_source, timezone, reported_timezone)
              VALUES (?, ?, 'screen', ?, 'online', 'device', ?, ?)`).run(d, userId, id().slice(0, 6), timezone, reported);
  return d;
}
function schedule(deviceId, recurrence) {
  db.prepare(`INSERT INTO schedules (id, user_id, device_id, playlist_id, title, start_time, end_time,
                                     timezone, recurrence, priority, enabled)
              VALUES (?, ?, ?, ?, 'window', ?, ?, 'UTC', ?, 0, 1)`)
    .run(id(), userId, deviceId, playlist, stamp(-2), stamp(2), recurrence);
}
const scheduled = (d) => db.prepare('SELECT scheduled_playlist_id FROM devices WHERE id = ?').get(d).scheduled_playlist_id;

before(() => {
  userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(userId, `iso-${userId}@example.com`, 'Iso', 'x');
  playlist = id();
  db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)').run(playlist, userId, 'scheduled');
});

test('a recurrence with a key and no value is read, not thrown on', () => {
  for (const r of ['FREQ=WEEKLY;BYDAY', 'BYDAY', 'FREQ=DAILY;;INTERVAL', ';', 'FREQ']) {
    assert.doesNotThrow(() => scheduler.parseSimpleRRule(r), `parseSimpleRRule(${JSON.stringify(r)})`);
  }
  assert.deepEqual(scheduler.parseSimpleRRule('FREQ=WEEKLY;BYDAY=MO,WE'), { freq: 'WEEKLY', byDay: [1, 3] },
    'and a well-formed rule still parses to exactly what it did');
  assert.deepEqual(scheduler.parseSimpleRRule('FREQ=YEARLY;BYDAY='), { freq: 'YEARLY', byDay: [] },
    'an empty day list is still a day list (no days), not "every day"');
  for (const r of ['FREQ=YEARLY;BYDAY=', 'FREQ=WEEKLY;BYDAY=']) {
    assert.equal(scheduler.isScheduleActiveNow({ start_time: '2026-01-01T00:00', end_time: '2026-01-01T23:59', recurrence: r }, new Date(Date.UTC(2026, 10, 11, 12, 0)), 'UTC'), false, r + ' is never active');
  }
});

test('a screen with an unreadable recurrence does not stop the tick, and the others are still scheduled', () => {
  db.prepare('DELETE FROM schedules').run();
  const bad = screen(), good = screen();
  schedule(bad, 'FREQ=WEEKLY;BYDAY');
  schedule(good, null);
  assert.doesNotThrow(() => scheduler.evaluateSchedules(fakeIo, undefined, { skipReboots: true }));
  assert.equal(scheduled(good), playlist, 'the healthy screen was evaluated in the same tick');
});

test('a screen whose time zone is not a real zone does not stop the tick either', () => {
  db.prepare('DELETE FROM schedules').run();
  // Both ways a zone reaches the row: the operator's override, and the player's own report.
  const override = screen({ timezone: 'Mars/Phobos' }), reported = screen({ timezone: 'UTC', reported: 'Not/A_Zone' });
  const good = screen();
  for (const d of [override, reported, good]) schedule(d, null);
  assert.doesNotThrow(() => scheduler.evaluateSchedules(fakeIo));   // reboots included: they read the zone too
  assert.equal(scheduled(good), playlist, 'the healthy screen was evaluated in the same tick');
  // An unknown zone falls back to the server clock, the same as a screen that reports none, so an
  // open-ended window still applies instead of the screen silently losing its schedule.
  assert.equal(scheduled(override), playlist);
  assert.equal(scheduled(reported), playlist);
});

test('a throw from one screen is contained to that screen', () => {
  db.prepare('DELETE FROM schedules').run();
  const first = screen(), second = screen();
  schedule(first, null); schedule(second, null);
  // Whatever goes wrong inside one screen's evaluation (here: its row cannot be written), the walk
  // carries on. Simulated by making the first screen's own schedule lookup blow up.
  const real = db.prepare.bind(db);
  let tripped = false;
  db.prepare = (sql) => {
    const st = real(sql);
    if (!tripped && /UPDATE devices SET scheduled_playlist_id/.test(sql)) {
      return new Proxy(st, { get: (t, k) => (k === 'run'
        ? (...a) => { if (!tripped) { tripped = true; throw new Error('simulated failure for one screen'); } return t.run(...a); }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    }
    return st;
  };
  try {
    assert.doesNotThrow(() => scheduler.evaluateSchedules(fakeIo, undefined, { skipReboots: true }));
  } finally { db.prepare = real; }
  assert.ok(tripped, 'the simulated failure was reached (otherwise this test proves nothing)');
  const done = [first, second].filter((d) => scheduled(d) === playlist).length;
  assert.ok(done >= 1, 'at least the screen after the failing one was still scheduled');
});
