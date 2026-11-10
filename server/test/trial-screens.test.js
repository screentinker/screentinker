'use strict';

// One free trial per screen (lib/trial-screens.js): the ledger check, its exemptions, the
// backfill, account deletion, and the digest's review signal. Real schema (db/database.js booted
// on a throwaway DATA_DIR, hosted mode), no server.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-trialscreens-' + crypto.randomBytes(4).toString('hex'));
delete process.env.SELF_HOSTED;
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const ts = require('../lib/trial-screens');
const { buildDigest, reuseLine, run } = require('../services/feedback-digest');

after(() => { try { db.close(); } catch { /* */ } try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const rid = (p) => p + '-' + crypto.randomBytes(5).toString('hex');
const salt = () => crypto.randomBytes(8).toString('hex');            // 16 hex, like st_install_id.slice(0,16)
const webFp = (s = salt(), hw = 'apc59o-75') => `web-${hw}-${s}`;

/** A user. state: 'trial' (running), 'lapsed' (expired unpaid), 'paid', 'free'. */
function user(state, { trialStarted = NOW - 2 * DAY } = {}) {
  const id = rid('u');
  const base = { id, email: id + '@t.local' };
  if (state === 'trial') {
    db.prepare("INSERT INTO users (id, email, password_hash, plan_id, trial_plan, trial_started) VALUES (?, ?, 'x', 'pro', 'pro', ?)").run(id, base.email, trialStarted);
  } else if (state === 'lapsed') {
    db.prepare("INSERT INTO users (id, email, password_hash, plan_id, trial_plan, trial_expired_at) VALUES (?, ?, 'x', 'free', 'pro', ?)").run(id, base.email, NOW - 5 * DAY);
  } else if (state === 'paid') {
    db.prepare("INSERT INTO users (id, email, password_hash, plan_id, trial_plan, stripe_subscription_id) VALUES (?, ?, 'x', 'pro', 'pro', 'sub_x')").run(id, base.email);
  } else {
    db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(id, base.email);
  }
  return id;
}
const plan = (id) => require('../middleware/subscription').getUserPlan(id);

/** A device with one fingerprint, owned by `owner` (or unclaimed). */
function screen(owner, fp = webFp()) {
  const id = rid('d');
  db.prepare("INSERT INTO devices (id, name, user_id, status) VALUES (?, 'S', ?, 'offline')").run(id, owner || null);
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, id);
  return { id, fp };
}
/** A screen burned by `prior`'s trial, then moved (unclaimed provisioning row, same fingerprint). */
function burnedScreen(prior, at = NOW - 10 * DAY) {
  const fp = webFp();
  db.prepare('INSERT INTO trial_screen_ledger (screen_key, user_id, first_trial_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(ts.screenKeyOf(fp), prior, at, at);
  return screen(null, fp);
}
const claim = (u, dev) => db.prepare('UPDATE devices SET user_id = ? WHERE id = ?').run(u, dev.id);
const check = (u, dev) => ts.checkTrialScreen(db, { userId: u, deviceId: dev.id, plan: plan(u), now: NOW });

/* ───────────── identity ───────────── */

test('screenKeyOf: the web salt is the key; the hardware half is ignored', () => {
  const s = salt();
  assert.equal(ts.screenKeyOf(`web-apc59o-75-${s}`), ts.screenKeyOf(`web-f84lto-75-${s}`), 'same install, drifted hardware hash = same screen');
  assert.notEqual(ts.screenKeyOf(`web-apc59o-75-${s}`), ts.screenKeyOf(`web-apc59o-75-${salt()}`), 'same TV model, different install = different screen');
});

test('screenKeyOf: a bare (model-level) web fingerprint, empty or short values are never keys', () => {
  assert.equal(ts.screenKeyOf('web-m73u8w-5f'), null, 'two UniFi panels at two sites produced exactly this');
  assert.equal(ts.screenKeyOf(''), null);
  assert.equal(ts.screenKeyOf(null), null);
  assert.equal(ts.screenKeyOf('fp-1'), null);
  assert.ok(ts.screenKeyOf('roku:a5e0789c-1111-2222-3333-444455556666'));
  assert.ok(ts.screenKeyOf(crypto.randomBytes(32).toString('hex')), 'Android / native hash');
});

test('screenKeyOf stores a hash, never the identifier', () => {
  const s = salt();
  const k = ts.screenKeyOf(`web-apc59o-75-${s}`);
  assert.match(k, /^[0-9a-f]{40}$/);
  assert.ok(!k.includes(s));
});

test('netOf: IPv4 exact, IPv6 to its /64 including compressed forms', () => {
  assert.equal(ts.netOf('103.69.218.232'), '103.69.218.232');
  assert.equal(ts.netOf('::ffff:103.69.218.232'), '103.69.218.232');
  assert.equal(ts.netOf('2401:4900:1c5e:9c23:19d8:abc8:6955:ad71'), '2401:4900:1c5e:9c23::/64');
  assert.equal(ts.netOf('2401:4900:1c5e:9c23:35f7:ce8b:dfe0:abe3'), '2401:4900:1c5e:9c23::/64', 'privacy addresses in one /64 match');
  assert.equal(ts.netOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ts.netOf('garbage'), null);
  assert.equal(ts.netOf(''), null);
});

/* ───────────── part A: the check ───────────── */

test('THE HOP: the third screen from the same earlier unpaid trial is refused; the first two pass', () => {
  const prior = user('lapsed');
  const me = user('trial');
  const s = [burnedScreen(prior), burnedScreen(prior), burnedScreen(prior), burnedScreen(prior)];
  assert.equal(check(me, s[0]).allowed, true, '1st re-used screen passes (a person\'s own laptop, a test panel)');
  claim(me, s[0]);
  assert.equal(check(me, s[1]).allowed, true, '2nd passes');
  claim(me, s[1]);
  const v = check(me, s[2]);
  assert.equal(v.allowed, false, '3rd is the pattern');
  assert.equal(v.priorUserId, prior);
  assert.equal(v.reused, 3);
});

test('a screen nobody trialed always passes, however many re-used ones the account holds', () => {
  const prior = user('lapsed');
  const me = user('trial');
  for (let i = 0; i < 2; i++) { const s = burnedScreen(prior); claim(me, s); }
  assert.equal(check(me, screen(null)).allowed, true);
});

test('only a RUNNING trial is ever refused: paid, Free and lapsed accounts pass', () => {
  const prior = user('lapsed');
  for (const state of ['paid', 'free', 'lapsed']) {
    const me = user(state);
    for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
    assert.equal(check(me, burnedScreen(prior)).allowed, true, `${state} account passes`);
  }
});

test('screens burned by an account that PAID are not burned', () => {
  const prior = user('paid');
  const me = user('trial');
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
  assert.equal(check(me, burnedScreen(prior)).allowed, true);
});

test('a subscription that has since been cancelled still counts as paid', () => {
  const prior = user('lapsed');
  db.prepare("INSERT INTO conversion_events (user_id, event) VALUES (?, 'checkout_complete')").run(prior);
  const me = user('trial');
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
  assert.equal(check(me, burnedScreen(prior)).allowed, true);
});

function org(owner, { sub = null } = {}) {
  const id = rid('o');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, stripe_subscription_id) VALUES (?, ?, ?, ?)').run(id, 'Org', owner, sub);
  return id;
}
const orgMember = (o, u, role = 'org_admin') => db.prepare('INSERT INTO organization_members (user_id, organization_id, role) VALUES (?, ?, ?)').run(u, o, role);
function wsIn(o, ...members) {
  const id = rid('w');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id, o, 'WS');
  for (const m of members) db.prepare("INSERT INTO workspace_members (user_id, workspace_id, role) VALUES (?, ?, 'workspace_editor')").run(m, id);
  return id;
}

