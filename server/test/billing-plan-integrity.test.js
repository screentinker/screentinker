'use strict';

/*
 * Plan integrity across the billing paths (audit F02, F03, F13, F14, F15, F25).
 *
 * Every test here is a way plan_id stopped matching what Stripe was billing — or a way an account
 * escaped its plan's limits — that a green suite never noticed, because each path was only ever
 * tested against the shape it was written for. Stripe is a double (require.cache, the same
 * convention as stripe-checkout.test.js); the database, the routes, the reconcile and the sweep
 * are the real ones.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-plan-integrity-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
process.env.SELF_HOSTED = '';                          // hosted shape: dunning + reconcile enabled
process.env.BILLING_GRACE_DAYS = '7';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';       // so the reconcile and the router build the (stubbed) client
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

// --- Stripe double: subscriptions.retrieve answers from this map; anything else is a 500-ish error
// the reconcile counts and skips, so rows from other tests are left alone. ---
const stripeSubs = new Map();
const fakeStripeFactory = () => ({
  subscriptions: {
    retrieve: async (id) => {
      if (stripeSubs.has(id)) return stripeSubs.get(id);
      const e = new Error('stub: unknown subscription'); e.statusCode = 500; throw e;
    },
  },
  webhooks: { constructEvent: (body) => (Buffer.isBuffer(body) || typeof body === 'string' ? JSON.parse(body) : body) },
});
const stripePath = require.resolve('stripe');
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: fakeStripeFactory };

// --- auth double for /api/subscription/assign: a super-admin caller. The routes destructure at
// require time, so the cache entry is replaced BEFORE they load. ---
const realAuth = require('../middleware/auth');
const authPath = require.resolve('../middleware/auth');
const pass = (req, _res, next) => { req.user = req.user || { id: 'u-admin', role: 'superadmin' }; next(); };
require.cache[authPath].exports = { ...realAuth, requireAuth: pass, requireAdmin: pass, requireSuperAdmin: pass };

const { db } = require('../db/database');
const subs = require('../middleware/subscription');
const emailSvc = require('../services/email');
const setupDeviceSocket = require('../ws/deviceSocket');
const stripeRouter = require('../routes/stripe');
const subscriptionRouter = require('../routes/subscription');
const dunning = require('../services/dunning');

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const uid = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const read = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function mkUser({ plan = 'pro', trialPlan = 'pro', trialStarted = null, subId = null, status = 'active', pastDueSince = null } = {}) {
  const id = uid('u');
  db.prepare(`INSERT INTO users (id, email, name, password_hash, role, plan_id, trial_plan, trial_started,
                                 stripe_subscription_id, stripe_customer_id, subscription_status, past_due_since,
                                 email_alerts, email_verified)
              VALUES (?, ?, 'Test', 'x', 'user', ?, ?, ?, ?, ?, ?, ?, 1, 1)`)
    .run(id, `${id}@t.local`, plan, trialPlan, trialStarted, subId, `cus_${id}`, status, pastDueSince);
  return id;
}
function mkDevices(userId, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = uid('d');
    const at = nowSec() - (100 - i) * 60;            // strictly ordered by created_at
    db.prepare('INSERT INTO devices (id, name, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'screen ' + id, userId, at, at);
    ids.push(id);
  }
  return ids;
}
const stripeSub = ({ id, userId, price, metaPlan, status = 'active' }) => ({
  id, status, metadata: { user_id: userId, ...(metaPlan ? { plan_id: metaPlan } : {}) },
  items: { data: [{ price: { id: price }, current_period_end: nowSec() + 30 * DAY }] },
});

let server, base, io, ioServer, sent = [];
before(async () => {
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_starter_m', stripe_price_yearly = 'price_starter_y' WHERE id = 'starter'").run();
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_pro_m', stripe_price_yearly = 'price_pro_y' WHERE id = 'pro'").run();
  emailSvc.sendEmail = async (m) => { sent.push(m); return { sent: true }; };

  ioServer = http.createServer(); io = new Server(ioServer); setupDeviceSocket(io);

  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  app.use('/api/subscription', subscriptionRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  io.close(); ioServer.close();
  await new Promise((r) => server.close(r));
});

const webhook = (type, object) => fetch(`${base}/api/stripe/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type, data: { object } }),
}).then((r) => r.json());
const access = (ids) => ids.map((d) => setupDeviceSocket.checkDeviceAccess(d).allowed);

/* ============ F02: a converted trial is held to its plan's screen limit ============ */

