'use strict';

/*
 * WHOSE LIMITS APPLY: THE PERSON'S (TODAY) OR THE ORGANIZATION'S (app_settings.limits_scope = org).
 *
 * Two things are proved here.
 *
 * 1. With the setting absent, nothing has changed: the screen access check answers exactly what
 *    the report (lib/org-billing-report.js) calls "today", for every screen in a database of
 *    awkward cases.
 *
 * 2. With the setting on, the limits are the organization's, everywhere they are enforced, and the
 *    server answers exactly what the report calls "after". That is what makes the report a promise
 *    rather than a guess: the list of screens it says would go dark is the list that goes dark.
 *
 * The cases (test/helpers/org-billing-fixture.js): an owner alone; a full organization where an
 * invited member's own trial added screens; a Free member inside an unlimited organization; a
 * lapsed trial; one person with two organizations; screens with no organization.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-limitscope-' + crypto.randomBytes(4).toString('hex'));
const { db } = require('../db/database');
const { Server } = require('socket.io');
const setupDeviceSocket = require('../ws/deviceSocket');
const appSettings = require('../lib/app-settings');
const limits = require('../middleware/subscription');
const report = require('../lib/org-billing-report');

let ioServer, io, S, planned;
const scope = (v) => { if (v) appSettings.set('limits_scope', v); else { db.prepare("DELETE FROM app_settings WHERE key = 'limits_scope'").run(); appSettings.__reload(); } };
const real = (id) => { const a = setupDeviceSocket.checkDeviceAccess(id); return a.allowed ? 'plays' : a.reason; };

/** Run a limit middleware as `userId` acting in `workspaceId`; resolves to { passed } or { status, body }. */
function run(mw, userId, workspaceId) {
  return new Promise((resolve) => {
    const req = { user: { id: userId, role: 'user' }, workspaceId, headers: {}, ip: '127.0.0.1' };
    const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
    mw(req, res, () => resolve({ passed: true }));
  });
}

before(() => {
  S = require('./helpers/org-billing-fixture').build(db);
  ioServer = http.createServer(); io = new Server(ioServer); setupDeviceSocket(io);
  planned = report.build(db);          // built BEFORE anything reads a plan (reading heals a lapsed trial)
});
after(() => { scope(null); try { io.close(); } catch { /* */ } try { ioServer.close(); } catch { /* */ } });

test('setting absent: every screen gets today\'s answer, and the default is the per-person rule', () => {
  scope(null);
  assert.equal(limits.limitsScope(), 'user');
  for (const s of planned.screens) assert.equal(real(s.id), s.today, s.id);
  assert.deepEqual(limits.limitSubject(S.guest, S.bossOrg.w), { scope: 'user', userId: S.guest, orgId: null });
});

test('an unknown value of the setting is the per-person rule, not a third behaviour', () => {
  scope('team'); assert.equal(limits.limitsScope(), 'user');
  scope('ORG'); assert.equal(limits.limitsScope(), 'user');
  scope(null);
});

test('organization mode: every screen gets exactly the answer the report promised', () => {
  scope('org');
  try {
    let changed = 0;
    for (const s of planned.screens) { assert.equal(real(s.id), s.after, s.id); if (s.today !== s.after) changed++; }
    assert.ok(changed >= 5, 'and the fixture really does differ between the two rules');
  } finally { scope(null); }
});

test('organization mode: the stacked member\'s extra screens stop, the owner\'s keep playing', () => {
  scope('org');
  try {
    for (const id of S.bossScreens) assert.equal(real(id), 'plays');
    for (const id of S.guestScreens) assert.equal(real(id), 'device_limit');
    for (const id of S.helperScreens) assert.equal(real(id), 'plays', 'a Free member inside an unlimited organization');
    // No organization: the per-person answer, in both modes (the loose one is its pairer's 4th of 3).
    assert.equal(real(S.loose), 'device_limit'); assert.equal(real(S.unclaimed), 'plays');
  } finally { scope(null); }
});

test('adding a screen: refused for a member of a full organization, allowed for a Free member of an unlimited one', async () => {
  scope(null);
  assert.equal((await run(limits.checkDeviceLimit, S.guest, S.bossOrg.w)).passed, true, 'today: the member\'s own trial lets them add');
  assert.equal((await run(limits.checkDeviceLimit, S.helper, S.entOrg.w)).status, 403, 'today: the Free member is refused in an unlimited organization');
  scope('org');
  try {
    const full = await run(limits.checkDeviceLimit, S.guest, S.bossOrg.w);
    assert.equal(full.status, 403);
    assert.equal(full.body.code, 'DEVICE_LIMIT');
    assert.equal(full.body.limit, 3); assert.equal(full.body.current, 5, 'counted across the organization');
    assert.equal((await run(limits.checkDeviceLimit, S.helper, S.entOrg.w)).passed, true);
    assert.equal((await run(limits.checkDeviceLimit, S.boss, S.bossOrg.w)).status, 403, 'the owner is at the same limit as everyone in it');
    assert.equal((await run(limits.checkDeviceLimit, S.guest, null)).passed, true, 'with no workspace there is no organization: the person\'s own plan');
  } finally { scope(null); }
});

test('storage is counted across the organization, and features follow its plan', async () => {
  const MB = 1024 * 1024;
  scope(null);
  assert.equal(limits.storageRoomBytes(S.boss, S.bossOrg.w), 60 * MB, 'today: the owner alone, 40 of 100');
  assert.equal((await run(limits.checkStorageLimit, S.boss, S.bossOrg.w)).passed, true);
  scope('org');
  try {
    assert.equal(limits.storageRoomBytes(S.boss, S.bossOrg.w), -10 * MB, '110 of 100 together');
    assert.equal(limits.storageRoomBytes(S.guest, S.bossOrg.w), -10 * MB, 'the same answer whoever asks');
    const r = await run(limits.checkStorageLimit, S.guest, S.bossOrg.w);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'STORAGE_LIMIT'); assert.equal(r.body.current_mb, 110);
    assert.equal(limits.storageRoomBytes(S.helper, S.entOrg.w), 100 * MB, 'the organization\'s allowance and usage, not the member\'s');
    assert.equal(limits.storageRoomBytes(S.boss), 60 * MB, 'a caller that names no workspace keeps the per-person figure');
  } finally { scope(null); }
});

test('a workspace with no organization, or a broken lookup, falls back to the person', () => {
  scope('org');
  try {
    assert.equal(limits.limitSubject(S.solo, 'no-such-workspace').scope, 'user');
    assert.equal(limits.limitSubject(S.solo, null).scope, 'user');
    assert.equal(limits.limitSubject(S.solo, undefined).scope, 'user');
    const sub = limits.limitSubject(S.guest, S.bossOrg.w);
    assert.deepEqual(sub, { scope: 'org', userId: S.boss, orgId: S.bossOrg.o });
  } finally { scope(null); }
});

test('switching the setting takes effect at once and switching back restores today exactly', () => {
  scope('org'); assert.equal(real(S.guestScreens[0]), 'device_limit');
  scope(null);  assert.equal(real(S.guestScreens[0]), 'plays');
  for (const s of planned.screens) assert.equal(real(s.id), s.today, s.id);
});
