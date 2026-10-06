'use strict';

/*
 * Dunning: what happens when a PAYING customer's payment fails.
 *
 * WHY THIS EXISTS. Before it, a failed payment wrote `subscription_status = 'past_due'` and
 * nothing in the product ever read that column again — no email, no banner, no change in access.
 * The only real consequence in the whole system was `customer.subscription.deleted` eventually
 * dropping the account to Free, whenever Stripe gave up. So a customer whose card expired was told
 * nothing by us and kept everything, and a customer whose subscription quietly went `unpaid`
 * without that event kept a paid plan for ever.
 *
 * THE SHAPE, and the reasoning behind each part:
 *
 *   1. Tell them, immediately. The first failed invoice of an episode sends one email. A card
 *      failing is not a policy violation — it is usually an expired card, and the person wants to
 *      fix it. Being told is the entire remedy in most cases.
 *   2. Change nothing for GRACE_DAYS (7). Stripe is still retrying during this window; taking
 *      anything away while the payment may yet succeed would punish a customer who is not at
 *      fault, and would have to be undone.
 *   3. Then fall to Free, and say so. Not a suspension, not a deletion — the Free plan's limits,
 *      the same ones an expired trial gets, applied by the same mechanism.
 *
 * ⚠️ THE PLAYERS ARE NEVER TOUCHED BY ANY OF THIS. Nothing here blanks a screen, and nothing here
 * deletes anything. A shopfront going dark over a card problem is a far worse outcome than a
 * month of unpaid Pro, and it is the customer's END USERS who would see it. Screens beyond the
 * Free limit stop, exactly as they already do when a trial ends — that is the one shared,
 * predictable rule, not a new punishment invented here.
 *
 * ⚠️ NOTHING IS IRREVERSIBLE. `stripe_subscription_id` is kept on a lapsed account so the
 * reconcile below can find it again the moment the customer fixes their card, and the email
 * stamps are cleared with the grace clock so a lapse next year is announced rather than
 * suppressed by a stale one.
 *
 * RECONCILE. Webhook delivery is not a guarantee — this instance lost `customer.subscription.*`
 * for months because the endpoint was never subscribed to them, and had no way to notice. So the
 * sweep also asks Stripe directly what it believes about every subscription we think we have, and
 * corrects the database. That is the part that makes the rest safe to rely on.
 *
 * GATING (identical to services/trialExpiry.js, deliberately):
 *   - SELF_HOSTED=true: the whole service is off. A self-host never bills.
 *   - HOSTED_INSTANCE=true additionally gates the EMAILS, so a bulk sweep can never mail a
 *     self-hoster's user base by accident. The downgrade and the reconcile do not need it.
 *
 * ⚠️ Every "now" comparison in SQL uses CAST(strftime('%s','now') AS INTEGER): strftime returns
 * TEXT and SQLite orders every INTEGER below every TEXT, so an un-cast comparison is silently
 * always-true or always-false.
 */

const config = require('../config');
const { db } = require('../db/database');
const emailSvc = require('./email');
const subscriptions = require('../middleware/subscription');
const { pushDowngradedUserScreens, stampAfter, displayName } = require('./trialExpiry');
const { periodEndOf } = require('../lib/stripe-fields');

// Which plan a subscription represents — billed price first, metadata as the fallback. One rule,
// shared with the subscription webhook (middleware/subscription.js explains why price wins).
const { planIdFromSubscription, planIdFromPrice } = subscriptions;

// Stripe statuses that mean the subscription will never bill again. Treated like a 404.
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

const SWEEP_HOUR_UTC = 15;          // an hour after the trial sweep, so the two never interleave
const BILLING_URL = 'https://screentinker.com/app#/billing';

function isEnabled() { return !config.selfHosted; }
function isHosted() { return process.env.HOSTED_INSTANCE === 'true'; }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------ the two emails ------------------------------ */

function failedText({ name, planName, graceDays }) {
  return `Hi ${name},

We tried to take payment for your ScreenTinker ${planName} plan and the card was declined.

Nothing has changed yet — your screens are playing and your account is untouched. Stripe will try
the card again over the next few days, and if it goes through this sorts itself out and you can
ignore this.

If it does not, we will move the account to the Free plan in ${graceDays} days. Nothing is deleted
when that happens; screens beyond the Free limit simply stop until a plan covers them again.

Updating the card takes a minute:
  -> ${BILLING_URL}

Reply to this email if something looks wrong — it comes to me.

Dan`;
}

