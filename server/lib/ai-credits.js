'use strict';

/*
 * Hosted AI image credits — the org-scoped ledger (docs/ai-credits.md).
 *
 *   1 credit = $0.01. An image costs ceil(provider cost × markup, to the cent) credits, for the
 *   EXACT model + resolution + quality the user chose (config/ai-rate-card.js). Unknown combo =
 *   refused, never guessed.
 *
 *   Two buckets. INCLUDED credits are granted per UTC month at 10% of the org's screen bill and
 *   expire with the month. PURCHASED credits never expire. Included is spent first.
 *
 *   Balance = SUM(delta_credits) over the live buckets. Nothing is ever updated in the ledger;
 *   every movement is a new row.
 *
 * ⚠️ THIS MODULE ONLY READS THE SCREEN METER. device_usage_daily and lib/billing.js are the
 * contractual system of record; the included allotment is derived from them with billing.js's own
 * exported functions and written nowhere near them.
 *
 * Generation is RESERVE → call provider → COMMIT or RELEASE. The reservation and its debit are one
 * transaction written before the provider is called, so a crash leaves a 'pending' attempt record
 * (refunded by sweepStale), never an unrecorded charge. better-sqlite3 transactions are synchronous,
 * so two concurrent reserves cannot both pass the balance check.
 */

const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db/database');
const billing = require('./billing');
const CARD = require('../config/ai-rate-card');

const MICROS_PER_CREDIT = 10000;   // $0.01 in micro-dollars

const nowSec = (ms) => Math.floor(ms / 1000);

/* ------------------------------ rate card ------------------------------ */

function validRow(r) {
  return r && typeof r === 'object'
    && ['provider', 'model', 'resolution', 'quality'].every((k) => typeof r[k] === 'string' && r[k].length > 0 && r[k].length <= 80)
    && Number.isInteger(r.provider_cost_usd_micros) && r.provider_cost_usd_micros > 0;
}

let _card = null;
function rateCard() {
  if (_card) return _card;
  /*
   * ⚠️ ONE ROW PER COMBINATION. The picker and the debit path must agree on the price, so a
   * duplicate is collapsed here rather than left for each reader to resolve its own way: a LATER
   * row (AI_HOSTED_RATE_CARD) replaces an earlier one (the built-in card), which is how an operator
   * records a provider price change without a code edit.
   */
  const byCombo = new Map();
  for (const r of [...CARD.RATE_CARD, ...(config.aiHosted.extraRateCard || [])]) {
    if (!validRow(r)) { console.warn('[ai-credits] ignoring malformed rate-card row:', JSON.stringify(r).slice(0, 200)); continue; }
    const k = [r.provider, r.model, r.resolution, r.quality].join('|');
    if (byCombo.has(k)) console.warn(`[ai-credits] rate-card row ${k} overridden by a later row`);
    byCombo.set(k, Object.freeze({ ...r, request: Object.freeze({ ...(r.request || {}) }) }));
  }
  _card = Object.freeze([...byCombo.values()]);
  return _card;
}

/** Customer price for one row. Pure. */
function priceOf(row, markup = config.aiHosted.markup) {
  const raw = row.provider_cost_usd_micros * markup;
  const credits = Math.ceil(raw / MICROS_PER_CREDIT);   // rounded UP to the cent
  return { credits, charge_usd_micros: credits * MICROS_PER_CREDIT, provider_cost_usd_micros: row.provider_cost_usd_micros };
}

/** The exact row for a selection, or null. No fuzzy matching — an unknown combo is refused. */
function findRow(sel) {
  if (!sel) return null;
  return rateCard().find((r) => r.provider === sel.provider && r.model === sel.model
    && r.resolution === sel.resolution && r.quality === sel.quality) || null;
}

/* ------------------------------ screen bill (READ ONLY) ------------------------------ */

const _orgAsdByDay = db.prepare(`
  SELECT u.day AS day, SUM(MIN(1.0, u.online_seconds / CAST(? AS REAL))) AS asd
    FROM device_usage_daily u
    JOIN devices d ON d.id = u.device_id
    JOIN workspaces w ON w.id = d.workspace_id
   WHERE w.organization_id = ? AND u.day BETWEEN ? AND ?
   GROUP BY u.day`);

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/*
 * The org's screen bill for a month, by the SAME formula as lib/billing.buildUsageReport, filtered
 * to the org's devices: Σ ASD over COMPLETED days / completed days, round half up, flat tier.
 *
 * ⚠️ DAY 1 HAS NO COMPLETED DAYS, so the month-to-date average is undefined (billing.js reports 0).
 * Granting 0 on the 1st and never revisiting it would hand every org nothing for the month, so on
 * day 1 the estimate is the previous month's final bill instead — and see ensureIncludedGrant for
 * why later in the month the grant can only grow.
 */
