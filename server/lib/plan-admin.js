'use strict';

/*
 * Editing plans from the dashboard (routes/admin.js PUT/POST /api/admin/plans).
 *
 * ⚠️ THE PRICE A CUSTOMER PAYS IS STRIPE'S, NOT OURS. Checkout charges the Stripe Price whose id the
 * plan stores (routes/stripe.js), and Stripe Prices cannot be edited. So a plan's `price_monthly` is
 * only what the pricing page SAYS; if it disagrees with the linked Stripe Price, the page advertises
 * one figure and the card is charged another. The rule here is the one the operator chose: prices are
 * created in Stripe and linked by id, and a save is refused while the shown price and the linked
 * Price disagree (amount, currency, interval, or an archived Price).
 *
 * Existing subscribers stay on the Stripe Price they subscribed to — changing a plan's link moves NEW
 * checkouts only. Limits and features are different: getUserPlan reads them live, so they apply to
 * every account on the plan at once; the dashboard says how many before saving.
 *
 * Without Stripe configured (self-hosted, alpha) nothing is for sale and checkout answers 503, so the
 * ids cannot be checked; they are stored as typed and the response says so.
 */

const PRICE_ID_RE = /^price_[A-Za-z0-9_]{4,64}$/;   // Stripe ids are price_ + alphanumerics; _ tolerated
const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const CURRENCY = 'usd';   // the dashboard and the pricing page show $ amounts

class PlanError extends Error {
  constructor(message, field = null, status = 400) { super(message); this.field = field; this.status = status; }
}

const isInt = (v) => Number.isInteger(v);
// How each field is named to a person (the field key goes back too, so the dashboard marks the input).
const LABEL = { max_devices: 'Screens', max_storage_mb: 'Storage', price_monthly: 'The monthly price', price_yearly: 'The yearly price', stripe_price_monthly: 'The monthly Stripe price id', stripe_price_yearly: 'The yearly Stripe price id' };
function limit(v, field) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!isInt(n) || n < -1) throw new PlanError(`${LABEL[field]} must be a whole number, or unlimited`, field);
  if (n > 1_000_000_000) throw new PlanError(`${LABEL[field]} is too large`, field);
  return n;
}
function money(v, field) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1_000_000) throw new PlanError(`${LABEL[field]} must be an amount of $0 or more`, field);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new PlanError(`${LABEL[field]} can have at most two decimals (cents)`, field);
  return Math.round(n * 100) / 100;
}
function priceId(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!PRICE_ID_RE.test(s)) throw new PlanError(`${LABEL[field]} must be a Stripe price id, which starts with price_ (not prod_)`, field);
  return s;
}
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;

/** The editable fields, validated and normalised. Only the fields present in `body` are returned. */
function normalisePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.display_name !== undefined) {
    const s = String(b.display_name || '').trim();
    if (!s || s.length > 60) throw new PlanError('The name must be 1–60 characters', 'display_name');
    out.display_name = s;
  }
  if (b.max_devices !== undefined) out.max_devices = limit(b.max_devices, 'max_devices');
  if (b.max_storage_mb !== undefined) out.max_storage_mb = limit(b.max_storage_mb, 'max_storage_mb');
  for (const k of ['remote_control', 'remote_url', 'priority_support', 'active']) if (b[k] !== undefined) out[k] = bool(b[k]);
  if (b.price_monthly !== undefined) out.price_monthly = money(b.price_monthly, 'price_monthly');
  if (b.price_yearly !== undefined) out.price_yearly = money(b.price_yearly, 'price_yearly');
  if (b.stripe_price_monthly !== undefined) out.stripe_price_monthly = priceId(b.stripe_price_monthly, 'stripe_price_monthly');
  if (b.stripe_price_yearly !== undefined) out.stripe_price_yearly = priceId(b.stripe_price_yearly, 'stripe_price_yearly');
  if (b.sort_order !== undefined) {
    const n = Number(b.sort_order);
    if (!isInt(n) || n < 0 || n > 10000) throw new PlanError('The order must be a whole number from 0', 'sort_order');
    out.sort_order = n;
  }
  return out;
}