test('F02: a trial that converted and then cancelled to Free is held to the Free limit', () => {
  // Signed up (trial stamped), paid, cancelled: Free, no subscription, trial_started never cleared.
  const id = mkUser({ plan: 'free', trialPlan: 'pro', trialStarted: nowSec() - 30 * DAY });
  const devices = mkDevices(id, 5);
  const free = db.prepare("SELECT max_devices FROM plans WHERE id = 'free'").get().max_devices;
  const expected = devices.map((_, i) => i < free);
  assert.deepEqual(access(devices), expected,
    'screens beyond the Free limit must stop — a stale trial_started is not a running trial');
});

test('F02: a paying account whose trial clock is still inside 14 days is held to the plan it pays for', () => {
  // Bought Starter on day 3 of a Pro trial: trial_active is true by the clock, but it is not a trial.
  const id = mkUser({ plan: 'starter', trialPlan: 'pro', trialStarted: nowSec() - 3 * DAY, subId: uid('sub') });
  const devices = mkDevices(id, 10);
  const starter = db.prepare("SELECT max_devices FROM plans WHERE id = 'starter'").get().max_devices;
  assert.deepEqual(access(devices), devices.map((_, i) => i < starter));
});

test('F02: checkout ends the trial — trial_started is cleared on conversion', async () => {
  const id = mkUser({ plan: 'pro', trialPlan: 'pro', trialStarted: nowSec() - 2 * DAY });
  await webhook('checkout.session.completed', { metadata: { user_id: id, plan_id: 'starter' }, subscription: 'sub_conv_' + id });
  const u = read(id);
  assert.equal(u.plan_id, 'starter');
  assert.equal(u.trial_started, null, 'a converted trial must stop looking like a trial');
  assert.equal(u.trial_expired_at, null, 'and it did not LAPSE, so no expiry stamp');
  assert.equal(subs.getUserPlan(id).trial_active, false);
});

/* ============ F03: the billed price, not the checkout metadata, decides the plan ============ */

test('F03: a portal downgrade (new price, stale metadata) reaches plan_id via the webhook', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'pro', subId });
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_starter_m', metaPlan: 'pro' }));
  assert.equal(read(id).plan_id, 'starter', 'they pay Starter, so they get Starter');
});

test('F03: a portal upgrade reaches plan_id via the webhook too', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'starter', subId });
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_pro_y', metaPlan: 'starter' }));
  assert.equal(read(id).plan_id, 'pro');
});

test('F03: metadata still answers for a price no plan row knows', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'free', subId });
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_custom_deal', metaPlan: 'pro' }));
  assert.equal(read(id).plan_id, 'pro');
});

test('F03: the reconcile corrects paid-to-paid drift from the billed price', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'pro', subId });
  // Status and period already match what we hold — the ONLY difference is the plan.
  const s = stripeSub({ id: subId, userId: id, price: 'price_starter_m', metaPlan: 'pro' });
  db.prepare('UPDATE users SET subscription_ends = ? WHERE id = ?').run(s.items.data[0].current_period_end, id);
  stripeSubs.set(subId, s);
  await dunning.reconcileFromStripe();
  assert.equal(read(id).plan_id, 'starter');
  stripeSubs.delete(subId);
});

/* ============ F13: a cancelled subscription comes back as 'canceled', not a 404 ============ */

for (const status of ['canceled', 'incomplete_expired']) {
  test(`F13: the reconcile moves a '${status}' subscription to Free, like a 404`, async () => {
    const subId = uid('sub');
    const id = mkUser({ plan: 'pro', subId });
    stripeSubs.set(subId, stripeSub({ id: subId, userId: id, price: 'price_pro_m', status }));
    await dunning.reconcileFromStripe();
    const u = read(id);
    assert.equal(u.plan_id, 'free', 'nothing bills it any more');
    assert.equal(u.subscription_status, 'cancelled');
    assert.equal(u.stripe_subscription_id, null, 'so /checkout offers a new subscription, not the portal');
    stripeSubs.delete(subId);
  });
}

