const { db } = require('../db/database');
const config = require('../config');

const TRIAL_DAYS = 14;

// The ONE way a lapsed trial becomes Free. Used by the lazy path below (getUserPlan) and by the
// nightly sweep (services/trialExpiry.js) so the two can never disagree on what "expired" writes.
//
// Sets plan_id='free', clears trial_started (so a later hand-granted plan is never re-downgraded
// — see the comment in getUserPlan) and stamps trial_expired_at with the moment the trial
// actually ended (trial_started + TRIAL_DAYS), NOT "now": the sweep may run days after the fact
// and the expiry email + the player's "Trial Expired" card both key on this column.
//
// Guarded by the same predicate as getUserPlan so a stray call on a paying / comped / active
// account is a no-op. Returns true when a row was flipped.
// Prepared lazily: some test fixtures build a minimal users table without the trial columns and
// require this module before any migration runs; a module-load prepare would throw there.
let _expireTrialStmt;
const EXPIRE_TRIAL_SQL = `
  UPDATE users
     SET plan_id = 'free',
         trial_expired_at = trial_started + ${TRIAL_DAYS * 86400},
         trial_started = NULL
   WHERE id = ?
     AND trial_started IS NOT NULL
     AND trial_started + ${TRIAL_DAYS * 86400} <= CAST(strftime('%s','now') AS INTEGER)
     AND stripe_subscription_id IS NULL
     AND plan_id = trial_plan
     AND plan_id != 'free'
`;
function expireTrial(userId) {
  if (!_expireTrialStmt) _expireTrialStmt = db.prepare(EXPIRE_TRIAL_SQL);
  return _expireTrialStmt.run(userId).changes === 1;
}

// Ids of every user whose trial has lapsed but who still sits on the trial plan. Same predicate
// as expireTrial; the sweep feeds these back through expireTrial one at a time.
//
// ⚠️ CAST(strftime(...) AS INTEGER): strftime returns TEXT, and in SQLite an INTEGER compares
// LESS THAN any TEXT, so `trial_started + N <= strftime('%s','now')` is ALWAYS true and
// `> strftime(...)` ALWAYS false. Compare against an integer or the predicate lies silently.
let _expiredTrialIdsStmt;
const EXPIRED_TRIAL_IDS_SQL = `
  SELECT id FROM users
   WHERE trial_started IS NOT NULL
     AND trial_started + ${TRIAL_DAYS * 86400} <= CAST(strftime('%s','now') AS INTEGER)
     AND stripe_subscription_id IS NULL
     AND plan_id = trial_plan
     AND plan_id != 'free'
`;
function findExpiredTrialUserIds() {
  if (!_expiredTrialIdsStmt) _expiredTrialIdsStmt = db.prepare(EXPIRED_TRIAL_IDS_SQL);
  return _expiredTrialIdsStmt.all().map(r => r.id);
}

/* ============================ dunning: a PAID subscription that stopped paying ============================
 *
 * Distinct from the trial path above and deliberately so. A trial ends on a clock nobody can pay to
 * stop; a failed payment is a customer who WANTS to pay and whose card did not work. So the first
 * seven days change nothing except what they are told, and only then do they fall to Free.
 *
 * ⚠️ The players are never touched by any of this. Degrading a paying customer's SCREENS over a
 * card problem turns a billing hiccup into a dark shopfront; falling to Free applies the Free
 * limits, exactly as an expired trial already does, and nothing else.
 *
 * ⚠️ CAST(strftime('%s','now') AS INTEGER) — same trap as the trial predicate above: strftime
 * returns TEXT and SQLite sorts every INTEGER below every TEXT, so an un-cast comparison is
 * silently always-true or always-false.
 */
const GRACE_DAYS = Math.max(0, Number(process.env.BILLING_GRACE_DAYS) || 7);

// Start the clock, once. `past_due_since IS NULL` makes a repeated failed invoice — Stripe retries
// several times per episode — leave the ORIGINAL failure time alone, which is what the grace is
// measured from. Returns true only for the first one.
let _startGraceStmt;
function startGrace(userId, atSec = Math.floor(Date.now() / 1000)) {
  if (!_startGraceStmt) _startGraceStmt = db.prepare(`
    UPDATE users SET past_due_since = ?, subscription_status = 'past_due'
     WHERE id = ? AND past_due_since IS NULL`);
  return _startGraceStmt.run(atSec, userId).changes === 1;
}

