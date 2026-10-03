// Activation nudge (Slice 3): a once-per-user "checking in" email sent T+3 days
// after signup when the user still has zero paired screens. Daily sweep at a
// fixed UTC hour. Reuses the single Microsoft Graph transport (./email).
//
// GATING — positive hosted signal, NOT !selfHosted:
//   This is a daily BULK sweep. A self-hoster who configured Graph but forgot
//   SELF_HOSTED=true would blast their whole dormant user base with Dan-branded
//   onboarding mail. So we gate on an explicit HOSTED_INSTANCE=true: if it's not
//   set, we neither schedule nor send. Hosted prod sets the env var.
//
// Idempotency: users.activation_nudge_sent_at, stamped after each send; the
// query's "IS NULL" guard means a user is nudged at most once. Re-runs are safe.
//
// Opt-out: users who explicitly turned email alerts off (email_alerts = 0) are
// excluded; NULL/unset and on (1) both qualify via COALESCE(...,1)=1.

const { db } = require('../db/database');
const { sendEmail } = require('./email');
const { LOCAL_USERS_SQL } = require('../lib/replica-proxy');

const NUDGE_HOUR_UTC = 15; // 15:00 UTC daily

const LINKS = {
  player:     'https://screentinker.com/player/',
  pi:         'https://screentinker.com/guides/raspberry-pi-digital-signage.html',
  androidTv:  'https://screentinker.com/guides/digital-signage-android-tv.html',
  selfHosted: 'https://screentinker.com/guides/self-hosted-digital-signage.html',
  discord:    'https://discord.gg/utTdsrqq4Z',
};

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Pure-ASCII plain text (same deliverability rule as the welcome email).
function nudgeText(name) {
  return `Hi ${name},

You signed up for ScreenTinker a few days ago, and I noticed you
haven't paired a screen yet. No worries at all. I just wanted to
check in and see if anything's getting in the way.

If you hit a snag, hit reply and tell me what happened. It comes
straight to me and I'll help you sort it.

If you just haven't had a chance yet, the fastest way to start is the
web player. Turn any browser into a screen in about a minute:

  -> ${LINKS.player}

Or if you're setting up real hardware:
  - Raspberry Pi: ${LINKS.pi}
  - Android TV:   ${LINKS.androidTv}
  - Self-hosted:  ${LINKS.selfHosted}

And the Discord is here if you'd rather ask there:
  ${LINKS.discord}

And if you'd rather I didn't check in, just say the word.

- Dan
ScreenTinker`;
}

function nudgeHtml(name) {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>You signed up for ScreenTinker a few days ago, and I noticed you haven't paired a screen yet. No worries at all. I just wanted to check in and see if anything's getting in the way.</p>
<p>If you hit a snag, hit reply and tell me what happened. It comes straight to me and I'll help you sort it.</p>
<p>If you just haven't had a chance yet, the fastest way to start is the web player. Turn any browser into a screen in about a minute:</p>
<p><a href="${LINKS.player}" style="font-weight:600">Open the web player</a></p>
<p>Or if you're setting up real hardware:</p>
<ul>
  <li><a href="${LINKS.pi}">Raspberry Pi setup</a></li>
  <li><a href="${LINKS.androidTv}">Android TV setup</a></li>
  <li><a href="${LINKS.selfHosted}">Self-hosted setup</a></li>
</ul>
<p>And the <a href="${LINKS.discord}">Discord is here</a> if you'd rather ask there.</p>
<p>And if you'd rather I didn't check in, just say the word.</p>
<p>- Dan<br>ScreenTinker</p>
</div>`;
}

// Eligible = signed up 3-14 days ago, never nudged, not opted out, and with
// ZERO devices either owned by the user OR present in any workspace they belong
// to (Option B, workspace-aware — avoids nudging engaged team members).
const ELIGIBLE_SQL = `
  SELECT u.id, u.email, u.name FROM users u
  WHERE u.created_at < strftime('%s','now') - (3 * 86400)
    AND u.created_at > strftime('%s','now') - (14 * 86400)
    AND u.activation_nudge_sent_at IS NULL
    AND COALESCE(u.email_alerts, 1) = 1
    AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id)
    AND NOT EXISTS (
      SELECT 1 FROM workspace_members wm
      JOIN devices d2 ON d2.workspace_id = wm.workspace_id
      WHERE wm.user_id = u.id)
    AND ${LOCAL_USERS_SQL('u')}
`;

function isHosted() {
  return process.env.HOSTED_INSTANCE === 'true';
}

// Run one sweep. Exported so the dev verify harness can drive it directly
// without waiting for 15:00 UTC. Returns the number of nudges sent.
async function runActivationNudgeSweep() {
  if (!isHosted()) return 0; // defense in depth (scheduler is also gated)
  const users = db.prepare(ELIGIBLE_SQL).all();
  console.log(`[NUDGE] sweep: ${users.length} eligible user(s)`);
  let sent = 0;
  for (const u of users) {
    const name = (u.name && u.name.trim()) ? u.name.trim() : u.email.split('@')[0];
    const r = await sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenTinker',
      rawSubject: true,
      subject: "Quick check-in - how's ScreenTinker going?",
      text: nudgeText(name),
      html: nudgeHtml(name),
      unsubscribeUserId: u.id,
    });
    console.log(`[NUDGE] nudge -> ${u.email}: ${JSON.stringify(r)}`);
    // Stamp after the send (no retry, same discipline as the welcome email).
    db.prepare("UPDATE users SET activation_nudge_sent_at = strftime('%s','now') WHERE id = ?").run(u.id);
    sent++;
  }
  return sent;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NUDGE_HOUR_UTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Self-correcting daily scheduler (recompute next 15:00 UTC each run; no drift,
// no node-cron dependency). Gated on HOSTED_INSTANCE.
function startActivationNudge() {
  if (!isHosted()) {
    console.log('[NUDGE] HOSTED_INSTANCE not set - activation nudge sweep disabled');
    return;
  }
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[NUDGE] next activation-nudge sweep in ~${Math.round(delay / 60000)} min (15:00 UTC daily)`);
    setTimeout(() => {
      runActivationNudgeSweep().catch(e => console.error('[NUDGE] sweep error:', e.message));
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startActivationNudge, runActivationNudgeSweep };
