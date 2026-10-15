// One-time signup emails (Slice 1):
//   (a) a personal welcome email to the new user, and
//   (b) an admin notification to Dan so no signup goes unnoticed.
//
// Fired fire-and-forget from all three signup paths (local /register, /google,
// /microsoft) at the point a NEW user is created. Reuses the single Microsoft
// Graph transport in ./email (no second mail path).
//
// Gating & safety:
//   - Hosted-instance only: skipped when SELF_HOSTED=true so self-host operators
//     never emit mail from our domain (and never CC Dan on their signups).
//   - Idempotent: users.welcome_email_sent_at is stamped after the send block;
//     a non-null value short-circuits, so a user is only ever emailed once.
//   - sendEmail() never throws, so a Graph hiccup is logged (per-email
//     {sent, reason}) but never blocks or fails the signup request.
//
// No retry logic by design: there is no path that re-enters the new-user branch
// for an existing user, so a failed Graph send is surfaced in the logs and left
// alone rather than retried (that code would be dead).

const { db } = require('../db/database');
const { sendEmail } = require('./email');
const { getClientIp } = require('./activity');
const config = require('../config');

// Admin signup-notify recipient. Sourced from env (not hardcoded) so the
// hosted .com address never ships in open-source code: a self-hoster who
// configures Graph but forgets SELF_HOSTED=true would otherwise fire their
// users' signup PII into our inbox. Unset -> admin notify is skipped entirely
// (the user's welcome email is unaffected). Hosted prod sets this env var.
const ADMIN_NOTIFY_TO = process.env.ADMIN_NOTIFY_EMAIL || null;

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

// Plain-text body. Pure ASCII on purpose: "->" not the arrow glyph, "-" not the
// bullet glyph, straight apostrophes, no em-dashes. Unicode in text/plain gets
// mangled by some clients and hurts deliverability on a new sending pattern.
function welcomeText(name) {
  return `Hi ${name},

Thanks for signing up for ScreenTinker. Glad you're here.

One thing worth knowing up front. ScreenTinker is run by one person, me.
There's no support queue or ticket robot. If you hit reply to this email,
it comes straight to me and I'll answer.

The fastest way to see it work is to put something on a screen. You can turn
any browser into a display in about a minute with the web player:

  -> ${LINKS.player}

Open that on whatever you want to use as a screen, pair it from your
dashboard, and you're live.

Using real signage hardware? These walk you through it:
  - Raspberry Pi: ${LINKS.pi}
  - Android TV:   ${LINKS.androidTv}
  - Self-hosted:  ${LINKS.selfHosted}

Want to ask a human or see what others are building? Discord's here:
  ${LINKS.discord}

Just hit reply if anything's unclear or not working. I read every email.

- Dan
ScreenTinker`;
}