test('ONE INVITE IS NOT A WAY OUT: sharing an UNPAID organization or workspace does not exempt the hop', () => {
  const prior = user('lapsed'), me = user('trial');
  const o = org(prior); orgMember(o, prior, 'org_owner'); orgMember(o, me);
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
  assert.equal(check(me, burnedScreen(prior)).allowed, false, 'organization members, nobody paid');

  const prior2 = user('lapsed'), me2 = user('trial');
  wsIn(org(prior2), prior2, me2);
  for (let i = 0; i < 2; i++) claim(me2, burnedScreen(prior2));
  assert.equal(check(me2, burnedScreen(prior2)).allowed, false, 'workspace members, nobody paid');
});

test('a PAYING team moving screens between its members is not a second trial', () => {
  const owner = user('paid'), prior = user('lapsed'), me = user('trial');
  const o = org(owner); orgMember(o, owner, 'org_owner'); orgMember(o, prior); orgMember(o, me);
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
  assert.equal(check(me, burnedScreen(prior)).allowed, true, 'the org owner pays');

  // An organization that pays for ITSELF while its owner does not. That state only exists once the
  // organization is the source of truth for billing (lib/org-billing.js): until then its row is a
  // copy of its owner's, kept in step by triggers, which would overwrite this fixture. So this half
  // runs in that mode.
  const orgBilling = require('../lib/org-billing');
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('billing_source', 'org', strftime('%s','now'))").run();
  orgBilling.install(db, null);
  try {
    const prior2 = user('lapsed'), me2 = user('trial');
    // Bought after the organization existed (a first organization starts as its owner's state).
    const paidOrg = org(prior2);
    db.prepare("UPDATE organizations SET stripe_subscription_id = 'sub_org' WHERE id = ?").run(paidOrg);
    wsIn(paidOrg, prior2, me2);
    for (let i = 0; i < 2; i++) claim(me2, burnedScreen(prior2));
    assert.equal(check(me2, burnedScreen(prior2)).allowed, true, 'the organization has its own subscription');
  } finally {
    db.prepare("DELETE FROM app_settings WHERE key = 'billing_source'").run();
    orgBilling.install(db, null);
  }
});

