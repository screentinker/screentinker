'use strict';

/*
 * The feedback loop's daily run (lib/feedback.js), at 15:00 UTC (an hour after the trial sweep, so
 * a trial that lapses today is not asked about it in the same breath as being told).
 *
 *   1. FOLLOW-UP EMAILS. A moment that happened away from the dashboard gets one short email a day
 *      or more after it: a trial that lapsed to Free unpaid ("what stopped you?") and a cancelled
 *      subscription ("what made you leave?"). Its 1-5 links open a page with that rating chosen
 *      (routes/feedback.js /respond); nothing is recorded until they press Send. Once per user per
 *      moment (feedback_followups), never to someone who already answered that moment in the app,
 *      never to an opted-out or unreachable address (the trial emails' REACHABLE rule).
 *   2. THE DIGEST, to every platform admin: what came in over the last day (every answer, with what
 *      that account went on to do), the week's numbers, the month's top reasons, and the funnel.
 *      Sent only when there is something new. FEEDBACK_DISCORD_WEBHOOK (a discord.com webhook URL)
 *      also gets a one-paragraph version.
 *
 * GATING. Off when SELF_HOSTED (nothing is recorded there anyway). The follow-up emails also need
 * HOSTED_INSTANCE=true, like the trial emails: a bulk send must never reach a self-hoster's users
 * by accident. Both need a mail transport and APP_URL; without them this logs and does nothing.
 */

const config = require('../config');
const feedback = require('../lib/feedback');