// A payment went through (or the subscription is active again): forget the episode entirely,
// including the email stamps, so a future lapse months from now is announced rather than silent.
let _clearGraceStmt;
function clearGrace(userId) {
  if (!_clearGraceStmt) _clearGraceStmt = db.prepare(`
    UPDATE users
       SET past_due_since = NULL, payment_failed_email_sent_at = NULL,
           subscription_lapsed_email_sent_at = NULL, subscription_status = 'active'
     WHERE id = ? AND past_due_since IS NOT NULL`);
  return _clearGraceStmt.run(userId).changes === 1;
}

// Ids of subscribers whose grace has run out and who are still on a paid plan. Same predicate as
// downgradeLapsed; the sweep feeds these back through it one at a time.
let _lapsedIdsStmt;
function findLapsedSubscriberIds() {
  if (!_lapsedIdsStmt) _lapsedIdsStmt = db.prepare(`
    SELECT id FROM users
     WHERE past_due_since IS NOT NULL
       AND past_due_since + ${GRACE_DAYS * 86400} <= CAST(strftime('%s','now') AS INTEGER)
       AND plan_id != 'free'`);
  return _lapsedIdsStmt.all().map(r => r.id);
}

/*
 * Fall to Free. `stripe_subscription_id` is deliberately KEPT: it is how the reconcile finds this
 * account again if the customer fixes their card, and clearing it would orphan a subscription that
 * still exists in Stripe. `customer.subscription.deleted` is the event that clears it, because
 * that is the one that means the subscription is really gone.
 */
let _downgradeLapsedStmt;
function downgradeLapsed(userId) {
  if (!_downgradeLapsedStmt) _downgradeLapsedStmt = db.prepare(`
    UPDATE users SET plan_id = 'free', subscription_status = 'unpaid'
     WHERE id = ?
       AND past_due_since IS NOT NULL
       AND past_due_since + ${GRACE_DAYS * 86400} <= CAST(strftime('%s','now') AS INTEGER)
       AND plan_id != 'free'`);
  return _downgradeLapsedStmt.run(userId).changes === 1;
}

function getUserPlan(userId) {
  const user = db.prepare(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name,
           p.max_devices, p.max_storage_mb, p.remote_control, p.remote_url,
           p.priority_support, p.price_monthly, p.price_yearly
    FROM users u
    JOIN plans p ON u.plan_id = p.id
    WHERE u.id = ?
  `).get(userId);

  // No user row (or no joinable plan) — return null so callers treat it as unrestricted
  // (checkDeviceAccess: `if (!plan) return { allowed: true }`). Previously the else branch
  // below dereferenced an undefined `user` ("Cannot set properties of undefined"), which — once
  // a claimed device's reclaim runs checkDeviceAccess — was swallowed by the caller's try/catch
  // and silently dropped the device to the provision-fresh path instead of reclaiming it.
  if (!user) return null;

  // Check if trial has expired
  if (user.trial_started) {
    const trialEnd = user.trial_started + (TRIAL_DAYS * 86400);
    const now = Math.floor(Date.now() / 1000);
    user.trial_active = now < trialEnd;
    user.trial_days_left = Math.max(0, Math.ceil((trialEnd - now) / 86400));
    user.trial_end = trialEnd;

    // Auto-downgrade an EXPIRED trial to free. Keyed on "no real paid subscription"
    // (stripe_subscription_id IS NULL) plus "still on the plan the trial granted"
    // (plan_id === trial_plan) — deliberately NOT on subscription_status.
    //
    // TRAP — do not reintroduce a subscription_status guard here: that column DEFAULTs to
    // 'active' and is only ever changed by Stripe webhook events. A `subscription_status !==
    // 'active'` check is therefore ALWAYS false for trial users who never touch Stripe — the
    // entire population this is meant to catch — so the downgrade never fired and every signup
    // kept Pro free forever.
    //
    // The `plan_id === user.trial_plan` clause is load-bearing: it protects comped / hand-
    // granted plans (e.g. an enterprise plan set manually, where plan_id !== trial_plan) from
    // being silently downgraded. Grandfathered users (trial_started IS NULL) never reach this
    // block at all.
    if (!user.trial_active && !user.stripe_subscription_id && user.plan_id === user.trial_plan && user.plan_name !== 'free') {
      expireTrial(userId);
      // Re-fetch with free plan
      return getUserPlan(userId);
    }
  } else {
    user.trial_active = false;
    user.trial_days_left = 0;
  }

  return user;
}

