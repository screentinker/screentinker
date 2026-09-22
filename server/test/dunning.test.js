'use strict';

/*
 * Dunning: a paying customer whose payment failed.
 *
 * The faults these pin are all ones that failed SILENTLY on the live instance — a status column
 * nothing read, an invoice field Stripe moved so the handler matched no account at all, and a
 * grace clock that has to survive Stripe's retries to mean anything. Each assertion below is one
 * of those, not a restatement of the implementation.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-dunning-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
process.env.SELF_HOSTED = '';             // hosted shape: the sweep is enabled
process.env.BILLING_GRACE_DAYS = '7';     // read at module load by middleware/subscription

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { db } = require('../db/database');
const subs = require('../middleware/subscription');
const { subscriptionIdOf, periodEndOf } = require('../lib/stripe-fields');

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

let n = 0;
function makeSubscriber({ plan = 'pro', pastDueSince = null, status = 'active' } = {}) {
  const id = `u-dun-${++n}`;
  db.prepare(`INSERT OR REPLACE INTO users
    (id, email, password_hash, role, plan_id, subscription_status, past_due_since, stripe_subscription_id, stripe_customer_id)
    VALUES (?, ?, 'x', 'user', ?, ?, ?, ?, ?)`)
    .run(id, `${id}@test.local`, plan, status, pastDueSince, `sub_${id}`, `cus_${id}`);
  return id;
}
const read = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

/* ------------------------------ the grace clock ------------------------------ */

test('the grace clock starts once and survives Stripe retrying the same card', () => {
  const id = makeSubscriber();
  const first = nowSec() - 3 * DAY;
  assert.equal(subs.startGrace(id, first), true, 'the first failure starts it');
  assert.equal(read(id).past_due_since, first);
  assert.equal(read(id).subscription_status, 'past_due');

  // Stripe retries a failing invoice several times per episode. Each retry must NOT restart the
  // clock, or the 7 days can never elapse and the account never lapses.
  assert.equal(subs.startGrace(id, nowSec()), false, 'a retry does not re-stamp');
  assert.equal(read(id).past_due_since, first, 'still measured from the original failure');
});

test('a payment landing clears the episode, including the email stamps', () => {
  const id = makeSubscriber({ pastDueSince: nowSec() - 2 * DAY, status: 'past_due' });
  db.prepare('UPDATE users SET payment_failed_email_sent_at = 123, subscription_lapsed_email_sent_at = 456 WHERE id = ?').run(id);

  assert.equal(subs.clearGrace(id), true);
  const u = read(id);
  assert.equal(u.past_due_since, null);
  assert.equal(u.subscription_status, 'active');
  // ⚠️ The stamps go too. A customer who lapses, pays, and lapses again next year must be told
  // again — a surviving stamp would suppress that email for ever.
  assert.equal(u.payment_failed_email_sent_at, null);
  assert.equal(u.subscription_lapsed_email_sent_at, null);
  assert.equal(subs.clearGrace(id), false, 'clearing a clear account changes nothing');
});

/* ------------------------------ the downgrade ------------------------------ */

test('nothing is taken away during the grace window', () => {
  const id = makeSubscriber({ pastDueSince: nowSec() - 6 * DAY, status: 'past_due' });
  assert.ok(!subs.findLapsedSubscriberIds().includes(id), 'day 6 is still grace');
  assert.equal(subs.downgradeLapsed(id), false, 'and the downgrade refuses even if called directly');
  assert.equal(read(id).plan_id, 'pro', 'still on the paid plan');
});

test('after the grace window the account falls to Free — and keeps its subscription id', () => {
  const id = makeSubscriber({ pastDueSince: nowSec() - 8 * DAY, status: 'past_due' });
  assert.ok(subs.findLapsedSubscriberIds().includes(id));
  assert.equal(subs.downgradeLapsed(id), true);

  const u = read(id);
  assert.equal(u.plan_id, 'free');
  assert.equal(u.subscription_status, 'unpaid');
  /*
   * ⚠️ The subscription id STAYS. It is how the reconcile finds this account again the moment the
   * customer fixes their card; clearing it here would orphan a subscription that still exists in
   * Stripe and make the recovery path unreachable.
   */
  assert.equal(u.stripe_subscription_id, `sub_${id}`);
  assert.equal(u.past_due_since !== null, true, 'the episode is still open until a payment lands');

  assert.equal(subs.downgradeLapsed(id), false, 'a second pass is a no-op (already Free)');
});

test('an account that never failed is never swept, however old', () => {
  const healthy = makeSubscriber();                       // past_due_since NULL
  assert.ok(!subs.findLapsedSubscriberIds().includes(healthy));
  assert.equal(subs.downgradeLapsed(healthy), false);
  assert.equal(read(healthy).plan_id, 'pro');
});

/* ------------------------------ the fields Stripe moved ------------------------------ */

