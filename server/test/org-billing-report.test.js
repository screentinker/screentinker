'use strict';

/*
 * THE REPORT'S "TODAY" IS THE SERVER'S TODAY, AND ITS "AFTER" IS THE ORGANIZATION RULE.
 *
 * scripts/org-billing-report.js is what decides whether limits can be switched from the person
 * who paired a screen to the organization the screen is in: it lists the screens that would go
 * dark. It restates the access rule instead of calling it (the real one writes as it reads, and
 * the report must be safe on a copy of production), so the first thing to prove is that the
 * restatement is right: for every screen in a database full of awkward cases, the report's
 * "today" equals what ws/deviceSocket.js checkDeviceAccess answers.
 *
 * Then that "after" is the organization rule: counted across the organization, oldest first,
 * against the owner's plan, and that the cases a person has to decide are listed.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-orgreport-' + crypto.randomBytes(4).toString('hex'));
const { db } = require('../db/database');
const { Server } = require('socket.io');
const setupDeviceSocket = require('../ws/deviceSocket');
const report = require('../lib/org-billing-report');

let ioServer, io, S;

before(() => {
  S = require('./helpers/org-billing-fixture').build(db);
  ioServer = http.createServer(); io = new Server(ioServer); setupDeviceSocket(io);
});
after(() => { try { io.close(); } catch { /* */ } try { ioServer.close(); } catch { /* */ } });

test('for every screen, "today" is exactly what the server\'s access check answers', () => {
  const r = report.build(db);
  const all = db.prepare('SELECT id, name FROM devices').all();
  assert.equal(r.screens.length, all.length, 'every screen is in the report');
  const said = new Map(r.screens.map((s) => [s.id, s.today]));
  let blocked = 0;
  for (const d of all) {
    const real = setupDeviceSocket.checkDeviceAccess(d.id);
    const want = real.allowed ? 'plays' : real.reason;
    if (!real.allowed) blocked++;
    assert.equal(said.get(d.id), want, `${d.name}: the report and the server agree, including WHY it is blocked`);
  }
  assert.ok(blocked >= 4, 'and the database really does contain blocked screens of both kinds');
  assert.ok(r.screens.some((s) => s.today === 'trial_expired') && r.screens.some((s) => s.today === 'device_limit'));
});

test('the stacking case: the member\'s screens beyond the organization\'s limit would go dark', () => {
  const r = report.build(db);
  const row = r.would_go_dark.find((o) => o.organization_id === S.bossOrg.o);
  assert.ok(row, 'the organization is listed');
  assert.equal(row.affected, 2);
  assert.deepEqual(row.screens_affected.map((s) => s.id).sort(), [...S.guestScreens].sort(), 'the two newest, the member\'s');
  assert.equal(row.screen_limit, 3); assert.equal(row.screens, 5); assert.equal(row.paying, true);
});

test('the opposite case: a Free member\'s screens in an unlimited organization would come back', () => {
  const r = report.build(db);
  const row = r.would_come_back.find((o) => o.organization_id === S.entOrg.o);
  assert.ok(row);
  assert.deepEqual(row.screens_affected.map((s) => s.id).sort(), S.helperScreens.slice(2).sort());
});

test('nothing changes for an owner alone, a lapsed trial, or a screen with no organization', () => {
  const r = report.build(db);
  const touched = new Set([...r.would_go_dark, ...r.would_come_back].flatMap((o) => o.screens_affected.map((s) => s.id)));
  for (const id of [...S.soloScreens, ...S.lapsedScreens, S.loose, S.unclaimed]) assert.equal(touched.has(id), false);
  assert.equal(r.totals.screens_without_an_organization, 2);
});

test('one person with two organizations is listed, and each is counted on its own afterwards', () => {
  const r = report.build(db);
  const m = r.owners_with_several_organizations.find((x) => x.owner_email === 'twin@example.com');
  assert.ok(m); assert.equal(m.paying, true);
  assert.deepEqual(m.organizations.map((o) => [o.name, o.screens, o.holds_subscription]), [['Twin A', 3, true], ['Twin B', 3, false]]);
  // Today the sixth screen is over the person's limit of 5; per organization each has 3 of 5.
  const back = r.would_come_back.find((o) => o.organization_id === S.twinB.o);
  assert.ok(back && back.affected === 1, 'which is the allowance doubling that has to be decided');
  assert.equal(r.totals.paying_owners_with_several_organizations, 1);
});

test('members whose own plan covers screens in someone else\'s organization are listed', () => {
  const r = report.build(db);
  const g = r.screens_paired_by_members.find((x) => x.member_email === 'guest@example.com');
  assert.ok(g); assert.equal(g.screens_paired_by_member, 2); assert.equal(g.member_trial_running, true);
  assert.equal(g.organization_id, S.bossOrg.o);
});

test('an organization over its storage limit only when counted together is listed', () => {
  const r = report.build(db);
  const o = r.organizations_newly_over_storage.find((x) => x.organization_id === S.bossOrg.o);
  assert.ok(o); assert.equal(o.owner_uses_mb, 40); assert.equal(o.organization_uses_mb, 110); assert.equal(o.storage_limit_mb, 100);
});

test('building the report writes nothing, and the text form names what matters', () => {
  const before_ = db.prepare('SELECT plan_id, trial_started, trial_expired_at FROM users WHERE id = ?').get(S.lapsed);
  const total = db.pragma('total_changes', { simple: true });
  const txt = report.text(report.build(db));
  assert.equal(db.pragma('total_changes', { simple: true }), total, 'no row was written');
  assert.deepEqual(db.prepare('SELECT plan_id, trial_started, trial_expired_at FROM users WHERE id = ?').get(S.lapsed), before_, 'the pending downgrade is still pending');
  assert.match(txt, /WOULD GO DARK: \d+/);
  assert.match(txt, /Stacked\s+owner boss@example\.com\s+plan starter \(limit 3, has 5\)\s+PAYING/);
  assert.match(txt, /guest@example\.com \(pro, trial running\) paired 2/);
});