test('a comped or invoiced (hand-assigned) account counts as paid', () => {
  const comped = user('lapsed'); db.prepare('UPDATE users SET plan_comped = 1 WHERE id = ?').run(comped);
  const invoiced = user('lapsed'); db.prepare('UPDATE users SET renewal_at = ? WHERE id = ?').run(NOW + 300 * DAY, invoiced);
  for (const prior of [comped, invoiced]) {
    const me = user('trial');
    for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
    assert.equal(check(me, burnedScreen(prior)).allowed, true);
  }
  const s = screen(comped);
  ts.backfillLedger(db, { now: NOW });
  assert.equal(db.prepare('SELECT 1 FROM trial_screen_ledger WHERE screen_key = ?').get(ts.screenKeyOf(s.fp)), undefined, 'and the backfill leaves its screens alone');
});

test('INVITEES INTO ONE WORKSPACE: re-used screens are counted across the workspace, not per invitee', () => {
  const prior = user('lapsed');
  const a = user('trial'), b = user('trial');
  const ws = wsIn(org(a), a, b);
  const inWs = (u, dev) => db.prepare('UPDATE devices SET user_id = ?, workspace_id = ? WHERE id = ?').run(u, ws, dev.id);
  inWs(a, burnedScreen(prior));
  inWs(b, burnedScreen(prior));
  const third = burnedScreen(prior);
  assert.equal(ts.checkTrialScreen(db, { userId: b, workspaceId: ws, deviceId: third.id, plan: plan(b), now: NOW }).allowed, false,
    'one each for two invitees is still the third screen in the workspace');
  const c = user('trial');
  assert.equal(ts.checkTrialScreen(db, { userId: c, deviceId: third.id, plan: plan(c), now: NOW }).allowed, true,
    'a different workspace is counted on its own');
});

