'use strict';

// Trial-expiry guard in getUserPlan() (middleware/subscription.js). There was NO test on this
// path before — which is exactly how the bug shipped: the auto-downgrade was guarded on
// `subscription_status !== 'active'`, but that column DEFAULTs to 'active' and only Stripe
// webhooks change it, so for trial users (who never touch Stripe) it was always false and the
// downgrade never fired → Pro-for-free forever.
//
// In-process (billing-unit.test.js convention): seed a user, call getUserPlan directly, assert
// both the returned plan and the DB side-effect (plan_id / trial_started).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-trial-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { getUserPlan } = require('../middleware/subscription');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const uid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');

function mkUser({ plan_id = 'pro', trial_plan = 'pro', trial_started = null, stripe_sub = null, subscription_status = 'active' }) {
  const id = uid('u');
  db.prepare(`INSERT INTO users (id, email, plan_id, trial_plan, trial_started, stripe_subscription_id, subscription_status)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id + '@t.local', plan_id, trial_plan, trial_started, stripe_sub, subscription_status);
  return id;
}
const rowOf = (id) => db.prepare('SELECT plan_id, trial_started FROM users WHERE id = ?').get(id);

before(() => {
  // 'home' is a prod-only plan (not in the schema seed); add it so the grandfathered case joins.
  db.prepare("INSERT OR IGNORE INTO plans (id, name, display_name, max_devices) VALUES ('home', 'home', 'Home', 2)").run();
});

test('lapsed pro trial, no sub, plan_id=trial_plan -> downgraded to free', () => {
  const id = mkUser({ plan_id: 'pro', trial_plan: 'pro', trial_started: now() - 15 * DAY });
  const plan = getUserPlan(id);
  assert.equal(plan.plan_name, 'free', 'resolver returns the free plan');
  assert.equal(rowOf(id).plan_id, 'free', 'persisted as free');
  assert.equal(rowOf(id).trial_started, null, 'trial_started cleared');
});

test('comped enterprise (plan_id != trial_plan), no sub -> NOT downgraded', () => {
  // enterprise granted by hand: plan_id='enterprise' but the trial had granted 'pro'.
  // The plan_id===trial_plan clause must protect it.
  const id = mkUser({ plan_id: 'enterprise', trial_plan: 'pro', trial_started: now() - 15 * DAY });
  getUserPlan(id);
  assert.equal(rowOf(id).plan_id, 'enterprise', 'comped plan not silently downgraded');
});

test('grandfathered home user (trial_started NULL) -> NOT downgraded', () => {
  const id = mkUser({ plan_id: 'home', trial_plan: 'pro', trial_started: null });
  const plan = getUserPlan(id);
  assert.equal(plan.plan_id, 'home');
  assert.equal(rowOf(id).plan_id, 'home', 'grandfathered account untouched');
});

test('paid user (stripe_subscription_id present) -> NOT downgraded', () => {
  const id = mkUser({ plan_id: 'pro', trial_plan: 'pro', trial_started: now() - 15 * DAY, stripe_sub: 'sub_123' });
  getUserPlan(id);
  assert.equal(rowOf(id).plan_id, 'pro', 'paying customer untouched');
});

test('trial still within window -> NOT downgraded', () => {
  const id = mkUser({ plan_id: 'pro', trial_plan: 'pro', trial_started: now() - 3 * DAY });
  const plan = getUserPlan(id);
  assert.equal(plan.trial_active, true);
  assert.equal(rowOf(id).plan_id, 'pro');
});

// Regression pinning the exact bug: subscription_status='active' (the column default) must NOT
// shield a lapsed free-tier trial from downgrade. This is the assertion the old guard failed.
test('subscription_status=active default does NOT block downgrade of a lapsed trial', () => {
  const id = mkUser({ plan_id: 'pro', trial_plan: 'pro', trial_started: now() - 20 * DAY, subscription_status: 'active' });
  getUserPlan(id);
  assert.equal(rowOf(id).plan_id, 'free', 'the default active status no longer protects a lapsed trial');
});
