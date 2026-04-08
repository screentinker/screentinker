const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

const appUrl = process.env.APP_URL || '';

let stripe = null;
if (config.stripeSecretKey) {
  stripe = require('stripe')(config.stripeSecretKey);
}

// Create checkout session - user clicks "Upgrade" on a plan
router.post('/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const { plan_id, interval } = req.body; // interval: 'monthly' or 'yearly'
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const priceId = interval === 'yearly' ? plan.stripe_price_yearly : plan.stripe_price_monthly;
  if (!priceId) return res.status(400).json({ error: `No Stripe price configured for ${plan_id} (${interval || 'monthly'})` });

  try {
    // Get or create Stripe customer
    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { user_id: req.user.id, name: req.user.name || '' },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
    }

    // If user already has an active subscription, create a portal session to manage it
    if (req.user.stripe_subscription_id) {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${req.headers.origin || appUrl}/#/settings`,
      });
      return res.json({ url: portal.url, type: 'portal' });
    }

    // Create checkout session for new subscription
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.headers.origin || appUrl}/#/settings?payment=success`,
      cancel_url: `${req.headers.origin || appUrl}/#/settings?payment=cancelled`,
      metadata: { user_id: req.user.id, plan_id },
      subscription_data: {
        metadata: { user_id: req.user.id, plan_id },
      },
    });

    res.json({ url: session.url, type: 'checkout' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Customer portal - manage existing subscription (change plan, cancel, update payment)
router.post('/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const customerId = req.user.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No billing account found' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${req.headers.origin || appUrl}/#/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err.message);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Stripe webhook - handles all subscription lifecycle events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(404).json({ error: 'Stripe not configured' });

  let event;
  try {
    if (config.stripeWebhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`Stripe webhook: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const planId = session.metadata?.plan_id;
        if (userId && session.subscription) {
          db.prepare(`UPDATE users SET stripe_subscription_id = ?, plan_id = ?, subscription_status = 'active', updated_at = strftime('%s','now') WHERE id = ?`)
            .run(session.subscription, planId || 'starter', userId);
          console.log(`User ${userId} subscribed to ${planId} (sub: ${session.subscription})`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        // Find plan by stripe price ID
        const priceId = sub.items?.data?.[0]?.price?.id;
        let planId = sub.metadata?.plan_id;
        if (priceId && !planId) {
          const plan = db.prepare('SELECT id FROM plans WHERE stripe_price_monthly = ? OR stripe_price_yearly = ?').get(priceId, priceId);
          if (plan) planId = plan.id;
        }

        const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : sub.status;
        const ends = sub.current_period_end || null;

        db.prepare(`UPDATE users SET plan_id = COALESCE(?, plan_id), subscription_status = ?, subscription_ends = ?, updated_at = strftime('%s','now') WHERE id = ?`)
          .run(planId, status, ends, userId);
        console.log(`Subscription updated for ${userId}: ${planId} (${status})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        if (userId) {
          db.prepare(`UPDATE users SET plan_id = 'free', subscription_status = 'cancelled', stripe_subscription_id = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
            .run(userId);
          console.log(`Subscription cancelled for ${userId}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const user = db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId);
          if (user) {
            db.prepare("UPDATE users SET subscription_status = 'past_due', updated_at = strftime('%s','now') WHERE id = ?").run(user.id);
            console.log(`Payment failed for user ${user.id}`);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