test('a teammate\'s OWN trial screens in the workspace never count against a colleague', () => {
  const a = user('trial'), b = user('trial');
  const ws = wsIn(org(a), a, b);
  for (let i = 0; i < 3; i++) {
    const s = screen(a); db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(ws, s.id);
    ts.recordTrialScreen(db, { userId: a, workspaceId: ws, deviceId: s.id, plan: plan(a), now: NOW });
  }
  const moved = burnedScreen(a);   // one screen a used, now being paired by b
  assert.equal(ts.checkTrialScreen(db, { userId: b, workspaceId: ws, deviceId: moved.id, plan: plan(b), now: NOW }).allowed, true);
});

test('a claimant that has paid (comped mid-trial) is never refused and never recorded', () => {
  const prior = user('lapsed'), me = user('trial');
  db.prepare('UPDATE users SET plan_comped = 1 WHERE id = ?').run(me);
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior));
  assert.equal(check(me, burnedScreen(prior)).allowed, true);
  assert.equal(ts.recordTrialScreen(db, { userId: me, deviceId: screen(me).id, plan: plan(me), now: NOW }), 0);
});

test('RE-ATTRIBUTION: a ledger row that stopped counting (expired, or its account paid) passes to the next trial', () => {
  const old = user('lapsed'), paidLater = user('lapsed'), next = user('trial'), after = user('trial');
  const sOld = burnedScreen(old, NOW - ts.LEDGER_TTL - DAY);
  const sPaid = burnedScreen(paidLater);
  db.prepare("INSERT INTO conversion_events (user_id, event) VALUES (?, 'checkout_complete')").run(paidLater);
  const owner = (fp) => db.prepare('SELECT user_id FROM trial_screen_ledger WHERE screen_key = ?').get(ts.screenKeyOf(fp)).user_id;
  for (const s of [sOld, sPaid]) ts.recordTrialScreen(db, { userId: next, deviceId: s.id, plan: plan(next), now: NOW });
  assert.equal(owner(sOld.fp), next, 'expired row handed on');
  assert.equal(owner(sPaid.fp), next, 'paid owner\'s row handed on');
  const live = burnedScreen(user('lapsed'));
  const before = owner(live.fp);
  ts.recordTrialScreen(db, { userId: after, deviceId: live.id, plan: plan(after), now: NOW });
  assert.equal(owner(live.fp), before, 'a row that still counts keeps its first owner');
});

test('a ledger entry older than a year no longer counts (a panel sold on gets a trial eventually)', () => {
  const prior = user('lapsed');
  const me = user('trial');
  const old = NOW - ts.LEDGER_TTL - DAY;
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(prior, old));
  assert.equal(check(me, burnedScreen(prior, old)).allowed, true);
});

test('re-used screens from DIFFERENT earlier accounts are counted per account, not pooled', () => {
  const a = user('lapsed'), b = user('lapsed');
  const me = user('trial');
  claim(me, burnedScreen(a)); claim(me, burnedScreen(b));
  assert.equal(check(me, burnedScreen(a)).allowed, true, 'two from a, one from b: under the threshold for each');
});

test('recordTrialScreen: first trial wins, so a chain A -> B -> C is still measured against A', () => {
  const a = user('trial'), b = user('trial');
  const s = screen(a);
  assert.equal(ts.recordTrialScreen(db, { userId: a, deviceId: s.id, plan: plan(a), now: NOW }), 1);
  ts.recordTrialScreen(db, { userId: b, deviceId: s.id, plan: plan(b), now: NOW + 10 });
  const row = db.prepare('SELECT user_id, last_seen_at FROM trial_screen_ledger WHERE screen_key = ?').get(ts.screenKeyOf(s.fp));
  assert.equal(row.user_id, a);
  assert.equal(row.last_seen_at, NOW + 10);
});