function failedHtml(ctx) {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#111">
<p>Hi ${esc(ctx.name)},</p>
<p>We tried to take payment for your ScreenTinker <strong>${esc(ctx.planName)}</strong> plan and the card was declined.</p>
<p><strong>Nothing has changed yet</strong> — your screens are playing and your account is untouched. Stripe will try the
card again over the next few days, and if it goes through this sorts itself out and you can ignore this.</p>
<p>If it does not, we will move the account to the Free plan in ${ctx.graceDays} days. Nothing is deleted when that
happens; screens beyond the Free limit simply stop until a plan covers them again.</p>
<p><a href="${BILLING_URL}" style="font-weight:600">Update your card</a></p>
<p>Reply to this email if something looks wrong — it comes to me.</p>
<p>Dan</p></div>`;
}

// planName is the plan they lapsed FROM, or null when it is no longer known (see runDunningSweep)
// — never the current plan, which is Free by the time this is sent.
const lapsedWhat = (planName) => (planName ? `${planName} plan` : 'subscription');

function lapsedText({ name, planName, screens }) {
  return `Hi ${name},

The payment for your ScreenTinker ${lapsedWhat(planName)} did not go through, so the account has moved to
the Free plan.

Nothing has been deleted. Your playlists, content and settings are exactly as you left them${screens ? `, and ${screens} screen${screens === 1 ? '' : 's'} ${screens === 1 ? 'is' : 'are'} affected by the Free limit` : ''}.
Putting a working card on the account restores everything immediately.

  -> ${BILLING_URL}

If the payment failing was a surprise, reply and tell me — I would rather fix it than lose you.

Dan`;
}

function lapsedHtml(ctx) {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#111">
<p>Hi ${esc(ctx.name)},</p>
<p>The payment for your ScreenTinker ${ctx.planName ? `<strong>${esc(ctx.planName)}</strong> plan` : 'subscription'} did not go through, so the account has
moved to the Free plan.</p>
<p><strong>Nothing has been deleted.</strong> Your playlists, content and settings are exactly as you left them.
Putting a working card on the account restores everything immediately.</p>
<p><a href="${BILLING_URL}" style="font-weight:600">Update your card</a></p>
<p>If the payment failing was a surprise, reply and tell me — I would rather fix it than lose you.</p>
<p>Dan</p></div>`;
}

const planNameOf = (planId) =>
  (db.prepare('SELECT display_name, name FROM plans WHERE id = ?').get(planId) || {}).display_name
  || (db.prepare('SELECT name FROM plans WHERE id = ?').get(planId) || {}).name
  || planId || 'paid';

const screenCountOf = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(userId).n;

/**
 * The "your payment failed" note, sent once per episode. Called from the webhook after it has
 * answered Stripe — never in front of the acknowledgement, for the same reason the receipt is not.
 */
async function sendPaymentFailedEmail(userId) {
  if (!isEnabled() || !isHosted()) return { sent: false, reason: 'not_hosted' };
  const u = db.prepare(`SELECT id, email, name, plan_id, email_alerts, payment_failed_email_sent_at
                          FROM users WHERE id = ?`).get(userId);
  if (!u) return { sent: false, reason: 'no_user' };
  if (u.payment_failed_email_sent_at) return { sent: false, reason: 'already_sent' };
  if (u.email_alerts === 0) return { sent: false, reason: 'opted_out' };
  const ctx = { name: displayName(u), planName: planNameOf(u.plan_id), graceDays: subscriptions.GRACE_DAYS };
  const r = await emailSvc.sendEmail({
    to: u.email,
    fromName: 'Dan at ScreenTinker',
    rawSubject: true,
    subject: 'Your ScreenTinker payment did not go through',
    text: failedText(ctx),
    html: failedHtml(ctx),
  });
  if (stampAfter(r, 'payment_failed_email_sent_at', u.id)) return { sent: true };
  return { sent: false, reason: (r && r.reason) || 'not_sent' };
}

/* ------------------------------ reconcile ------------------------------ */

/*
 * Ask Stripe what it actually believes, for every account we think has a subscription, and correct
 * the database. This is the safety net under every webhook in routes/stripe.js: a missed delivery,
 * an endpoint that was never subscribed to an event, an outage — all of them heal here within a
 * day instead of persisting indefinitely and invisibly.
 */
