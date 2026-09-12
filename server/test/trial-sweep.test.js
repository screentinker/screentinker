'use strict';

// Nightly trial-expiry sweep (services/trialExpiry.js) + the access-gated playlist builder.
//
// Covers the four things the 2026-09 audit found missing:
//   1. a lapsed trial is flipped to Free without waiting for the user to open Billing;
//   2. the T-3 and expiry emails go out once each, to the right people, and never to opt-outs,
//      unverified-never-logged-in signups, or trials that lapsed before the email window;
//   3. buildPlaylistPayload (the ONLY exported delivery builder) returns the suspended card for a
//      blocked screen, so a dashboard push can no longer re-enable it;
//   4. that card says "Trial Expired", not "Device Limit Reached".
// Plus the self-hosted gate: SELF_HOSTED=true means the sweep does nothing at all.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-trialsweep-' + crypto.randomBytes(4).toString('hex'));
delete process.env.SELF_HOSTED;
process.env.HOSTED_INSTANCE = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const config = require('../config');
const emailSvc = require('../services/email');
const setupDeviceSocket = require('../ws/deviceSocket');
const { runTrialExpirySweep, EXPIRED_EMAIL_MAX_AGE_DAYS } = require('../services/trialExpiry');
const { TRIAL_DAYS } = require('../middleware/subscription');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const uid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');

let httpServer, io, sent = [];
before(() => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  // Mirror hosted prod: Free = 1 screen (the schema seed says 2).
  db.prepare("UPDATE plans SET max_devices = 1 WHERE id = 'free'").run();
  emailSvc.sendEmail = async (m) => { sent.push(m); return { sent: true }; };
});
after(() => { io.close(); httpServer.close(); });
beforeEach(() => { sent = []; });

