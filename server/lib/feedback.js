'use strict';

/*
 * The feedback loop: ask people what they thought at the moments that explain the funnel, keep the
 * answers next to what they actually did, and hand the platform admin the lot.
 *
 * WHEN WE ASK (one prompt per moment, ever; at most one prompt every PROMPT_COOLDOWN_DAYS):
 *   cancelled     their subscription ended in the last 30 days         "What made you cancel?"
 *   trial_ended   their trial lapsed to Free in the last 30 days      "What stopped you?"
 *   paid          they paid 3 to 30 days ago                          "What made you choose it?"
 *   trial_day7    7+ days into a trial that is still running         "How is it going?"
 *   first_pair    their first screen was paired 10 min to 14 days ago "How was setting up?"
 *   general       the "Send feedback" link; never prompted
 * The order above is the priority: the moment that says most about conversion wins.
 *
 * WHO IS ASKED. The account itself: not a support session (no users row), not a platform admin
 * (that is us), and only on a hosted server. Self-hosted records and asks nothing, like
 * conversion_events: a self-hosted operator is not our funnel, and nothing here calls home.
 *
 * WHAT IS STORED. A 1-5 rating, ticked reasons from a closed list per moment, and a comment of at
 * most COMMENT_MAX characters. Never content, never anything the client sends outside those fields.
 *
 * EMAIL. A moment that happened away from the dashboard (a lapsed trial, a cancellation) also gets
 * one follow-up email (services/feedback-digest.js) whose 1-5 links carry a signed token. The token
 * names the user and the moment and expires; it can record a rating and a comment for that moment
 * and nothing else.
 */

const crypto = require('crypto');
const config = require('../config');

const TRIGGERS = ['cancelled', 'trial_ended', 'paid', 'trial_day7', 'first_pair', 'general'];
const PROMPTED = ['cancelled', 'trial_ended', 'paid', 'trial_day7', 'first_pair'];
const REASONS = {
  trial_ended: ['price', 'missing_feature', 'hardware', 'too_complex', 'didnt_work', 'just_testing', 'other'],
  cancelled: ['price', 'missing_feature', 'didnt_work', 'switched', 'project_ended', 'other'],
  paid: ['easy_setup', 'price', 'hardware_support', 'features', 'open_source', 'other'],
  trial_day7: [], first_pair: [], general: [],
};
const COMMENT_MAX = 2000;
const PROMPT_COOLDOWN_DAYS = 3;
const TOKEN_TTL_DAYS = 30;
const DAY = 86400;

function enabled(cfg = config) { return !cfg.selfHosted; }
function now() { return Math.floor(Date.now() / 1000); }
function isPlatformRole(role) { return role === 'platform_admin' || role === 'superadmin'; }

/** Which moment, if any, to ask this user about right now. */
function promptFor(db, user, { at = now(), cfg = config } = {}) {
  if (!enabled(cfg) || !user || !user.id || String(user.id).includes(':') || isPlatformRole(user.role)) return null;
  const asked = new Map(db.prepare('SELECT trigger, shown_at FROM feedback_prompts WHERE user_id = ?').all(user.id)
    .map((r) => [r.trigger, r.shown_at]));
  const lastAsked = Math.max(0, ...asked.values());
  if (lastAsked && at - lastAsked < PROMPT_COOLDOWN_DAYS * DAY) return null;
  const u = db.prepare(`SELECT id, plan_id, trial_started, trial_expired_at, stripe_subscription_id, subscription_status
                          FROM users WHERE id = ?`).get(user.id);
  if (!u) return null;
  const ev = (event) => {
    const r = db.prepare('SELECT MAX(created_at) AS t FROM conversion_events WHERE user_id = ? AND event = ?').get(u.id, event);
    return r && r.t ? Number(r.t) : null;
  };
  const within = (t, min, max) => t != null && at - t >= min && at - t <= max;
  const due = {
    cancelled: () => within(ev('subscription_cancelled'), 0, 30 * DAY) && !u.stripe_subscription_id,
    trial_ended: () => u.trial_expired_at != null && within(Number(u.trial_expired_at), 0, 30 * DAY)
      && !u.stripe_subscription_id && u.plan_id === 'free',
    paid: () => within(ev('checkout_complete'), 3 * DAY, 30 * DAY) && !!u.stripe_subscription_id,
    trial_day7: () => u.trial_started != null && !u.stripe_subscription_id && u.trial_expired_at == null
      && at - Number(u.trial_started) >= 7 * DAY && at - Number(u.trial_started) < 14 * DAY,
    first_pair: () => within(ev('first_pair'), 600, 14 * DAY),
  };
  for (const trigger of PROMPTED) {
    if (asked.has(trigger)) continue;
    if (due[trigger]()) return { trigger, reasons: REASONS[trigger] };
  }
  return null;
}

