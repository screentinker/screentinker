'use strict';

// A device that belongs to no workspace used to lose EVERY live dashboard event, silently.
//
// deviceRoom() returned null for it and emitToWorkspace() drops a null room, so all 27
// emitToDeviceWorkspace call sites — device-status, screenshot-ready, playback-state,
// playback-progress, content-ack, shell-result, talk-state, device-log — went nowhere and
// nothing was logged to say so.
//
// A device is workspace-less for one ordinary reason: it has registered itself and nobody has
// claimed it yet. POST /api/provision/pair is what assigns the workspace, and it refuses when the
// caller has no workspace context, precisely so a paired device is never left NULL. Meanwhile a
// platform operator CAN open an unclaimed device's detail page — observed on a customer instance
// on 2026-09-28, where five of eight devices were unclaimed and ticking "Debug logging" on them
// produced an empty panel for ever. The command arrived, the player streamed its lines back, and
// the server discarded every one for want of a room.
//
// The empty panel is the symptom that gets reported. The dangerous part is that a dropped room is
// indistinguishable from a quiet device.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-unclaimed-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { deviceRoom, roomsForDashboard, workspaceRoom, emitToWorkspace, UNCLAIMED_ROOM } = require('../lib/socket-rooms');

const WS = 'ws-unclaimed-test';
const CLAIMED = 'dev-claimed';
const UNCLAIMED = 'dev-unclaimed';

const ORG = 'org-unclaimed-test';
const OWNER = 'user-unclaimed-test';

before(() => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'op@test.local', 'x', 'platform_admin')").run(OWNER);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG, 'Test Org', OWNER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Test')").run(WS, ORG);
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?, ?, ?)').run(CLAIMED, 'Claimed', WS);
  // Exactly the shape seen in the field: registered, still holding its pairing code, no owner.
  db.prepare('INSERT INTO devices (id, name, workspace_id, user_id, pairing_code) VALUES (?, ?, NULL, NULL, ?)')
    .run(UNCLAIMED, 'Unnamed Display', '408241');
});

test('a claimed device still resolves to its own workspace room', () => {
  assert.equal(deviceRoom(CLAIMED), workspaceRoom(WS));
});

test('an UNCLAIMED device resolves to a room instead of null', () => {
  const room = deviceRoom(UNCLAIMED);
  assert.notEqual(room, null, 'null here is the bug: emitToWorkspace drops it and the event vanishes');
  assert.equal(room, UNCLAIMED_ROOM);
  assert.notEqual(room, workspaceRoom(WS), 'it must NOT land in a tenant workspace room');
});

test('a device id that does not exist still has no room', () => {
  // Unchanged on purpose: nothing to deliver, and inventing a room would hand a forged id a
  // delivery path into the operators' room.
  assert.equal(deviceRoom('no-such-device'), null);
  assert.equal(deviceRoom(null), null);
  assert.equal(deviceRoom(''), null);
});

test('an event about an unclaimed device is actually delivered', () => {
  // The whole failure was a silent drop, so assert on delivery, not on the room name.
  const seen = [];
  const ns = { to(room) { return { emit(event, payload) { seen.push({ room, event, payload }); } }; } };
  emitToWorkspace(ns, deviceRoom(UNCLAIMED), 'dashboard:device-log', { message: 'hello' });
  assert.equal(seen.length, 1, 'the log line must reach a room');
  assert.equal(seen[0].room, UNCLAIMED_ROOM);
  assert.equal(seen[0].payload.message, 'hello');
});

test('only platform roles join the unclaimed room', () => {
  // Tenants keep exactly the rooms they had: an unclaimed screen stays invisible to them.
  const tenant = roomsForDashboard([WS], false);
  assert.deepEqual(tenant, [workspaceRoom(WS)]);
  assert.ok(!tenant.includes(UNCLAIMED_ROOM));

  const operator = roomsForDashboard([WS], true);
  assert.ok(operator.includes(workspaceRoom(WS)), 'an operator keeps their workspace rooms');
  assert.ok(operator.includes(UNCLAIMED_ROOM), 'and gains the unclaimed room');

  // A platform operator with no workspace memberships at all is the support-session shape.
  assert.deepEqual(roomsForDashboard([], true), [UNCLAIMED_ROOM]);
  assert.deepEqual(roomsForDashboard([], false), []);
  assert.deepEqual(roomsForDashboard(undefined, false), []);
});