test("F13: the reconcile starts the grace clock for an 'unpaid' subscription whose failure webhook was lost", async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'pro', subId });
  stripeSubs.set(subId, stripeSub({ id: subId, userId: id, price: 'price_pro_m', status: 'unpaid' }));
  await dunning.reconcileFromStripe();
  const u = read(id);
  assert.ok(u.past_due_since, 'the grace clock is running, so the normal downgrade path can act');
  assert.equal(u.subscription_status, 'unpaid', "Stripe's own status is what is left in the column");
  assert.equal(u.plan_id, 'pro', 'nothing taken away yet — that is what the grace is for');
  stripeSubs.delete(subId);
});

/* ============ F14: the lapse email names the right plan, and only after a real downgrade ============ */

test('F14: the lapse email names the plan they lapsed FROM, and an in-grace "unpaid" account gets none', async () => {
  const prev = process.env.HOSTED_INSTANCE;
  process.env.HOSTED_INSTANCE = 'true';
  sent = [];
  try {
    const lapsed = mkUser({ plan: 'pro', subId: uid('sub'), status: 'past_due', pastDueSince: nowSec() - 9 * DAY });
    // Stripe marked it unpaid on day 3 of OUR grace: still on Pro, not downgraded.
    const inGrace = mkUser({ plan: 'pro', subId: uid('sub'), status: 'unpaid', pastDueSince: nowSec() - 3 * DAY });

    await dunning.runDunningSweep({ io: null });

    assert.equal(read(lapsed).plan_id, 'free');
    const toLapsed = sent.filter((m) => m.to === `${lapsed}@t.local`);
    assert.equal(toLapsed.length, 1);
    assert.match(toLapsed[0].text, /ScreenTinker Pro plan did not go through/);
    assert.doesNotMatch(toLapsed[0].text, /ScreenTinker Free plan/, 'they were never on a Free plan that could fail to pay');

    assert.equal(read(inGrace).plan_id, 'pro');
    assert.equal(sent.filter((m) => m.to === `${inGrace}@t.local`).length, 0,
      'an account still on its paid plan has not "moved to Free"');
    assert.equal(read(inGrace).subscription_lapsed_email_sent_at, null,
      'and no stamp, so the real notice still goes out when the downgrade happens');
  } finally {
    if (prev === undefined) delete process.env.HOSTED_INSTANCE; else process.env.HOSTED_INSTANCE = prev;
  }
});

/* ============ F15: only the tracked subscription's deletion drops the account ============ */

test('F15: deleting a duplicate subscription leaves the account on the one still billing', async () => {
  const live = uid('sub_B');
  const id = mkUser({ plan: 'pro', subId: live });
  await webhook('customer.subscription.deleted', stripeSub({ id: uid('sub_A'), userId: id, price: 'price_pro_m', status: 'canceled' }));
  const u = read(id);
  assert.equal(u.plan_id, 'pro');
  assert.equal(u.stripe_subscription_id, live, 'the reconcile can still find the live subscription');
});

test('F15: deleting the tracked subscription (or one we never stored) still drops to Free', async () => {
  const subId = uid('sub');
  const tracked = mkUser({ plan: 'pro', subId });
  await webhook('customer.subscription.deleted', stripeSub({ id: subId, userId: tracked, price: 'price_pro_m', status: 'canceled' }));
  assert.equal(read(tracked).plan_id, 'free');
  assert.equal(read(tracked).stripe_subscription_id, null);

  const untracked = mkUser({ plan: 'pro', subId: null });   // checkout webhook lost
  await webhook('customer.subscription.deleted', stripeSub({ id: uid('sub'), userId: untracked, price: 'price_pro_m', status: 'canceled' }));
  assert.equal(read(untracked).plan_id, 'free');
});

/* ============ F25: an admin-assigned plan survives the trial and dunning sweeps ============ */

const assign = (user_id, plan_id) => fetch(`${base}/api/subscription/assign`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id, plan_id }),
});

