const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { getUserPlan, getUserDeviceCount, getUserStorageMB } = require('../middleware/subscription');
const config = require('../config');

// Get all plans
router.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order ASC').all();
  res.json(plans);
});

// Get current user's subscription info
router.get('/me', requireAuth, (req, res) => {
  const plan = getUserPlan(req.user.id);
  const deviceCount = getUserDeviceCount(req.user.id);
  const storageMB = getUserStorageMB(req.user.id);

  res.json({
    plan: {
      id: plan.plan_id,
      name: plan.plan_name,
      display_name: plan.plan_display_name,
      max_devices: plan.max_devices,
      max_storage_mb: plan.max_storage_mb,
      remote_control: !!plan.remote_control,
      remote_url: !!plan.remote_url,
      priority_support: !!plan.priority_support,
      price_monthly: plan.price_monthly,
      price_yearly: plan.price_yearly,
    },
    usage: {
      devices: deviceCount,
      devices_limit: plan.max_devices,
      storage_mb: storageMB,
      storage_limit_mb: plan.max_storage_mb,
    },
    subscription: {
      status: plan.subscription_status,
      ends: plan.subscription_ends,
      stripe_customer_id: plan.stripe_customer_id,
      stripe_subscription_id: plan.stripe_subscription_id,
    },
    trial: {
      active: plan.trial_active || false,
      days_left: plan.trial_days_left || 0,
      end: plan.trial_end ? new Date(plan.trial_end * 1000).toISOString() : null,
      plan: plan.trial_plan || null,
    },
    self_hosted: config.selfHosted,
  });
});

// Admin: assign plan to user
router.post('/assign', requireAuth, requireSuperAdmin, (req, res) => {
  const { user_id, plan_id } = req.body;
  if (!user_id || !plan_id) return res.status(400).json({ error: 'user_id and plan_id required' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare("UPDATE users SET plan_id = ?, subscription_status = 'active', updated_at = strftime('%s','now') WHERE id = ?")
    .run(plan_id, user_id);

  res.json({ success: true, plan: plan.display_name });
});

// Admin: update plan details
router.put('/plans/:id', requireAuth, requireAdmin, (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const { display_name, max_devices, max_storage_mb, remote_control, remote_url,
          priority_support, price_monthly, price_yearly, active } = req.body;

  const updates = [];
  const values = [];
  if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
  if (max_devices !== undefined) { updates.push('max_devices = ?'); values.push(max_devices); }
  if (max_storage_mb !== undefined) { updates.push('max_storage_mb = ?'); values.push(max_storage_mb); }
  if (remote_control !== undefined) { updates.push('remote_control = ?'); values.push(remote_control ? 1 : 0); }
  if (remote_url !== undefined) { updates.push('remote_url = ?'); values.push(remote_url ? 1 : 0); }
  if (priority_support !== undefined) { updates.push('priority_support = ?'); values.push(priority_support ? 1 : 0); }
  if (price_monthly !== undefined) { updates.push('price_monthly = ?'); values.push(price_monthly); }
  if (price_yearly !== undefined) { updates.push('price_yearly = ?'); values.push(price_yearly); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Admin: create custom plan
router.post('/plans', requireAuth, requireAdmin, (req, res) => {
  const { id, name, display_name, max_devices, max_storage_mb, remote_control,
          remote_url, priority_support, price_monthly, price_yearly } = req.body;

  if (!id || !name || !display_name) return res.status(400).json({ error: 'id, name, and display_name required' });

  const existing = db.prepare('SELECT id FROM plans WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Plan ID already exists' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM plans').get().max_order || 0;

  db.prepare(`
    INSERT INTO plans (id, name, display_name, max_devices, max_storage_mb, remote_control, remote_url,
                       priority_support, price_monthly, price_yearly, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, display_name, max_devices || 2, max_storage_mb || 500,
         remote_control ? 1 : 0, remote_url ? 1 : 0, priority_support ? 1 : 0,
         price_monthly || 0, price_yearly || 0, maxOrder + 1);

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  res.status(201).json(plan);
});

// Stripe webhook (if configured)
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!config.stripeSecretKey) return res.status(404).json({ error: 'Stripe not configured' });

  // TODO: Implement Stripe webhook handling
  // - customer.subscription.created -> activate plan
  // - customer.subscription.updated -> update plan
  // - customer.subscription.deleted -> downgrade to free
  // - invoice.payment_succeeded -> extend subscription
  // - invoice.payment_failed -> mark as past_due

  res.json({ received: true });
});

module.exports = router;