function orgScreenBill(orgId, nowMs = Date.now()) {
  const month = billing.utcMonth(nowMs);
  const todayDom = new Date(nowMs).getUTCDate();
  let target = month;
  let completedDays = todayDom - 1;
  let basis = 'month_to_date';
  if (completedDays === 0) { target = prevMonth(month); completedDays = billing.daysInMonth(target); basis = 'previous_month'; }
  const dim = billing.daysInMonth(target);
  const first = `${target}-01`;
  // Completed days only: for the current month that is strictly before today.
  const last = basis === 'month_to_date'
    ? `${month}-${String(todayDom - 1).padStart(2, '0')}`
    : `${target}-${String(dim).padStart(2, '0')}`;
  const denom = config.billing.hoursPerDay * 3600;
  let sum = 0;
  for (const r of _orgAsdByDay.all(denom, orgId, first, last)) sum += r.asd;
  const screens = billing.billableScreens(sum, completedDays);
  const tier = billing.tierFor(screens);
  const rate = tier ? tier.rate : 0;
  return { month, basis, billable_screens: screens, rate_usd: rate, cost_cents: Math.round(screens * rate * 100) };
}

/** Included credits for a bill: 10% of it, at 1 credit per cent, floored. Pure. */
function includedFor(costCents, share = config.aiHosted.includedShare) {
  // Integer-safe: 10% of 15000 cents must be exactly 1500, not 1499.999…
  return Math.max(0, Math.floor(Math.round(costCents * share * 1e6) / 1e6));
}

/* ------------------------------ ledger ------------------------------ */

const _insert = db.prepare(`INSERT INTO ai_credit_ledger
  (org_id, delta_credits, reason, bucket, period, provider, model, resolution, quality,
   provider_cost_usd_micros, charge_usd_micros, ref, user_id, workspace_id, created_at)
  VALUES (@org_id, @delta, @reason, @bucket, @period, @provider, @model, @resolution, @quality,
   @provider_cost, @charge, @ref, @user_id, @workspace_id, @created_at)`);

function append(row) {
  return _insert.run({
    org_id: row.org_id, delta: row.delta, reason: row.reason, bucket: row.bucket,
    period: row.period || null, provider: row.provider || null, model: row.model || null,
    resolution: row.resolution || null, quality: row.quality || null,
    provider_cost: row.provider_cost == null ? null : row.provider_cost,
    charge: row.charge == null ? null : row.charge,
    ref: row.ref || null, user_id: row.user_id || null, workspace_id: row.workspace_id || null,
    created_at: row.created_at,
  });
}

const _sumIncluded = db.prepare("SELECT COALESCE(SUM(delta_credits),0) AS n FROM ai_credit_ledger WHERE org_id = ? AND bucket = 'included' AND period = ?");
const _sumPurchased = db.prepare("SELECT COALESCE(SUM(delta_credits),0) AS n FROM ai_credit_ledger WHERE org_id = ? AND bucket = 'purchased'");
const _sumGranted = db.prepare("SELECT COALESCE(SUM(delta_credits),0) AS n FROM ai_credit_ledger WHERE org_id = ? AND reason = 'grant_included' AND period = ?");

/*
 * Top the month's included grant up to what the current screen bill entitles.
 *
 * ⚠️ A TOP-UP, AND IT NEVER CLAWS BACK. The month-to-date bill is an estimate that firms up as the
 * month goes on. Granting once, on the first call, would lock in whatever the estimate was that
 * morning; re-granting the difference as it RISES keeps the cap at 10% of the real bill. When it
 * FALLS nothing is taken back — the customer may already have spent it, and the ledger must never
 * go negative. Idempotent: the ref names the entitlement level, and the unique index refuses a
 * second row for the same level.
 */
function ensureIncludedGrant(orgId, nowMs = Date.now()) {
  const bill = orgScreenBill(orgId, nowMs);
  const entitled = includedFor(bill.cost_cents);
  const granted = _sumGranted.get(orgId, bill.month).n;
  if (entitled > granted) {
    try {
      append({
        org_id: orgId, delta: entitled - granted, reason: 'grant_included', bucket: 'included',
        period: bill.month, ref: `included:${bill.month}:${entitled}`,
        charge: bill.cost_cents * 10000, created_at: nowSec(nowMs),
      });
    } catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e;   // a concurrent top-up to the same level won
    }
  }
  return { bill, entitled };
}

