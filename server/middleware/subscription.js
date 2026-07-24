const { db } = require('../db/database');
const config = require('../config');

const TRIAL_DAYS = 14;

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
      db.prepare("UPDATE users SET plan_id = 'free', trial_started = NULL WHERE id = ?").run(userId);
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

// Check subscription is active (not expired)
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
  getUserPlan,
  getUserDeviceCount,
  getUserStorageMB,
  checkDeviceLimit,
  checkStorageLimit,
  checkRemoteControl,
  checkRemoteUrl,
  checkActiveSubscription
};
