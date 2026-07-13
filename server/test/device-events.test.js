'use strict';

// Offline-cause / incident-log unit tests. Two layers, no socket server needed:
//   1. The pure classifier (lib/incident-classify) — the actual rules the live
//      device:connectivity-report + disconnect handlers apply. Testing the extracted
//      helper guarantees the handler and these assertions agree on the exact strings.
//   2. A tiny in-memory better-sqlite3 exercising the same INSERT/UPDATE the handlers
//      run, driven by the classifier's output, so the persistence shape is proven too
//      (a device:event row lands; a connectivity-report upgrades the recent offline row).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ALLOWED_EVENT_TYPES,
  isAllowedEventType,
  normalizeDisconnectReason,
  classifyConnectivity,
} = require('../lib/incident-classify');

// ---- 1. classifyConnectivity: reason/detail composition ----

test('connectivity: cold_start wins -> reason reboot', () => {
  const c = classifyConnectivity({ cold_start: true, link_lost: true });
  assert.equal(c.reason, 'reboot');
  assert.equal(c.type, 'reboot');
  assert.equal(c.detail, 'Device restarted (power/reboot)');
});

test('connectivity: link_lost true -> reason network, link-lost detail', () => {
  const c = classifyConnectivity({ link_lost: true });
  assert.equal(c.reason, 'network');
  assert.equal(c.type, 'network');
  assert.match(c.detail, /link lost/);
});

test('connectivity: link_lost false -> reason network, router/upstream detail', () => {
  const c = classifyConnectivity({ link_lost: false });
  assert.equal(c.reason, 'network');
  assert.equal(c.type, 'network');
  assert.match(c.detail, /server unreachable \(router\/internet\/upstream\)/);
});

test('connectivity: ssid / weak-rssi / ip_changed fragments append to detail', () => {
  const c = classifyConnectivity({ link_lost: true, ssid: 'Office', rssi: -82, ip_changed: true });
  assert.match(c.detail, /SSID "Office"/);
  assert.match(c.detail, /weak signal \(-82 dBm\)/);
  assert.match(c.detail, /IP changed \(DHCP\/router\)/);
  // strong signal is NOT flagged
  assert.ok(!/weak signal/.test(classifyConnectivity({ link_lost: true, rssi: -50 }).detail));
});

// ---- 2. normalizeDisconnectReason: socket.io reason -> category token ----

test('disconnect reason normalizes (whitespace->_, lowercase) and defaults to silent', () => {
  assert.equal(normalizeDisconnectReason('transport close'), 'transport_close');
  assert.equal(normalizeDisconnectReason('ping timeout'), 'ping_timeout');
  assert.equal(normalizeDisconnectReason('Transport Error'), 'transport_error');
  assert.equal(normalizeDisconnectReason(''), 'silent');
  assert.equal(normalizeDisconnectReason(undefined), 'silent');
  assert.equal(normalizeDisconnectReason(null), 'silent');
});

// ---- 3. allowed event types ----

test('event types: allowed set gates device:event', () => {
  for (const t of ['offline', 'display_off', 'display_on', 'crash', 'reboot', 'network', 'app_error']) {
    assert.ok(isAllowedEventType(t), `${t} allowed`);
    assert.ok(ALLOWED_EVENT_TYPES.has(t));
  }
  assert.ok(!isAllowedEventType('bogus'));
  assert.ok(!isAllowedEventType(''));
  assert.ok(!isAllowedEventType(undefined));
});

// ---- 4. persistence: the SQL the handlers run, driven by the classifier ----

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE device_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, type TEXT NOT NULL,
      reason TEXT, detail TEXT, timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')));
    CREATE TABLE device_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, status TEXT, reason TEXT, detail TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')));
  `);
  return db;
}

test('device:event inserts a device_events row (allowed type)', () => {
  const db = freshDb();
  // mirrors the handler body after the isAllowedEventType gate
  db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, ?, ?, ?)")
    .run('dev1', 'display_off', null, 'screen slept');
  const rows = db.prepare('SELECT * FROM device_events WHERE device_id = ?').all('dev1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'display_off');
  assert.equal(rows[0].detail, 'screen slept');
});

test('connectivity-report upgrades the recent offline status-log row + logs an event', () => {
  const db = freshDb();
  // A server-guessed offline row exists (the disconnect handler wrote 'transport_close').
  db.prepare("INSERT INTO device_status_log (device_id, status, reason, detail) VALUES ('dev1','offline','transport_close',NULL)").run();

  // Handler path: classify the device's report, then UPDATE the recent offline row + INSERT an event.
  const { reason, detail, type } = classifyConnectivity({ link_lost: true, ssid: 'Shop', rssi: -80 });
  db.prepare(`UPDATE device_status_log SET reason = ?, detail = ?
    WHERE id = (SELECT id FROM device_status_log
      WHERE device_id = ? AND status IN ('offline','offline_timeout')
        AND timestamp > strftime('%s','now') - 900
      ORDER BY timestamp DESC, id DESC LIMIT 1)`).run(reason, detail, 'dev1');
  db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, ?, ?, ?)")
    .run('dev1', type, reason, detail);

  const log = db.prepare("SELECT reason, detail FROM device_status_log WHERE device_id = 'dev1'").get();
  assert.equal(log.reason, 'network', 'server guess upgraded to device ground truth');
  assert.match(log.detail, /link lost/);
  assert.match(log.detail, /SSID "Shop"/);

  const ev = db.prepare("SELECT type, reason FROM device_events WHERE device_id = 'dev1'").get();
  assert.equal(ev.type, 'network');
  assert.equal(ev.reason, 'network');
});

test('connectivity-report with cold_start records a reboot event', () => {
  const db = freshDb();
  const { reason, type, detail } = classifyConnectivity({ cold_start: true });
  db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, ?, ?, ?)")
    .run('dev2', type, reason, detail);
  const ev = db.prepare("SELECT type, reason FROM device_events WHERE device_id = 'dev2'").get();
  assert.equal(ev.type, 'reboot');
  assert.equal(ev.reason, 'reboot');
});
