'use strict';

/*
 * AN AUDIT ROW BELONGS TO SOMEONE THE SERVER KNOWS.
 *
 * The activity logger writes a row for a finished mutation that "belongs to an authenticated user
 * or a known device". "Known device" was decided from the request itself: a device_id in the body,
 * or a :deviceId in the path. Both are whatever the caller typed, so an anonymous request that was
 * refused (401, 404) still became a row, with the request's own `name` copied into it at any
 * length. That is the unlimited anonymous write to this table the rule exists to prevent.
 *
 * The invariant:
 *   - a signed-in user's mutations are audited (unchanged), as is any 5xx (unchanged);
 *   - without a user, a row is written only for a device that exists;
 *   - what a request can put in the row is bounded.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-auditown-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { activityLogger } = require('../services/activity');

let userId, deviceId;
const rows = () => db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
const last = () => db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1').get();

/** Run one request through the middleware and finish it with `status`. */
function finish(req, status) {
  const res = new EventEmitter(); res.statusCode = status;
  const full = { method: 'POST', baseUrl: '/api/x', path: '/y', route: { path: '/y' }, params: {}, body: {}, headers: {},
    socket: { remoteAddress: '203.0.113.9' }, connection: { remoteAddress: '203.0.113.9' }, ip: '203.0.113.9', ...req };
  activityLogger(full, res, () => {});
  res.emit('finish');
}

before(() => {
  userId = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(userId, `a-${userId}@example.com`, 'A', 'x');
  deviceId = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, name, status) VALUES (?, 'Lobby', 'online')").run(deviceId);
});

test('a signed-in user is audited, success or refusal', () => {
  const n = rows();
  finish({ user: { id: userId }, body: { name: 'New playlist' } }, 200);
  finish({ user: { id: userId }, body: {} }, 403);
  assert.equal(rows(), n + 2);
});

test('a real device is audited without a user', () => {
  const n = rows();
  finish({ body: { device_id: deviceId } }, 200);
  finish({ params: { deviceId } }, 401);
  assert.equal(rows(), n + 2);
  assert.equal(last().device_id, deviceId);
});

test('an anonymous request naming a device that does not exist writes nothing', () => {
  const n = rows();
  for (let i = 0; i < 25; i++) {
    finish({ body: { device_id: 'made-up-' + i, name: 'x' } }, 401);
    finish({ params: { deviceId: crypto.randomUUID() } }, 404);
    finish({ body: { device_id: { $ne: null } } }, 400);
    finish({ body: { device_id: ['a', 'b'] } }, 400);
  }
  assert.equal(rows(), n, 'a caller the server does not know must not be able to grow this table');
});

test('a server error is kept whoever caused it', () => {
  const n = rows();
  finish({ body: {} }, 500);
  assert.equal(rows(), n + 1);
});

test('what a request can put in the row is bounded', () => {
  finish({ user: { id: userId }, body: { name: 'N'.repeat(500000), filename: 'F'.repeat(500000) } }, 200);
  assert.ok(last().details.length <= 600, `details is ${last().details.length} characters`);
  // ...and an ordinary name is recorded whole.
  finish({ user: { id: userId }, body: { name: 'Autumn menu' } }, 200);
  assert.equal(last().details, 'name: Autumn menu');
});
