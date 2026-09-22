'use strict';

// Stripe checkout session shape. There was no pre-existing Stripe-SDK test/mock in the repo
// (the billing-*.test.js files cover the #146 usage-metering path, not Stripe), so this uses
// the repo's in-process router-mount convention with a minimal `stripe` stub injected via
// require.cache — capturing the exact params passed to checkout.sessions.create.
//
// Guards that the hosted-checkout promo-code field stays enabled: allow_promotion_codes:true
// is the ONLY way to render it for API-created sessions (no dashboard equivalent), so a
// silent removal would quietly break promotion codes with no other signal.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-stripe-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'; // makes routes/stripe build the (stubbed) client
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy'; // the webhook route refuses to run without one

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// --- stub the Stripe SDK: capture checkout.sessions.create params ---
let capturedCheckout = null;
let capturedPortal = null;
let testUser = { id: 'u-test', email: 'u@test.local', name: 'Test',
                 stripe_customer_id: 'cus_test', stripe_subscription_id: null };
const fakeStripeFactory = () => ({
  customers: { create: async () => ({ id: 'cus_test' }) },
  checkout: { sessions: { create: async (params) => { capturedCheckout = params; return { url: 'https://stripe.test/checkout' }; } } },
  billingPortal: { sessions: { create: async (params) => { capturedPortal = params; return { url: 'https://stripe.test/portal' }; } } },
  // Signature verification is Stripe's, not ours — hand the handler the event it would have built.
  webhooks: { constructEvent: (body) => (Buffer.isBuffer(body) || typeof body === 'string' ? JSON.parse(body) : body) },
});
const stripePath = require.resolve('stripe');
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: fakeStripeFactory };

// --- stub requireAuth so the route runs with a fixed user (no JWT plumbing needed) ---
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    // ⚠️ routes/stripe.js destructures requireAuth at require time, so a test cannot swap this
    // function later — it closes over `testUser`, which a test mutates instead.
    requireAuth: (req, _res, next) => { req.user = { ...testUser }; next(); },
  },
};

const { db } = require('../db/database');
// A plan with a Stripe price so the handler reaches checkout.sessions.create.
db.prepare(`INSERT OR REPLACE INTO plans (id, name, display_name, stripe_price_monthly, stripe_price_yearly)
            VALUES ('promo_test', 'promo_test', 'Promo', 'price_test_m', 'price_test_y')`).run();