function welcomeHtml(name) {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>Thanks for signing up for ScreenTinker. Glad you're here.</p>
<p>One thing worth knowing up front. ScreenTinker is run by one person, me. There's no support queue or ticket robot. If you hit reply to this email, it comes straight to me and I'll answer.</p>
<p>The fastest way to see it work is to put something on a screen. You can turn any browser into a display in about a minute with the web player:</p>
<p><a href="${LINKS.player}" style="font-weight:600">Open the web player</a></p>
<p>Open that on whatever you want to use as a screen, pair it from your dashboard, and you're live.</p>
<p>Using real signage hardware? These walk you through it:</p>
<ul>
  <li><a href="${LINKS.pi}">Raspberry Pi setup</a></li>
  <li><a href="${LINKS.androidTv}">Android TV setup</a></li>
  <li><a href="${LINKS.selfHosted}">Self-hosted setup</a></li>
</ul>
<p>Want to ask a human or see what others are building? <a href="${LINKS.discord}">Discord's here</a>.</p>
<p>Just hit reply if anything's unclear or not working. I read every email.</p>
<p>- Dan<br>ScreenTinker</p>
</div>`;
}

function fmtUtc(unixSec) {
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function fmtCentral(unixSec) {
  return new Date(unixSec * 1000).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function adminText({ name, email, orgName, signupUnix, ip, country, userAgent }) {
  return `New ScreenTinker signup.

Name:       ${name}
Email:      ${email}
Org:        ${orgName}
Plan:       pro (14-day trial)
Signed up:  ${fmtUtc(signupUnix)}  (${fmtCentral(signupUnix)} America/Chicago)
IP:         ${ip || 'unknown'}
Country:    ${country || 'unknown'}
User agent: ${userAgent || 'unknown'}`;
}

// Public entry point. `user` only needs `.id`; everything else is re-read from
// the row so the caller's column selection doesn't matter. `req` supplies the
// client IP (CF-aware), Cloudflare's free CF-IPCountry header, and user agent.
function sendSignupEmails(user, req) {
  try {
    // Hosted instance only.
    if (config.selfHosted) return;

    const row = db.prepare(
      'SELECT email, name, created_at, welcome_email_sent_at FROM users WHERE id = ?'
    ).get(user.id);
    if (!row || row.welcome_email_sent_at) return; // unknown or already handled

    const email = row.email;
    const name = (row.name && row.name.trim()) ? row.name.trim() : email.split('@')[0];
    const signupUnix = row.created_at || Math.floor(Date.now() / 1000);

    // Workspace name is always "Default" at signup, so use the org name instead.
    const orgRow = db.prepare(
      'SELECT name FROM organizations WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(user.id);
    const orgName = orgRow ? orgRow.name : `${name}'s organization`;

    const ip = getClientIp(req);
    const country = (req && req.headers && req.headers['cf-ipcountry']) || 'unknown';
    const userAgent = (req && req.headers && req.headers['user-agent']) || 'unknown';

    (async () => {
      const w = await sendEmail({
        to: email,
        fromName: 'Dan at ScreenTinker',
        rawSubject: true,
        subject: 'Welcome to ScreenTinker',
        text: welcomeText(name),
        html: welcomeHtml(name),
      });
      console.log(`[SIGNUP-EMAIL] welcome -> ${email}: ${JSON.stringify(w)}`);

      if (ADMIN_NOTIFY_TO) {
        const a = await sendEmail({
          to: ADMIN_NOTIFY_TO,
          rawSubject: true,
          subject: `New signup: ${email}`,
          text: adminText({ name, email, orgName, signupUnix, ip, country, userAgent }),
        });
        console.log(`[SIGNUP-EMAIL] admin-notify (${email}) -> ${ADMIN_NOTIFY_TO}: ${JSON.stringify(a)}`);
      } else {
        console.log('[SIGNUP-EMAIL] admin notify skipped (ADMIN_NOTIFY_EMAIL unset)');
      }

      // Stamp after the send block regardless of per-email outcome (no retry):
      // marks this user handled so we never double-send.
      db.prepare("UPDATE users SET welcome_email_sent_at = strftime('%s','now') WHERE id = ?")
        .run(user.id);
    })().catch(e => console.error(`[SIGNUP-EMAIL] unexpected failure for ${email}: ${e.message}`));
  } catch (e) {
    // Never let signup-email bookkeeping affect the signup request itself.
    console.error(`[SIGNUP-EMAIL] setup failed: ${e.message}`);
  }
}

// Email-verification message. Unlike the welcome/admin-notify pair above this is NOT
// hosted-only — a self-hoster with SMTP configured should still verify their own users.
// sendEmail() self-gates on isConfigured() and never throws, so an unconfigured instance
// simply no-ops (and the caller has already decided not to hard-gate in that case).
function verifyEmailBody(name, url) {
  const text = `Hi ${name},

Confirm your email address to finish setting up your ScreenTinker account:

${url}

This link expires in 24 hours. If you didn't create this account, you can ignore this email.`;
  const html = `<p>Hi ${htmlEscape(name)},</p>
<p>Confirm your email address to finish setting up your ScreenTinker account:</p>
<p><a href="${htmlEscape(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Verify my email</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${htmlEscape(url)}<br><br>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>`;
  return { text, html };
}

