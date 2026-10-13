'use strict';

/*
 * One Stripe client for code outside routes/stripe.js (promotions create and delete coupons).
 * null when STRIPE_SECRET_KEY is unset — self-hosted instances have no billing. Tests substitute a
 * double with __setForTests.
 */
const config = require('../config');

/*
 * ⚠️ Pinned on purpose. Unpinned, every request uses whatever version the installed SDK defaults
 * to, so a Dependabot bump silently changes the API (stripe 23 moved to 2026-09-30.endive, which
 * rejects the payment_method_types our checkouts send). Move this deliberately, with a test-mode
 * checkout, never as a side effect of an SDK update. Every client in the server is built with it.
 */
const STRIPE_API_VERSION = '2026-02-25.clover';

let client;
let override;

function create(secretKey) {
  return require('stripe')(secretKey, { apiVersion: STRIPE_API_VERSION });
}

function get() {
  if (override !== undefined) return override;
  if (client === undefined) client = config.stripeSecretKey ? create(config.stripeSecretKey) : null;
  return client;
}

function __setForTests(c) { override = c; }

module.exports = { get, create, STRIPE_API_VERSION, __setForTests };