function balance(orgId, nowMs = Date.now()) {
  const period = billing.utcMonth(nowMs);
  const included = _sumIncluded.get(orgId, period).n;
  const purchased = _sumPurchased.get(orgId).n;
  return { period, included, purchased, total: included + purchased };
}

/* ------------------------------ reserve / commit / release ------------------------------ */

class CreditError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
}

const _resByKey = db.prepare('SELECT * FROM ai_credit_reservations WHERE org_id = ? AND idempotency_key = ?');
const _resById = db.prepare('SELECT * FROM ai_credit_reservations WHERE id = ?');
const _resInsert = db.prepare(`INSERT INTO ai_credit_reservations
  (id, org_id, workspace_id, user_id, idempotency_key, provider, model, resolution, quality, credits,
   from_included, from_purchased, included_period, provider_cost_usd_micros, charge_usd_micros, status, created_at, updated_at)
  VALUES (@id, @org_id, @workspace_id, @user_id, @key, @provider, @model, @resolution, @quality, @credits,
   @from_included, @from_purchased, @period, @provider_cost, @charge, 'pending', @t, @t)`);

/**
 * Reserve the price of one image. Returns {reservation, replay:false} for a new attempt, or
 * {reservation, replay:true} when this idempotency key was already used (the caller replays that
 * outcome instead of charging again). Throws CreditError('unknown_model') / ('insufficient_credits').
 */
const reserve = db.transaction((opts) => {
  const { orgId, workspaceId, userId, idempotencyKey, selection, nowMs = Date.now() } = opts;
  const prior = _resByKey.get(orgId, idempotencyKey);
  if (prior) return { reservation: prior, replay: true };

  const row = findRow(selection);
  if (!row) throw new CreditError('unknown_model', 'That model, resolution and quality is not on the rate card.');
  const price = priceOf(row);

  ensureIncludedGrant(orgId, nowMs);
  const bal = balance(orgId, nowMs);
  if (bal.total < price.credits) {
    throw new CreditError('insufficient_credits', 'Not enough credits for this image.',
      { needed: price.credits, balance: bal });
  }
  const fromIncluded = Math.min(Math.max(0, bal.included), price.credits);
  const fromPurchased = price.credits - fromIncluded;

  const id = crypto.randomUUID();
  const t = nowSec(nowMs);
  _resInsert.run({
    id, org_id: orgId, workspace_id: workspaceId || null, user_id: userId || null, key: idempotencyKey,
    provider: row.provider, model: row.model, resolution: row.resolution, quality: row.quality,
    credits: price.credits, from_included: fromIncluded, from_purchased: fromPurchased, period: bal.period,
    provider_cost: price.provider_cost_usd_micros, charge: price.charge_usd_micros, t,
  });
  const common = {
    org_id: orgId, reason: 'image_debit', provider: row.provider, model: row.model,
    resolution: row.resolution, quality: row.quality, ref: id, user_id: userId, workspace_id: workspaceId, created_at: t,
  };
  // Cost/charge recorded once, on the first row, so SUM over the ledger never double-counts them.
  let first = true;
  const share = (n) => { const out = first ? { provider_cost: price.provider_cost_usd_micros, charge: price.charge_usd_micros } : {}; first = false; return out; };
  if (fromIncluded) append({ ...common, ...share(), delta: -fromIncluded, bucket: 'included', period: bal.period });
  if (fromPurchased) append({ ...common, ...share(), delta: -fromPurchased, bucket: 'purchased' });
  return { reservation: _resById.get(id), replay: false, row };
});

const _commit = db.prepare("UPDATE ai_credit_reservations SET status = 'committed', content_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'");
function commit(id, contentId, nowMs = Date.now()) {
  return _commit.run(contentId, nowSec(nowMs), id).changes === 1;
}

const _release = db.prepare("UPDATE ai_credit_reservations SET status = 'released', error = ?, error_status = ?, updated_at = ? WHERE id = ? AND status = 'pending'");
/** Refund a pending reservation into the buckets it came from. Idempotent: a second call is a no-op. */
const release = db.transaction((id, error, errorStatus, nowMs = Date.now()) => {
  const r = _resById.get(id);
  if (!r || r.status !== 'pending') return false;
  if (_release.run(String(error || 'failed').slice(0, 300), errorStatus || null, nowSec(nowMs), id).changes !== 1) return false;
  const common = {
    org_id: r.org_id, reason: 'image_refund', provider: r.provider, model: r.model,
    resolution: r.resolution, quality: r.quality, ref: r.id, user_id: r.user_id, workspace_id: r.workspace_id,
    created_at: nowSec(nowMs),
  };
  if (r.from_included) append({ ...common, delta: r.from_included, bucket: 'included', period: r.included_period });
  if (r.from_purchased) append({ ...common, delta: r.from_purchased, bucket: 'purchased' });
  return true;
});

