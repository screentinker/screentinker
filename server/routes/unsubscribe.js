'use strict';

/*
 * One-click unsubscribe for alert email. Public, unauthenticated, by necessity: the person clicking
 * is in their mail client, not signed in, and asking them to log in to stop emails is the behaviour
 * that makes people mark mail as spam instead — which costs the sending domain's reputation far more
 * than the alert was ever worth.
 *
 * ⚠️ A GET NEVER UNSUBSCRIBES ANYONE. This is the trap this file exists to avoid. Mail clients,
 * corporate scanners and link-safety services (Outlook Safe Links, spam filters, anything that
 * renders a preview) FETCH the links in a message without a human involved. Wire the unsubscribe to
 * GET and a single message can silence an account nobody touched — and it looks exactly like a bug in
 * the alert system, because the recipient never knowingly did anything.
 *
 * So GET renders a page with a button, and the state change lives in POST. That also happens to be
 * what RFC 8058 requires for the `List-Unsubscribe-Post` one-click header, so the same POST serves
 * both the human and the mail client's own unsubscribe button.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const { verify } = require('../lib/unsubscribe-token');
const { audit } = require('../lib/audit');

/*
 * ⚠️ ON A REPLICA, THE WRITE MUST GO TO THE PRIMARY.
 *
 * `users` is copied to a replica and `email_alerts` is not on the replication blocklist, so a naive
 * local UPDATE would set the flag on the COPY. The primary — which is what actually sends the alert
 * mail for those accounts, because the sweeps exclude copied users — would never hear about it. The
 * page would say "done", the emails would keep arriving, and the recipient's next move is the spam
 * button. Silent, and expensive to the sending domain.
 *
 * Same definition of "a copy" as routes/auth.js uses to proxy login: every workspace membership sits
 * on a copied workspace. Proxying only when PRIMARY_URL is configured means a standalone instance —
 * which is every self-hosted one — takes the local path with no change in behaviour.
 */
function isCopiedUser(userId) {
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN w.origin_node_id IS NOT NULL THEN 1 ELSE 0 END) AS copied
        FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ?`).get(userId);
    return !!(r && r.total > 0 && r.copied === r.total);
  } catch (e) { return false; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function page(title, bodyHtml, status = 200) {
  return { status, html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111827;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;line-height:1.6;padding:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:32px;max-width:520px;width:100%}
h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 14px;color:#cbd5e1;font-size:15px}
.addr{color:#f1f5f9;font-weight:600;word-break:break-all}
button{background:#3b82f6;color:#fff;border:none;border-radius:9px;padding:13px 24px;font-size:15px;font-weight:700;cursor:pointer;min-height:44px}
button:hover{background:#2563eb}
.muted{color:#94a3b8;font-size:13px;margin:0}
a{color:#3b82f6}
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>` };
}

function send(res, { status, html }) {
  res.status(status).type('text/html; charset=utf-8').set('Cache-Control', 'no-store').send(html);
}

/*
 * Resolve the link's target, or null.
 *
 * ⚠️ A bad token and an unknown user return the SAME refusal. Distinguishing them turns this endpoint
 * into an oracle for "is this address a customer" against any user id someone cares to try — and the
 * page is public, unauthenticated and unrate-limited by nature of being in an email.
 */
function resolve(req) {
  const userId = String((req.query && req.query.u) || (req.body && req.body.u) || '').trim();
  const token = String((req.query && req.query.t) || (req.body && req.body.t) || '').trim();
  if (!verify(userId, token)) return null;
  return db.prepare('SELECT id, email, email_alerts FROM users WHERE id = ?').get(userId) || null;
}

const REFUSAL = `
  <h1>This link isn't valid</h1>
  <p>It may have been truncated by your email client, or it belongs to an account that no longer
  exists.</p>
  <p class="muted">You can turn alert emails off from your account settings, or reply to the email
  you received and we'll do it for you.</p>`;

// The landing page. Shows WHICH address is about to be unsubscribed — a person who has several
// accounts, or who was forwarded the mail, is otherwise guessing.
router.get('/', (req, res) => {
  const user = resolve(req);
  if (!user) return send(res, page("Link isn't valid", REFUSAL, 400));

  if (!user.email_alerts) {
    return send(res, page('Already unsubscribed', `
      <h1>You're already unsubscribed</h1>
      <p><span class="addr">${esc(user.email)}</span> is not receiving alert emails.</p>
      <p class="muted">Nothing more to do. You can turn them back on any time in your account
      settings.</p>`));
  }

  return send(res, page('Unsubscribe', `
    <h1>Stop alert emails?</h1>
    <p>We'll stop sending alert email to <span class="addr">${esc(user.email)}</span> &mdash; display
    offline notices, trial reminders and setup nudges.</p>
    <p class="muted">You'll still get email that's about your account itself, like password resets and
    security notices.</p>
    <form method="POST" action="/unsubscribe">
      <input type="hidden" name="u" value="${esc(user.id)}">
      <input type="hidden" name="t" value="${esc(String(req.query.t || ''))}">
      <button type="submit">Yes, stop these emails</button>
    </form>`));
});

/*
 * The state change. Reached by the button above, and by a mail client's own one-click unsubscribe
 * (RFC 8058 posts `List-Unsubscribe=One-Click` as the body, which needs no interpretation from us —
 * the token in the URL is the whole authorisation).
 *
 * Idempotent: a second POST is a no-op that still renders success, because a mail client may retry
 * and the honest answer to "stop emailing me" asked twice is still "done".
 */
router.post('/', (req, res) => {
  const user = resolve(req);
  if (!user) return send(res, page("Link isn't valid", REFUSAL, 400));

  // See isCopiedUser above: writing the copy would leave the primary still sending.
  if (config.primaryUrl && isCopiedUser(user.id)) {
    return require('../lib/replica-proxy').proxyToPrimary(req, res, config);
  }

  if (user.email_alerts) {
    db.prepare("UPDATE users SET email_alerts = 0, updated_at = strftime('%s','now') WHERE id = ?")
      .run(user.id);
    // The trail matters here more than for most writes: this row is the only evidence distinguishing
    // "the customer asked us to stop" from "our alerts are broken", months later, when somebody asks
    // why a display went dark unnoticed.
    audit('email_alerts_unsubscribed', {
      userId: user.id,
      ip: req.ip || null,
      details: { via: 'email_link', email: user.email },
    });
  }

  return send(res, page('Unsubscribed', `
    <h1>Done &mdash; no more alert emails</h1>
    <p>We've stopped alert email to <span class="addr">${esc(user.email)}</span>.</p>
    <p class="muted">⚠️ That includes notices when one of your displays goes offline, so nothing will
    email you if a screen goes dark. You can turn alerts back on any time under <strong>Settings</strong>
    in your dashboard.</p>`));
});

module.exports = router;
