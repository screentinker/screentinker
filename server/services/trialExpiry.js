// Trial expiry: the nightly sweep that ends a lapsed trial, plus the two emails around it.
//
// WHY THIS EXISTS. The trial-expiry check lives in getUserPlan() (middleware/subscription.js) and
// only runs when something calls it: the Billing page, pairing a device, uploading content, a
// device (re)connecting. Logging in and browsing the dashboard do not. So a user who signed up,
// tried it and went quiet stayed on Pro in the database indefinitely — on 2026-09-12 that was 283
// of 421 hosted accounts. Nothing else in the trial story works while that is true: no screen is
// ever blocked, no one is ever asked to pay, the countdown just vanishes from a page most users
// never open.
//
// WHAT RUNS, once a day at SWEEP_HOUR_UTC:
//   1. downgrade  — every lapsed trial is flipped to Free through the SAME expireTrial() helper the
//                   lazy path uses (one predicate, one writer). Each affected screen is then pushed
//                   its (now access-gated) playlist so an extra screen that is currently connected
//                   stops immediately instead of playing on until its next reconnect.
//   2. T-3 email  — "your Pro trial ends in N days", once per user, while ENDING_SOON_DAYS or fewer
//                   remain. What changes, what it costs to keep, reply-to-Dan.
//   3. expiry email — "your Pro trial has ended", once per user, after the downgrade. Which of their
//                   screens stopped, that nothing was deleted, how to bring the screens back.
//
// GATING.
//   - config.selfHosted (SELF_HOSTED=true): the whole service is OFF — nothing scheduled, the sweep
//     returns null. A self-host never bills, so there is nothing to enforce and no one to upsell.
//     (The lazy getUserPlan path is untouched by this file and behaves as it always has.)
//   - HOSTED_INSTANCE=true additionally gates the EMAILS (same rule as activationNudge: a bulk
//     sweep must never mail a self-hoster's user base by accident). The downgrade itself does not
//     need it.
//   - TRIAL_EXPIRED_EMAIL_MAX_AGE_DAYS (default 30): the expiry email only goes to trials that
//     ended within this window. The first sweep on hosted prod flips a months-deep backlog; a
//     "your trial ended" note four months late reads as broken, so the backlog older than the
//     window is downgraded silently. Raise the env var to reach further back on purpose.
//
// Idempotency: users.trial_ending_email_sent_at / trial_expired_email_sent_at, stamped after each
// send; each email goes to a user at most once. expireTrial() is a guarded UPDATE, so re-running the
// downgrade is a no-op. Opt-out: email_alerts = 0 excludes a user from both emails. Unverified
// addresses that never logged in are skipped too — a typo'd signup is not a lead.
//
// ⚠️ Every "now" comparison in SQL here uses CAST(strftime('%s','now') AS INTEGER). strftime
// returns TEXT and SQLite orders every INTEGER below every TEXT, so an un-cast comparison is
// silently always-true or always-false. See the note on findExpiredTrialUserIds.

const config = require('../config');
const { db } = require('../db/database');
const emailSvc = require('./email');
const { TRIAL_DAYS, expireTrial, findExpiredTrialUserIds } = require('../middleware/subscription');

const SWEEP_HOUR_UTC = 14;     // 14:00 UTC daily: mid-morning US, afternoon EU — the emails land in a workday
const ENDING_SOON_DAYS = 3;
const EXPIRED_EMAIL_MAX_AGE_DAYS = Math.max(0, Number(process.env.TRIAL_EXPIRED_EMAIL_MAX_AGE_DAYS) || 30);
const BILLING_URL = 'https://screentinker.com/#/billing';
const DISCORD_URL = 'https://discord.gg/utTdsrqq4Z';

function isEnabled() { return !config.selfHosted; }
function isHosted() { return process.env.HOSTED_INSTANCE === 'true'; }

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function displayName(u) {
  return (u.name && u.name.trim()) ? u.name.trim() : String(u.email).split('@')[0];
}
function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

