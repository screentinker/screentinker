'use strict';

/*
 * WHICH SUBSCRIPTION EVENTS MAY CHANGE AN ACCOUNT.
 *
 * Stripe creates the subscription object before the first payment is settled. If that payment is
 * never completed (a card that needs confirming and is abandoned, a declined card), the object
 * exists as `incomplete`, becomes `incomplete_expired` a day later, and no deletion event follows.
 * The created/updated handler used to copy the plan from the price for ANY status, so an abandoned
 * checkout upgraded the account, and a second, abandoned checkout on a paying account overwrote
 * that account's good standing with `incomplete`.
 *
 * The invariant:
 *   - a plan is granted only by a subscription Stripe is honouring (active, trialing, past_due);
 *   - any other status changes an account only when it is the subscription that account tracks,
 *     and then it records the status without touching the plan;
 *   - everything that worked before still works: an active subscription whose webhook beats the
 *     checkout event, a portal price change, a tracked subscription going past due or unpaid.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sub-status-' + crypto.randomBytes(4).toString('hex'));
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

function mkUser({ plan = 'free', subId = null, status = 'active', ends = null } = {}) {
  const id = uid('u');
  db.prepare(`INSERT INTO users (id, email, name, password_hash, role, plan_id, stripe_subscription_id, stripe_customer_id,
                                 subscription_status, subscription_ends, email_alerts, email_verified)
              VALUES (?, ?, 'Test', 'x', 'user', ?, ?, ?, ?, ?, 1, 1)`)
    .run(id, `${id}@t.local`, plan, subId, `cus_${id}`, status, ends);
  return id;
}
const stripeSub = ({ id, userId, price, status }) => ({
  id, status, metadata: { user_id: userId },
  items: { data: [{ price: { id: price }, current_period_end: nowSec() + 30 * DAY }] },
});

let server, base;
before(async () => {
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_starter_m', stripe_price_yearly = 'price_starter_y' WHERE id = 'starter'").run();
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_pro_m', stripe_price_yearly = 'price_pro_y' WHERE id = 'pro'").run();
  emailSvc.sendEmail = async () => ({ sent: true });
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

const webhook = (type, object) => fetch(`${base}/api/stripe/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type, data: { object } }),
}).then((r) => r.json());

for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'canceled', 'paused']) {
  test(`a subscription that is ${status} never grants a plan`, async () => {
    const id = mkUser({ plan: 'free' });
    for (const type of ['customer.subscription.created', 'customer.subscription.updated']) {
      await webhook(type, stripeSub({ id: uid('sub'), userId: id, price: 'price_pro_m', status }));
    }
    assert.equal(read(id).plan_id, 'free', `a subscription that is ${status} is not being paid for`);
  });

  test(`a subscription that is ${status} changes nothing on an account that tracks a different one`, async () => {
    const tracked = uid('sub'), ends = nowSec() + 20 * DAY;
    const id = mkUser({ plan: 'pro', subId: tracked, status: 'active', ends });
    await webhook('customer.subscription.updated', stripeSub({ id: uid('sub'), userId: id, price: 'price_starter_m', status }));
    const u = read(id);
    assert.equal(u.plan_id, 'pro');
    assert.equal(u.subscription_status, 'active');
    assert.equal(u.subscription_ends, ends);
  });
}

test('a never-paid subscription leaves an account with nothing tracked exactly as it was', async () => {
  const id = mkUser({ plan: 'free' });
  const was = read(id);
  await webhook('customer.subscription.created', stripeSub({ id: uid('sub'), userId: id, price: 'price_pro_m', status: 'incomplete' }));
  await webhook('customer.subscription.updated', stripeSub({ id: uid('sub'), userId: id, price: 'price_pro_m', status: 'incomplete_expired' }));
  const u = read(id);
  assert.equal(u.subscription_status, was.subscription_status);
  assert.equal(u.subscription_ends, was.subscription_ends);
});

test('an abandoned second checkout does not disturb a paying account', async () => {
  const tracked = uid('sub'), ends = nowSec() + 20 * DAY;
  const id = mkUser({ plan: 'pro', subId: tracked, status: 'active', ends });
  await webhook('customer.subscription.created', stripeSub({ id: uid('sub'), userId: id, price: 'price_starter_m', status: 'incomplete' }));
  await webhook('customer.subscription.updated', stripeSub({ id: uid('sub'), userId: id, price: 'price_starter_m', status: 'incomplete_expired' }));
  const u = read(id);
  assert.equal(u.plan_id, 'pro', 'still on the plan they pay for');
  assert.equal(u.subscription_status, 'active', 'still in good standing');
  assert.equal(u.subscription_ends, ends, 'with the period end of the subscription that is billing them');
  assert.equal(u.stripe_subscription_id, tracked);
});

/* ---- everything below already worked and has to keep working ---- */

test('an active subscription still grants its plan when its webhook beats the checkout event', async () => {
  const id = mkUser({ plan: 'free' });               // nothing tracked yet
  await webhook('customer.subscription.created', stripeSub({ id: uid('sub'), userId: id, price: 'price_pro_m', status: 'active' }));
  const u = read(id);
  assert.equal(u.plan_id, 'pro');
  assert.equal(u.subscription_status, 'active');
  assert.ok(u.subscription_ends > nowSec(), 'and the period end is recorded');
});

test('a trialing subscription grants its plan too', async () => {
  const id = mkUser({ plan: 'free' });
  await webhook('customer.subscription.created', stripeSub({ id: uid('sub'), userId: id, price: 'price_starter_m', status: 'trialing' }));
  assert.equal(read(id).plan_id, 'starter');
});

test('the tracked subscription going past due keeps the plan and records the status', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'pro', subId });
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_pro_m', status: 'past_due' }));
  const u = read(id);
  assert.equal(u.plan_id, 'pro');
  assert.equal(u.subscription_status, 'past_due');
});

test('the tracked subscription going unpaid records the status and leaves the plan to the dunning path', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'pro', subId });
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_pro_m', status: 'unpaid' }));
  const u = read(id);
  assert.equal(u.subscription_status, 'unpaid');
  assert.equal(u.plan_id, 'pro', 'the webhook itself never downgraded here; middleware/subscription.js does, on its own clock');
});

test('a portal price change on an active subscription still reaches the plan', async () => {
  const subId = uid('sub');
  const id = mkUser({ plan: 'pro', subId });
  await webhook('customer.subscription.updated', stripeSub({ id: subId, userId: id, price: 'price_starter_m', status: 'active' }));
  assert.equal(read(id).plan_id, 'starter');
});
