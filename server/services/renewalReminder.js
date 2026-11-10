// Renewal reminders for manually-billed / comped accounts.
//
// WHY. An account billed by PO or invoice (plan_comped, or any account given a renewal_at) has no
// Stripe subscription, so nothing renews it and nothing warns anyone it is coming up — the renewal
// has to be watched by hand. This sends a reminder to the account and CCs the platform admins at
// 90, 60, 30 and 7 days before users.renewal_at, so the renewal is never missed.
//
// WHAT RUNS, once a day at RUN_HOUR_UTC: for every user with renewal_at set in the future, work out
// how many days remain and which single milestone band that falls in (<=7, <=30, <=60, <=90), and
// if that milestone has not already been sent for the current renewal_at, email it once.
//
// BANDS, not thresholds: the due milestone is the SMALLEST of [7,30,60,90] that is >= days-left, so
// each run sends at most one reminder. Setting renewal_at only 7 days out fires the 7-day reminder
// alone, not all four; a date a year out fires 90 first, then 60, 30, 7 as time passes.
//
// RECIPIENTS: to = the account's own email; cc = every platform admin (so the operator is always
// copied) plus RENEWAL_CC (comma-separated) if set. If the account has opted out of mail
// (email_alerts = 0) the reminder still goes to the admins — the point is that WE do not miss it.
//
// GATING: off entirely on a self-hosted server (config.selfHosted). The emails additionally need
// HOSTED_INSTANCE=true (same belt as trialExpiry/activationNudge: a bulk sweep must never mail a
// self-hoster's users), a configured transport and APP_URL.
//
// IDEMPOTENCY: renewal_reminders(user_id, milestone_days, renewal_at). One row per milestone sent.
// Moving renewal_at makes the stored rows stale (their renewal_at no longer matches), so they are
// cleared and the milestones that are still ahead re-arm for the new date.

const config = require('../config');
const { db } = require('../db/database');
const emailSvc = require('./email');
const { PLATFORM_ROLES } = require('../middleware/auth');

const RUN_HOUR_UTC = 13;              // before trialExpiry(14)/freshness(9 earlier); a quiet slot
const MILESTONES = [7, 30, 60, 90];   // ascending; a band is (prev, m]
const DAY = 86400;
const BILLING_URL = 'https://screentinker.com/app#/billing';

function isEnabled() { return !config.selfHosted; }
function isHosted() { return process.env.HOSTED_INSTANCE === 'true'; }

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function displayName(u) {
  return (u && u.name && u.name.trim()) ? u.name.trim() : String(u.email || '').split('@')[0];
}

/**
 * The single milestone a reminder is due at, or null. The smallest milestone >= daysLeft: daysLeft
 * 5->7, 20->30, 45->60, 88->90, 120->null (too early), 0 or less->null (already due/past).
 */
function dueMilestone(daysLeft, milestones = MILESTONES) {
  if (daysLeft <= 0) return null;
  for (const m of [...milestones].sort((a, b) => a - b)) {
    if (daysLeft <= m) return m;
  }
  return null;
}

/** Active platform admins' emails, for the private BCC copy (disabled admins excluded). */
function adminEmails(database) {
  const ph = PLATFORM_ROLES.map(() => '?').join(',');
  try {
    return database.prepare(
      `SELECT DISTINCT email FROM users
         WHERE role IN (${ph}) AND email IS NOT NULL AND email != '' AND disabled_at IS NULL`
    ).all(...PLATFORM_ROLES).map((r) => r.email);
  } catch {
    // Older schema without disabled_at: fall back without the filter rather than returning nobody.
    try {
      return database.prepare(
        `SELECT DISTINCT email FROM users WHERE role IN (${ph}) AND email IS NOT NULL AND email != ''`
      ).all(...PLATFORM_ROLES).map((r) => r.email);
    } catch { return []; }
  }
}

