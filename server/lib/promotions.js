'use strict';

/*
 * Sales and limited-time discounts on the subscription plans.
 *
 * A promotion is a percentage off one or more plans, for monthly and/or yearly billing, inside a
 * time window. It is shown on the pricing page and the dashboard's Billing page, and ⚠️ IT IS ALSO
 * WHAT CHECKOUT CHARGES. Every promotion is backed by a Stripe coupon created when the promotion is,
 * and routes/stripe.js attaches that coupon to any checkout the promotion covers. A price that is
 * only painted onto a web page is false advertising the moment someone pays the full amount, so:
 *
 *   - a promotion cannot exist without its Stripe coupon (creation fails if Stripe does);
 *   - the coupon's redeem_by is the promotion's end, so Stripe refuses it after the sale even if our
 *     clock or a cached page says otherwise;
 *   - ending a sale early deletes the coupon (existing subscribers keep what they bought — Stripe
 *     does not claw back an applied discount — but nobody new can get it).
 *
 * ONE SALE AT A TIME. Overlapping windows are refused. Two banners, two countdowns and a checkout
 * that has to pick the "best" of several coupons is a confusing page and an argument with support;
 * a single current sale is what a visitor can understand.
 *
 * "Limited time" means a real end: a countdown is only shown when there is an `ends_at`, and it is
 * the same moment Stripe stops accepting the coupon. No fake urgency, no timer that resets.
 */

const { db } = require('../db/database');
const config = require('../config');

const DURATIONS = new Set(['once', 'repeating', 'forever']);
const CYCLES = new Set(['monthly', 'yearly', 'both']);
const MAX_WINDOW_DAYS = 366;

function nowSec() { return Math.floor(Date.now() / 1000); }

function rowToPromo(r) {
  if (!r) return null;
  let planIds = [];
  try { planIds = JSON.parse(r.plan_ids || '[]'); } catch { planIds = []; }
  return { ...r, plan_ids: planIds };
}

function list() {
  return db.prepare('SELECT * FROM promotions ORDER BY starts_at DESC').all().map(rowToPromo);
}

function get(id) {
  return rowToPromo(db.prepare('SELECT * FROM promotions WHERE id = ?').get(id));
}

/** The sale running at `at` (unix seconds), or null. */
function current(at = nowSec()) {
  const r = db.prepare(`
    SELECT * FROM promotions
     WHERE ended_at IS NULL AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
     ORDER BY starts_at DESC LIMIT 1
  `).get(at, at);
  return rowToPromo(r);
}

/*
 * Can this server sell at all? A self-hosted instance has no checkout — the Subscription page shows
 * no buy buttons and admins assign plans directly — so a sale there is a price nobody can pay.
 * ⚠️ EVERY SURFACE ASKS THIS ONE FUNCTION. The homepage once showed a sale the Subscription page
 * (rightly) hid on the same server; the rule now lives here so the two cannot disagree.
 */
function salesAvailable(stripe, cfg = config) {
  if (cfg.selfHosted) return { ok: false, reason: 'This server runs in self-hosted mode, which has no checkout, so a sale could not be bought. Sales run on a cloud-mode server with Stripe.' };
  if (!stripe) return { ok: false, reason: 'Stripe is not configured on this server, so a discount could not be charged. Sales need Stripe.' };
  return { ok: true, reason: null };
}

/** The sale visitors may be shown right now: none on a server that cannot sell. */
function publicCurrent(cfg = config, at = nowSec()) {
  if (cfg.selfHosted) return null;
  return publicView(current(at), at);
}

/** The sale that applies to this plan and billing interval right now, or null. */
function activeFor(planId, interval, at = nowSec()) {
  const p = current(at);
  if (!p) return null;
  const cycle = interval === 'yearly' ? 'yearly' : 'monthly';
  if (p.cycles !== 'both' && p.cycles !== cycle) return null;
  if (p.plan_ids.length && !p.plan_ids.includes(planId)) return null;
  return p;
}

/**
 * Validate and normalise an admin's input. Returns { value } or { error }.
 * `existingId` excludes a promotion from the overlap check (editing itself).
 */