const RUN_HOUR_UTC = 15;
const DAY = 86400;
const FOLLOWUP_MIN_AGE = DAY;          // a day after the moment, not the same day
const FOLLOWUP_MAX_AGE = 5 * DAY;      // and not weeks later, when it reads as broken
const REACHABLE = "COALESCE(u.email_alerts, 1) = 1 AND (u.email_verified = 1 OR u.last_login IS NOT NULL)";
const SUBJECT = {
  trial_ended: 'Quick question about your ScreenTinker trial',
  cancelled: 'Quick question before you go',
};
const ASK = {
  trial_ended: 'Your ScreenTinker trial ended last week. Could you tell us what stopped you from carrying on? One click is enough, and every answer is read.',
  cancelled: 'You recently cancelled ScreenTinker. Could you tell us what made you leave? One click is enough, and every answer is read.',
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function appBase(appUrl) { const b = String(appUrl || '').trim().replace(/\/+$/, ''); return /^https?:\/\//.test(b) ? b : null; }
function nameOf(u) { return (u.name && u.name.trim()) ? u.name.trim().split(/\s+/)[0] : String(u.email).split('@')[0]; }

/** Who is owed a follow-up email now, per moment. */
function followupCandidates(db, at) {
  const lo = at - FOLLOWUP_MAX_AGE, hi = at - FOLLOWUP_MIN_AGE;
  const notYet = (trigger) => `NOT EXISTS (SELECT 1 FROM feedback_followups x WHERE x.user_id = u.id AND x.trigger = '${trigger}')
       AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.user_id = u.id AND f.trigger = '${trigger}')`;
  const trial = db.prepare(`SELECT u.id, u.email, u.name FROM users u
     WHERE u.trial_expired_at BETWEEN ? AND ? AND u.plan_id = 'free' AND u.stripe_subscription_id IS NULL
       AND ${REACHABLE} AND ${notYet('trial_ended')}`).all(lo, hi).map((u) => ({ ...u, trigger: 'trial_ended' }));
  const cancelled = db.prepare(`SELECT DISTINCT u.id, u.email, u.name FROM users u
       JOIN conversion_events c ON c.user_id = u.id AND c.event = 'subscription_cancelled' AND c.created_at BETWEEN ? AND ?
     WHERE u.stripe_subscription_id IS NULL AND ${REACHABLE} AND ${notYet('cancelled')}`).all(lo, hi).map((u) => ({ ...u, trigger: 'cancelled' }));
  return [...cancelled, ...trial];
}

function followupEmail(u, base, at) {
  const token = feedback.makeToken(u.id, u.trigger, { at });
  const link = (n) => `${base}/api/feedback/respond?t=${encodeURIComponent(token)}&r=${n}`;
  const buttons = [1, 2, 3, 4, 5].map((n) => `<a href="${esc(link(n))}" style="display:inline-block;width:44px;padding:10px 0;margin:0 4px;border:1px solid #cbd5e1;border-radius:8px;text-align:center;color:#0f172a;text-decoration:none;font-weight:700">${n}</a>`).join('');
  const html = `<div style="font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;max-width:560px">
<p>Hi ${esc(nameOf(u))},</p><p>${esc(ASK[u.trigger])}</p>
<p style="margin:18px 0 6px;color:#475569;font-size:13px">How well did ScreenTinker work for you? (1 = not at all, 5 = very well)</p>
<p style="margin:0 0 18px">${buttons}</p>
<p>Or just reply to this email. It comes straight to me.</p><p>Thanks,<br>Dan, ScreenTinker</p></div>`;
  const text = `Hi ${nameOf(u)},\n\n${ASK[u.trigger]}\n\nHow well did ScreenTinker work for you? Pick one:\n` +
    [1, 2, 3, 4, 5].map((n) => `${n}: ${link(n)}`).join('\n') + '\n\nOr just reply to this email. It comes straight to me.\n\nThanks,\nDan, ScreenTinker\n';
  return { subject: SUBJECT[u.trigger], html, text };
}

/** The admin digest for the day: null when there is nothing new to say. */
function buildDigest(db, at, base) {
  const day = feedback.summary(db, { days: 1, at });
  const week = feedback.summary(db, { days: 7, at });
  const month = feedback.summary(db, { days: 30, at });
  const count = (event, days) => db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM conversion_events WHERE event = ? AND created_at >= ?`)
    .get(event, at - days * DAY).n;
  const funnel = ['signup', 'first_pair', 'first_publish', 'limit_hit', 'checkout_start', 'checkout_complete', 'trial_expired', 'subscription_cancelled']
    .map((e) => ({ event: e, day: count(e, 1), week: count(e, 7) }));
  const signupsToday = funnel[0].day;
  if (!day.total && !signupsToday && !funnel.find((f) => f.event === 'checkout_complete').day) return null;

  const stars = (r) => (r == null ? 'no rating' : `${r}/5`);
  const journey = (j) => [j.screens ? `${j.screens} screen${j.screens === 1 ? '' : 's'}` : 'no screens', j.first_publish ? 'published' : null,
    j.limit_hit ? 'hit a limit' : null, j.checkout_start ? 'started checkout' : null, j.checkout_complete ? 'PAID' : null].filter(Boolean).join(', ');
  const lines = day.entries.map((e) => `- [${e.trigger}] ${stars(e.rating)} ${e.email || 'unknown'} (${journey(e.journey)})` +
    (e.reasons.length ? `\n    reasons: ${e.reasons.join(', ')}` : '') + (e.comment ? `\n    "${e.comment.replace(/\s+/g, ' ').slice(0, 600)}"` : ''));
  const reasons = month.reasons.slice(0, 8).map((r) => `${r.trigger}/${r.reason}: ${r.n}`).join(', ') || 'none yet';
  const text = [
    `ScreenTinker feedback, ${new Date(at * 1000).toISOString().slice(0, 10)}`, '',
    `Last 24h: ${day.total} answer(s), average ${day.average ?? 'n/a'}. Last 7 days: ${week.total}, average ${week.average ?? 'n/a'}.`,
    `Funnel (24h / 7d): ` + funnel.map((f) => `${f.event} ${f.day}/${f.week}`).join(' | '), '',
    day.total ? 'New answers:' : 'No new answers today.', ...lines, '',
    `Top reasons (30 days): ${reasons}`,
    base ? `\nEverything, with a CSV export: ${base}/app#/platform/overview` : '',
  ].join('\n');
  const html = `<div style="font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;max-width:720px">
<h2 style="margin:0 0 8px">ScreenTinker feedback</h2>
<p>Last 24h: <b>${day.total}</b> answer(s), average <b>${esc(day.average ?? 'n/a')}</b>. Last 7 days: <b>${week.total}</b>, average <b>${esc(week.average ?? 'n/a')}</b>.</p>
<table style="border-collapse:collapse;font-size:13px;margin:8px 0 16px">${funnel.map((f) => `<tr><td style="padding:2px 12px 2px 0">${esc(f.event)}</td><td style="padding:2px 8px"><b>${f.day}</b> today</td><td style="padding:2px 8px">${f.week} this week</td></tr>`).join('')}</table>
${day.entries.map((e) => `<div style="border-left:3px solid ${e.rating != null && e.rating <= 2 ? '#dc2626' : '#3b82f6'};padding:6px 12px;margin:10px 0">
<div><b>${esc(stars(e.rating))}</b> · ${esc(e.trigger)} · ${esc(e.email || 'unknown')} <span style="color:#64748b">(${esc(journey(e.journey))})</span></div>
${e.reasons.length ? `<div style="color:#475569">${esc(e.reasons.join(', '))}</div>` : ''}${e.comment ? `<div style="margin-top:4px">“${esc(e.comment)}”</div>` : ''}</div>`).join('') || '<p>No new answers today.</p>'}
<p style="color:#475569">Top reasons (30 days): ${esc(reasons)}</p>
${base ? `<p><a href="${esc(base)}/app#/platform/overview">Everything, with a CSV export</a></p>` : ''}</div>`;
  const short = `Feedback: ${day.total} new today (avg ${day.average ?? 'n/a'}), ${week.total} this week. Signups ${funnel[0].day}, paid ${funnel.find((f) => f.event === 'checkout_complete').day}.` +
    (day.entries.find((e) => e.comment) ? ` Latest: "${day.entries.find((e) => e.comment).comment.replace(/\s+/g, ' ').slice(0, 200)}"` : '');
  return { subject: `Feedback: ${day.total} new, avg ${day.average ?? 'n/a'} · signups ${signupsToday}`, text, html, short };
}

/**
 * One run. db/email/now/appUrl/fetch injected so tests drive it directly. Returns what it did.
 */
async function run({ db = require('../db/database').db, email = require('./email'), now = Math.floor(Date.now() / 1000),
  appUrl = process.env.APP_URL, hosted = process.env.HOSTED_INSTANCE === 'true', cfg = config,
  discordUrl = process.env.FEEDBACK_DISCORD_WEBHOOK, fetchImpl = (typeof fetch === 'function' ? fetch : null) } = {}) {
  const out = { followups: 0, digests: 0, discord: false, skipped: null };
  if (cfg.selfHosted) { out.skipped = 'self_hosted'; return out; }
  const base = appBase(appUrl);
  const canMail = email.isConfigured() && !!base;

  if (canMail && hosted) {
    for (const u of followupCandidates(db, now)) {
      const m = followupEmail(u, base, now);
      // Stamp first: a crash mid-send must not mail the same person twice tomorrow.
      if (db.prepare('INSERT OR IGNORE INTO feedback_followups (user_id, trigger) VALUES (?, ?)').run(u.id, u.trigger).changes !== 1) continue;
      try { await email.sendEmail({ to: u.email, subject: m.subject, html: m.html, text: m.text, unsubscribeUserId: u.id }); out.followups++; }
      catch (e) { console.warn(`[feedback] follow-up to ${u.id} failed: ${e.message}`); }
    }
  }

  const d = buildDigest(db, now, base);
  if (!d) { out.skipped = out.skipped || 'nothing_new'; return out; }
  if (canMail) {
    const admins = db.prepare("SELECT id, email FROM users WHERE role IN ('platform_admin','superadmin') AND email IS NOT NULL AND disabled_at IS NULL").all();
    for (const a of admins) {
      try { await email.sendEmail({ to: a.email, subject: d.subject, html: d.html, text: d.text }); out.digests++; }
      catch (e) { console.warn(`[feedback] digest to ${a.id} failed: ${e.message}`); }
    }
  }
  if (discordUrl && fetchImpl && /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//.test(discordUrl)) {
    try {
      const r = await fetchImpl(discordUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: d.short.slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10000) });
      out.discord = !!(r && r.ok);
    } catch (e) { console.warn(`[feedback] Discord post failed: ${e.message}`); }
  }
  out.digest = d;
  return out;
}

function msUntilNextRun(at = new Date()) {
  const next = new Date(at);
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (next <= at) next.setUTCDate(next.getUTCDate() + 1);
  return next - at;
}

function startFeedbackDigest() {
  if (config.selfHosted) { console.log('[feedback] SELF_HOSTED=true - feedback loop off'); return; }
  const schedule = () => {
    const t = setTimeout(() => {
      run().then((r) => console.log(`[feedback] daily run: ${r.followups} follow-up(s), ${r.digests} digest(s)${r.discord ? ', Discord' : ''}${r.skipped ? ` (${r.skipped})` : ''}`))
        .catch((e) => console.error('[feedback] daily run failed:', e.message));
      schedule();
    }, msUntilNextRun());
    if (t.unref) t.unref();
  };
  schedule();
}

module.exports = { run, startFeedbackDigest, followupCandidates, followupEmail, buildDigest, msUntilNextRun, RUN_HOUR_UTC };
