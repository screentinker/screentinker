'use strict';

// Renewal reminders (services/renewalReminder.js): the 90/60/30/7-day bands, who is emailed and CC'd,
// send-once idempotency, re-arming when the date moves, and the gating.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-renewal-'));
process.env.DATA_DIR = TMP;
delete process.env.SELF_HOSTED;
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const renew = require('../services/renewalReminder');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function user(over = {}) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, email, name, role, plan_id, plan_comped, email_verified, renewal_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(id, over.email || `${id.slice(0, 8)}@acct.test`, over.name || 'Acct', over.role || 'user',
         over.plan_id || 'pro', over.plan_comped == null ? 1 : over.plan_comped, over.renewal_at ?? null);
  if (over.email_alerts != null) db.prepare('UPDATE users SET email_alerts = ? WHERE id = ?').run(over.email_alerts, id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function mailer() {
  const sent = [];
  return { sent, email: { isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } } };
}
function cleanup() {
  db.prepare("DELETE FROM users WHERE email LIKE '%@acct.test' OR email LIKE '%@admin.test'").run();
  db.prepare('DELETE FROM renewal_reminders').run();
}

test('the due milestone is the smallest band at or above the days left', () => {
  assert.equal(renew.dueMilestone(5), 7);
  assert.equal(renew.dueMilestone(7), 7);
  assert.equal(renew.dueMilestone(8), 30);
  assert.equal(renew.dueMilestone(30), 30);
  assert.equal(renew.dueMilestone(45), 60);
  assert.equal(renew.dueMilestone(88), 90);
  assert.equal(renew.dueMilestone(90), 90);
  assert.equal(renew.dueMilestone(120), null, 'too early');
  assert.equal(renew.dueMilestone(0), null, 'already due/past');
});

test('each milestone fires once; the account is the To and the admins are CC', async () => {
  cleanup();
  const admin = user({ role: 'platform_admin', email: 'dan@admin.test' });
  const u = user({ email: 'cust@acct.test', renewal_at: NOW + 88 * DAY });
  const { sent, email } = mailer();

  let r = await renew.run({ db, email, now: NOW, hosted: true });
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'cust@acct.test');
  assert.ok(sent[0].cc.includes('dan@admin.test'), 'admin CC');
  assert.match(sent[0].subject, /renewal in 88 days/);

  // Same day, run again: nothing re-sends.
  r = await renew.run({ db, email, now: NOW + 3600, hosted: true });
  assert.equal(r.sent, 0, 'already sent this milestone');
  assert.equal(sent.length, 1);

  // Time passes into the 60-day band: the 60 reminder fires, once.
  const at60 = u.renewal_at - 55 * DAY;
  r = await renew.run({ db, email, now: at60, hosted: true });
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /renewal in 55 days/);
  // and not again
  assert.equal((await renew.run({ db, email, now: at60 + 3600, hosted: true })).sent, 0);
});

test('setting the date only 7 days out fires the 7-day band alone', async () => {
  cleanup();
  user({ role: 'platform_admin', email: 'dan@admin.test' });
  user({ email: 'short@acct.test', renewal_at: NOW + 6 * DAY });
  const { sent, email } = mailer();
  const r = await renew.run({ db, email, now: NOW, hosted: true });
  assert.equal(r.sent, 1);
  assert.deepEqual(Object.keys(r.milestones), ['7']);
});

test('moving the renewal date re-arms the milestones for the new date', async () => {
  cleanup();
  user({ role: 'platform_admin', email: 'dan@admin.test' });
  const u = user({ email: 'moved@acct.test', renewal_at: NOW + 88 * DAY });
  const { sent, email } = mailer();
  assert.equal((await renew.run({ db, email, now: NOW, hosted: true })).sent, 1); // 90-band sent

  // Push the renewal a year further; the stored 90 row is stale -> re-arms, fires again at the new 90.
  db.prepare('UPDATE users SET renewal_at = ? WHERE id = ?').run(NOW + (365 + 88) * DAY, u.id);
  const r = await renew.run({ db, email, now: NOW + 365 * DAY, hosted: true });
  assert.equal(r.sent, 1);
  assert.equal(r.cleared, 1, 'the stale milestone row was cleared');
  assert.equal(sent.length, 2);
});

test('an opted-out account still reaches the admins (To falls back to the admin)', async () => {
  cleanup();
  user({ role: 'platform_admin', email: 'dan@admin.test' });
  user({ email: 'quiet@acct.test', renewal_at: NOW + 20 * DAY, email_alerts: 0 });
  const { sent, email } = mailer();
  const r = await renew.run({ db, email, now: NOW, hosted: true });
  assert.equal(r.sent, 1);
  assert.equal(sent[0].to, 'dan@admin.test', 'opted-out customer: admin becomes the recipient');
  assert.ok(!sent[0].cc.includes('dan@admin.test'), 'never CC the same address it is To');
});

test('comped vs self-serve wording, and future-dated accounts beyond 90 days are left alone', async () => {
  cleanup();
  user({ role: 'platform_admin', email: 'dan@admin.test' });
  user({ email: 'comped@acct.test', plan_comped: 1, renewal_at: NOW + 25 * DAY });
  user({ email: 'early@acct.test', renewal_at: NOW + 200 * DAY });
  const { sent, email } = mailer();
  const r = await renew.run({ db, email, now: NOW, hosted: true });
  assert.equal(r.sent, 1, 'only the in-band account');
  assert.match(sent[0].text, /PO \/ invoice/);
});

test('gating: self-hosted does nothing; mail-off records the milestone but sends no mail', async () => {
  cleanup();
  user({ role: 'platform_admin', email: 'dan@admin.test' });
  const u = user({ email: 'g@acct.test', renewal_at: NOW + 20 * DAY });
  assert.deepEqual(await renew.run({ db, email: mailer().email, now: NOW, cfg: { selfHosted: true } }), { skipped: 'self_hosted', sent: 0 });

  // Hosted flag off (not a mailing instance): records so it does not re-fire daily, sends nothing.
  const { sent, email } = mailer();
  const r = await renew.run({ db, email, now: NOW, hosted: false });
  assert.equal(r.mailed, false);
  assert.equal(sent.length, 0);
  assert.ok(db.prepare('SELECT 1 FROM renewal_reminders WHERE user_id = ?').get(u.id), 'milestone recorded');
  assert.equal((await renew.run({ db, email, now: NOW + 3600, hosted: false })).sent, 0, 'not re-fired');
});

test('the run is scheduled for 13:00 UTC', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 12, 0, 0));
  assert.equal(renew.msUntilNextRun(at), 3600 * 1000);
});
