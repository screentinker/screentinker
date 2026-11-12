const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { sendPaymentReceipt } = require('../services/billingEmails');
const { requireAuth } = require('../middleware/auth');
const subscriptions = require('../middleware/subscription');
const config = require('../config');
const { periodEndOf, subscriptionIdOf, invoicePriceIdOf } = require('../lib/stripe-fields');
const { trimTrailing } = require('../lib/trim-trailing');

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
  return `${trimTrailing(raw, '/')}/app`;
};

// Resolved per request (lib/stripe-client.js) so a test can substitute a double; null when
// STRIPE_SECRET_KEY is unset.
const stripeClient = require('../lib/stripe-client');

// Statuses under which Stripe is providing the service: paid, in a trial, or paid-but-retrying.
const ENTITLING_STATUSES = new Set(['active', 'trialing', 'past_due']);
/*
 * WHO IS PAYING (lib/org-billing.js). While the person pays, the account is the signed-in user,
 * exactly as it always was. Once the organization pays (app_settings.billing_source = 'org'), the
 * account is the ORGANIZATION of the workspace the request is made in:
 *
 *   - anyone who belongs to it may start a checkout for it;
 *   - only its owner and its organization admins may open the portal, which is where a
 *     subscription is changed or cancelled;
 *   - the Stripe customer and subscription belong to the organization, and their metadata carries
 *     org_id (and the user who clicked, for the funnel).
 */
const orgPays = () => subscriptions.billingSource() === 'org';
const T = () => subscriptions.billingTable();
const { resolveTenancy } = require('../lib/tenancy');
const tenancyWhenOrgPays = (req, res, next) => (orgPays() ? resolveTenancy(req, res, next) : next());

/** The paying account for this request: { id, row, org } or { error: [status, body] }. */
function payerOf(req) {
  if (!orgPays()) return { id: req.user.id, row: req.user, org: null };
  if (!req.organizationId) return { error: [400, { error: 'Choose a workspace first: the plan belongs to its organization.' }] };
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.organizationId);
  if (!org) return { error: [404, { error: 'Organization not found' }] };
  return { id: org.id, row: org, org };
}
/** May this person change or cancel the organization's subscription? Its owner and its admins. */
function mayManageBilling(req, org) {
  if (!org) return true;                                   // the person pays: it is their own
  if (org.owner_user_id === req.user.id) return true;
  try {
    const m = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(org.id, req.user.id);
    return !!m && (m.role === 'org_owner' || m.role === 'org_admin');
  } catch { return false; }
}

/**
 * The account a Stripe object belongs to. Person pays: metadata.user_id, as before. Organization
 * pays: metadata.org_id; else the organization holding that subscription or customer (every
 * subscription made before the switch carries only user_id, and was moved to the person's oldest
 * organization); else that person's oldest organization.
 */
function accountOfStripe(meta, subId, custId) {
  if (!orgPays()) return (meta && meta.user_id) || null;
  const has = (id) => id && db.prepare('SELECT id FROM organizations WHERE id = ?').get(id);
  if (meta && meta.org_id) {
    // Made for one organization: that one, or none. A deleted organization's events must not be
    // guessed onto the owner's other organization (a cancellation would end its trial; a renewal
    // would give it a plan it never bought).
    return has(meta.org_id) ? meta.org_id : null;
  }
  const bySub = subId && db.prepare('SELECT id FROM organizations WHERE stripe_subscription_id = ?').get(subId);
  if (bySub) return bySub.id;
  const byCust = custId && db.prepare('SELECT id FROM organizations WHERE stripe_customer_id = ?').get(custId);
  if (byCust) return byCust.id;
  if (meta && meta.user_id) {
    const o = db.prepare('SELECT id FROM organizations WHERE owner_user_id = ? ORDER BY created_at ASC, id ASC LIMIT 1').get(meta.user_id);
    if (o) return o.id;
  }
  return null;
}
const ownerOf = (accountId) => subscriptions.accountOwnerId(accountId);

/*
 * The account's plan just changed: tell its screens NOW.
 *
 * A screen learns whether it is inside the plan when it connects and whenever a playlist is pushed
 * to it. The trial sweep and the dunning sweep push after they change a plan; the webhook did not.
 * So after a cancellation the screens beyond the Free limit went on playing until each one next
 * reconnected or was sent something (hours, or never for a screen nobody edits), and after an
 * UPGRADE the screens that had been showing "Device Limit Reached" stayed dark the same way.
 * Best effort, after the state is written; a failure here never fails the webhook.
 */