/** Extra CC addresses from RENEWAL_CC (comma-separated). */
function envCc() {
  return String(process.env.RENEWAL_CC || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Accounts with a future renewal_at and the milestone each is currently in, minus milestones already
 * sent for that exact renewal_at. Also returns stale rows (renewal_at moved) to clear.
 */
function renewalCandidates(database, now) {
  // Only manually-billed accounts: a live Stripe subscription renews itself (and Stripe emails), and
  // a free plan has nothing to renew. Both would contradict "self-serve accounts are unaffected".
  const users = database.prepare(
    `SELECT id, email, name, plan_id, plan_comped, renewal_at, COALESCE(email_alerts,1) AS email_alerts
       FROM billing_accounts
      WHERE renewal_at IS NOT NULL
        AND renewal_at > CAST(? AS INTEGER)
        AND plan_id != 'free'
        AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')`
  ).all(now);
  const out = [];
  for (const u of users) {
    const daysLeft = Math.ceil((u.renewal_at - now) / DAY);
    const m = dueMilestone(daysLeft);
    if (!m) continue;
    const sent = database.prepare(
      'SELECT renewal_at FROM renewal_reminders WHERE user_id = ? AND milestone_days = ?'
    ).get(u.id, m);
    if (sent && sent.renewal_at === u.renewal_at) continue;   // already sent for this date
    out.push({ user: u, milestone: m, daysLeft, staleFor: sent ? sent.renewal_at : null });
  }
  return out;
}

function reminderText({ name, plan, days, renewalDate, comped }) {
  return `Hi ${name},

This is a heads-up that the ScreenTinker ${plan} plan for this account is up
for renewal in ${days} ${days === 1 ? 'day' : 'days'}, on ${renewalDate}.

${comped
  ? 'This account is billed by arrangement (PO / invoice), so it will not renew\nautomatically. To keep it running past the date above, please have your\nteam process the renewal, or reply to this email and we will sort it out.'
  : 'To keep everything running past the date above, renew from the Billing page:\n\n  -> ' + BILLING_URL}

Nothing changes before then, and nothing is ever deleted.

- ScreenTinker`;
}
function reminderHtml({ name, plan, days, renewalDate, comped }) {
  const body = comped
    ? 'This account is billed by arrangement (PO / invoice), so it will <b>not renew automatically</b>. '
      + 'To keep it running past the date above, please have your team process the renewal, or just reply to this email and we will sort it out.'
    : `To keep everything running past the date above, renew from the <a href="${BILLING_URL}">Billing page</a>.`;
  return `<div style="font-family:sans-serif;line-height:1.5">
<p>Hi ${htmlEscape(name)},</p>
<p>This is a heads-up that the ScreenTinker <b>${htmlEscape(plan)}</b> plan for this account is up for
renewal in <b>${days} ${days === 1 ? 'day' : 'days'}</b>, on <b>${htmlEscape(renewalDate)}</b>.</p>
<p>${body}</p>
<p>Nothing changes before then, and nothing is ever deleted.</p>
<p>- ScreenTinker</p></div>`;
}

/**
 * The daily run. Injectable for tests: db, email service, now (epoch s), appUrl, cfg, cc override.
 * Returns a summary { skipped?, sent, cleared, milestones:{...} }.
 */
async function run({ db: database = db, email = emailSvc, now = Math.floor(Date.now() / 1000),
                     cfg = config, hosted = isHosted(), ccOverride = null } = {}) {
  if (cfg.selfHosted) return { skipped: 'self_hosted', sent: 0 };

  const cands = renewalCandidates(database, now);
  // Clear stale milestone rows (renewal_at moved) so future milestones re-arm.
  let cleared = 0;
  for (const c of cands) {
    if (c.staleFor != null) {
      database.prepare('DELETE FROM renewal_reminders WHERE user_id = ? AND milestone_days = ?')
        .run(c.user.id, c.milestone);
      cleared++;
    }
  }
  const mailable = hosted && email.isConfigured();
  // Visible CC is only the explicitly-configured RENEWAL_CC (e.g. billing@), so the operator can be
  // on the thread on purpose. Platform-admin addresses go in a PRIVATE BCC — never exposed to the
  // external customer. ccOverride (tests) stands in for the admin set.
  const visibleCc = ccOverride ? [] : envCc();
  const admins = ccOverride || adminEmails(database);
  let sent = 0;
  const milestones = {};
  for (const c of cands) {
    const u = c.user;
    const plan = database.prepare('SELECT display_name FROM plans WHERE id = ?').get(u.plan_id);
    const planName = (plan && plan.display_name) || (u.plan_id || 'current');
    const renewalDate = new Date(u.renewal_at * 1000).toISOString().slice(0, 10);
    const fields = { name: displayName(u), plan: planName, days: c.daysLeft, renewalDate, comped: !!u.plan_comped };
    const subject = `ScreenTinker renewal in ${c.daysLeft} days (${renewalDate})`;

    // Two shapes, never mixed:
    //  - email_alerts on  -> customer-facing reminder TO the account, admins BCC'd privately, carries
    //    the ACCOUNT's unsubscribe token (so the customer, not an admin, can opt out).
    //  - email_alerts off -> the account opted out, so it is NOT mailed; an internal heads-up goes to
    //    the admins only (no customer unsubscribe token). If there are no admins, there is nothing to
    //    send and nothing is recorded, so it can still go out once an admin exists.
    let result = { sent: false, reason: 'mail_off' };
    if (u.email_alerts) {
      if (mailable) {
        result = await email.sendEmail({
          to: u.email,
          cc: [...new Set(visibleCc.filter((a) => a && a.toLowerCase() !== u.email.toLowerCase()))],
          bcc: [...new Set(admins.filter((a) => a && a.toLowerCase() !== u.email.toLowerCase()))],
          subject,
          text: reminderText(fields),
          html: reminderHtml(fields),
          unsubscribeUserId: u.id,
          unsubscribeList: 'alerts',
        }).catch((e) => ({ sent: false, reason: 'threw', error: e && e.message }));
      }
    } else {
      const recips = [...new Set([...admins, ...visibleCc].filter(Boolean))];
      if (!recips.length) { result = { sent: false, reason: 'opted_out_no_admins' }; }
      else if (mailable) {
        result = await email.sendEmail({
          to: recips[0],
          bcc: recips.slice(1),
          subject: `[internal] ${subject} — ${u.email} (opted out of alerts)`,
          text: `Heads-up for the operator (the account opted out of alerts, so it was not emailed):\n\n`
            + `  Account:  ${u.email}\n  Plan:     ${planName}\n  Renews:   ${renewalDate} (${c.daysLeft} days)\n`
            + `  Billing:  ${u.plan_comped ? 'comped / PO' : 'self-serve'}\n`,
          html: `<div style="font-family:sans-serif;line-height:1.5"><p>Heads-up for the operator — the account opted out of alerts, so it was <b>not</b> emailed:</p>`
            + `<ul><li>Account: <b>${htmlEscape(u.email)}</b></li><li>Plan: ${htmlEscape(planName)}</li>`
            + `<li>Renews: <b>${htmlEscape(renewalDate)}</b> (${c.daysLeft} days)</li>`
            + `<li>Billing: ${u.plan_comped ? 'comped / PO' : 'self-serve'}</li></ul></div>`,
        }).catch((e) => ({ sent: false, reason: 'threw', error: e && e.message }));
      }
    }

    // Decide whether to stamp this milestone as done:
    //  - delivered: yes.
    //  - instance is not mailing at all (!mailable): yes, or it would re-fire every day forever.
    //  - opted out with no admins to tell: NO — nothing happened, so leave it to fire once an admin
    //    exists.
    //  - transient failure on a mailing instance (smtp/graph error, threw, dev_restricted): NO, so
    //    the next daily run retries.
    let record;
    if (result.reason === 'opted_out_no_admins') record = false;
    else if (result.sent) record = true;
    else if (!mailable) record = true;
    else record = false;
    if (!record) {
      if (mailable && result.reason !== 'opted_out_no_admins') {
        console.warn(`[renewal] send failed for ${u.email} (${result.reason}); will retry next run`);
      }
      continue;
    }
    database.prepare(
      `INSERT INTO renewal_reminders (user_id, milestone_days, renewal_at, sent_at)
       VALUES (?, ?, ?, CAST(? AS INTEGER))
       ON CONFLICT(user_id, milestone_days) DO UPDATE SET renewal_at = excluded.renewal_at, sent_at = excluded.sent_at`
    ).run(u.id, c.milestone, u.renewal_at, now);
    if (result.sent) { sent++; milestones[c.milestone] = (milestones[c.milestone] || 0) + 1; }
  }
  return { sent, cleared, mailed: mailable, milestones };
}

function msUntilNextRun(at = new Date()) {
  const next = new Date(at);
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (next <= at) next.setUTCDate(next.getUTCDate() + 1);
  return next - at;
}

function startRenewalReminder() {
  if (!isEnabled()) { console.log('[renewal] self-hosted: reminders off'); return; }
  const schedule = () => {
    const t = setTimeout(async () => {
      try { const r = await run(); console.log(`[renewal] run: ${JSON.stringify(r)}`); }
      catch (e) { console.error(`[renewal] run failed: ${e && e.message}`); }
      schedule();
    }, msUntilNextRun());
    if (t.unref) t.unref();
  };
  schedule();
  console.log('[renewal] reminders scheduled (13:00 UTC daily)');
}

module.exports = {
  run, startRenewalReminder, renewalCandidates, dueMilestone, adminEmails,
  msUntilNextRun, RUN_HOUR_UTC, MILESTONES,
};