async function sendVerificationEmail(user, token, req) {
  // Same public-origin resolution as workspace invites: APP_URL pins the canonical origin
  // in prod; otherwise derive from the (proxy-aware) request. The link hits the API GET
  // route, which flips the flag and redirects into the app.
  // ⚠️ lib/public-origin, never the raw Host header: see its note on host-header poisoning.
  const base = require('../lib/public-origin').publicOrigin(req);
  const url = `${base}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const { text, html } = verifyEmailBody(user.name || user.email, url);
  return sendEmail({ to: user.email, subject: 'Verify your email for ScreenTinker', text, html });
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function sendPasswordResetEmail(user, token, req) {
  // Same public-origin resolution as verification/invites. The link lands on the SPA,
  // which posts the token back to /api/auth/reset-password with the new password — the
  // token is never redeemed by a bare GET, so a link-prefetching mail client cannot
  // consume it.
  // ⚠️ lib/public-origin, never the raw Host header: a forged Host would mail the victim a real
  // reset token inside a link to the attacker's site.
  const base = require('../lib/public-origin').publicOrigin(req);
  const url = `${base}/app#/reset-password?token=${encodeURIComponent(token)}`;
  const who = user.name || user.email;
  const text = `Hi ${who},

Someone asked to reset the password for your ScreenTinker account.

Open this link to choose a new password (valid for 1 hour, and usable once):
${url}

If this wasn't you, you can ignore this email — your password has not changed.`;
  const html = `<p>Hi ${escapeHtml(who)},</p>
<p>Someone asked to reset the password for your ScreenTinker account.</p>
<p><a href="${escapeHtml(url)}">Choose a new password</a> &mdash; the link is valid for 1 hour and can be used once.</p>
<p style="color:#666">If this wasn't you, you can ignore this email &mdash; your password has not changed.</p>`;
  return sendEmail({ to: user.email, subject: 'Reset your ScreenTinker password', text, html });
}

/*
 * Self-service account deletion (routes/auth.js DELETE /me): a receipt to the address that was just
 * deleted, so a deletion the owner did not make is noticed. Sent AFTER the delete from the copy of
 * the row the route still holds, and carries nothing from the account but the greeting. Not an
 * unsubscribe-able list mail: it is the last message this address will get from the server.
 */
async function sendAccountDeletedEmail(user, req) {
  const base = require('../lib/public-origin').publicOrigin(req);
  const who = user.name || user.email;
  // A self-hosted server's people are its operator's, not ours: never point them at our inbox.
  const contact = config.selfHosted ? 'the administrator of this server' : 'support@screentinker.com';
  const text = `Hi ${who},

Your ScreenTinker account (${user.email}) and the data that belonged only to it have been deleted, as you asked.

Copies of deleted data remain in backups until those backups expire. More: ${base}/delete-account

If you did not delete your account, contact ${contact} straight away.`;
  const html = `<p>Hi ${escapeHtml(who)},</p>
<p>Your ScreenTinker account (${escapeHtml(user.email)}) and the data that belonged only to it have been deleted, as you asked.</p>
<p>Copies of deleted data remain in backups until those backups expire. <a href="${escapeHtml(base)}/delete-account">What was deleted</a>.</p>
<p style="color:#666">If you did not delete your account, contact ${escapeHtml(contact)} straight away.</p>`;
  return sendEmail({ to: user.email, subject: 'Your ScreenTinker account has been deleted', text, html });
}

module.exports = { sendSignupEmails, sendVerificationEmail, sendPasswordResetEmail, sendAccountDeletedEmail };