const planOf = (accountId) => { try { const r = db.prepare(`SELECT plan_id FROM ${T()} WHERE id = ?`).get(accountId); return r ? r.plan_id : null; } catch { return null; } };
function pushIfPlanChanged(req, accountId, before) {
  try {
    if (!accountId || planOf(accountId) === before) return 0;
    return require('../services/trialExpiry').pushDowngradedUserScreens(req.app.get('io'), accountId);
  } catch (e) { console.warn('[billing] could not push the new limits to screens:', e.message); return 0; }
}

// Create checkout session - user clicks "Upgrade" on a plan
router.post('/checkout', requireAuth, tenancyWhenOrgPays, async (req, res) => {
  const stripe = stripeClient.get();
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const { plan_id, interval } = req.body; // interval: 'monthly' or 'yearly'
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
  const payer = payerOf(req);
  if (payer.error) return res.status(payer.error[0]).json(payer.error[1]);

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  // 3.0 funnel (hosted only; lib/conversion-events.js). `from` is where the click came from.
  require('../lib/conversion-events').record(db, { userId: req.user.id, event: 'checkout_start',
    meta: { plan: plan_id, interval: interval === 'yearly' ? 'yearly' : 'monthly', from: typeof req.body.from === 'string' ? req.body.from : undefined } });

  const priceId = interval === 'yearly' ? plan.stripe_price_yearly : plan.stripe_price_monthly;
  if (!priceId) return res.status(400).json({ error: `No Stripe price configured for ${plan_id} (${interval || 'monthly'})` });

  try {
    // Get or create Stripe customer
    const idMeta = payer.org ? { org_id: payer.org.id, user_id: req.user.id } : { user_id: req.user.id };
    let customerId = payer.row.stripe_customer_id;
    if (!customerId) {
      // The organization's customer carries its OWNER's address: Stripe sends its own receipts
      // and card-failure notices there, and "whoever clicked first" (possibly a member who has
      // since left) is the wrong person to get them. Seen in the sandbox: the portal's billing
      // email was the member's.
      const ownerEmail = payer.org ? (db.prepare('SELECT email FROM users WHERE id = ?').get(payer.org.owner_user_id) || {}).email : null;
      const customer = await stripe.customers.create({
        email: ownerEmail || req.user.email,
        ...(payer.org ? { name: payer.org.name } : {}),
        metadata: { ...idMeta, name: (payer.org ? payer.org.name : req.user.name) || '' },
      });
      customerId = customer.id;
      db.prepare(`UPDATE ${T()} SET stripe_customer_id = ? WHERE id = ?`).run(customerId, payer.id);
    }

    // If the account already has a subscription, the portal is where it is changed. For an
    // organization that is its owner's and admins' call; anyone else is told who to ask.
    if (payer.row.stripe_subscription_id) {
      if (!mayManageBilling(req, payer.org)) {
        return res.status(403).json({ error: 'This organization already has a subscription. Its owner or an organization admin can change it.', code: 'BILLING_ADMIN_ONLY' });
      }
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${appBase(req)}#/billing`,
      });
      return res.json({ url: portal.url, type: 'portal' });
    }

    // A running sale that covers this plan and interval (lib/promotions.js). The price the pricing
    // page showed is only true if checkout charges it, so its coupon goes on the session here.
    const promo = require('../lib/promotions').activeFor(plan.id, interval === 'yearly' ? 'yearly' : 'monthly');
    const discount = promo && promo.stripe_coupon_id
      // ⚠️ Stripe refuses `discounts` together with `allow_promotion_codes`, so during a sale the
      // "Add promotion code" field is not offered: the sale price is already applied.
      ? { discounts: [{ coupon: promo.stripe_coupon_id }] }
      // Renders the "Add promotion code" field on Stripe's hosted checkout page. For
      // API-created sessions this is the ONLY way to enable it — there is no Stripe Dashboard
      // toggle for it outside Payment Links (which we don't use). Do not remove thinking it's
      // redundant with a dashboard setting.
      : { allow_promotion_codes: true };

    // Create checkout session for new subscription
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      ...discount,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appBase(req)}#/billing?payment=success`,
      cancel_url: `${appBase(req)}#/billing?payment=cancelled`,
      metadata: { ...idMeta, plan_id, ...(promo ? { promotion_id: promo.id } : {}) },
      subscription_data: {
        metadata: { ...idMeta, plan_id },
      },
    });

    res.json({ url: session.url, type: 'checkout' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Customer portal - manage existing subscription (change plan, cancel, update payment)
router.post('/portal', requireAuth, tenancyWhenOrgPays, async (req, res) => {
  const stripe = stripeClient.get();
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const payer = payerOf(req);
  if (payer.error) return res.status(payer.error[0]).json(payer.error[1]);
  if (!mayManageBilling(req, payer.org)) {
    return res.status(403).json({ error: 'Only the organization\'s owner or an organization admin can manage its billing.', code: 'BILLING_ADMIN_ONLY' });
  }
  const customerId = payer.row.stripe_customer_id;
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
  const stripe = stripeClient.get();
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
        /*
         * AI credit packs (routes/ai-hosted.js). Granted HERE and only here — after the signature
         * check above — and only once Stripe says the money moved. Idempotent on the session id,
         * because Stripe redelivers. A one-off payment never has a subscription, so this cannot be
         * confused with the plan branch below.
         */
        if (session.metadata?.kind === 'ai_credits') {
          if (session.mode === 'payment' && session.payment_status === 'paid') {
            const r = require('../lib/ai-credits').recordPurchase({
              orgId: session.metadata.org_id, packId: session.metadata.pack_id,
              ref: session.id, userId: session.metadata.user_id,
            });
            console.log(`[ai-credits] pack ${session.metadata.pack_id} for org ${session.metadata.org_id}: ${r.applied ? `+${r.credits} credits` : r.reason}`);
          } else {
            console.warn(`[ai-credits] checkout ${session.id} completed unpaid (${session.payment_status}) — no credits granted`);
          }
          break;
        }
        const userId = accountOfStripe(session.metadata, session.subscription, session.customer);   // the ACCOUNT: a user, or an organization
        const planId = session.metadata?.plan_id;
        const planBefore = userId ? planOf(userId) : null;
        if (userId && session.subscription) {
          // ⚠️ trial_started = NULL: a trial that converts is OVER. Left set, the account looked like
          // a trial for ever (the Billing page's trial block, checkDeviceAccess's trial exemption),
          // because the only other writer that clears it — expireTrial — skips anyone with a
          // subscription. trial_expired_at stays NULL: that column means "lapsed to Free", which
          // this is not.
          db.prepare(`UPDATE ${T()} SET stripe_subscription_id = ?, plan_id = ?, plan_comped = 0, subscription_status = 'active', trial_started = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
            .run(session.subscription, planId || 'starter', userId);
          console.log(`User ${userId} subscribed to ${planId} (sub: ${session.subscription})`);
          require('../lib/conversion-events').record(db, { userId: ownerOf(userId), event: 'checkout_complete', meta: { plan: planId || 'starter' } });
          pushIfPlanChanged(req, userId, planBefore);
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
        const userId = accountOfStripe(sub.metadata, sub.id, sub.customer);
        if (!userId) break;

        /*
         * ⚠️ THE BILLED PRICE FIRST, metadata only as the fallback.
         *
         * metadata.plan_id is stamped ONCE, at checkout, and Stripe leaves subscription metadata
         * untouched when the billing portal swaps the price — and the portal is where plan changes
         * happen (/checkout sends every subscriber there). Reading metadata first re-wrote the
         * ORIGINAL plan on every later event: a Pro customer who downgraded to Starter paid Starter
         * and kept Pro, and one who upgraded paid Pro and stayed capped at Starter. The price is
         * what Stripe is actually charging; metadata only answers for a price no plan row knows.
         */
        let planId = subscriptions.planIdFromSubscription(sub);

        /*
         * ⚠️ ONLY A SUBSCRIPTION STRIPE IS HONOURING GRANTS A PLAN.
         *
         * Stripe creates the subscription before the first payment settles. A payment that is never
         * completed leaves it `incomplete`, then `incomplete_expired` a day later, and NO deletion
         * event follows. This handler copied the plan from the price for any status, so an
         * abandoned checkout upgraded the account; and because it also wrote the status, a second,
         * abandoned checkout on a paying account replaced that account's `active` with `incomplete`.
         *
         *   active / trialing / past_due   as before: plan from the billed price, status, period end.
         *   incomplete(_expired)           never paid. Ignored unless it IS the tracked subscription.
         *   anything else (unpaid, canceled, paused, a status added later)
         *                                  ignored when the account tracks a DIFFERENT subscription
         *                                  (the same rule customer.subscription.deleted applies);
         *                                  otherwise the status is recorded and the plan is left to
         *                                  the paths that own it (deletion, dunning, reconcile).
         */
        if (!ENTITLING_STATUSES.has(sub.status)) {
          const acct = db.prepare(`SELECT stripe_subscription_id FROM ${T()} WHERE id = ?`).get(userId);   // the paying account: a person, or an organization
          const tracked = acct ? acct.stripe_subscription_id : null;
          const neverPaid = sub.status === 'incomplete' || sub.status === 'incomplete_expired';
          const mine = tracked ? tracked === sub.id : !neverPaid;
          if (!mine) {
            console.log(`Subscription ${sub.id} is ${sub.status} for ${userId} and is not the tracked one - account left as is`);
            break;
          }
          planId = null;   // COALESCE below keeps the plan the account has
        }

        const planBefore = planOf(userId);
        const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : sub.status;
        const ends = periodEndOf(sub);   // moved to the item in Stripe 2025-03+; see lib/stripe-fields.js

        db.prepare(`UPDATE ${T()} SET plan_id = CASE WHEN plan_comped = 1 THEN plan_id ELSE COALESCE(?, plan_id) END, subscription_status = ?, subscription_ends = ?, updated_at = strftime('%s','now') WHERE id = ?`)
          .run(planId, status, ends, userId);
        // Back in good standing: end the dunning episode, including its email stamps, so a lapse
        // next year is announced rather than silently suppressed by a stale one.
        if (status === 'active') subscriptions.clearGrace(userId);
        pushIfPlanChanged(req, userId, planBefore);
        console.log(`Subscription ${event.type.split('.').pop()} for ${userId}: ${planId} (${status}, ends ${ends || 'unknown'})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = accountOfStripe(sub.metadata, sub.id, sub.customer);
        if (userId) {
          /*
           * ⚠️ Only the subscription we are TRACKING may drop the account. Two checkouts finished
           * before the first webhook landed (two tabs, a double click) leave two live
           * subscriptions with the last one stored; cancelling the duplicate used to drop a paying
           * customer to Free AND null the id of the one still billing them, which also blinded the
           * reconcile. `IS NULL` is kept so a deletion still lands when the checkout webhook that
           * would have stored the id was itself lost.
           */
          const r = db.prepare(`UPDATE ${T()} SET plan_id = CASE WHEN plan_comped = 1 THEN plan_id ELSE 'free' END, subscription_status = 'cancelled', stripe_subscription_id = NULL, updated_at = strftime('%s','now')
                                 WHERE id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)`)
            .run(userId, sub.id);
          if (r.changes) {
            console.log(`Subscription cancelled for ${userId}`);
            pushIfPlanChanged(req, userId, null);   // now on Free: the screens beyond its limit are told at once
            // When it happened, so the feedback loop can ask why (lib/feedback.js, the 'cancelled' moment).
            require('../lib/conversion-events').record(db, { userId: ownerOf(userId), event: 'subscription_cancelled', meta: { status: sub.status || '' } });
          }
          else console.log(`Subscription ${sub.id} deleted for ${userId}, but it is not the tracked one — account left as is`);
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
          const u = (subId && db.prepare(`SELECT id FROM ${T()} WHERE stripe_subscription_id = ?`).get(subId))
            || (custId && db.prepare(`SELECT id FROM ${T()} WHERE stripe_customer_id = ?`).get(custId));
          if (u) {
            /*
             * ⚠️ Restore the PLAN, not just the status. A previous sweep may have dropped them to
             * Free; clearing the grace alone would leave someone who has just paid on Free limits.
             * The plan comes from the price this invoice actually billed, so it needs no API call.
             */
            const row = db.prepare(`SELECT plan_id FROM ${T()} WHERE id = ?`).get(u.id);
            const priceId = invoicePriceIdOf(pendingReceipt);
            const plan = priceId && db.prepare('SELECT id FROM plans WHERE stripe_price_monthly = ? OR stripe_price_yearly = ?').get(priceId, priceId);
            if (row && row.plan_id === 'free' && plan) {
              if (subscriptions.restorePlan(u.id, plan.id)) console.log(`Payment recovered for user ${u.id} — restored to ${plan.id}`);
            } else if (subscriptions.clearGrace(u.id)) {
              console.log(`Payment recovered for user ${u.id} — grace cleared`);
            }
          }
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
        const user = (subId && db.prepare(`SELECT id FROM ${T()} WHERE stripe_subscription_id = ?`).get(subId))
          || (custId && db.prepare(`SELECT id FROM ${T()} WHERE stripe_customer_id = ?`).get(custId))
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
