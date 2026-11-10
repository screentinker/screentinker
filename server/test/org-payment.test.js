'use strict';

/*
 * THE ORGANIZATION PAYS (app_settings.billing_source = 'org').
 *
 * With the switch on, the subscription belongs to the organization: anyone in it can buy a plan
 * for it, its owner and organization admins manage it, Stripe's events land on the organization
 * row, its screens and storage are held to ITS plan, and the trial and failed-payment clocks run
 * on it. This file drives the real Stripe routes (with a Stripe double), the real webhook, and
 * the real trial and dunning code in that mode.
 *
 * It also holds the promises that make the switch safe:
 *   - a subscription made BEFORE the switch (its Stripe metadata names only a user) still finds
 *     its organization;
 *   - one person's two organizations are separate accounts;
 *   - a member's own row is never charged or changed;
 *   - the owner's row stays a faithful copy, for the code that still reads people.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-orgpay-' + crypto.randomBytes(4).toString('hex'));

// --- Stripe double: records what the routes ask Stripe for.
const calls = [];
const fakeStripeFactory = () => ({
  customers: { create: async (p) => { calls.push(['customers.create', p]); return { id: 'cus_' + crypto.randomBytes(4).toString('hex') }; } },
  checkout: { sessions: { create: async (p) => { calls.push(['checkout.create', p]); return { url: 'https://stripe.test/checkout' }; } } },
  billingPortal: { sessions: { create: async (p) => { calls.push(['portal.create', p]); return { url: 'https://stripe.test/portal' }; } } },
  subscriptions: { retrieve: async () => { const e = new Error('stub'); e.statusCode = 500; throw e; } },
  webhooks: { constructEvent: (body) => (Buffer.isBuffer(body) || typeof body === 'string' ? JSON.parse(body) : body) },
});
const stripePath = require.resolve('stripe');
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: fakeStripeFactory };
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_double';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_double';

// --- auth double: the caller is whoever the test names in a header.
const realAuth = require('../middleware/auth');
const authPath = require.resolve('../middleware/auth');
let dbRef;
const asHeaderUser = (req, res, next) => {
  const u = dbRef.prepare('SELECT * FROM users WHERE id = ?').get(req.headers['x-test-user'] || '');
  if (!u) return res.status(401).json({ error: 'no test user' });
  req.user = u; next();
};
const superOnly = (req, res, next) => (req.user && req.user.role === 'platform_admin' ? next() : res.status(403).json({ error: 'platform admin only' }));
require.cache[authPath].exports = { ...realAuth, requireAuth: asHeaderUser, requireSuperAdmin: superOnly };

const { db } = require('../db/database');
dbRef = db;
const subs = require('../middleware/subscription');
const orgBilling = require('../lib/org-billing');
const emailSvc = require('../services/email');
const setupDeviceSocket = require('../ws/deviceSocket');
const stripeRouter = require('../routes/stripe');
const subscriptionRouter = require('../routes/subscription');
const dunning = require('../services/dunning');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const rid = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const orgRow = (id) => db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
let clock = 5000;

function person(name, fields = {}) {
  const id = rid(name);
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, email_alerts, email_verified)
              VALUES (?, ?, ?, 'x', 'local', 'user', 'free', 1, 1)`).run(id, `${id}@t.local`, name);
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  return id;
}
function organization(owner, name) {
  const o = rid('org'), w = rid('ws');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').run(o, name, owner, clock++);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(o, owner);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(w, o, name + ' ws');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(w, owner);
  return { o, w };
}
const joinWorkspace = (w, u, role = 'workspace_editor') => db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(w, u, role);
const joinOrg = (o, u, role) => db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(o, u, role);
function screens(n, pairedBy, ws) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = rid('d');
    db.prepare(`INSERT INTO devices (id, name, status, user_id, workspace_id, device_token, client_type, created_at) VALUES (?, 'S', 'online', ?, ?, ?, 'apk', ?)`)
      .run(id, pairedBy, ws, crypto.randomBytes(16).toString('hex'), clock++);
    ids.push(id);
  }
  return ids;
}

let server, base, io, ioServer; const sent = [];
const post = (p, user, ws, body) => fetch(base + p, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...(ws ? { 'x-workspace-id': ws } : {}) }, body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (p, user, ws) => fetch(base + p, { headers: { 'x-test-user': user, ...(ws ? { 'x-workspace-id': ws } : {}) } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const webhook = (type, object) => fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type, data: { object } }) }).then((r) => r.json());
const plays = (ids) => ids.map((d) => setupDeviceSocket.checkDeviceAccess(d).allowed);
const sub = ({ id, meta, price, status = 'active', customer }) => ({ id, status, customer, metadata: meta,
  items: { data: [{ price: { id: price }, current_period_end: now() + 30 * DAY }] } });

const A = {};
before(async () => {
  for (const [id, max] of [['free', 2], ['starter', 3], ['pro', 5]]) {
    db.prepare(`INSERT INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES (?, ?, ?, ?, 100)
                ON CONFLICT(id) DO UPDATE SET max_devices = excluded.max_devices`).run(id, id, id, max);
  }
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_starter_m', stripe_price_yearly = 'price_starter_y' WHERE id = 'starter'").run();
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_pro_m', stripe_price_yearly = 'price_pro_y' WHERE id = 'pro'").run();
  emailSvc.sendEmail = async (m) => { sent.push(m); return { sent: true }; };
  ioServer = http.createServer(); io = new Server(ioServer); setupDeviceSocket(io);

  // People and organizations as they are BEFORE the switch (the person pays, the mirror runs).
  A.owner = person('owner');
  A.org = organization(A.owner, 'Acme');
  A.member = person('member'); joinWorkspace(A.org.w, A.member);
  A.admin = person('orgadmin'); joinWorkspace(A.org.w, A.admin, 'workspace_viewer'); joinOrg(A.org.o, A.admin, 'org_admin');
  A.outsider = person('outsider'); A.outOrg = organization(A.outsider, 'Elsewhere');
  // A customer who subscribed before the switch: the subscription is on the PERSON, metadata user_id only.
  A.legacy = person('legacy', { plan_id: 'starter', stripe_customer_id: 'cus_legacy', stripe_subscription_id: 'sub_legacy' });
  A.legacyOrg = organization(A.legacy, 'Legacy');
  // One person, two organizations.
  A.twin = person('twin');
  A.twin1 = organization(A.twin, 'Twin one'); A.twin2 = organization(A.twin, 'Twin two');
  // A trial that lapsed, not yet swept.
  A.lapsed = person('lapsed', { plan_id: 'pro', trial_started: now() - 30 * DAY, trial_plan: 'pro' });
  A.lapsedOrg = organization(A.lapsed, 'Lapsed');

  const r = orgBilling.switchToOrganizations(db);
  assert.equal(r.ok, true, 'switched: ' + JSON.stringify(r));

  const app = express();
  app.use(express.json());
  app.set('io', io);
  app.use('/api/stripe', stripeRouter);
  app.use('/api/subscription', subscriptionRouter);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  try { orgBilling.switchToPeople(db, { force: true }); } catch { /* */ }
  io.close(); ioServer.close();
  await new Promise((r) => server.close(r));
});