// The Free plan's limits and the paid ladder, read from the plans table at send time so the
// emails can never drift from what Billing shows or what checkDeviceAccess enforces.
function planFacts() {
  const free = db.prepare("SELECT max_devices, max_storage_mb FROM plans WHERE id = 'free'").get()
    || { max_devices: 1, max_storage_mb: 500 };
  const paid = db.prepare(`
    SELECT display_name, max_devices, price_monthly FROM plans
     WHERE COALESCE(active, 1) = 1 AND price_monthly > 0 AND max_devices != 0
     ORDER BY sort_order ASC, price_monthly ASC`).all();
  return { free, paid };
}
function ladderText(paid) {
  if (!paid.length) return '';
  return paid.map(p => `  - ${p.display_name}: ${p.max_devices === -1 ? 'unlimited' : p.max_devices} ${plural(p.max_devices === -1 ? 2 : p.max_devices, 'screen')}, $${p.price_monthly}/month`).join('\n');
}
function ladderHtml(paid) {
  if (!paid.length) return '';
  return '<ul>' + paid.map(p => `<li><b>${htmlEscape(p.display_name)}</b>: ${p.max_devices === -1 ? 'unlimited' : p.max_devices} ${plural(p.max_devices === -1 ? 2 : p.max_devices, 'screen')}, $${htmlEscape(p.price_monthly)}/month</li>`).join('') + '</ul>';
}

// ---------- T-3 "ends in N days" ----------

function endingSoonText({ name, daysLeft, screens, free, paid }) {
  const d = `${daysLeft} ${plural(daysLeft, 'day')}`;
  const screensLine = screens > free.max_devices
    ? `You have ${screens} screens paired. On the Free plan ${free.max_devices === 1 ? 'only the first one keeps' : `only the first ${free.max_devices} keep`} playing; the rest will show a "Trial Expired" card until you upgrade.`
    : `Your ${screens === 0 ? 'account' : plural(screens, 'screen')} will keep working on the Free plan (${free.max_devices} ${plural(free.max_devices, 'screen')}, ${free.max_storage_mb} MB of content).`;
  return `Hi ${name},

Your ScreenTinker Pro trial ends in ${d}. After that your account moves
to the Free plan.

${screensLine}
Nothing gets deleted: your content, playlists and layouts all stay.

If ScreenTinker is doing its job for you, keeping everything running is
one click here:

  -> ${BILLING_URL}
${paid.length ? '\n' + ladderText(paid) + '\n' : ''}
If it isn't quite there yet, hit reply and tell me what's missing. It
comes straight to me. The Discord is here too: ${DISCORD_URL}

- Dan
ScreenTinker`;
}
function endingSoonHtml({ name, daysLeft, screens, free, paid }) {
  const d = `${daysLeft} ${plural(daysLeft, 'day')}`;
  const screensLine = screens > free.max_devices
    ? `You have <b>${screens} screens</b> paired. On the Free plan ${free.max_devices === 1 ? 'only the first one keeps' : `only the first ${free.max_devices} keep`} playing; the rest will show a "Trial Expired" card until you upgrade.`
    : `Your ${screens === 0 ? 'account' : plural(screens, 'screen')} will keep working on the Free plan (${free.max_devices} ${plural(free.max_devices, 'screen')}, ${free.max_storage_mb} MB of content).`;
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>Your ScreenTinker Pro trial ends in <b>${d}</b>. After that your account moves to the Free plan.</p>
<p>${screensLine} Nothing gets deleted: your content, playlists and layouts all stay.</p>
<p>If ScreenTinker is doing its job for you, keeping everything running is one click:</p>
<p><a href="${BILLING_URL}" style="font-weight:600">Choose a plan</a></p>
${ladderHtml(paid)}
<p>If it isn't quite there yet, hit reply and tell me what's missing. It comes straight to me. The <a href="${DISCORD_URL}">Discord</a> is here too.</p>
<p>- Dan<br>ScreenTinker</p>
</div>`;
}

// ---------- expiry "has ended" ----------

function expiredText({ name, screens, free, paid }) {
  const blocked = Math.max(0, screens - free.max_devices);
  const screensLine = blocked > 0
    ? `${blocked} of your ${screens} screens ${plural(blocked, 'is', 'are')} now showing a "Trial Expired" card. The first ${free.max_devices === 1 ? 'one' : free.max_devices} ${plural(free.max_devices, 'keeps', 'keep')} playing.`
    : `Your ${screens === 0 ? 'account' : plural(screens, 'screen')} keeps working on the Free plan (${free.max_devices} ${plural(free.max_devices, 'screen')}, ${free.max_storage_mb} MB of content).`;
  return `Hi ${name},

Your ScreenTinker Pro trial has ended and your account is now on the
Free plan.

${screensLine}
Nothing was deleted: your content, playlists and layouts are all still
there.

To bring every screen back and keep all the features, pick a plan here:

  -> ${BILLING_URL}
${paid.length ? '\n' + ladderText(paid) + '\n' : ''}
If you decided ScreenTinker isn't for you, no hard feelings, and I'd
genuinely like to know why. Hit reply, it comes straight to me.

- Dan
ScreenTinker`;
}
function expiredHtml({ name, screens, free, paid }) {
  const blocked = Math.max(0, screens - free.max_devices);
  const screensLine = blocked > 0
    ? `<b>${blocked} of your ${screens} screens</b> ${plural(blocked, 'is', 'are')} now showing a "Trial Expired" card. The first ${free.max_devices === 1 ? 'one' : free.max_devices} ${plural(free.max_devices, 'keeps', 'keep')} playing.`
    : `Your ${screens === 0 ? 'account' : plural(screens, 'screen')} keeps working on the Free plan (${free.max_devices} ${plural(free.max_devices, 'screen')}, ${free.max_storage_mb} MB of content).`;
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>Your ScreenTinker Pro trial has ended and your account is now on the Free plan.</p>
<p>${screensLine} Nothing was deleted: your content, playlists and layouts are all still there.</p>
<p>To bring every screen back and keep all the features, pick a plan:</p>
<p><a href="${BILLING_URL}" style="font-weight:600">Choose a plan</a></p>
${ladderHtml(paid)}
<p>If you decided ScreenTinker isn't for you, no hard feelings, and I'd genuinely like to know why. Hit reply, it comes straight to me.</p>
<p>- Dan<br>ScreenTinker</p>
</div>`;
}