async function reconcileFromStripe() {
  if (!isEnabled() || !config.stripeSecretKey) return { checked: 0, corrected: 0, skipped: 'not_configured' };
  const stripe = require('stripe')(config.stripeSecretKey);
  const rows = db.prepare(`SELECT id, plan_id, plan_comped, subscription_status, subscription_ends, stripe_subscription_id, past_due_since
                             FROM users
                            WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> ''`).all();
  const out = { checked: 0, corrected: 0, errors: 0 };
  for (const u of rows) {
    out.checked++;
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
    } catch (e) {
      // A subscription Stripe no longer has is not an error to retry — it is an answer.
      if (e && e.statusCode === 404) {
        /*
         * ⚠️ plan_id = 'free' as well. Clearing the subscription id while leaving a paid plan_id
         * left the account on Pro for ever with nothing left to bill it — the mirror image of the
         * customer.subscription.deleted handler, which has always dropped the plan.
         */
        db.prepare(`UPDATE users SET plan_id = CASE WHEN plan_comped = 1 THEN plan_id ELSE 'free' END, subscription_status = 'cancelled',
                                     stripe_subscription_id = NULL WHERE id = ?`).run(u.id);
        out.corrected++;
        console.log(`[DUNNING] reconcile: ${u.id} — subscription gone from Stripe, moved to Free`);
      } else {
        out.errors++;
        console.error(`[DUNNING] reconcile: ${u.id}: ${e && e.message}`);
      }
      continue;
    }
    /*
     * ⚠️ A CANCELLED SUBSCRIPTION IS NOT A 404. Stripe keeps cancelled subscriptions and retrieve
     * returns them with status 'canceled' (or 'incomplete_expired' for one that never started) —
     * the 404 branch above is the rare case, not the normal one. Before this, the exact failure the
     * reconcile exists for (a lost customer.subscription.deleted) wrote status='canceled', left the
     * paid plan_id in place, started no grace clock, and skipped the row as unchanged every night
     * after: Pro for ever with nothing billing it. Terminal means the same as gone.
     */
    if (TERMINAL_STATUSES.has(sub.status)) {
      db.prepare(`UPDATE users SET plan_id = CASE WHEN plan_comped = 1 THEN plan_id ELSE 'free' END, subscription_status = 'cancelled',
                                   stripe_subscription_id = NULL WHERE id = ?`).run(u.id);
      out.corrected++;
      console.log(`[DUNNING] reconcile: ${u.id} — subscription ${sub.status} in Stripe, moved to Free`);
      continue;
    }
    const ends = periodEndOf(sub);
    const status = sub.status === 'active' ? 'active' : sub.status;
    const changes = [];
    /*
     * ⚠️ Stripe says it is failing but our grace clock never started — the invoice.payment_failed
     * delivery was lost. Without the clock, findLapsedSubscriberIds never sees the account and it
     * keeps its paid plan for ever. Start it now (and send the once-per-episode note, which is
     * hosted-gated and idempotent) so the ordinary 7-day grace and downgrade take over. Started
     * BEFORE the status write below because startGrace writes 'past_due', and Stripe's own word
     * ('unpaid') should be what is left in the column.
     */
    if ((status === 'past_due' || status === 'unpaid') && u.past_due_since == null) {
      if (subscriptions.startGrace(u.id)) {
        changes.push('grace started');
        try { await sendPaymentFailedEmail(u.id); }
        catch (e) { console.error(`[DUNNING] reconcile: payment-failed note for ${u.id}: ${e && e.message}`); }
      }
    }
    /*
     * ⚠️ PLAN DRIFT. A plan change made in the billing portal arrives as a new PRICE on the same
     * subscription; if that customer.subscription.updated delivery is lost (or was processed by an
     * older build that trusted the stale metadata), nothing else ever moves a paying account from
     * one paid plan to another. Only the price may overwrite a stored paid plan here — never the
     * checkout metadata, which is exactly the stale value that caused the drift.
     */
    const billedPlan = status === 'active' ? planIdFromPrice(sub) : null;
    const planDrift = !!billedPlan && billedPlan !== u.plan_id && !u.plan_comped;   // a comp is not drift
    if (planDrift) changes.push(`plan ${u.plan_id} -> ${billedPlan}`);
    if (status !== u.subscription_status) changes.push(`status ${u.subscription_status} -> ${status}`);
    if (ends && ends !== u.subscription_ends) changes.push(`ends ${u.subscription_ends || 'null'} -> ${ends}`);
    if (!changes.length) continue;
    db.prepare(`UPDATE users SET subscription_status = ?, subscription_ends = COALESCE(?, subscription_ends) WHERE id = ?`)
      .run(status, ends, u.id);
    /*
     * Stripe says this is paid and running: whatever we thought, the episode is over — and if a
     * previous sweep had already dropped them to Free, the plan comes back here. This is the path
     * that makes recovery work without depending on a webhook arriving.
     */
    if (status === 'active') {
      const planId = planDrift ? billedPlan : planIdFromSubscription(sub);
      if ((u.plan_id === 'free' || planDrift) && planId) {
        if (subscriptions.restorePlan(u.id, planId)) console.log(`[DUNNING] reconcile: ${u.id} — paid, plan set to ${planId}`);
      } else {
        subscriptions.clearGrace(u.id);
      }
    }
    out.corrected++;
    console.log(`[DUNNING] reconcile: ${u.id} — ${changes.join(', ')}`);
  }
  return out;
}

