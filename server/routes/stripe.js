const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { sendPaymentReceipt } = require('../services/billingEmails');
const { requireAuth } = require('../middleware/auth');
const subscriptions = require('../middleware/subscription');
const config = require('../config');
const { periodEndOf, subscriptionIdOf } = require('../lib/stripe-fields');

const appUrl = process.env.APP_URL || '';

/*
 * ⚠️ WHERE STRIPE SENDS THEM BACK, AND WHY EVERY PART OF THIS STRING MATTERS.
 *
 * `/app` — `req.headers.origin` is scheme+host with NO PATH, and APP_URL is set the same way, so
 *   `${origin}/#/...` resolves to `https://host/#/...`. `/` serves the MARKETING page
 *   (server.js: landing.html), which ignores the hash entirely. Two customers paid and were
 *   dropped on the homepage with nothing to say the purchase had worked.
 *
 * `#/billing` — not `#/settings`. views/billing.js is what reads `payment=success` and renders the
 *   confirmation; settings never looks at it.
 *
 * The `?payment=...` sits INSIDE the hash, so the SPA router has to match that route by prefix.
 *   It does (app.js `hash.startsWith('#/billing')`) — exact equality silently routed the whole
 *   thing to the default view instead, which is how the first fix for this would have failed too.
 *
 * `req.headers.origin` first, so a white-label customer on their own domain comes back to THEIR
 *   domain rather than ours; APP_URL is only the fallback when there is no Origin header.
 */