test('F25: comping a trialing user their trial plan is not reverted when the trial clock runs out', async () => {
  // The trial clock has already passed 14 days; nobody has read the plan since, so it is not expired yet.
  const id = mkUser({ plan: 'pro', trialPlan: 'pro', trialStarted: nowSec() - 15 * DAY });
  assert.equal((await assign(id, 'pro')).status, 200);
  assert.equal(subs.getUserPlan(id).plan_name, 'pro', 'the lazy expiry must not take a hand-granted plan');
  assert.ok(!subs.findExpiredTrialUserIds().includes(id), 'nor the nightly sweep');
});

test('F25: a hand-assigned plan on a past-due account is not downgraded by the dunning sweep', async () => {
  const id = mkUser({ plan: 'starter', subId: uid('sub'), status: 'past_due', pastDueSince: nowSec() - 9 * DAY });
  db.prepare('UPDATE users SET payment_failed_email_sent_at = 1 WHERE id = ?').run(id);
  assert.equal((await assign(id, 'pro')).status, 200);
  assert.ok(!subs.findLapsedSubscriberIds().includes(id));
  assert.equal(subs.downgradeLapsed(id), false);
  const u = read(id);
  assert.equal(u.plan_id, 'pro');
  assert.equal(u.past_due_since, null);
  assert.equal(u.payment_failed_email_sent_at, null, 'a genuine future failure is announced again');
});

/* ============ Comps: a hand-granted plan is changed only by an admin or the customer's own checkout ============ */

test('comp: the nightly reconcile does not "correct" a comped plan back to the billed price', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'starter', subId });                 // pays Starter...
  assert.equal((await assign(id, 'pro')).status, 200);           // ...comped Pro
  const s = stripeSub({ id: subId, userId: id, price: 'price_starter_m' });
  db.prepare('UPDATE users SET subscription_ends = ? WHERE id = ?').run(s.items.data[0].current_period_end, id);
  stripeSubs.set(subId, s);
  await dunning.reconcileFromStripe();
  assert.equal(read(id).plan_id, 'pro');
  stripeSubs.delete(subId);
});

test('comp: the subscription webhook keeps the comped plan but still records Stripe\'s status', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'starter', subId });
  await assign(id, 'pro');
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_starter_m', status: 'past_due' }));
  const u = read(id);
  assert.equal(u.plan_id, 'pro');
  assert.equal(u.subscription_status, 'past_due', 'what Stripe says is still recorded truthfully');
});

test('comp: cancelling the Stripe subscription (webhook, or found terminal by the reconcile) keeps the comp', async () => {
  const a = uid('sub');
  const viaWebhook = mkUser({ plan: 'starter', subId: a });
  await assign(viaWebhook, 'pro');
  await webhook('customer.subscription.deleted', stripeSub({ id: a, userId: viaWebhook, price: 'price_starter_m', status: 'canceled' }));
  assert.equal(read(viaWebhook).plan_id, 'pro');
  assert.equal(read(viaWebhook).stripe_subscription_id, null);

  const b = uid('sub');
  const viaReconcile = mkUser({ plan: 'starter', subId: b });
  await assign(viaReconcile, 'pro');
  stripeSubs.set(b, stripeSub({ id: b, userId: viaReconcile, price: 'price_starter_m', status: 'canceled' }));
  await dunning.reconcileFromStripe();
  assert.equal(read(viaReconcile).plan_id, 'pro');
  stripeSubs.delete(b);
});

test('comp: the customer\'s own completed checkout ends the comp; assigning Free never sets one', async () => {
  const id = mkUser({ plan: 'starter' });
  await assign(id, 'pro');
  assert.equal(read(id).plan_comped, 1);
  await webhook('checkout.session.completed', {
    id: uid('cs'), mode: 'subscription', subscription: uid('sub'), customer: `cus_${id}`,
    metadata: { user_id: id, plan_id: 'starter' }, payment_status: 'paid',
  });
  const u = read(id);
  assert.equal(u.plan_id, 'starter', 'they chose and paid for a plan themselves');
  assert.equal(u.plan_comped, 0);

  const free = mkUser({ plan: 'pro' });
  await assign(free, 'free');
  assert.equal(read(free).plan_comped, 0);
});