/** Remember that a moment was asked about, so it is never asked again. */
function markShown(db, userId, trigger) {
  if (!PROMPTED.includes(trigger)) return false;
  return db.prepare('INSERT OR IGNORE INTO feedback_prompts (user_id, trigger) VALUES (?, ?)').run(userId, trigger).changes === 1;
}

function markDismissed(db, userId, trigger) {
  markShown(db, userId, trigger);
  db.prepare(`UPDATE feedback_prompts SET dismissed_at = strftime('%s','now') WHERE user_id = ? AND trigger = ? AND answered_at IS NULL`)
    .run(userId, trigger);
}

/**
 * Validate and normalise an answer. Returns { value } or { error }. Reasons outside the moment's
 * closed list are dropped; an answer must carry a rating, a reason or a comment.
 */
function clean(input) {
  const b = input || {};
  const trigger = String(b.trigger || '');
  if (!TRIGGERS.includes(trigger)) return { error: 'Unknown feedback moment' };
  let rating = b.rating == null || b.rating === '' ? null : Number(b.rating);
  if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { error: 'Rating must be 1 to 5' };
  const allowed = new Set(REASONS[trigger]);
  const reasons = Array.isArray(b.reasons) ? [...new Set(b.reasons.map(String).filter((r) => allowed.has(r)))] : [];
  const comment = typeof b.comment === 'string' ? b.comment.replace(/\u0000/g, '').trim().slice(0, COMMENT_MAX) : '';
  if (rating == null && !reasons.length && !comment) return { error: 'Add a rating, a reason or a comment' };
  return { value: { trigger, rating, reasons, comment } };
}

/** Store one answer. Returns the new row id, or null when this server records nothing. */
function save(db, { userId, workspaceId = null, source = 'app', cfg = config, ...input }) {
  if (!enabled(cfg)) return null;
  const c = clean(input);
  if (c.error) { const e = new Error(c.error); e.status = 400; throw e; }
  const v = c.value;
  const plan = userId ? (db.prepare('SELECT plan_id FROM users WHERE id = ?').get(userId) || {}).plan_id : null;
  const r = db.prepare(`INSERT INTO feedback (user_id, workspace_id, trigger, rating, reasons, comment, plan_id, source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, workspaceId, v.trigger, v.rating, v.reasons.length ? JSON.stringify(v.reasons) : null, v.comment || null, plan || null,
      source === 'email' ? 'email' : 'app');
  if (userId && PROMPTED.includes(v.trigger)) {
    markShown(db, userId, v.trigger);
    db.prepare(`UPDATE feedback_prompts SET answered_at = strftime('%s','now') WHERE user_id = ? AND trigger = ?`).run(userId, v.trigger);
  }
  return Number(r.lastInsertRowid);
}

/* ------------------------------------------------------------------ signed email links */

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function sign(body, secret) { return b64url(crypto.createHmac('sha256', String(secret)).update(`feedback:${body}`).digest()); }

/** A token that lets its holder answer ONE moment for ONE user, until it expires. */
function makeToken(userId, trigger, { at = now(), secret = config.jwtSecret } = {}) {
  const body = b64url(JSON.stringify({ u: userId, k: trigger, e: at + TOKEN_TTL_DAYS * DAY }));
  return `${body}.${sign(body, secret)}`;
}

/** { userId, trigger } for a valid, unexpired token; null otherwise. */
function readToken(token, { at = now(), secret = config.jwtSecret } = {}) {
  if (typeof token !== 'string' || token.length > 600 || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  const want = sign(body, secret);
  if (!mac || mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
  if (!p || typeof p.u !== 'string' || !TRIGGERS.includes(p.k) || !(Number(p.e) > at)) return null;
  return { userId: p.u, trigger: p.k };
}

/* ------------------------------------------------------------------ what the admin sees */

/** What each account went on to do, from conversion_events: the funnel next to the words. */
function journeyOf(db, userIds) {
  const out = {};
  if (!userIds.length) return out;
  const ph = userIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT user_id, event, COUNT(*) AS n FROM conversion_events
                            WHERE user_id IN (${ph}) GROUP BY user_id, event`).all(...userIds);
  for (const r of rows) (out[r.user_id] = out[r.user_id] || {})[r.event] = r.n;
  const devs = db.prepare(`SELECT user_id, COUNT(*) AS n FROM devices WHERE user_id IN (${ph}) GROUP BY user_id`).all(...userIds);
  for (const r of devs) (out[r.user_id] = out[r.user_id] || {}).screens = r.n;
  return out;
}