/* ------------------------------ the sweep ------------------------------ */

/**
 * One full pass. Exported so an operator can run it by hand
 * (`node -e "require('./services/dunning').runDunningSweep()"`) and so tests can drive it without
 * waiting for SWEEP_HOUR_UTC. Returns counts, or null when disabled.
 */
async function runDunningSweep({ io = null } = {}) {
  if (!isEnabled()) return null;
  const out = { reconciled: 0, downgraded: 0, screensPushed: 0, lapsedSent: 0, emailsSkipped: false };

  // 1. Correct the database from Stripe FIRST, so the downgrade below never acts on a stale
  //    "past due" that Stripe has since seen paid.
  try {
    const r = await reconcileFromStripe();
    out.reconciled = r.corrected || 0;
  } catch (e) {
    console.error('[DUNNING] reconcile failed (sweep continues):', e && e.message);
  }

  // 2. Grace expired -> Free.
  //
  // ⚠️ The plan's NAME is captured BEFORE the downgrade: afterwards plan_id is 'free', and the
  // lapse email used to read it back and tell every customer that "your ScreenTinker Free plan"
  // payment failed. Held in memory for step 3 of this same sweep; a later sweep that retries an
  // unsent note no longer knows it and says "subscription" instead of guessing.
  const lapsedFrom = new Map();
  for (const id of subscriptions.findLapsedSubscriberIds()) {
    const before = db.prepare('SELECT plan_id FROM users WHERE id = ?').get(id);
    if (!subscriptions.downgradeLapsed(id)) continue;   // raced, or no longer eligible
    if (before) lapsedFrom.set(id, planNameOf(before.plan_id));
    out.downgraded++;
    out.screensPushed += pushDowngradedUserScreens(io, id);
  }
  console.log(`[DUNNING] sweep: ${out.reconciled} corrected from Stripe, ${out.downgraded} lapsed subscription(s) moved to Free, ${out.screensPushed} screen(s) pushed`);

  if (!isHosted()) {
    out.emailsSkipped = true;
    console.log('[DUNNING] HOSTED_INSTANCE not set - dunning emails skipped');
    return out;
  }

  // 3. Tell the ones that just lapsed, once each.
  //
  // ⚠️ `plan_id = 'free'` is what makes this "lapsed". subscription_status = 'unpaid' alone is not:
  // Stripe sends that status itself (retry policy "mark subscription unpaid"), and the webhook and
  // the reconcile copy it straight in — so an account still INSIDE its grace, still on Pro, was
  // told "your plan has moved to Free", and the stamp then silenced the real notice on day 7.
  const lapsed = db.prepare(`
    SELECT id, email, name, plan_id FROM users
     WHERE subscription_status = 'unpaid'
       AND plan_id = 'free'
       AND past_due_since IS NOT NULL
       AND subscription_lapsed_email_sent_at IS NULL
       AND COALESCE(email_alerts, 1) != 0`).all();
  for (const u of lapsed) {
    const ctx = { name: displayName(u), planName: lapsedFrom.get(u.id) || null, screens: screenCountOf(u.id) };
    const r = await emailSvc.sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenTinker',
      rawSubject: true,
      subject: 'Your ScreenTinker plan has moved to Free',
      text: lapsedText(ctx),
      html: lapsedHtml(ctx),
    });
    console.log(`[DUNNING] lapsed -> ${u.email}: ${JSON.stringify(r)}`);
    if (stampAfter(r, 'subscription_lapsed_email_sent_at', u.id)) out.lapsedSent++;
  }
  return out;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SWEEP_HOUR_UTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Self-correcting daily scheduler — same shape as trialExpiry, no cron dependency. */
function startDunning(io) {
  if (!isEnabled()) {
    console.log('[DUNNING] SELF_HOSTED=true - dunning sweep disabled');
    return;
  }
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[DUNNING] next dunning sweep in ~${Math.round(delay / 60000)} min (${String(SWEEP_HOUR_UTC).padStart(2, '0')}:00 UTC daily)`);
    const t = setTimeout(() => {
      runDunningSweep({ io }).catch((e) => console.error('[DUNNING] sweep error:', e && e.message));
      schedule();
    }, delay);
    if (t.unref) t.unref();
  };
  schedule();
}

module.exports = {
  startDunning,
  runDunningSweep,
  reconcileFromStripe,
  sendPaymentFailedEmail,
  SWEEP_HOUR_UTC,
};