test('recordTrialScreen records nothing for a paid account or a model-level fingerprint', () => {
  const p = user('paid');
  assert.equal(ts.recordTrialScreen(db, { userId: p, deviceId: screen(p).id, plan: plan(p), now: NOW }), 0);
  const t = user('trial');
  assert.equal(ts.recordTrialScreen(db, { userId: t, deviceId: screen(t, 'web-m73u8w-5f').id, plan: plan(t), now: NOW }), 0);
});

/* ───────────── backfill and deletion ───────────── */

test('backfill seeds screens on trialing and lapsed-unpaid accounts, never on paid ones', () => {
  const t = user('trial'), l = user('lapsed'), p = user('paid');
  const st = screen(t), sl = screen(l), sp = screen(p);
  ts.backfillLedger(db, { now: NOW });
  const owner = (fp) => (db.prepare('SELECT user_id FROM trial_screen_ledger WHERE screen_key = ?').get(ts.screenKeyOf(fp)) || {}).user_id;
  assert.equal(owner(st.fp), t);
  assert.equal(owner(sl.fp), l);
  assert.equal(owner(sp.fp), undefined);
});

test('account deletion keeps the screens burned but stops naming the person', () => {
  const prior = user('lapsed');
  const s = burnedScreen(prior);
  assert.equal(ts.anonymizeUser(db, prior), 1);
  const row = db.prepare('SELECT user_id FROM trial_screen_ledger WHERE screen_key = ?').get(ts.screenKeyOf(s.fp));
  assert.match(row.user_id, /^deleted:[0-9a-f]{24}$/);
  assert.ok(!row.user_id.includes(prior));
  const me = user('trial');
  for (let i = 0; i < 2; i++) claim(me, burnedScreen(row.user_id));
  assert.equal(check(me, s).allowed, false, 'deleting the old account does not hand its screens a fresh trial');
});

test('deleting an account that PAID drops its ledger rows (a tombstone would look unpaid)', () => {
  const prior = user('lapsed');
  db.prepare("INSERT INTO conversion_events (user_id, event) VALUES (?, 'checkout_complete')").run(prior);
  const s = burnedScreen(prior);
  assert.equal(ts.anonymizeUser(db, prior), 1);
  assert.equal(db.prepare('SELECT 1 FROM trial_screen_ledger WHERE screen_key = ?').get(ts.screenKeyOf(s.fp)), undefined);
});

test('the digest TTL matches the block: a ledger entry older than a year is not "re-used"', () => {
  const prior = user('lapsed'), me = user('trial');
  for (let i = 0; i < 3; i++) claim(me, burnedScreen(prior, NOW - ts.LEDGER_TTL - DAY));
  assert.equal(ts.suspectTrialReuse(db, { now: NOW }).find((r) => r.user_id === me), undefined);
});

/* ───────────── part B: the review signal ───────────── */

function signIn(u, ip, at = NOW - DAY) {
  db.prepare("INSERT INTO activity_log (user_id, action, ip_address, created_at) VALUES (?, 'auth:login_success', ?, ?)").run(u, ip, at);
}

test('suspectTrialReuse flags a 3+ screen trial sharing a network with a recently lapsed unpaid trial', () => {
  const lapsed = user('lapsed'), me = user('trial');
  for (let i = 0; i < 3; i++) screen(me);
  signIn(lapsed, '198.51.100.7'); signIn(me, '198.51.100.7');
  const hit = ts.suspectTrialReuse(db, { now: NOW }).find((r) => r.user_id === me);
  assert.ok(hit, 'flagged');
  assert.deepEqual(hit.lapsed_accounts.map((l) => l.user_id), [lapsed]);
  assert.deepEqual(hit.shared_networks, ['198.51.100.7']);
  assert.match(reuseLine(hit), /same network as/);
});

test('suspectTrialReuse ignores small trials and paying neighbours', () => {
  const lapsed = user('lapsed');
  signIn(lapsed, '198.51.100.8');
  const small = user('trial'); screen(small); screen(small); signIn(small, '198.51.100.8');
  const paidN = user('paid'); signIn(paidN, '198.51.100.9');
  const me = user('trial'); for (let i = 0; i < 3; i++) screen(me); signIn(me, '198.51.100.9');
  const flagged = ts.suspectTrialReuse(db, { now: NOW }).map((r) => r.user_id);
  assert.ok(!flagged.includes(small), 'two screens is not a pattern');
  assert.ok(!flagged.includes(me), 'a paying neighbour is not a lapsed trial');
});

