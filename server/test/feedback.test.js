'use strict';

// The feedback loop (lib/feedback.js, services/feedback-digest.js, routes/feedback.js): which moment
// is asked about and when, what an answer may contain, the signed email link, the admin summary and
// CSV with each account's journey, the follow-up emails and the daily digest.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-feedback-'));
process.env.DATA_DIR = TMP;
delete process.env.SELF_HOSTED;
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const feedback = require('../lib/feedback');
const digest = require('../services/feedback-digest');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function user(over = {}) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, email, name, role, plan_id, email_verified) VALUES (?, ?, ?, 'user', ?, 1)`)
    .run(id, `${id.slice(0, 8)}@example.test`, 'Test Person', over.plan_id || 'free');
  const sets = Object.entries(over).filter(([k]) => k !== 'plan_id');
  for (const [k, v] of sets) db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function event(userId, ev, ago) {
  db.prepare('INSERT INTO conversion_events (user_id, event, created_at) VALUES (?, ?, ?)').run(userId, ev, NOW - ago);
}

test('a trial that lapsed unpaid is asked "what stopped you", with its reasons', () => {
  const u = user({ trial_expired_at: NOW - 2 * DAY });
  const p = feedback.promptFor(db, u, { at: NOW });
  assert.equal(p.trigger, 'trial_ended');
  assert.ok(p.reasons.includes('price') && p.reasons.includes('missing_feature'));
});

test('priority: a cancellation beats everything; each moment is asked once; a cooldown spaces them', () => {
  const u = user({ trial_expired_at: NOW - 2 * DAY });
  event(u.id, 'subscription_cancelled', DAY);
  event(u.id, 'first_pair', 3 * DAY);
  assert.equal(feedback.promptFor(db, u, { at: NOW }).trigger, 'cancelled');
  feedback.markShown(db, u.id, 'cancelled');
  assert.equal(feedback.promptFor(db, u, { at: NOW }), null, 'nothing else inside the cooldown');
  const later = NOW + (feedback.PROMPT_COOLDOWN_DAYS + 1) * DAY;
  assert.equal(feedback.promptFor(db, u, { at: later }).trigger, 'trial_ended', 'the next moment after the cooldown');
});

test('first screen paired: asked after 10 minutes, not straight away', () => {
  const u = user({ plan_id: 'pro', trial_started: NOW - DAY });
  event(u.id, 'first_pair', 60);
  assert.equal(feedback.promptFor(db, u, { at: NOW }), null);
  assert.equal(feedback.promptFor(db, u, { at: NOW + 700 }).trigger, 'first_pair');
});

test('trial day 7, and a paying customer a few days in', () => {
  const t = user({ plan_id: 'pro', trial_started: NOW - 8 * DAY });
  assert.equal(feedback.promptFor(db, t, { at: NOW }).trigger, 'trial_day7');
  const p = user({ plan_id: 'pro', stripe_subscription_id: 'sub_x' });
  event(p.id, 'checkout_complete', 4 * DAY);
  assert.equal(feedback.promptFor(db, p, { at: NOW }).trigger, 'paid');
});

test('never asks a platform admin, a support session, or anyone on a self-hosted server', () => {
  const a = user({ trial_expired_at: NOW - DAY, role: 'platform_admin' });
  assert.equal(feedback.promptFor(db, a, { at: NOW }), null);
  assert.equal(feedback.promptFor(db, { id: 'support:abc', role: 'user' }, { at: NOW }), null);
  const u = user({ trial_expired_at: NOW - DAY });
  assert.equal(feedback.promptFor(db, u, { at: NOW, cfg: { selfHosted: true } }), null);
  assert.equal(feedback.save(db, { userId: u.id, trigger: 'general', rating: 3, cfg: { selfHosted: true } }), null);
});

test('an answer: rating 1-5, only the moment\'s own reasons, a capped comment, and it closes the moment', () => {
  const u = user({ trial_expired_at: NOW - DAY });
  assert.match(feedback.clean({ trigger: 'trial_ended', rating: 7 }).error, /1 to 5/);
  assert.match(feedback.clean({ trigger: 'nope', rating: 3 }).error, /Unknown/);
  assert.match(feedback.clean({ trigger: 'general' }).error, /rating, a reason or a comment/);
  const id = feedback.save(db, { userId: u.id, trigger: 'trial_ended', rating: 2, reasons: ['price', 'drop table', 'price'],
    comment: 'x'.repeat(5000) });
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  assert.equal(row.rating, 2);
  assert.deepEqual(JSON.parse(row.reasons), ['price']);
  assert.equal(row.comment.length, feedback.COMMENT_MAX);
  assert.equal(row.plan_id, 'free');
  assert.ok(db.prepare("SELECT answered_at FROM feedback_prompts WHERE user_id = ? AND trigger = 'trial_ended'").get(u.id).answered_at);
  assert.notEqual(feedback.promptFor(db, u, { at: NOW + 30 * DAY })?.trigger, 'trial_ended');
});

test('the email token: one user, one moment, signed and expiring', () => {
  const tok = feedback.makeToken('user-1', 'trial_ended', { at: NOW, secret: 's3cret' });
  assert.deepEqual(feedback.readToken(tok, { at: NOW, secret: 's3cret' }), { userId: 'user-1', trigger: 'trial_ended' });
  assert.equal(feedback.readToken(tok, { at: NOW, secret: 'other' }), null, 'wrong key');
  assert.equal(feedback.readToken(tok, { at: NOW + (feedback.TOKEN_TTL_DAYS + 1) * DAY, secret: 's3cret' }), null, 'expired');
  const [body, mac] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'someone-else', k: 'trial_ended', e: NOW + DAY })).toString('base64url');
  assert.equal(feedback.readToken(`${forged}.${mac}`, { at: NOW, secret: 's3cret' }), null, 'body swapped');
  assert.equal(feedback.readToken(`${body}.`, { at: NOW, secret: 's3cret' }), null);
});

test('the admin summary and CSV carry each account\'s journey; CSV cells cannot run as formulas', () => {
  const u = user({ trial_expired_at: NOW - DAY });
  event(u.id, 'first_pair', 5 * DAY);
  event(u.id, 'limit_hit', 4 * DAY);
  feedback.save(db, { userId: u.id, trigger: 'trial_ended', rating: 1, reasons: ['hardware'], comment: '=HYPERLINK("x")' });
  const s = feedback.summary(db, { days: 30 });
  const e = s.entries.find((x) => x.user_id === u.id);
  assert.equal(e.journey.first_pair, 1);
  assert.equal(e.journey.limit_hit, 1);
  assert.ok(s.reasons.find((r) => r.trigger === 'trial_ended' && r.reason === 'hardware'));
  const csv = feedback.csv(db, { days: 30 });
  const line = csv.split('\n').find((l) => l.includes(u.email));
  assert.ok(line.includes(`"'=HYPERLINK(""x"")"`), line);
  assert.match(csv.split('\n')[0], /^created_at,email,trigger,rating/);
});

test('follow-up emails: a lapsed trial and a cancellation, once, a day or more later, never to an opted-out address', async () => {
  const lapsed = user({ trial_expired_at: NOW - 2 * DAY });
  const tooSoon = user({ trial_expired_at: NOW - 3600 });
  const optedOut = user({ trial_expired_at: NOW - 2 * DAY, email_alerts: 0 });
  const answered = user({ trial_expired_at: NOW - 2 * DAY });
  feedback.save(db, { userId: answered.id, trigger: 'trial_ended', rating: 4 });
  const left = user({ plan_id: 'free' });
  event(left.id, 'subscription_cancelled', 2 * DAY);
  const sent = [];
  const email = { isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } };
  const r = await digest.run({ db, email, now: NOW, appUrl: 'https://st.example.test', hosted: true, cfg: {}, discordUrl: '' });
  const to = sent.map((m) => m.to);
  assert.ok(to.includes(lapsed.email) && to.includes(left.email));
  assert.ok(!to.includes(tooSoon.email) && !to.includes(optedOut.email) && !to.includes(answered.email));
  assert.ok(r.followups >= 2);
  const mail = sent.find((m) => m.to === lapsed.email);
  assert.match(mail.html, /api\/feedback\/respond\?t=[^&]+&amp;r=5/);
  sent.length = 0;
  await digest.run({ db, email, now: NOW, appUrl: 'https://st.example.test', hosted: true, cfg: {}, discordUrl: '' });
  assert.ok(!sent.some((m) => m.to === lapsed.email), 'once per user per moment');
});

test('no follow-ups without HOSTED_INSTANCE; the digest goes to platform admins with the day\'s answers', async () => {
  const admin = user({ role: 'platform_admin' });
  const u = user({ trial_expired_at: NOW - 2 * DAY });
  feedback.save(db, { userId: u.id, trigger: 'general', rating: 5, comment: 'Love the Roku app' });
  const sent = [];
  const email = { isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } };
  let posted = null;
  const fetchImpl = async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true }; };
  const r = await digest.run({ db, email, now: NOW + 10, appUrl: 'https://st.example.test', hosted: false, cfg: {},
    discordUrl: 'https://discord.com/api/webhooks/1/abc', fetchImpl });
  assert.equal(r.followups, 0);
  const d = sent.find((m) => m.to === admin.email);
  assert.ok(d, 'the admin got the digest');
  assert.match(d.text, /Love the Roku app/);
  assert.match(d.text, /signup/);
  assert.ok(r.discord && posted.url.startsWith('https://discord.com/api/webhooks/'));
  assert.deepEqual(posted.body.allowed_mentions, { parse: [] });
});

test('the daily run does nothing on a self-hosted server, and a non-Discord webhook URL is ignored', async () => {
  const r = await digest.run({ db, email: { isConfigured: () => true, sendEmail: async () => ({}) }, now: NOW, cfg: { selfHosted: true } });
  assert.equal(r.skipped, 'self_hosted');
  let called = false;
  await digest.run({ db, email: { isConfigured: () => false, sendEmail: async () => ({}) }, now: NOW + 20, appUrl: '', cfg: {},
    discordUrl: 'https://evil.example/api/webhooks/1', fetchImpl: async () => { called = true; return { ok: true }; } });
  assert.equal(called, false);
});

test('the digest is scheduled for 15:00 UTC', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 14, 0, 0));
  assert.equal(digest.msUntilNextRun(at), 3600 * 1000);
  const after = new Date(Date.UTC(2026, 10, 2, 16, 0, 0));
  assert.equal(digest.msUntilNextRun(after), 23 * 3600 * 1000);
});