test('the switch itself: organizations hold what their owners held, and limits are the organization\'s', () => {
  assert.equal(subs.billingSource(), 'org');
  assert.equal(subs.billingTable(), 'organizations');
  assert.equal(subs.limitsScope(), 'org', 'limits follow the payer');
  assert.equal(orgRow(A.legacyOrg.o).stripe_subscription_id, 'sub_legacy');
  assert.equal(orgRow(A.legacyOrg.o).plan_id, 'starter');
});

test('any member can start a checkout, and it is the ORGANIZATION that becomes the Stripe customer', async () => {
  calls.length = 0;
  const r = await post('/api/stripe/checkout', A.member, A.org.w, { plan_id: 'starter', interval: 'monthly' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.type, 'checkout');
  const cust = calls.find((c) => c[0] === 'customers.create')[1];
  assert.equal(cust.metadata.org_id, A.org.o);
  assert.equal(cust.metadata.user_id, A.member, 'who clicked is kept, for the funnel');
  assert.equal(cust.name, 'Acme');
  assert.equal(cust.email, userRow(A.owner).email, 'Stripe writes to the organization\'s owner, not to whoever clicked');
  const session = calls.find((c) => c[0] === 'checkout.create')[1];
  assert.equal(session.metadata.org_id, A.org.o);
  assert.equal(session.subscription_data.metadata.org_id, A.org.o);
  assert.equal(session.customer, orgRow(A.org.o).stripe_customer_id, 'the customer id is stored on the organization');
  assert.equal(userRow(A.member).stripe_customer_id, null, 'and not on the member who clicked');
  assert.equal(userRow(A.owner).stripe_customer_id, orgRow(A.org.o).stripe_customer_id, 'the owner\'s row is the copy');
});

test('the checkout webhook lands on the organization; the member who paid is untouched', async () => {
  await webhook('checkout.session.completed', { id: 'cs_1', subscription: 'sub_acme', customer: orgRow(A.org.o).stripe_customer_id,
    metadata: { org_id: A.org.o, user_id: A.member, plan_id: 'starter' } });
  const o = orgRow(A.org.o);
  assert.equal(o.plan_id, 'starter'); assert.equal(o.stripe_subscription_id, 'sub_acme'); assert.equal(o.subscription_status, 'active');
  assert.equal(userRow(A.member).plan_id, 'free'); assert.equal(userRow(A.member).stripe_subscription_id, null);
  assert.equal(userRow(A.owner).plan_id, 'starter', 'the owner\'s row mirrors their organization');
  assert.equal(subs.getOrgPlan(A.org.o).max_devices, 3);
});

test('the organization\'s screens are held to its plan, whoever paired them', () => {
  const mine = screens(2, A.owner, A.org.w), theirs = screens(3, A.member, A.org.w);
  assert.deepEqual(plays([...mine, ...theirs]), [true, true, true, false, false], 'three of five on Starter, oldest first');
});

test('once subscribed: a member is told who can change it; the owner and an org admin get the portal', async () => {
  const again = await post('/api/stripe/checkout', A.member, A.org.w, { plan_id: 'pro' });
  assert.equal(again.status, 403); assert.equal(again.body.code, 'BILLING_ADMIN_ONLY');
  const memberPortal = await post('/api/stripe/portal', A.member, A.org.w);
  assert.equal(memberPortal.status, 403); assert.equal(memberPortal.body.code, 'BILLING_ADMIN_ONLY');
  for (const who of [A.owner, A.admin]) {
    calls.length = 0;
    const r = await post('/api/stripe/portal', who, A.org.w);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls.find((c) => c[0] === 'portal.create')[1].customer, orgRow(A.org.o).stripe_customer_id);
    const up = await post('/api/stripe/checkout', who, A.org.w, { plan_id: 'pro' });
    assert.equal(up.status, 200); assert.equal(up.body.type, 'portal', 'a subscriber changing plan goes to the portal');
  }
});

