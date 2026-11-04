'use strict';

/*
 * What a schedule is allowed to touch.
 *
 * ⚠️ services/scheduler.js used to overwrite devices.playlist_id and layout_id directly, keeping the
 * previous values in an in-memory Map so it could put them back. Two failures came out of that: a
 * restart during an active schedule lost the Map and stranded the device on the scheduled playlist
 * FOREVER (nothing on the row said it was temporary), and a schedule was indistinguishable from an
 * operator's own choice because both ended up in the same column.
 *
 * It now writes scheduled_playlist_id / scheduled_layout_id, which the resolver ranks above the
 * device's own. "Revert" is clearing a column, not remembering something.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-schedcol-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { evaluateSchedules } = require('../services/scheduler');
const { resolveDevicePlaylist } = require('../lib/resolve-device-playlist');

const id = () => crypto.randomUUID();
let userId, deviceId, ownPlaylist, schedPlaylist;

// The scheduler needs an io whose /device namespace exists; nothing here asserts on emissions.
const fakeIo = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) };

before(() => {
  userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(userId, `sched-${userId}@example.com`, 'Sched', 'x');
  ownPlaylist = id(); schedPlaylist = id();
  for (const [p, n] of [[ownPlaylist, 'normally'], [schedPlaylist, 'at-noon']]) {
    db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)').run(p, userId, n);
  }
  deviceId = id();
  db.prepare(`INSERT INTO devices (id, user_id, name, pairing_code, status, playlist_id, playlist_source, timezone)
              VALUES (?, ?, ?, ?, 'online', ?, 'device', 'UTC')`)
    .run(deviceId, userId, 'sched-screen', id().slice(0, 6), ownPlaylist);
});

/*
 * ⚠️ start_time / end_time are full device-LOCAL stamps ("YYYY-MM-DDTHH:MM"), not "HH:MM" — a
 * one-off window, no recurrence, so this fixture depends on nothing but the clock being between
 * yesterday and tomorrow.
 */
const stamp = (dayOffset) => {
  const d = new Date(Date.now() + dayOffset * 86400000);
  return `${d.toISOString().slice(0, 10)}T12:00`;
};
const setSchedule = (enabled) => {
  db.prepare('DELETE FROM schedules').run();
  db.prepare(`INSERT INTO schedules (id, user_id, device_id, playlist_id, title, start_time, end_time,
                                     timezone, recurrence, priority, enabled)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'UTC', NULL, 0, ?)`)
    .run(id(), userId, deviceId, schedPlaylist, 'open window', stamp(-1), stamp(1), enabled ? 1 : 0);
};
const row = () => db.prepare('SELECT playlist_id, playlist_source, scheduled_playlist_id FROM devices WHERE id = ?').get(deviceId);

test('⚠️ an active schedule writes its OWN column and leaves the device playlist alone', () => {
  setSchedule(true);
  evaluateSchedules(fakeIo);

  const r = row();
  assert.equal(r.scheduled_playlist_id, schedPlaylist, 'the scheduler did not record the active schedule');
  assert.equal(r.playlist_id, ownPlaylist,
    "the schedule overwrote the operator's own playlist — that write is what the in-memory Map then "
    + 'had to undo, and could not after a restart');
  assert.equal(r.playlist_source, 'device');
  assert.deepEqual(resolveDevicePlaylist(deviceId), { playlist_id: schedPlaylist, source: 'schedule' },
    'the schedule must still WIN while it runs — it just wins by ranking, not by clobbering');
});

test('⚠️ THE RESTART: a fresh process re-derives the same state, with nothing remembered', () => {
  setSchedule(true);
  evaluateSchedules(fakeIo);
  // Nothing to simulate: there is no in-memory state. Re-evaluating is the restart.
  evaluateSchedules(fakeIo);
  assert.equal(row().scheduled_playlist_id, schedPlaylist);
  assert.equal(resolveDevicePlaylist(deviceId).playlist_id, schedPlaylist);
});

test('when the schedule stops applying, the column is CLEARED and the device returns', () => {
  setSchedule(true);
  evaluateSchedules(fakeIo);
  assert.equal(row().scheduled_playlist_id, schedPlaylist);

  setSchedule(false);   // disabled — no longer active
  evaluateSchedules(fakeIo);

  assert.equal(row().scheduled_playlist_id, null, 'a schedule that no longer applies must release the device');
  assert.deepEqual(resolveDevicePlaylist(deviceId), { playlist_id: ownPlaylist, source: 'device' },
    'reverting is now "clear the column"; the original was never overwritten to begin with');
});

test('a device with no schedule at all is left entirely untouched', () => {
  db.prepare('DELETE FROM schedules').run();
  db.prepare('UPDATE devices SET scheduled_playlist_id = NULL WHERE id = ?').run(deviceId);
  evaluateSchedules(fakeIo);
  const r = row();
  assert.equal(r.scheduled_playlist_id, null);
  assert.equal(r.playlist_id, ownPlaylist);
});