test('the invoice -> subscription link is read in both shapes', () => {
  // The shape this instance actually receives today. `invoice.subscription` is gone, and reading
  // only it meant invoice.payment_failed matched no account and did nothing at all.
  assert.equal(subscriptionIdOf({ parent: { subscription_details: { subscription: 'sub_new' } } }), 'sub_new');
  // The older shape, still delivered by an endpoint pinned to an earlier API version.
  assert.equal(subscriptionIdOf({ subscription: 'sub_old' }), 'sub_old');
  // Expanded to an object rather than an id.
  assert.equal(subscriptionIdOf({ subscription: { id: 'sub_expanded' } }), 'sub_expanded');
  // A one-off invoice genuinely has no subscription — null, not undefined, so a caller storing it
  // writes an honest unknown.
  assert.equal(subscriptionIdOf({ customer: 'cus_x' }), null);
  assert.equal(subscriptionIdOf(null), null);
});

test('the period end is read in both shapes', () => {
  assert.equal(periodEndOf({ items: { data: [{ current_period_end: 1792658673 }] } }), 1792658673);
  assert.equal(periodEndOf({ current_period_end: 1700000000 }), 1700000000);
  assert.equal(periodEndOf({ items: { data: [{}] } }), null);
  assert.equal(periodEndOf(null), null);
});

/* ------------------------------ the sweep ------------------------------ */

test('the sweep downgrades the lapsed and leaves everyone else alone', async () => {
  const lapsed = makeSubscriber({ pastDueSince: nowSec() - 9 * DAY, status: 'past_due' });
  const inGrace = makeSubscriber({ pastDueSince: nowSec() - 2 * DAY, status: 'past_due' });
  const healthy = makeSubscriber();

  // No Stripe key in this process, so the reconcile step reports not_configured and the sweep
  // carries on — the downgrade must not depend on being able to reach Stripe.
  const { runDunningSweep } = require('../services/dunning');
  const out = await runDunningSweep({ io: null });

  assert.ok(out, 'the sweep ran (SELF_HOSTED is unset)');
  assert.equal(read(lapsed).plan_id, 'free');
  assert.equal(read(inGrace).plan_id, 'pro', 'still inside the window');
  assert.equal(read(healthy).plan_id, 'pro');
  assert.ok(out.downgraded >= 1);
  assert.equal(out.emailsSkipped, true, 'HOSTED_INSTANCE is unset, so no mail is sent');
});

test('a self-hosted instance runs none of this', async () => {
  const prev = process.env.SELF_HOSTED;
  process.env.SELF_HOSTED = 'true';
  try {
    // config caches, so re-require through a fresh module registry entry for the check it makes.
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/dunning')];
    const fresh = require('../services/dunning');
    assert.equal(await fresh.runDunningSweep({ io: null }), null, 'disabled entirely — a self-host never bills');
  } finally {
    process.env.SELF_HOSTED = prev;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/dunning')];
  }
});

/* ------------------------------ recovery: the half that was missing ------------------------------ */

test('a customer who fixes their card gets their PLAN back, not just an active status', () => {
  /*
   * The downgrade sets plan_id='free'. Recovery therefore has to put the plan BACK — clearing the
   * grace and writing subscription_status='active' leaves a paying customer sitting on Free
   * limits, which is the same outcome as not having paid.
   */
  const id = makeSubscriber({ pastDueSince: nowSec() - 9 * DAY, status: 'past_due' });
  assert.equal(subs.downgradeLapsed(id), true);
  assert.equal(read(id).plan_id, 'free');

  // The card is fixed. Whatever tells us — a webhook or the reconcile — the plan must return.
  const { restorePlan } = require('../middleware/subscription');
  assert.equal(restorePlan(id, 'pro'), true);
  const u = read(id);
  assert.equal(u.plan_id, 'pro', 'back on the plan they pay for');
  assert.equal(u.subscription_status, 'active');
  assert.equal(u.past_due_since, null, 'and the episode is closed');
});

test('restorePlan refuses a plan that does not exist rather than writing a dead id', () => {
  const id = makeSubscriber({ pastDueSince: nowSec() - 9 * DAY, status: 'past_due' });
  subs.downgradeLapsed(id);
  const { restorePlan } = require('../middleware/subscription');
  assert.equal(restorePlan(id, 'no_such_plan'), false);
  assert.equal(read(id).plan_id, 'free', 'unchanged — a dead plan_id has no entitlements at all');
});

test('the invoice line price is read in both shapes (the fourth field Stripe moved)', () => {
  const { invoicePriceIdOf } = require('../lib/stripe-fields');
  // What this account actually delivers today.
  assert.equal(invoicePriceIdOf({ lines: { data: [{ pricing: { price_details: { price: 'price_new' } } }] } }), 'price_new');
  // Older shapes, expanded and not.
  assert.equal(invoicePriceIdOf({ lines: { data: [{ price: { id: 'price_obj' } }] } }), 'price_obj');
  assert.equal(invoicePriceIdOf({ lines: { data: [{ price: 'price_str' }] } }), 'price_str');
  assert.equal(invoicePriceIdOf({ lines: { data: [] } }), null);
  assert.equal(invoicePriceIdOf(null), null);
});
