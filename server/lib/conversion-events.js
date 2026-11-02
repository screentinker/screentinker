'use strict';

/*
 * 3.0: the trial-to-paid funnel, measured. 2.x had no record of signup -> first screen -> limit hit
 * -> checkout, so nobody could say where trials were lost or whether a change helped.
 *
 * Deliberately small and boring:
 * - HOSTED ONLY. Nothing is written when SELF_HOSTED is set: a self-hosted operator is not a funnel.
 * - Closed vocabulary (EVENTS). A client can only report the CLIENT_EVENTS subset, and an unknown
 *   name is dropped, so this table cannot become a free-form log anyone can fill.
 * - meta is a small JSON object of short scalar values (a plan id, a limit code), never content.
 * - Never throws into the caller: instrumentation must not be the reason a pairing fails.
 */

const config = require('../config');

const EVENTS = new Set([
  // server-side
  'signup', 'first_pair', 'limit_hit', 'checkout_start', 'checkout_complete', 'trial_expired',
  'subscription_cancelled',   // routes/stripe.js on customer.subscription.deleted: the feedback loop's "why did you leave"
  // client-side (also listed in CLIENT_EVENTS)
  'onboarding_started', 'onboarding_completed', 'onboarding_skipped', 'sample_content_used',
  'first_publish', 'billing_view', 'upgrade_prompt_shown', 'upgrade_prompt_clicked',
  'trial_banner_clicked', 'locked_feature_viewed',
]);
const CLIENT_EVENTS = new Set([
  'onboarding_started', 'onboarding_completed', 'onboarding_skipped', 'sample_content_used',
  'first_publish', 'billing_view', 'upgrade_prompt_shown', 'upgrade_prompt_clicked',
  'trial_banner_clicked', 'locked_feature_viewed',
]);
// Events that only mean something once per account: a second "first_pair" is noise.
const ONCE = new Set(['signup', 'first_pair', 'first_publish', 'onboarding_completed', 'onboarding_skipped', 'checkout_complete']);
// A client re-rendering a banner must not count as forty views.
const DEDUPE_SECONDS = 600;

function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  for (const [k, v] of Object.entries(meta).slice(0, 8)) {
    if (!/^[a-z_]{1,32}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 64);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function enabled() { return !config.selfHosted; }

/** Record one event. Returns true when a row was written. */
function record(db, { userId = null, workspaceId = null, event, meta = null } = {}) {
  if (!enabled() || !EVENTS.has(event)) return false;
  try {
    if (userId && ONCE.has(event)) {
      if (db.prepare('SELECT 1 FROM conversion_events WHERE user_id = ? AND event = ? LIMIT 1').get(userId, event)) return false;
    } else if (userId) {
      const recent = db.prepare(`SELECT 1 FROM conversion_events WHERE user_id = ? AND event = ?
                                   AND COALESCE(meta, '') = COALESCE(?, '') AND created_at > strftime('%s','now') - ? LIMIT 1`)
        .get(userId, event, cleanMeta(meta), DEDUPE_SECONDS);
      if (recent) return false;
    }
    db.prepare('INSERT INTO conversion_events (user_id, workspace_id, event, meta) VALUES (?, ?, ?, ?)')
      .run(userId, workspaceId, event, cleanMeta(meta));
    return true;
  } catch (e) {
    console.warn(`[conversion] could not record ${event}: ${e.message}`);
    return false;
  }
}

/**
 * Funnel over the last `days`: distinct accounts per step, in order, counted among accounts that
 * signed up in the window (so the ratios are cohort ratios, not a mix of old and new accounts).
 */
function funnel(db, { days = 30 } = {}) {
  const since = Math.floor(Date.now() / 1000) - Math.max(1, Math.min(365, days)) * 86400;
  const cohort = `SELECT user_id FROM conversion_events WHERE event = 'signup' AND created_at >= ${since}`;
  const step = (event) => db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM conversion_events
                                      WHERE event = ? AND user_id IN (${cohort})`).get(event).n;
  const steps = ['signup', 'onboarding_completed', 'first_pair', 'first_publish', 'limit_hit',
    'upgrade_prompt_clicked', 'billing_view', 'checkout_start', 'checkout_complete'];
  const limitHits = db.prepare(`SELECT json_extract(meta, '$.code') AS code, COUNT(*) AS n FROM conversion_events
                                WHERE event = 'limit_hit' AND created_at >= ? GROUP BY code ORDER BY n DESC`).all(since);
  return { days, since, steps: steps.map((e) => ({ event: e, accounts: step(e) })), limit_hits: limitHits };
}

module.exports = { record, funnel, enabled, EVENTS, CLIENT_EVENTS, cleanMeta };