/** Rules about the plan as it would be after the patch, that no single field can check. */
function checkWhole(db, id, next) {
  // Free is where expired trials and lapsed subscriptions land (services/trialExpiry.js, dunning.js):
  // it must stay free and unpurchasable.
  if (id === 'free') {
    if (next.price_monthly > 0 || next.price_yearly > 0) throw new PlanError('The Free plan must stay at $0: lapsed accounts are moved to it', 'price_monthly');
    if (next.stripe_price_monthly || next.stripe_price_yearly) throw new PlanError('The Free plan cannot be linked to a Stripe price', 'stripe_price_monthly');
  }
  // A price shown without a Price to charge it is fine (checkout refuses it), but a linked Price for
  // a plan shown as free would charge a customer for "Free".
  if (next.stripe_price_monthly && !(next.price_monthly > 0)) throw new PlanError('A monthly Stripe price is linked but the monthly price is $0', 'price_monthly');
  if (next.stripe_price_yearly && !(next.price_yearly > 0)) throw new PlanError('A yearly Stripe price is linked but the yearly price is $0', 'price_yearly');
  if (next.stripe_price_monthly && next.stripe_price_monthly === next.stripe_price_yearly) {
    throw new PlanError('Monthly and yearly need two different Stripe prices', 'stripe_price_yearly');
  }
  // The Stripe webhook maps a Price back to a plan (stripe_price_monthly = ? OR stripe_price_yearly = ?):
  // one Price on two plans would put a customer on whichever row SQLite returns first.
  for (const [field, pid] of [['stripe_price_monthly', next.stripe_price_monthly], ['stripe_price_yearly', next.stripe_price_yearly]]) {
    if (!pid) continue;
    const other = db.prepare('SELECT id, display_name FROM plans WHERE id != ? AND (stripe_price_monthly = ? OR stripe_price_yearly = ?)').get(id, pid, pid);
    if (other) throw new PlanError(`That Stripe price is already linked to ${other.display_name}`, field);
  }
}

/**
 * Check each linked Stripe Price against the price shown for it. Returns { checked, warnings }.
 * Throws a PlanError on a disagreement. `stripe` null = not configured: nothing is checked.
 */
async function checkStripePrices(stripe, next, changed) {
  const slots = [
    ['stripe_price_monthly', 'price_monthly', 'month', 'monthly'],
    ['stripe_price_yearly', 'price_yearly', 'year', 'yearly'],
  ];
  // Only what this save touches: a Price is re-checked when its id or its amount changes.
  const todo = slots.filter(([idf, amf]) => next[idf] && (changed.has(idf) || changed.has(amf)));
  if (!todo.length) return { checked: [], warnings: [] };
  if (!stripe) return { checked: [], warnings: ['Stripe is not configured on this server, so the linked prices were saved without being checked.'] };
  const checked = [];
  for (const [idf, amf, interval, label] of todo) {
    let p;
    try { p = await stripe.prices.retrieve(next[idf]); }
    catch (e) {
      const msg = e && e.code === 'resource_missing' ? 'Stripe has no price with that id (check test vs live mode)' : `Stripe could not be asked about that price: ${(e && e.message) || 'error'}`;
      throw new PlanError(msg, idf, e && e.code === 'resource_missing' ? 400 : 502);
    }
    if (!p.active) throw new PlanError(`That Stripe price is archived; checkout cannot use it`, idf);
    if (!p.recurring || p.recurring.interval !== interval || (p.recurring.interval_count || 1) !== 1) {
      throw new PlanError(`That Stripe price is not billed every ${interval}, so it cannot be the ${label} price`, idf);
    }
    if (String(p.currency).toLowerCase() !== CURRENCY) throw new PlanError(`That Stripe price is in ${String(p.currency).toUpperCase()}; the pricing page shows US dollars`, idf);
    const want = Math.round(next[amf] * 100);
    if (p.unit_amount !== want) {
      throw new PlanError(`Stripe charges $${(p.unit_amount / 100).toFixed(2)} for that price, but the ${label} price says $${(want / 100).toFixed(2)}`, amf);
    }
    checked.push({ field: idf, id: p.id, amount: p.unit_amount, interval });
  }
  return { checked, warnings: [] };
}