// ---------- queries ----------

const NOW = "CAST(strftime('%s','now') AS INTEGER)";
const REACHABLE = "COALESCE(u.email_alerts, 1) = 1 AND (u.email_verified = 1 OR u.last_login IS NOT NULL)";

// Trial still running, ENDING_SOON_DAYS or fewer left, not paid, still on the trial plan, not yet told.
const ENDING_SOON_SQL = `
  SELECT u.id, u.email, u.name, u.trial_started + ${TRIAL_DAYS * 86400} AS trial_end,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS screens
    FROM users u
   WHERE u.trial_started IS NOT NULL
     AND u.trial_started + ${TRIAL_DAYS * 86400} > ${NOW}
     AND u.trial_started + ${TRIAL_DAYS * 86400} <= ${NOW} + ${ENDING_SOON_DAYS * 86400}
     AND u.stripe_subscription_id IS NULL
     AND u.plan_id = u.trial_plan
     AND u.trial_ending_email_sent_at IS NULL
     AND ${REACHABLE}`;

// Downgraded (by the sweep or the lazy path) within the window, still Free, not paid, not yet told.
const EXPIRED_SQL = `
  SELECT u.id, u.email, u.name,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS screens
    FROM users u
   WHERE u.trial_expired_at IS NOT NULL
     AND u.trial_expired_at > ${NOW} - ?
     AND u.plan_id = 'free'
     AND u.stripe_subscription_id IS NULL
     AND u.trial_expired_email_sent_at IS NULL
     AND ${REACHABLE}`;

const USER_DEVICE_IDS_SQL = 'SELECT id FROM devices WHERE user_id = ?';

// After a send: stamp unless the transport was absent/dev-restricted (then a later, configured
// run should still send). A transport ERROR is stamped — a bad address must not be retried nightly.
function stampAfter(r, column, userId) {
  if (r && (r.reason === 'not_configured' || r.reason === 'dev_restricted')) return false;
  db.prepare(`UPDATE users SET ${column} = strftime('%s','now') WHERE id = ?`).run(userId);
  return true;
}

