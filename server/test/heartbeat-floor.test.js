'use strict';
// #777: a flooding player must not drive the DB and every dashboard; a normal one must never notice.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const floor = require('../lib/heartbeat-floor');

beforeEach(() => { floor.reset(); config.heartbeatMinIntervalMs = 5000; });

test('a normal 15s player is admitted on every beat', () => {
  for (let i = 0; i < 20; i++) assert.equal(floor.admit('d1', 1e6 + i * 15000).pass, true);
});

test('a ~20/s flood is admitted once per floor, and logged ONCE per window with its rate', () => {
  let passed = 0, logs = 0, last;
  for (let i = 0; i < 20 * 60; i++) {        // one minute at 20 beats a second
    const v = floor.admit('flood', 1e6 + i * 50);
    if (v.pass) passed++; else { if (v.logStart) logs++; last = v; }
  }
  assert.equal(passed, 12, 'one side-effect pass per 5s over 60s');
  assert.equal(logs, 1, 'the operator hears about it once, not 1,188 times');
  assert.ok(last.beats > 1000 && last.floorMs === 5000);
});

test('devices are independent: one flooding screen does not hold back another', () => {
  for (let i = 0; i < 100; i++) floor.admit('flood', 1e6 + i * 50);
  assert.equal(floor.admit('quiet', 1e6 + 100).pass, true);
});

test('going offline clears the floor, so the first beat back flips the card at once', () => {
  assert.equal(floor.admit('d1', 1e6).pass, true);
  assert.equal(floor.admit('d1', 1e6 + 1000).pass, false);
  floor.clear('d1');
  assert.equal(floor.admit('d1', 1e6 + 1500).pass, true);
});

test('HEARTBEAT_MIN_INTERVAL_MS=0 disables the floor', () => {
  config.heartbeatMinIntervalMs = 0;
  for (let i = 0; i < 50; i++) assert.equal(floor.admit('d1', 1e6 + i).pass, true);
});

test('idle buckets are swept', () => {
  floor.admit('gone', 1e6);
  assert.equal(floor.sweep(1e6 + floor.LOG_WINDOW_MS * 5), 1);
});

test('wiring: liveness is recorded on EVERY beat, before the floor; offline clears it', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const hb = ds.slice(ds.indexOf("'heartbeat'(deviceId, data, ctx) {"));
  const live = hb.indexOf('heartbeat.updateHeartbeat(device_id);');
  const gate = hb.indexOf('heartbeatFloor.admit(device_id)');
  const write = hb.indexOf('INSERT INTO device_telemetry');
  assert.ok(live > 0 && gate > live && write > gate, 'updateHeartbeat, then the floor, then the writes');
  assert.match(ds, /'offline'\(deviceId, data, ctx\) \{\s+pendingOfflines\.delete\(deviceId\);\s+heartbeatFloor\.clear\(deviceId\);/);
});