function getUserDeviceCount(userId) {
  return db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(userId).count;
}

function getUserStorageMB(userId) {
  const result = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM content WHERE user_id = ?').get(userId);
  return Math.ceil(result.total / (1024 * 1024));
}

// Check if user can add more devices
function checkDeviceLimit(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // -1 means unlimited
  if (plan.max_devices === -1) return next();

  const deviceCount = getUserDeviceCount(req.user.id);
  if (deviceCount >= plan.max_devices) {
    return res.status(403).json({
      error: `Device limit reached (${plan.max_devices} on ${plan.plan_display_name} plan). Upgrade to add more.`,
      code: 'DEVICE_LIMIT',
      current: deviceCount,
      limit: plan.max_devices,
      plan: plan.plan_name
    });
  }
  next();
}

// Check if user can upload more content
function checkStorageLimit(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // -1 means unlimited
  if (plan.max_storage_mb === -1) return next();

  const usedMB = getUserStorageMB(req.user.id);
  if (usedMB >= plan.max_storage_mb) {
    return res.status(403).json({
      error: `Storage limit reached (${plan.max_storage_mb}MB on ${plan.plan_display_name} plan). Upgrade for more.`,
      code: 'STORAGE_LIMIT',
      current_mb: usedMB,
      limit_mb: plan.max_storage_mb,
      plan: plan.plan_name
    });
  }
  next();
}

// Check if user has remote control access
function checkRemoteControl(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan || !plan.remote_control) {
    return res.status(403).json({
      error: 'Remote control requires Starter plan or above.',
      code: 'FEATURE_LOCKED',
      plan: plan?.plan_name
    });
  }
  next();
}

// Check remote URL feature access
function checkRemoteUrl(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan || !plan.remote_url) {
    return res.status(403).json({
      error: 'Remote URL content requires Pro plan or above.',
      code: 'FEATURE_LOCKED',
      plan: plan?.plan_name
    });
  }
  next();
}

/*
 * ⚠️ NEVER MOUNTED, and now superseded. This was the only thing in the codebase that looked like
 * subscription enforcement, which is exactly why it was dangerous: it is exported, commented, and
 * wired to nothing, so `past_due` had no effect on anything at all. Enforcement is now the
 * dunning sweep (services/dunning.js) moving a lapsed subscriber to Free, after which the ordinary
 * plan limits apply — one mechanism, the same one an expired trial already uses. Kept only so a
 * self-hosted fork that DID mount it is not broken by its disappearance; do not add it to a route.
 */
function checkActiveSubscription(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // Free plan is always active
  if (plan.plan_name === 'free') return next();

  // Self-hosted mode doesn't check expiry
  if (config.selfHosted) return next();

  // Check if subscription has expired
  if (plan.subscription_status !== 'active' && plan.subscription_ends && plan.subscription_ends < Math.floor(Date.now() / 1000)) {
    return res.status(403).json({
      error: 'Subscription expired. Please renew to continue.',
      code: 'SUBSCRIPTION_EXPIRED'
    });
  }
  next();
}

module.exports = {
  TRIAL_DAYS,
  GRACE_DAYS,
  startGrace,
  clearGrace,
  findLapsedSubscriberIds,
  downgradeLapsed,
  expireTrial,
  findExpiredTrialUserIds,
  getUserPlan,
  getUserDeviceCount,
  getUserStorageMB,
  checkDeviceLimit,
  checkStorageLimit,
  checkRemoteControl,
  checkRemoteUrl,
  checkActiveSubscription
};