test('someone outside the organization cannot pay for it or manage it: they act on their own', async () => {
  calls.length = 0;
  const r = await post('/api/stripe/checkout', A.outsider, A.org.w, { plan_id: 'starter' });
  if (r.status === 200) {
    assert.equal(calls.find((c) => c[0] === 'checkout.create')[1].metadata.org_id, A.outOrg.o, 'the request resolved to their own organization');
  } else {
    assert.ok(r.status === 403 || r.status === 400, 'or it was refused: ' + r.status);
  }
  assert.equal(orgRow(A.org.o).stripe_subscription_id, 'sub_acme', 'the organization they named is untouched');
});

test('a portal plan change (billed price) lands on the organization', async () => {
  await webhook('customer.subscription.updated', sub({ id: 'sub_acme', price: 'price_pro_m', customer: orgRow(A.org.o).stripe_customer_id,
    meta: { org_id: A.org.o, user_id: A.member, plan_id: 'starter' } }));
  assert.equal(orgRow(A.org.o).plan_id, 'pro', 'the price, not the stale metadata');
  assert.ok(orgRow(A.org.o).subscription_ends > now());
});

test('a subscription from BEFORE the switch (metadata names only a user) still finds its organization', async () => {
  await webhook('customer.subscription.updated', sub({ id: 'sub_legacy', price: 'price_pro_m', customer: 'cus_legacy', meta: { user_id: A.legacy, plan_id: 'starter' } }));
  assert.equal(orgRow(A.legacyOrg.o).plan_id, 'pro');
  assert.equal(userRow(A.legacy).plan_id, 'pro', 'and the owner\'s copy follows');
  // Even with no id to match on, the person's oldest organization is the account.
  db.prepare('UPDATE organizations SET stripe_subscription_id = NULL, stripe_customer_id = NULL WHERE id = ?').run(A.legacyOrg.o);
  await webhook('checkout.session.completed', { id: 'cs_legacy', subscription: 'sub_legacy2', customer: 'cus_other', metadata: { user_id: A.legacy, plan_id: 'starter' } });
  assert.equal(orgRow(A.legacyOrg.o).stripe_subscription_id, 'sub_legacy2');
});