// Push every screen of a just-downgraded user its access-gated playlist. Extra screens that are
// online get the "Trial Expired" card now; offline ones are queued (TTL) and in any case get the
// gated payload on their next register. Best-effort: a push failure never aborts the sweep.
function pushDowngradedUserScreens(io, userId) {
  if (!io) return 0;
  let pushed = 0;
  try {
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    if (typeof buildPlaylistPayload !== 'function') return 0; // socket layer not set up (tests)
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    for (const d of db.prepare(USER_DEVICE_IDS_SQL).all(userId)) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, buildPlaylistPayload);
      pushed++;
    }
  } catch (e) {
    console.error(`[TRIAL] playlist push after downgrade failed for user ${userId}: ${e.message}`);
  }
  return pushed;
}

// One full sweep. Exported so an operator can run it by hand
// (`node -e "require('./services/trialExpiry').runTrialExpirySweep()"`) and so the tests can
// drive it without waiting for SWEEP_HOUR_UTC. Returns counts, or null when disabled.
async function runTrialExpirySweep({ io = null } = {}) {
  if (!isEnabled()) return null;
  const out = { downgraded: 0, screensPushed: 0, endingSoonSent: 0, expiredSent: 0, emailsSkipped: false };

  // 1. downgrade
  for (const id of findExpiredTrialUserIds()) {
    if (!expireTrial(id)) continue; // raced with the lazy path — already done
    out.downgraded++;
    out.screensPushed += pushDowngradedUserScreens(io, id);
  }
  console.log(`[TRIAL] sweep: ${out.downgraded} lapsed trial(s) moved to Free, ${out.screensPushed} screen(s) pushed`);

  if (!isHosted()) {
    out.emailsSkipped = true;
    console.log('[TRIAL] HOSTED_INSTANCE not set - trial emails skipped');
    return out;
  }

  const facts = planFacts();
  const nowSec = Math.floor(Date.now() / 1000);

  // 2. T-3 email
  for (const u of db.prepare(ENDING_SOON_SQL).all()) {
    const daysLeft = Math.max(1, Math.ceil((u.trial_end - nowSec) / 86400));
    const ctx = { name: displayName(u), daysLeft, screens: u.screens, ...facts };
    const r = await emailSvc.sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenTinker',
      rawSubject: true,
      subject: `Your ScreenTinker Pro trial ends in ${daysLeft} ${plural(daysLeft, 'day')}`,
      text: endingSoonText(ctx),
      html: endingSoonHtml(ctx),
    });
    console.log(`[TRIAL] ending-soon -> ${u.email} (${daysLeft}d, ${u.screens} screens): ${JSON.stringify(r)}`);
    if (stampAfter(r, 'trial_ending_email_sent_at', u.id)) out.endingSoonSent++;
  }

  // 3. expiry email
  for (const u of db.prepare(EXPIRED_SQL).all(EXPIRED_EMAIL_MAX_AGE_DAYS * 86400)) {
    const ctx = { name: displayName(u), screens: u.screens, ...facts };
    const r = await emailSvc.sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenTinker',
      rawSubject: true,
      subject: 'Your ScreenTinker Pro trial has ended',
      text: expiredText(ctx),
      html: expiredHtml(ctx),
    });
    console.log(`[TRIAL] expired -> ${u.email} (${u.screens} screens): ${JSON.stringify(r)}`);
    if (stampAfter(r, 'trial_expired_email_sent_at', u.id)) out.expiredSent++;
  }

  return out;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SWEEP_HOUR_UTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Self-correcting daily scheduler (same shape as activationNudge: recompute the next
// SWEEP_HOUR_UTC after every run; no drift, no cron dependency). Gated on !selfHosted.
function startTrialExpiry(io) {
  if (!isEnabled()) {
    console.log('[TRIAL] SELF_HOSTED=true - trial expiry sweep disabled');
    return;
  }
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[TRIAL] next trial-expiry sweep in ~${Math.round(delay / 60000)} min (${String(SWEEP_HOUR_UTC).padStart(2, '0')}:00 UTC daily)`);
    const t = setTimeout(() => {
      runTrialExpirySweep({ io }).catch(e => console.error('[TRIAL] sweep error:', e.message));
      schedule();
    }, delay);
    if (t.unref) t.unref();
  };
  schedule();
}

module.exports = {
  startTrialExpiry,
  runTrialExpirySweep,
  // exposed for tests
  SWEEP_HOUR_UTC, ENDING_SOON_DAYS, EXPIRED_EMAIL_MAX_AGE_DAYS,
};
