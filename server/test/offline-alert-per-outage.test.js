'use strict';

// An offline display is ONE event, not a recurring condition.
//
// The alert loop ticks every 60s and re-evaluated a still-offline device every time,
// so a 2-hour dedup window turned a single outage into an alert every 2 hours for as
// long as it lasted. A real prospect evaluating the product left a browser tab closed
// overnight and collected six "your display is offline" mails for one outage.
//
// The rule pinned here: one alert per OUTAGE. The marker is devices.offline_alert_heartbeat,
// holding the last_heartbeat an alert was sent for. A reconnect advances last_heartbeat,
// which invalidates the marker by construction — so recovery needs no cleanup, and the
// marker being on the row (not in memory) means a restart no longer re-alerts the fleet.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-offalert-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

// Capture mail instead of sending it. Must be stubbed before alerts.js resolves it.
const emailPath = require.resolve('../services/email');
const sent = [];
require(emailPath);
require.cache[emailPath].exports.sendEmail = async (msg) => { sent.push(msg); return { ok: true }; };

const { db } = require('../db/database');
const { __test } = require('../services/alerts');

const HOUR = 3600;
let userId;

const now = () => Math.floor(Date.now() / 1000);
function mkDevice(name, offlineForSec, { alerts = 1 } = {}) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, last_heartbeat, user_id, created_at)
              VALUES (?, ?, 'offline', ?, ?, strftime('%s','now'))`)
    .run(id, name, now() - offlineForSec, alerts ? userId : null);
  return id;
}
const setState = (id, status, hbAgo) => db.prepare('UPDATE devices SET last_heartbeat = ?, status = ? WHERE id = ?')
  .run(now() - hbAgo, status, id);
const markerOf = (id) => db.prepare('SELECT offline_alert_heartbeat FROM devices WHERE id = ?').get(id).offline_alert_heartbeat;
const mailFor = (name) => sent.filter(m => (m.subject || '').includes(name)).length;

before(() => {
  userId = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, email, password_hash, email_alerts, created_at)
              VALUES (?, ?, 'x', 1, strftime('%s','now'))`)
    .run(userId, 'owner' + crypto.randomBytes(3).toString('hex') + '@x.local');
});
after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('the column exists — the migration is wired up', () => {
  const cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  assert.ok(cols.includes('offline_alert_heartbeat'));
});

test('THE BUG: a continuous outage alerts exactly once, however many times we tick', async () => {
  const id = mkDevice('Lobby', 20 * 60);
  for (let i = 0; i < 12; i++) await __test.checkOfflineDevices();
  assert.equal(mailFor('Lobby'), 1, 'twelve ticks, one mail');
  assert.equal(markerOf(id), db.prepare('SELECT last_heartbeat FROM devices WHERE id = ?').get(id).last_heartbeat,
    'the outage is marked as alerted');
});

test('the dedup window expiring does NOT re-open a still-running outage', async () => {
  const id = mkDevice('Cafe', 20 * 60);
  await __test.checkOfflineDevices();
  assert.equal(mailFor('Cafe'), 1);
  // Simulate >2h passing with the device still down — the old window would re-fire here.
  __test.alertLastSent.clear();
  await __test.checkOfflineDevices();
  assert.equal(mailFor('Cafe'), 1, 'still one — the outage marker outlives the window');
  void id;
});

test('a restart does not re-alert the offline fleet', async () => {
  const id = mkDevice('Warehouse', 20 * 60);
  await __test.checkOfflineDevices();
  assert.equal(mailFor('Warehouse'), 1);
  __test.alertLastSent.clear();   // what a process restart actually does to in-memory state
  await __test.checkOfflineDevices();
  assert.equal(mailFor('Warehouse'), 1, 'the marker is on the row, so it survives');
  void id;
});

test('a NEW outage after recovery does alert again', async () => {
  // The timeline has to be physical, or it proves nothing: a device can only come back
  // by sending a heartbeat, so a later outage ALWAYS carries a later last_heartbeat than
  // the one already marked. That advance is exactly what invalidates the marker.
  const id = mkDevice('Atrium', 1 * HOUR);
  await __test.checkOfflineDevices();
  assert.equal(mailFor('Atrium'), 1);
  const firstOutage = markerOf(id);

  setState(id, 'online', 10 * 60);         // reconnected: heartbeat advances to 10m ago
  await __test.checkOfflineDevices();      // observed online -> flap window cleared
  setState(id, 'offline', 10 * 60);        // then silent since that heartbeat

  await __test.checkOfflineDevices();
  assert.equal(mailFor('Atrium'), 2, 'a distinct outage is a distinct alert');
  assert.notEqual(markerOf(id), firstOutage, 'and it is marked as its own outage');
});

test('a device already dark for more than a day never opens an alert', async () => {
  mkDevice('Abandoned', 30 * HOUR);
  await __test.checkOfflineDevices();
  assert.equal(mailFor('Abandoned'), 0);
});

test('alerts disabled means no mail, and no marker burned', async () => {
  const id = mkDevice('Silent', 20 * 60);
  db.prepare('UPDATE users SET email_alerts = 0 WHERE id = ?').run(userId);
  await __test.checkOfflineDevices();
  db.prepare('UPDATE users SET email_alerts = 1 WHERE id = ?').run(userId);
  assert.equal(mailFor('Silent'), 0, 'respects the preference');
  assert.equal(markerOf(id), null,
    're-enabling alerts must not find the outage pre-marked and silently skipped');
});

test('one alert per outage still logs one activity row, not one per tick', async () => {
  const id = mkDevice('Ledger', 20 * 60);
  // Clear the flap window between ticks, or the in-memory guard alone would carry this
  // test and it would pass with the per-outage marker removed.
  for (let i = 0; i < 5; i++) { __test.alertLastSent.clear(); await __test.checkOfflineDevices(); }
  const n = db.prepare("SELECT COUNT(*) c FROM activity_log WHERE device_id = ? AND action = 'alert:device_offline'")
    .get(id).c;
  assert.equal(n, 1, 'the activity feed reflects the outage once');
});

/*
 * Embedded e-paper panels poll over HTTP and deep-sleep for as long as X-ST-Expires-In says —
 * overnight under a power schedule that is many hours. heartbeat_expected_by is when it was due
 * back; lateness (the 5-minute threshold and the 24h first-alert cutoff) counts from there.
 */
test('an embedded panel asleep on our instruction is not alerted until it is late from its due time', async () => {
  const id = mkDevice('EpaperNight', 9 * HOUR);
  const due = (agoSec) => db.prepare('UPDATE devices SET heartbeat_expected_by = ? WHERE id = ?').run(now() - agoSec, id);

  due(60);                                   // due back a minute ago: not late yet
  await __test.checkOfflineDevices();
  assert.equal(mailFor('EpaperNight'), 0);

  due(10 * 60);                              // ten minutes overdue: a real outage
  __test.alertLastSent.clear();
  await __test.checkOfflineDevices();
  assert.equal(mailFor('EpaperNight'), 1);
});

test('a weekend-long scheduled sleep that then fails still alerts (the 24h cutoff counts from due time)', async () => {
  const id = mkDevice('EpaperWeekend', 62 * HOUR);
  db.prepare('UPDATE devices SET heartbeat_expected_by = ? WHERE id = ?').run(now() - 20 * 60, id);
  await __test.checkOfflineDevices();
  assert.equal(mailFor('EpaperWeekend'), 1);
});