test('a failed payment starts the grace on the organization and writes to its owner, once', async () => {
  sent.length = 0;
  await webhook('invoice.payment_failed', { id: 'in_1', subscription: 'sub_acme', customer: orgRow(A.org.o).stripe_customer_id });
  const o = orgRow(A.org.o);
  assert.equal(o.subscription_status, 'past_due'); assert.ok(o.past_due_since);
  assert.equal(o.plan_id, 'pro', 'nothing is taken away during the grace');
  const direct = await dunning.sendPaymentFailedEmail(A.org.o);
  if (direct.sent || direct.reason === 'already_sent') {
    const mail = sent.find((m) => m.to === userRow(A.owner).email);
    assert.ok(mail, 'the note goes to the organization\'s owner');
    assert.ok(!sent.some((m) => m.to === userRow(A.member).email), 'not to the member who happened to pay');
    assert.ok(orgRow(A.org.o).payment_failed_email_sent_at, 'and is stamped on the organization');
  } else {
    assert.ok(['not_hosted'].includes(direct.reason), 'not sent only because this is not a hosted instance: ' + direct.reason);
  }
  await webhook('invoice.payment_failed', { id: 'in_2', subscription: 'sub_acme', customer: o.stripe_customer_id });
  assert.equal(orgRow(A.org.o).past_due_since, o.past_due_since, 'a retry does not restart the clock');
});

test('the grace running out drops the ORGANIZATION to Free; paying restores its plan', async () => {
  db.prepare('UPDATE organizations SET past_due_since = ? WHERE id = ?').run(now() - 30 * DAY, A.org.o);
  assert.ok(subs.findLapsedSubscriberIds().includes(A.org.o), 'the sweep finds organizations');
  assert.equal(subs.downgradeLapsed(A.org.o), true);
  assert.equal(orgRow(A.org.o).plan_id, 'free'); assert.equal(orgRow(A.org.o).subscription_status, 'unpaid');
  assert.equal(orgRow(A.org.o).stripe_subscription_id, 'sub_acme', 'the subscription id is kept so recovery can find it');
  await webhook('invoice.payment_succeeded', { id: 'in_3', subscription: 'sub_acme', customer: orgRow(A.org.o).stripe_customer_id,
    lines: { data: [{ pricing: { price_details: { price: 'price_pro_m' } }, price: { id: 'price_pro_m' } }] } });
  const o = orgRow(A.org.o);
  assert.equal(o.past_due_since, null); assert.equal(o.subscription_status, 'active');
  assert.equal(o.plan_id, 'pro', 'restored to the plan the invoice billed');
});

test('cancelling drops the organization to Free and only the tracked subscription may do it', async () => {
  await webhook('customer.subscription.deleted', sub({ id: 'sub_duplicate', price: 'price_pro_m', meta: { org_id: A.org.o } }));
  assert.equal(orgRow(A.org.o).plan_id, 'pro', 'a duplicate subscription being cancelled changes nothing');
  await webhook('customer.subscription.deleted', sub({ id: 'sub_acme', price: 'price_pro_m', meta: { org_id: A.org.o } }));
  const o = orgRow(A.org.o);
  assert.equal(o.plan_id, 'free'); assert.equal(o.stripe_subscription_id, null); assert.equal(o.subscription_status, 'cancelled');
  assert.equal(userRow(A.owner).plan_id, 'free');
});