/** Everything in the window: totals, average per moment, reason counts, and every answer. */
function summary(db, { days = 30, at = now(), limit = 500 } = {}) {
  const since = at - Math.max(1, Math.min(365, days)) * DAY;
  const rows = db.prepare(`SELECT f.*, u.email, u.name AS user_name FROM feedback f LEFT JOIN users u ON u.id = f.user_id
                            WHERE f.created_at >= ? ORDER BY f.created_at DESC LIMIT ?`).all(since, Math.min(5000, limit));
  const byTrigger = {};
  const reasons = {};
  for (const r of rows) {
    const t = (byTrigger[r.trigger] = byTrigger[r.trigger] || { trigger: r.trigger, answers: 0, rated: 0, sum: 0, low: 0 });
    t.answers++;
    if (r.rating != null) { t.rated++; t.sum += r.rating; if (r.rating <= 2) t.low++; }
    for (const reason of (r.reasons ? JSON.parse(r.reasons) : [])) {
      const k = `${r.trigger}:${reason}`; reasons[k] = (reasons[k] || 0) + 1;
    }
  }
  const asked = db.prepare(`SELECT trigger, COUNT(*) AS shown, SUM(answered_at IS NOT NULL) AS answered, SUM(dismissed_at IS NOT NULL) AS dismissed
                              FROM feedback_prompts WHERE shown_at >= ? GROUP BY trigger`).all(since);
  const journeys = journeyOf(db, [...new Set(rows.map((r) => r.user_id).filter(Boolean))]);
  const rated = rows.filter((r) => r.rating != null);
  return {
    enabled: enabled(),
    days, since,
    total: rows.length,
    average: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null,
    by_trigger: Object.values(byTrigger).map((t) => ({ trigger: t.trigger, answers: t.answers, low: t.low,
      average: t.rated ? Math.round((t.sum / t.rated) * 10) / 10 : null })),
    prompts: asked,
    reasons: Object.entries(reasons).map(([k, n]) => ({ trigger: k.split(':')[0], reason: k.split(':')[1], n })).sort((a, b) => b.n - a.n),
    entries: rows.map((r) => ({
      id: r.id, created_at: r.created_at, trigger: r.trigger, rating: r.rating, source: r.source, plan_id: r.plan_id,
      reasons: r.reasons ? JSON.parse(r.reasons) : [], comment: r.comment || '',
      user_id: r.user_id, email: r.email || null, name: r.user_name || null,
      journey: journeys[r.user_id] || {},
    })),
  };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // A cell starting with = + - @ would be run as a formula by a spreadsheet: quote it as text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The same answers as a CSV, one row per answer, with the account's funnel steps alongside. */
function csv(db, opts = {}) {
  const s = summary(db, { ...opts, limit: 5000 });
  const head = ['created_at', 'email', 'trigger', 'rating', 'reasons', 'comment', 'plan', 'source', 'screens',
    'paired', 'published', 'hit_limit', 'checkout_started', 'paid'];
  const lines = [head.join(',')];
  for (const e of s.entries) {
    const j = e.journey;
    lines.push([new Date(e.created_at * 1000).toISOString(), e.email, e.trigger, e.rating, e.reasons.join(' '), e.comment,
      e.plan_id, e.source, j.screens || 0, j.first_pair ? 1 : 0, j.first_publish ? 1 : 0, j.limit_hit ? 1 : 0,
      j.checkout_start ? 1 : 0, j.checkout_complete ? 1 : 0].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  TRIGGERS, PROMPTED, REASONS, COMMENT_MAX, PROMPT_COOLDOWN_DAYS, TOKEN_TTL_DAYS,
  enabled, promptFor, markShown, markDismissed, clean, save, makeToken, readToken, summary, csv, journeyOf, csvCell,
};
