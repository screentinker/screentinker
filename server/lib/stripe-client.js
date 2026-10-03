'use strict';

/*
 * One Stripe client for code outside routes/stripe.js (promotions create and delete coupons).
 * null when STRIPE_SECRET_KEY is unset — self-hosted instances have no billing. Tests substitute a
 * double with __setForTests.
 */
const config = require('../config');

let client;
let override;

function get() {
  if (override !== undefined) return override;
  if (client === undefined) client = config.stripeSecretKey ? require('stripe')(config.stripeSecretKey) : null;
  return client;
}

function __setForTests(c) { override = c; }

module.exports = { get, __setForTests };