test('the subscription summary is the organization\'s, and says what this person may do about it', async () => {
  const B = {}; B.owner = person('sumowner'); B.org = organization(B.owner, 'Summary');
  B.member = person('summember'); joinWorkspace(B.org.w, B.member);
  db.prepare("UPDATE organizations SET plan_id = 'starter', stripe_subscription_id = 'sub_sum', stripe_customer_id = 'cus_sum' WHERE id = ?").run(B.org.o);
  screens(2, B.owner, B.org.w); screens(2, B.member, B.org.w);
  const m = await get('/api/subscription/me', B.member, B.org.w);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.plan.id, 'starter', 'the organization\'s plan, not the member\'s own Free');
  assert.equal(m.body.usage.devices, 4, 'counted across the organization');
  assert.equal(m.body.usage.devices_limit, 3);
  assert.equal(m.body.subscription.stripe_subscription_id, 'sub_sum');
  assert.deepEqual({ scope: m.body.billing.scope, org: m.body.billing.organization_id, name: m.body.billing.organization_name,
    can_pay: m.body.billing.can_pay, can_manage: m.body.billing.can_manage },
  { scope: 'org', org: B.org.o, name: 'Summary', can_pay: true, can_manage: false });
  assert.equal(m.body.billing.owner_name, 'sumowner', 'so the page can say who to ask');
  const o = await get('/api/subscription/me', B.owner, B.org.w);
  assert.equal(o.body.billing.can_manage, true);
});

test('a plan assigned by the operator goes to the organization: by its id, or by naming its owner', async () => {
  const op = person('operator', { role: 'platform_admin' });
  const C = {}; C.owner = person('compowner', { plan_id: 'pro', trial_started: now() - DAY, trial_plan: 'pro' });
  C.org = organization(C.owner, 'Comped'); C.org2 = organization(C.owner, 'Comped two');
  const byOrg = await post('/api/subscription/assign', op, null, { organization_id: C.org2.o, plan_id: 'starter', renewal_at: now() + 90 * DAY });
  assert.equal(byOrg.status, 200, JSON.stringify(byOrg.body));
  assert.equal(orgRow(C.org2.o).plan_id, 'starter'); assert.equal(orgRow(C.org2.o).plan_comped, 1); assert.ok(orgRow(C.org2.o).renewal_at);
  assert.equal(orgRow(C.org.o).plan_id, 'pro', 'the other organization is untouched');
  const byOwner = await post('/api/subscription/assign', op, null, { user_id: C.owner, plan_id: 'pro' });
  assert.equal(byOwner.status, 200);
  const first = orgRow(C.org.o);
  assert.equal(first.plan_comped, 1); assert.equal(first.trial_started, null, 'a comp ends the trial clock, on the organization');
  assert.equal((await post('/api/subscription/assign', op, null, { organization_id: 'nope', plan_id: 'pro' })).status, 404);
  assert.equal((await post('/api/subscription/assign', C.owner, null, { organization_id: C.org.o, plan_id: 'pro' })).status, 403, 'operators only');
});

test('when the plan changes, every screen of the organization is told at once: cancel, then buy again', async () => {
  const D = {}; D.owner = person('pushowner'); D.org = organization(D.owner, 'Pushed');
  D.member = person('pushmember'); joinWorkspace(D.org.w, D.member);
  db.prepare("UPDATE organizations SET plan_id = 'starter', stripe_subscription_id = 'sub_push', stripe_customer_id = 'cus_push', trial_started = NULL WHERE id = ?").run(D.org.o);
  const all = [...screens(2, D.owner, D.org.w), ...screens(2, D.member, D.org.w)];
  assert.deepEqual(plays(all), [true, true, true, false], 'Starter: three of four');
  // What a push is: the gated payload queued or sent to the screen (lib/command-queue.js).
  const queue = require('../lib/command-queue');
  const real = queue.queueOrEmitPlaylistUpdate; const pushed = [];
  queue.queueOrEmitPlaylistUpdate = (ns, id) => { pushed.push(id); };
  try {
    await webhook('customer.subscription.deleted', sub({ id: 'sub_push', price: 'price_starter_m', meta: { org_id: D.org.o } }));
    assert.equal(orgRow(D.org.o).plan_id, 'free');
    assert.deepEqual([...pushed].sort(), [...all].sort(), 'cancelled: all four screens are sent their new answer, not left until they next reconnect');
    assert.deepEqual(plays(all), [true, true, false, false], 'and the answer is the Free limit: the two oldest play');
    pushed.length = 0;
    await webhook('checkout.session.completed', { id: 'cs_push', subscription: 'sub_push2', customer: 'cus_push', metadata: { org_id: D.org.o, user_id: D.member, plan_id: 'pro' } });
    assert.deepEqual([...pushed].sort(), [...all].sort(), 'bought again: the dark screens are told straight away too');
    assert.deepEqual(plays(all), [true, true, true, true]);
    pushed.length = 0;
    await webhook('customer.subscription.updated', sub({ id: 'sub_push2', price: 'price_pro_m', meta: { org_id: D.org.o } }));
    assert.deepEqual(pushed, [], 'an event that changes no plan pushes nothing');
  } finally { queue.queueOrEmitPlaylistUpdate = real; }
});