/** Refund every attempt left pending by a crash. Run at boot and periodically. */
/*
 * ⚠️ NEVER SHORTER THAN A LIVE ATTEMPT CAN TAKE. A sweep that releases a reservation whose request
 * is still running refunds an image that is about to be delivered. The window is clamped to the
 * provider timeout plus five minutes for ingest, whatever the env says.
 */
function staleWindowSec() {
  return Math.max(config.aiHosted.reservationStaleSec, Math.ceil(config.aiHosted.providerTimeoutMs / 1000) + 300);
}

function sweepStale(nowMs = Date.now()) {
  const cutoff = nowSec(nowMs) - staleWindowSec();
  const stale = db.prepare("SELECT id FROM ai_credit_reservations WHERE status = 'pending' AND created_at < ?").all(cutoff);
  let n = 0;
  for (const s of stale) if (release(s.id, 'abandoned attempt (server restarted or timed out)', 500, nowMs)) n++;
  return n;
}

/* ------------------------------ purchases & admin ------------------------------ */

function packById(id) { return CARD.PACKS.find((p) => p.id === id) || null; }

/**
 * Record a paid pack. ONLY call this from a verified payment (the Stripe webhook). Idempotent on
 * `ref` (the Checkout Session id): Stripe redelivers, and a redelivery must not grant twice.
 */
function recordPurchase({ orgId, packId, ref, userId, nowMs = Date.now() }) {
  const pack = packById(packId);
  if (!pack || !orgId || !ref) return { applied: false, reason: 'bad_request' };
  try {
    append({ org_id: orgId, delta: pack.credits, reason: 'purchase', bucket: 'purchased', ref,
      charge: pack.usd_cents * 10000, user_id: userId, created_at: nowSec(nowMs) });
    return { applied: true, credits: pack.credits };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { applied: false, reason: 'already_applied' };
    throw e;
  }
}

/** Platform-admin adjustment, into the purchased (non-expiring) bucket. Never below zero. */
const adminAdjust = db.transaction(({ orgId, delta, userId, ref, nowMs = Date.now() }) => {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000000) throw new CreditError('bad_delta', 'delta must be a non-zero integer');
  if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(orgId)) throw new CreditError('no_org', 'Organization not found');
  const bal = balance(orgId, nowMs);
  if (bal.purchased + delta < 0) throw new CreditError('would_go_negative', 'That would take the purchased balance below zero.', { balance: bal });
  append({ org_id: orgId, delta, reason: 'admin_adjust', bucket: 'purchased', ref: ref ? String(ref).slice(0, 120) : null,
    user_id: userId, created_at: nowSec(nowMs) });
  return balance(orgId, nowMs);
});

/** This month's committed usage, by model/tier. */
function usageThisMonth(orgId, nowMs = Date.now()) {
  const month = billing.utcMonth(nowMs);
  const [y, m] = month.split('-').map(Number);
  const from = Date.UTC(y, m - 1, 1) / 1000;
  const to = Date.UTC(y, m, 1) / 1000;
  return db.prepare(`SELECT provider, model, resolution, quality, COUNT(*) AS images, SUM(credits) AS credits
      FROM ai_credit_reservations WHERE org_id = ? AND status = 'committed' AND created_at >= ? AND created_at < ?
      GROUP BY provider, model, resolution, quality ORDER BY credits DESC`).all(orgId, from, to);
}

function rateCardAge(nowMs = Date.now()) {
  const days = Math.floor((nowMs - Date.parse(CARD.VERIFIED_AT + 'T00:00:00Z')) / 86400000);
  return { verified_at: CARD.VERIFIED_AT, age_days: days, stale: days > CARD.STALE_AFTER_DAYS, stale_after_days: CARD.STALE_AFTER_DAYS };
}

module.exports = {
  MICROS_PER_CREDIT, CreditError,
  rateCard, priceOf, staleWindowSec, findRow, orgScreenBill, includedFor, ensureIncludedGrant, balance,
  reserve, commit, release, sweepStale, packById, recordPurchase, adminAdjust, usageThisMonth, rateCardAge,
  PACKS: CARD.PACKS, HIGHLIGHT: CARD.HIGHLIGHT,
  __resetCardForTests: () => { _card = null; },
};