const appBase = (req) => {
  /*
   * ⚠️ Trailing slashes stripped, and a last resort that is still ABSOLUTE.
   *
   * `APP_URL=https://host/` would otherwise build `https://host//app#/...` — path `//app`, which
   * Express does not match, so the customer lands on a 404 instead of the dashboard: the same
   * class of failure this function exists to fix. And with no Origin header AND no APP_URL the
   * string was relative, which Stripe refuses outright (success_url must be absolute), turning a
   * checkout into a 500 rather than a wrong page. Falling back to the request's own host is the
   * only thing left that is true, and it can only ever affect the caller's own redirect.
   */
  const raw = req.headers.origin || appUrl || `${req.protocol}://${req.get('host') || ''}`;
  return `${String(raw).replace(/\/+$/, '')}/app`;
};

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
        return_url: `${appBase(req)}#/billing`,
      });
      return res.json({ url: portal.url, type: 'portal' });
    }

    // Create checkout session for new subscription
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      // Renders the "Add promotion code" field on Stripe's hosted checkout page. For
      // API-created sessions this is the ONLY way to enable it — there is no Stripe Dashboard
      // toggle for it outside Payment Links (which we don't use). Do not remove thinking it's
      // redundant with a dashboard setting.
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appBase(req)}#/billing?payment=success`,
      cancel_url: `${appBase(req)}#/billing?payment=cancelled`,
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
      return_url: `${appBase(req)}#/billing`,
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
    if (!config.stripeWebhookSecret) {
      console.error('Stripe webhook secret not configured — rejecting unsigned webhook');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`Stripe webhook: ${event.type}`);

  // Set by the payment_succeeded case; sent after the response. See that case for why.
  let pendingReceipt = null;
  // Set by payment_failed on the FIRST failure of an episode — the dunning note goes out the same
  // way, after the 200, for the same reason.
  let pendingDunning = null;

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

      /*
       * ⚠️ `created` AS WELL AS `updated`, and both read the period end defensively.
       *
       * A subscription that is born and then simply runs emits `customer.subscription.created` and
       * nothing else until it renews or changes — so subscribing only to `updated` meant the first
       * (and for an annual plan, the only) statement of when the period ends never arrived. Both
       * live subscribers sat with subscription_ends NULL for that reason.
       *
       * And `current_period_end` MOVED from the subscription to the ITEM (Stripe API 2025-03+).
       * The webhook endpoint is pinned to an older version than the SDK's own default, so a payload
       * can legitimately arrive in either shape; reading only the subscription level wrote NULL
       * without erroring, which is the kind of silence that survives a green test suite.
       */
      case 'customer.subscription.created':
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
        const ends = periodEndOf(sub);   // moved to the item in Stripe 2025-03+; see lib/stripe-fields.js

        db.prepare(`UPDATE users SET plan_id = COALESCE(?, plan_id), subscription_status = ?, subscription_ends = ?, updated_at = strftime('%s','now') WHERE id = ?`)
          .run(planId, status, ends, userId);
        // Back in good standing: end the dunning episode, including its email stamps, so a lapse
        // next year is announced rather than silently suppressed by a stale one.
        if (status === 'active') subscriptions.clearGrace(userId);
        console.log(`Subscription ${event.type.split('.').pop()} for ${userId}: ${planId} (${status}, ends ${ends || 'unknown'})`);
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

      /*
       * ⚠️ invoice.payment_succeeded, NOT checkout.session.completed.
       *
       * Checkout fires once, for the first payment made through the hosted page. Every renewal
       * after that, and every payment made from the billing portal or after a card is fixed, is an
       * invoice — so a receipt hung off checkout would arrive for a customer's first month and
       * never again. This event covers all of them, which is also why the send has to be idempotent
       * rather than merely rare.
       */
      case 'invoice.payment_succeeded': {
        /*
         * ⚠️ DEFERRED UNTIL AFTER THE 200, not awaited here. Stripe's own guidance is to acknowledge
         * quickly and do the work afterwards, and this send is a network round trip to Graph or
         * SMTP with NO TIMEOUT anywhere in services/email.js — a hung transport would hold the
         * webhook open until Stripe gave up and retried, and enough of those pile up as open
         * requests. Deferring is safe precisely because the send is idempotent: a retry that
         * arrives while the first is still sending is refused by the invoice claim, not by luck.
         */
        pendingReceipt = event.data.object;
        {
          // A payment landing is the end of the episode, whichever invoice it was.
          const subId = subscriptionIdOf(pendingReceipt);
          const custId = pendingReceipt.customer || null;
          const u = (subId && db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId))
            || (custId && db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(custId));
          if (u && subscriptions.clearGrace(u.id)) console.log(`Payment recovered for user ${u.id} — grace cleared`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        /*
         * ⚠️ `invoice.subscription` is GONE (Stripe 2025-03+), so this used to resolve to
         * undefined and the whole case did nothing — a failed payment changed no state at all.
         * The customer id is the fallback for an invoice raised outside a subscription.
         */
        const invoice = event.data.object;
        const subId = subscriptionIdOf(invoice);
        const custId = invoice.customer || null;
        const user = (subId && db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId))
          || (custId && db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(custId))
          || null;
        if (user) {
          // Starts the grace clock on the FIRST failure of an episode and leaves it alone on
          // Stripe's retries, so the 7 days are measured from when the trouble began.
          const first = subscriptions.startGrace(user.id);
          console.log(`Payment failed for user ${user.id}${first ? ' — grace started' : ' (retry, grace already running)'}`);
          if (first) pendingDunning = { userId: user.id, invoice };
        } else {
          console.warn(`Payment failed but no account matched (sub=${subId || 'none'}, cust=${custId || 'none'})`);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }

  res.json({ received: true });

  /*
   * After the acknowledgement, and deliberately not awaited by the request. Errors cannot reach the
   * response any more, so sendPaymentReceipt logs its own — it returns a result for every path
   * including its own bugs, and the .catch is the belt to that braces.
   */
  if (pendingReceipt) {
    sendPaymentReceipt(pendingReceipt)
      .then((r) => {
        if (r.sent) console.log(`Payment receipt emailed for invoice ${pendingReceipt.id}`);
        else if (r.reason !== 'already_sent') {
          console.log(`No payment receipt for invoice ${pendingReceipt.id}: ${r.reason}`);
        }
      })
      .catch((e) => console.error('[billing] receipt dispatch failed:', e && e.message));
  }

  // Same treatment for the dunning note: after the acknowledgement, never in front of it, because
  // the send is a network round trip with no timeout and Stripe retries anything we hold open.
  if (pendingDunning) {
    require('../services/dunning').sendPaymentFailedEmail(pendingDunning.userId)
      .then((r) => console.log(`[billing] payment-failed note for ${pendingDunning.userId}: ${JSON.stringify(r)}`))
      .catch((e) => console.error('[billing] payment-failed note failed:', e && e.message));
  }
});

module.exports = router;
