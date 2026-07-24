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

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// --- stub the Stripe SDK: capture checkout.sessions.create params ---
let capturedCheckout = null;
const fakeStripeFactory = () => ({
  customers: { create: async () => ({ id: 'cus_test' }) },
  checkout: { sessions: { create: async (params) => { capturedCheckout = params; return { url: 'https://stripe.test/checkout' }; } } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/portal' }) } },
});
const stripePath = require.resolve('stripe');
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: fakeStripeFactory };

// --- stub requireAuth so the route runs with a fixed user (no JWT plumbing needed) ---
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    requireAuth: (req, _res, next) => {
      req.user = { id: 'u-test', email: 'u@test.local', name: 'Test',
                   stripe_customer_id: 'cus_test', stripe_subscription_id: null };
      next();
    },
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
