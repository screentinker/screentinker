'use strict';

/*
 * An exception escaping the heartbeat interval is an uncaughtException, which this server answers
 * with logFatalAndExit: one SQLITE_BUSY in the offline sweep restarted the process and dropped every
 * screen. The tick is guarded as a whole, and each device separately, so one bad row cannot stop the
 * sweep for the rest.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hb-guard-'));
process.env.DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { db } = require('../db/database');
const heartbeat = require('../services/heartbeat');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'heartbeat.js'), 'utf8');

test('the interval body is wrapped, so a throw is logged, not fatal', () => {
  assert.match(SRC, /setInterval\(\(\) => \{\n\s*try \{ heartbeatTick\(io, deviceNs\); \} catch \(e\) \{/);
});

test('one device that throws does not stop the sweep for the others', () => {
  const stale = Math.floor(Date.now() / 1000) - 3600;
  for (const id of ['hb-a', 'hb-b']) {
    db.prepare("INSERT INTO devices (id, name, status, last_heartbeat) VALUES (?, ?, 'online', ?)").run(id, id, stale);
  }
  const realPrepare = db.prepare.bind(db);
  let thrown = 0;
  db.prepare = (sql) => {
    // The first device's follow-up read fails, as a SQLITE_BUSY would.
    if (/SELECT offline_reason, offline_detail, client_type FROM devices/.test(sql) && thrown++ === 0) {
      return { get() { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; } };
    }
    return realPrepare(sql);
  };
  const ns = { sockets: new Map(), to: () => ({ emit() {} }), adapter: { rooms: new Map() } };
  const io = { of: () => ns };
  try {
    assert.doesNotThrow(() => heartbeat._heartbeatTickForTests(io, ns));
  } finally { db.prepare = realPrepare; }
  assert.equal(thrown >= 1, true, 'the failure was hit');
  for (const id of ['hb-a', 'hb-b']) {
    assert.equal(db.prepare('SELECT status FROM devices WHERE id = ?').get(id).status, 'offline', id);
  }
});

// Provisioning flood: one unauthenticated socket registering fresh pairing codes in a loop provisioned
// a row per code, and only the last id was removed on disconnect, so the rest stayed in the live
// connection map forever (and accrued a usage row each, every tick).
test('one socket holds one connection entry, however many ids it registers', () => {
  const before = heartbeat.getConnectedCount();
  for (let i = 0; i < 50; i++) heartbeat.registerConnection(`flood-${i}`, 'sock-flood');
  assert.equal(heartbeat.getConnectedCount() - before, 1);
  assert.ok(heartbeat.getConnection('flood-49'));
  assert.equal(heartbeat.getConnection('flood-0'), undefined);
  heartbeat.removeConnection('flood-49');
  assert.equal(heartbeat.getConnectedCount(), before);
});

test('a stale entry whose socket is gone is reaped, a live one is kept', () => {
  heartbeat.registerConnection('stale-dev', 'sock-gone');
  heartbeat.registerConnection('live-dev', 'sock-live');
  const ns = { sockets: new Map([['sock-live', {}]]) };
  const later = Date.now() + 10 * 60 * 1000;
  assert.equal(heartbeat.reapStaleConnections(ns, later) >= 1, true);
  assert.equal(heartbeat.getConnection('stale-dev'), undefined);
  assert.ok(heartbeat.getConnection('live-dev'));
  heartbeat.removeConnection('live-dev');
});

test('a mesh replica\'s screens share one pseudo-socket and are all kept', () => {
  for (const id of ['m-1', 'm-2', 'm-3']) heartbeat.registerConnection(id, 'mesh:node-a');
  for (const id of ['m-1', 'm-2', 'm-3']) assert.ok(heartbeat.getConnection(id), id);
  heartbeat.reapStaleConnections({ sockets: new Map() }, Date.now() + 10 * 60 * 1000);
  for (const id of ['m-1', 'm-2', 'm-3']) { assert.ok(heartbeat.getConnection(id), `${id} not reaped`); heartbeat.removeConnection(id); }
});