function mkUser({ plan_id = 'pro', trial_plan = 'pro', trial_started = null, stripe_sub = null,
                  email_alerts = 1, email_verified = 1, last_login = now(), trial_expired_at = null, name = 'Test' } = {}) {
  const id = uid('u');
  db.prepare(`INSERT INTO users (id, email, name, plan_id, trial_plan, trial_started, stripe_subscription_id,
                                 email_alerts, email_verified, last_login, trial_expired_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id + '@t.local', name, plan_id, trial_plan, trial_started, stripe_sub, email_alerts, email_verified, last_login, trial_expired_at);
  return id;
}
function mkDevice(userId, createdAt) {
  const id = uid('d');
  db.prepare('INSERT INTO devices (id, name, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'screen ' + id, userId, createdAt, createdAt);
  return id;
}
const row = (id) => db.prepare('SELECT plan_id, trial_started, trial_expired_at, trial_ending_email_sent_at, trial_expired_email_sent_at FROM users WHERE id = ?').get(id);
const mailsTo = (id) => sent.filter(m => m.to === id + '@t.local');

// ---------- 1. downgrade ----------

test('sweep flips a lapsed trial to Free and stamps trial_expired_at with the real end, not "now"', async () => {
  const started = now() - 20 * DAY;
  const id = mkUser({ trial_started: started });
  const r = await runTrialExpirySweep();
  assert.ok(r.downgraded >= 1);
  const u = row(id);
  assert.equal(u.plan_id, 'free');
  assert.equal(u.trial_started, null, 'trial_started cleared (a later comped plan must not be re-downgraded)');
  assert.equal(u.trial_expired_at, started + TRIAL_DAYS * DAY, 'stamped with when the trial actually ended');
});

test('sweep leaves active trials, paying users, comped plans and already-Free accounts alone', async () => {
  const active  = mkUser({ trial_started: now() - 3 * DAY });
  const paying  = mkUser({ trial_started: now() - 30 * DAY, stripe_sub: 'sub_x' });
  const comped  = mkUser({ trial_started: now() - 30 * DAY, plan_id: 'enterprise', trial_plan: 'pro' });
  const free    = mkUser({ trial_started: null, plan_id: 'free' });
  await runTrialExpirySweep();
  assert.equal(row(active).plan_id, 'pro');
  assert.equal(row(active).trial_started !== null, true);
  assert.equal(row(paying).plan_id, 'pro');
  assert.equal(row(comped).plan_id, 'enterprise');
  assert.equal(row(free).plan_id, 'free');
  assert.equal(row(free).trial_expired_at, null, 'a never-trialed Free account is not marked expired');
});

test('sweep is idempotent: a second run downgrades nothing new', async () => {
  mkUser({ trial_started: now() - 15 * DAY });
  await runTrialExpirySweep();
  const again = await runTrialExpirySweep();
  assert.equal(again.downgraded, 0);
});

test('lazy getUserPlan path stamps trial_expired_at too (shared expireTrial)', () => {
  const { getUserPlan } = require('../middleware/subscription');
  const started = now() - 16 * DAY;
  const id = mkUser({ trial_started: started });
  const plan = getUserPlan(id);
  assert.equal(plan.plan_name, 'free');
  assert.equal(row(id).trial_expired_at, started + TRIAL_DAYS * DAY);
});

// ---------- 2. emails ----------

test('T-3 email: sent once to a trial with <=3 days left, never to one with 10 days left', async () => {
  const soon = mkUser({ trial_started: now() - (TRIAL_DAYS - 2) * DAY, name: 'Ada' });
  const later = mkUser({ trial_started: now() - (TRIAL_DAYS - 10) * DAY });
  await runTrialExpirySweep();
  const m = mailsTo(soon);
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /ends in 2 days/);
  assert.match(m[0].text, /Hi Ada,/);
  assert.match(m[0].text, /screentinker\.com\/#\/billing/);
  assert.equal(mailsTo(later).length, 0);
  assert.ok(row(soon).trial_ending_email_sent_at, 'stamped');
  assert.equal(row(soon).plan_id, 'pro', 'still on the trial — not downgraded early');

  sent = [];
  await runTrialExpirySweep();
  assert.equal(mailsTo(soon).length, 0, 'not sent twice');
});

test('T-3 email tells a multi-screen user which screens will stop', async () => {
  const id = mkUser({ trial_started: now() - (TRIAL_DAYS - 1) * DAY });
  mkDevice(id, now() - 5 * DAY); mkDevice(id, now() - 4 * DAY); mkDevice(id, now() - 3 * DAY);
  await runTrialExpirySweep();
  const m = mailsTo(id);
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /ends in 1 day$/);
  assert.match(m[0].text, /You have 3 screens paired/);
  assert.match(m[0].text, /only the first one keeps/);
});

test('expiry email: sent once after the downgrade, says which screens stopped', async () => {
  const id = mkUser({ trial_started: now() - 15 * DAY, name: 'Grace' });
  mkDevice(id, now() - 10 * DAY); mkDevice(id, now() - 9 * DAY);
  const r = await runTrialExpirySweep();
  assert.ok(r.expiredSent >= 1);
  const m = mailsTo(id);
  assert.equal(m.length, 1);
  assert.equal(m[0].subject, 'Your ScreenTinker Pro trial has ended');
  assert.match(m[0].text, /1 of your 2 screens is now showing a "Trial Expired" card/);
  assert.match(m[0].text, /Nothing was deleted/);
  assert.ok(row(id).trial_expired_email_sent_at);

  sent = [];
  await runTrialExpirySweep();
  assert.equal(mailsTo(id).length, 0, 'not sent twice');
});

test('expiry email is NOT sent for a trial that lapsed before the email window (silent backlog)', async () => {
  // Seeded as already-downgraded long ago: the shape the first prod sweep leaves for the backlog.
  const old = mkUser({ plan_id: 'free', trial_started: null, trial_expired_at: now() - (EXPIRED_EMAIL_MAX_AGE_DAYS + 5) * DAY });
  const recent = mkUser({ plan_id: 'free', trial_started: null, trial_expired_at: now() - 2 * DAY });
  await runTrialExpirySweep();
  assert.equal(mailsTo(old).length, 0);
  assert.equal(mailsTo(recent).length, 1);
});

test('neither email goes to opt-outs or to unverified signups that never logged in', async () => {
  const optOut     = mkUser({ trial_started: now() - (TRIAL_DAYS - 1) * DAY, email_alerts: 0 });
  const optOutDone = mkUser({ trial_started: now() - 15 * DAY, email_alerts: 0 });
  const ghost      = mkUser({ trial_started: now() - 15 * DAY, email_verified: 0, last_login: null });
  const unverifiedButActive = mkUser({ trial_started: now() - 15 * DAY, email_verified: 0, last_login: now() - DAY });
  await runTrialExpirySweep();
  assert.equal(mailsTo(optOut).length, 0);
  assert.equal(mailsTo(optOutDone).length, 0);
  assert.equal(mailsTo(ghost).length, 0);
  assert.equal(mailsTo(unverifiedButActive).length, 1, 'pre-verification-era users who did log in are still reached');
  assert.equal(row(ghost).plan_id, 'free', 'the downgrade itself still happens for a ghost');
});

test('a paying user never gets the expiry email even if trial_expired_at is set', async () => {
  const id = mkUser({ plan_id: 'pro', trial_started: null, stripe_sub: 'sub_y', trial_expired_at: now() - DAY });
  await runTrialExpirySweep();
  assert.equal(mailsTo(id).length, 0);
});

test('a transport that is not configured does not consume the once-only stamp', async () => {
  const id = mkUser({ trial_started: now() - (TRIAL_DAYS - 1) * DAY });
  const real = emailSvc.sendEmail;
  emailSvc.sendEmail = async () => ({ sent: false, reason: 'not_configured' });
  try { await runTrialExpirySweep(); } finally { emailSvc.sendEmail = real; }
  assert.equal(row(id).trial_ending_email_sent_at, null);
  await runTrialExpirySweep();
  assert.equal(mailsTo(id).length, 1, 'sent once the transport exists');
});

// ---------- 3 + 4. the access-gated builder and the Trial Expired card ----------

test('after the downgrade the second screen gets a suspended "Trial Expired" payload; the first plays', async () => {
  const id = mkUser({ trial_started: now() - 15 * DAY });
  const first = mkDevice(id, now() - 10 * DAY);
  const second = mkDevice(id, now() - 9 * DAY);
  await runTrialExpirySweep();

  const { buildPlaylistPayload, checkDeviceAccess } = setupDeviceSocket;
  const a = checkDeviceAccess(second);
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'trial_expired', 'the reason is the trial, not a generic device limit');
  assert.equal(a.message, 'Trial Expired');

  const blocked = buildPlaylistPayload(second);
  assert.equal(blocked.suspended, true);
  assert.equal(blocked.reason, 'trial_expired');
  assert.deepEqual(blocked.assignments, []);

  const playing = buildPlaylistPayload(first);
  assert.equal(playing.suspended, undefined);
  assert.ok(Array.isArray(playing.assignments));
});

test('a Free account that never trialed and is over the limit still gets the device-limit card', () => {
  const id = mkUser({ plan_id: 'free', trial_started: null });
  mkDevice(id, now() - 10 * DAY);
  const extra = mkDevice(id, now() - 9 * DAY);
  const a = setupDeviceSocket.checkDeviceAccess(extra);
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'device_limit');
});

test('dashboard-side push path (command-queue) delivers the gated payload, not the raw one', async () => {
  const id = mkUser({ trial_started: now() - 15 * DAY });
  mkDevice(id, now() - 10 * DAY);
  const extra = mkDevice(id, now() - 9 * DAY);
  await runTrialExpirySweep();

  // Simulate an online socket for `extra` and capture what the room is sent.
  const commandQueue = require('../lib/command-queue');
  const got = [];
  const fakeNs = {
    adapter: { rooms: new Map([[extra, new Set(['sock'])]]) },
    to: () => ({ emit: (ev, payload) => got.push({ ev, payload }) }),
  };
  const r = commandQueue.queueOrEmitPlaylistUpdate(fakeNs, extra, setupDeviceSocket.buildPlaylistPayload);
  assert.equal(r.delivered, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].ev, 'device:playlist-update');
  assert.equal(got[0].payload.suspended, true, 'a dashboard push can no longer re-enable a blocked screen');
});

test('the sweep itself pushes the gated payload to a downgraded user\'s connected screens', async () => {
  const id = mkUser({ trial_started: now() - 15 * DAY });
  mkDevice(id, now() - 10 * DAY);
  const extra = mkDevice(id, now() - 9 * DAY);
  const got = [];
  const fakeIo = { of: () => ({
    adapter: { rooms: new Map([[extra, new Set(['sock'])]]) },
    to: (room) => ({ emit: (ev, payload) => got.push({ room, ev, payload }) }),
  }) };
  const r = await runTrialExpirySweep({ io: fakeIo });
  assert.ok(r.screensPushed >= 2);
  const toExtra = got.find(g => g.room === extra);
  assert.ok(toExtra, 'the online extra screen was pushed');
  assert.equal(toExtra.payload.suspended, true);
  assert.equal(toExtra.payload.message, 'Trial Expired');
});

// ---------- self-hosted gate ----------

test('SELF_HOSTED: the sweep is a no-op and returns null', async () => {
  const id = mkUser({ trial_started: now() - 15 * DAY });
  const prev = config.selfHosted;
  config.selfHosted = true;
  try {
    const r = await runTrialExpirySweep();
    assert.equal(r, null);
  } finally { config.selfHosted = prev; }
  assert.equal(row(id).plan_id, 'pro', 'untouched');
  assert.equal(sent.length, 0);
});