function validate(input, { existingId = null, at = nowSec() } = {}) {
  const b = input || {};
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) return { error: 'Give the sale a name (80 characters at most)' };
  const headline = String(b.headline || '').trim();
  if (!headline || headline.length > 120) return { error: 'Write the banner headline (120 characters at most)' };
  const pct = Number(b.percent_off);
  if (!Number.isInteger(pct) || pct < 1 || pct > 90) return { error: 'Percent off must be a whole number from 1 to 90' };
  const cycles = b.cycles || 'both';
  if (!CYCLES.has(cycles)) return { error: 'Billing must be monthly, yearly or both' };
  const duration = b.duration || 'once';
  if (!DURATIONS.has(duration)) return { error: 'Duration must be once, repeating or forever' };
  let months = null;
  if (duration === 'repeating') {
    months = Number(b.duration_in_months);
    if (!Number.isInteger(months) || months < 1 || months > 36) return { error: 'Repeating discounts last 1 to 36 months' };
  }
  const planIds = Array.isArray(b.plan_ids) ? [...new Set(b.plan_ids.map(String))] : [];
  if (planIds.length) {
    const known = new Set(db.prepare('SELECT id FROM plans').all().map((p) => p.id));
    const bad = planIds.filter((id) => !known.has(id));
    if (bad.length) return { error: `Unknown plan: ${bad.join(', ')}` };
    const priced = db.prepare(`SELECT id FROM plans WHERE id IN (${planIds.map(() => '?').join(',')}) AND price_monthly > 0`).all(...planIds);
    if (!priced.length) return { error: 'Choose at least one paid plan' };
  }
  const startsAt = b.starts_at == null || b.starts_at === '' ? at : Number(b.starts_at);
  if (!Number.isInteger(startsAt)) return { error: 'Invalid start time' };
  const endsAt = b.ends_at == null || b.ends_at === '' ? null : Number(b.ends_at);
  if (endsAt !== null) {
    if (!Number.isInteger(endsAt)) return { error: 'Invalid end time' };
    if (endsAt <= startsAt) return { error: 'The sale must end after it starts' };
    if (endsAt <= at) return { error: 'The end time is already in the past' };
    if (endsAt - startsAt > MAX_WINDOW_DAYS * 86400) return { error: 'A sale can run for a year at most' };
  }
  // One sale at a time: refuse any window that overlaps another live or scheduled sale.
  const others = db.prepare('SELECT id, name, starts_at, ends_at FROM promotions WHERE ended_at IS NULL AND id != ?').all(existingId || '');
  const INF = Number.MAX_SAFE_INTEGER;
  for (const o of others) {
    if (o.ends_at !== null && o.ends_at <= at) continue; // already over
    if (startsAt < (o.ends_at ?? INF) && o.starts_at < (endsAt ?? INF)) {
      return { error: `Overlaps "${o.name}". Only one sale can run at a time — end or reschedule it first.` };
    }
  }
  return {
    value: {
      name, headline, percent_off: pct, cycles, duration, duration_in_months: months,
      plan_ids: planIds, starts_at: startsAt, ends_at: endsAt,
    },
  };
}

/** What the public pricing page may know: no internal name, no Stripe ids. */
function publicView(p, at = nowSec()) {
  if (!p) return null;
  return {
    headline: p.headline,
    percent_off: p.percent_off,
    cycles: p.cycles,
    duration: p.duration,
    duration_in_months: p.duration_in_months,
    plan_ids: p.plan_ids,
    ends_at: p.ends_at,
    server_now: at,
  };
}

/** Stripe coupon parameters for a validated promotion. */
function couponParams(v, id) {
  const params = {
    percent_off: v.percent_off,
    duration: v.duration,
    name: v.name.slice(0, 40),
    metadata: { promotion_id: id },
  };
  if (v.duration === 'repeating') params.duration_in_months = v.duration_in_months;
  if (v.ends_at) params.redeem_by = v.ends_at;
  return params;
}

/**
 * Create a promotion and its Stripe coupon. `stripe` is a Stripe client (or a test double).
 * Throws { status, message } on failure; nothing is stored unless Stripe accepted the coupon.
 */
async function create(input, stripe, createdBy) {
  const avail = salesAvailable(stripe);
  if (!avail.ok) throw Object.assign(new Error(avail.reason), { status: 503 });
  const { value, error } = validate(input);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const id = `promo_${require('crypto').randomUUID()}`;
  let coupon;
  try {
    coupon = await stripe.coupons.create(couponParams(value, id));
  } catch (err) {
    throw Object.assign(new Error(`Stripe refused the coupon: ${err.message}`), { status: 502 });
  }
  db.prepare(`
    INSERT INTO promotions (id, name, headline, percent_off, cycles, duration, duration_in_months, plan_ids,
                            starts_at, ends_at, stripe_coupon_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, value.name, value.headline, value.percent_off, value.cycles, value.duration, value.duration_in_months,
    JSON.stringify(value.plan_ids), value.starts_at, value.ends_at, coupon.id, createdBy || null, nowSec());
  return get(id);
}

/**
 * End a sale now. The coupon is deleted so nobody new can redeem it; Stripe keeps the discount on
 * subscriptions that already used it. A Stripe failure is reported but the sale still ends here —
 * the page and checkout stop offering it either way, and redeem_by is the backstop.
 */
async function end(id, stripe) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Sale not found'), { status: 404 });
  if (p.ended_at) return { promo: p, stripeWarning: null };
  const at = nowSec();
  db.prepare('UPDATE promotions SET ended_at = ? WHERE id = ?').run(at, id);
  let stripeWarning = null;
  if (stripe && p.stripe_coupon_id) {
    try { await stripe.coupons.del(p.stripe_coupon_id); } catch (err) { stripeWarning = err.message; }
  }
  return { promo: get(id), stripeWarning };
}

/** A sale price, rounded to cents. */
function salePrice(price, percentOff) {
  return Math.round(Number(price) * (100 - percentOff)) / 100;
}

module.exports = { list, get, current, publicCurrent, salesAvailable, activeFor, validate, publicView, couponParams, create, end, salePrice };