const stripeRouter = require('../routes/stripe');

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('POST /checkout passes allow_promotion_codes:true to Stripe', async () => {
  capturedCheckout = null;
  const res = await fetch(`${base}/api/stripe/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: 'promo_test', interval: 'monthly' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.type, 'checkout', 'took the checkout branch, not the portal branch');

  assert.ok(capturedCheckout, 'checkout.sessions.create was called');
  assert.equal(capturedCheckout.allow_promotion_codes, true,
    'allow_promotion_codes:true must be present so the promo-code field renders on hosted checkout');
  // sanity: it is still a subscription checkout for the requested price
  assert.equal(capturedCheckout.mode, 'subscription');
  assert.equal(capturedCheckout.line_items[0].price, 'price_test_m');
});

/*
 * Where Stripe sends a paying customer back. Every assertion here is a bug that actually shipped:
 * the URL had no `/app`, so `/` served the marketing page and the hash was ignored; it pointed at
 * `#/settings`, which never reads `payment=success`; and the query inside the hash only survives
 * because the router matches that route by prefix.
 */
test('checkout returns the customer to the dashboard billing view, not the marketing homepage', async () => {
  capturedCheckout = null;
  const res = await fetch(`${base}/api/stripe/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://signage.example.com' },
    body: JSON.stringify({ plan_id: 'promo_test', interval: 'monthly' }),
  });
  assert.equal(res.status, 200);

  for (const [label, url] of [['success_url', capturedCheckout.success_url], ['cancel_url', capturedCheckout.cancel_url]]) {
    assert.ok(url.startsWith('https://signage.example.com/app#/billing'),
      `${label} must land on the dashboard's billing view on the CALLER's origin, got: ${url}`);
    assert.doesNotMatch(url, /^https:\/\/[^/]+\/#/,
      `${label} must not drop the customer at / — that is the marketing page, which ignores the hash`);
  }
  assert.match(capturedCheckout.success_url, /#\/billing\?payment=success$/);
  assert.match(capturedCheckout.cancel_url, /#\/billing\?payment=cancelled$/);
});

test('the SPA routes the returned URL to billing rather than the default view', () => {
  // The query rides INSIDE the hash, so an exact-equality match would drop it on the floor.
  const appJs = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'frontend', 'js', 'app.js'), 'utf8');
  assert.match(appJs, /\} else if \(hash\.startsWith\('#\/billing'\)\) \{/,
    "#/billing must match by prefix or `#/billing?payment=success` falls through to the dashboard");
  const billingJs = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'frontend', 'js', 'views', 'billing.js'), 'utf8');
  assert.match(billingJs, /payment=success/,
    'the view we redirect to is the one that reads the flag');
});

test('the billing portal returns to the same place', async () => {
  capturedPortal = null;
  const prev = testUser;
  testUser = { ...prev, stripe_subscription_id: 'sub_existing' };  // an existing subscriber
  try {
    const res = await fetch(`${base}/api/stripe/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://signage.example.com' },
      body: JSON.stringify({ plan_id: 'promo_test', interval: 'monthly' }),
    });
    const body = await res.json();
    assert.equal(body.type, 'portal', 'an existing subscriber is sent to the portal');
    assert.equal(capturedPortal.return_url, 'https://signage.example.com/app#/billing');
  } finally {
    testUser = prev;
  }
});

test('a trailing slash on the base never produces the unroutable //app', async () => {
  // `APP_URL=https://host/` built `https://host//app#/...`, and Express does not serve `//app` —
  // the customer would land on a 404 instead of the dashboard, which is the same class of failure
  // this whole change exists to remove. Sent as an Origin because `appUrl` is bound at module load
  // and cannot be varied from a test; both values go through the same normalisation.
  capturedCheckout = null;
  const res = await fetch(`${base}/api/stripe/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://configured.example.com/' },
    body: JSON.stringify({ plan_id: 'promo_test', interval: 'monthly' }),
  });
  assert.equal(res.status, 200);
  const u = new URL(capturedCheckout.success_url);
  assert.equal(u.pathname, '/app', `got ${u.pathname} — a doubled slash is not routed`);
  assert.equal(u.hash, '#/billing?payment=success');
});

test('with no Origin and no APP_URL the URL is still ABSOLUTE, because Stripe refuses a relative one', async () => {
  // APP_URL is unset in this test process, so this exercises the last-resort branch. Before it
  // existed the value was `/app#/billing?...`, which Stripe rejects outright — a 500 at checkout
  // rather than a wrong landing page.
  capturedCheckout = null;
  const res = await fetch(`${base}/api/stripe/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: 'promo_test', interval: 'monthly' }),
  });
  assert.equal(res.status, 200);
  assert.equal(process.env.APP_URL, undefined, 'the fallback under test is the request-derived one');
  const u = new URL(capturedCheckout.success_url);   // throws if relative
  assert.match(u.protocol, /^https?:$/);
  assert.equal(u.pathname, '/app');
});

/*
 * The webhook side. Both live subscribers had subscription_ends NULL, for two reasons that each
 * fail silently: a subscription that is created and then simply runs emits `created`, never
 * `updated`; and `current_period_end` moved from the subscription to the ITEM in Stripe's
 * 2025-03+ API, so reading only the subscription level wrote NULL without erroring.
 */
const WEBHOOK_USER = 'u-webhook-test';
db.prepare(`INSERT OR REPLACE INTO users (id, email, password_hash, role, plan_id)
            VALUES (?, 'webhook@test.local', 'x', 'user', 'free')`).run(WEBHOOK_USER);

async function postWebhook(event) {
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig_test' },
    body: JSON.stringify(event),
  });
}
const subEvent = (type, extra) => ({
  type,
  data: { object: { id: 'sub_test', status: 'active', metadata: { user_id: WEBHOOK_USER, plan_id: 'promo_test' }, ...extra } },
});

test('customer.subscription.created is handled, not only .updated', async () => {
  db.prepare('UPDATE users SET subscription_ends = NULL, plan_id = ? WHERE id = ?').run('free', WEBHOOK_USER);
  const res = await postWebhook(subEvent('customer.subscription.created', {
    items: { data: [{ current_period_end: 1792658673, price: { id: 'price_test_m' } }] },
  }));
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT plan_id, subscription_status, subscription_ends FROM users WHERE id = ?').get(WEBHOOK_USER);
  assert.equal(row.subscription_ends, 1792658673, 'a created subscription must record when the period ends');
  assert.equal(row.subscription_status, 'active');
});

test('current_period_end is read from the item when the subscription level does not carry it', async () => {
  // Stripe 2025-03+ shape: nothing at the subscription level at all.
  db.prepare('UPDATE users SET subscription_ends = NULL WHERE id = ?').run(WEBHOOK_USER);
  await postWebhook(subEvent('customer.subscription.updated', {
    items: { data: [{ current_period_end: 1819216882, price: { id: 'price_test_m' } }] },
  }));
  assert.equal(db.prepare('SELECT subscription_ends FROM users WHERE id = ?').get(WEBHOOK_USER).subscription_ends,
    1819216882, 'item-level period end must be picked up');

  // Older shape, still delivered by an endpoint pinned to an earlier API version.
  db.prepare('UPDATE users SET subscription_ends = NULL WHERE id = ?').run(WEBHOOK_USER);
  await postWebhook(subEvent('customer.subscription.updated', {
    current_period_end: 1700000000,
    items: { data: [{ price: { id: 'price_test_m' } }] },
  }));
  assert.equal(db.prepare('SELECT subscription_ends FROM users WHERE id = ?').get(WEBHOOK_USER).subscription_ends,
    1700000000, 'subscription-level period end must still work');
});