test('one person\'s two organizations are separate accounts', async () => {
  await webhook('checkout.session.completed', { id: 'cs_t2', subscription: 'sub_twin2', customer: 'cus_twin2', metadata: { org_id: A.twin2.o, user_id: A.twin, plan_id: 'pro' } });
  assert.equal(orgRow(A.twin2.o).plan_id, 'pro');
  assert.equal(orgRow(A.twin1.o).plan_id, 'free', 'the other organization did not get it');
  assert.equal(orgRow(A.twin1.o).stripe_subscription_id, null);
  const first = screens(3, A.twin, A.twin1.w), second = screens(3, A.twin, A.twin2.w);
  assert.deepEqual(plays(first), [true, true, false], 'Free: two');
  assert.deepEqual(plays(second), [true, true, true], 'Pro: all three');
  assert.equal(userRow(A.twin).plan_id, 'free', 'the person\'s row copies their OLDEST organization only');
});

test('a lapsed trial is found and ended on the organization, by the sweep and by a read', () => {
  assert.ok(subs.findExpiredTrialUserIds().includes(A.lapsedOrg.o));
  const plan = subs.getOrgPlan(A.lapsedOrg.o);         // reading heals
  assert.equal(plan.plan_id, 'free');
  const o = orgRow(A.lapsedOrg.o);
  assert.equal(o.plan_id, 'free'); assert.equal(o.trial_started, null); assert.ok(o.trial_expired_at);
  assert.equal(userRow(A.lapsed).plan_id, 'free', 'the owner\'s copy follows');
  // Reading a PERSON in this mode never writes and never loops.
  db.prepare("UPDATE users SET plan_id = 'pro', trial_started = ?, trial_plan = 'pro' WHERE id = ?").run(now() - 40 * DAY, A.member);
  const p = subs.getUserPlan(A.member);
  assert.equal(p.plan_id, 'free', 'reported as it would be');
  assert.equal(userRow(A.member).plan_id, 'pro', 'but the copy was not written');
});

test('a new signup\'s trial becomes its first organization\'s trial; a second organization gets none', () => {
  // What registration does: the person row is created with the trial, then the organization.
  const fresh = person('fresh', { plan_id: 'pro', trial_started: now() - DAY, trial_plan: 'pro' });
  const first = organization(fresh, 'Fresh');
  const o = orgRow(first.o);
  assert.equal(o.plan_id, 'pro'); assert.equal(o.trial_plan, 'pro'); assert.equal(o.trial_started, userRow(fresh).trial_started);
  assert.equal(subs.getOrgPlan(first.o).trial_active, true, 'the organization is on a running trial');
  assert.equal(userRow(fresh).trial_started, o.trial_started, 'and the person\'s copy was not wiped by creating it');
  const second = organization(fresh, 'Fresh two');
  const o2 = orgRow(second.o);
  assert.equal(o2.plan_id, 'free'); assert.equal(o2.trial_started, null, 'no second trial');
  assert.equal(orgRow(first.o).plan_id, 'pro', 'and the first is untouched');
  // Someone whose trial already ended and who then starts an organization does not get a new one.
  const used = person('used', { plan_id: 'free', trial_expired_at: now() - 5 * DAY });
  const late = organization(used, 'Late');
  assert.equal(orgRow(late.o).plan_id, 'free'); assert.equal(orgRow(late.o).trial_started, null);
  assert.ok(orgRow(late.o).trial_expired_at, 'the used trial is remembered on it');
});

test('switching back to people keeps what was paid for on each owner\'s oldest organization', () => {
  const before_ = orgRow(A.twin2.o).plan_id;
  const refused = orgBilling.switchToPeople(db);
  assert.equal(refused.ok, false, 'it says which organizations would be overwritten first');
  assert.ok(refused.would_overwrite.includes(A.twin2.o));
  assert.equal(before_, 'pro');
  assert.equal(subs.billingSource(), 'org');
});