/** How many accounts and screens a change to this plan reaches at once. */
function impactOf(db, id) {
  const accounts = db.prepare('SELECT COUNT(*) AS n FROM users WHERE plan_id = ?').get(id).n;
  const subscribers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan_id = ? AND stripe_subscription_id IS NOT NULL").get(id).n;
  return { accounts, subscribers };
}

const FIELDS = ['display_name', 'max_devices', 'max_storage_mb', 'remote_control', 'remote_url', 'priority_support',
  'price_monthly', 'price_yearly', 'stripe_price_monthly', 'stripe_price_yearly', 'active', 'sort_order'];

/** Update a plan. Returns { plan, changed, stripe }. */
async function updatePlan(db, stripe, id, body) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!plan) throw new PlanError('Plan not found', null, 404);
  const patch = normalisePatch(body);
  const changed = new Set(Object.keys(patch).filter((k) => patch[k] !== plan[k]));
  const next = { ...plan, ...patch };
  checkWhole(db, id, next);
  const stripeResult = await checkStripePrices(stripe, next, changed);
  if (changed.size) {
    const cols = [...changed];
    db.prepare(`UPDATE plans SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c]), id);
  }
  return { plan: db.prepare('SELECT * FROM plans WHERE id = ?').get(id), changed: [...changed], stripe: stripeResult };
}

/** Create a plan, hidden from the pricing page until it is shown. Returns { plan, stripe }. */
async function createPlan(db, stripe, body) {
  const b = body && typeof body === 'object' ? body : {};
  const id = String(b.id || '').trim().toLowerCase();
  if (!PLAN_ID_RE.test(id)) throw new PlanError('The plan id must be 2–32 lower-case letters, digits, - or _', 'id');
  if (db.prepare('SELECT 1 FROM plans WHERE id = ?').get(id)) throw new PlanError('A plan with that id already exists', 'id', 409);
  const patch = normalisePatch({ max_devices: 1, max_storage_mb: 500, price_monthly: 0, price_yearly: 0, active: 0, ...b });
  if (!patch.display_name) throw new PlanError('Enter a name', 'display_name');
  const next = { remote_control: 0, remote_url: 0, priority_support: 0, stripe_price_monthly: null, stripe_price_yearly: null, ...patch };
  checkWhole(db, id, next);
  const stripeResult = await checkStripePrices(stripe, next, new Set(Object.keys(next)));
  const order = next.sort_order != null ? next.sort_order : (db.prepare('SELECT MAX(sort_order) AS m FROM plans').get().m || 0) + 1;
  db.prepare(`INSERT INTO plans (id, name, display_name, max_devices, max_storage_mb, remote_control, remote_url, priority_support,
      price_monthly, price_yearly, stripe_price_monthly, stripe_price_yearly, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id, next.display_name, next.max_devices, next.max_storage_mb, next.remote_control, next.remote_url, next.priority_support,
      next.price_monthly, next.price_yearly, next.stripe_price_monthly, next.stripe_price_yearly, order, next.active);
  return { plan: db.prepare('SELECT * FROM plans WHERE id = ?').get(id), stripe: stripeResult };
}

module.exports = { PlanError, normalisePatch, updatePlan, createPlan, impactOf, FIELDS, PRICE_ID_RE, PLAN_ID_RE };