test('suspectTrialReuse also flags screens an earlier unpaid trial used, without a shared network', () => {
  const prior = user('lapsed'), me = user('trial');
  for (let i = 0; i < 3; i++) claim(me, burnedScreen(prior));
  const hit = ts.suspectTrialReuse(db, { now: NOW }).find((r) => r.user_id === me);
  assert.ok(hit);
  assert.equal(hit.reused_screens, 3);
});

test('the digest is sent for a new flag alone, and carries it', () => {
  const lapsed = user('lapsed'), me = user('trial');
  for (let i = 0; i < 3; i++) screen(me);
  signIn(lapsed, '203.0.113.5'); signIn(me, '203.0.113.5');
  const flags = ts.suspectTrialReuse(db, { now: NOW }).filter((r) => r.user_id === me);
  const d = buildDigest(db, NOW + 400 * DAY, null, flags);   // a day with no feedback and no signups
  assert.ok(d, 'not suppressed as "nothing new"');
  assert.match(d.text, /Possible trial re-use/);
  assert.match(d.text, new RegExp(me));
  assert.match(d.subject, /trial re-use flag/);
  assert.equal(buildDigest(db, NOW + 400 * DAY, null, []), null, 'and without one, a quiet day stays quiet');
});

test('a flag is marked reported only once a digest was delivered; a failed send reports it again', async () => {
  const lapsed = user('lapsed'), me = user('trial');
  for (let i = 0; i < 3; i++) screen(me);
  signIn(lapsed, '203.0.113.77'); signIn(me, '203.0.113.77');
  const cfg = { selfHosted: false };
  const stamped = () => !!db.prepare('SELECT 1 FROM trial_reuse_flags WHERE user_id = ?').get(me);
  const broken = { isConfigured: () => true, sendEmail: async () => { throw new Error('SMTP down'); } };
  const r1 = await run({ db, email: broken, now: NOW, appUrl: 'https://x.test', cfg, discordUrl: '' });
  assert.equal(r1.digests, 0);
  assert.equal(stamped(), false, 'nobody saw it: not marked');
  const sent = [];
  const ok = { isConfigured: () => true, sendEmail: async (m) => { sent.push(m); } };
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, 'x', 'platform_admin')").run(rid('adm'), rid('adm') + '@t.local');
  const r2 = await run({ db, email: ok, now: NOW, appUrl: 'https://x.test', cfg, discordUrl: '' });
  assert.ok(r2.digests >= 1);
  assert.ok(sent.some((m) => m.text.includes(me)), 'reported on the next run that delivers');
  assert.equal(stamped(), true);
  sent.length = 0;
  await run({ db, email: ok, now: NOW, appUrl: 'https://x.test', cfg, discordUrl: '' });
  assert.ok(!sent.some((m) => m.text.includes(me)), 'and only once');
});

test('a Discord-only delivery does not mark flags reported (it carries the count, not the accounts)', async () => {
  const lapsed = user('lapsed'), me = user('trial');
  for (let i = 0; i < 3; i++) screen(me);
  signIn(lapsed, '203.0.113.88'); signIn(me, '203.0.113.88');
  const noMail = { isConfigured: () => false, sendEmail: async () => {} };
  const r = await run({ db, email: noMail, now: NOW, appUrl: 'https://x.test', cfg: { selfHosted: false },
    discordUrl: 'https://discord.com/api/webhooks/1/x', fetchImpl: async () => ({ ok: true }) });
  assert.equal(r.discord, true);
  assert.equal(!!db.prepare('SELECT 1 FROM trial_reuse_flags WHERE user_id = ?').get(me), false);
});
