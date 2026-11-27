'use strict';

/*
 * The weekly content-freshness digest: one email per person, covering every workspace they are an
 * admin or editor of, saying what is going stale on those screens, with links straight to it.
 *
 * WHO. Direct workspace admins and editors (workspace_members), opted in by default. Viewers never:
 * they cannot act on it. Org owners/admins who are not members are not mailed for every workspace in
 * their org — on a large estate that is a wall of mail nobody asked for; they see the page instead.
 *
 * WHO NOT, in order of precedence:
 *   - anyone with users.email_alerts = 0: they stopped alert email, and this is alert email;
 *   - anyone who unsubscribed from the digest (freshness_digest_prefs.opted_out, set by the link in
 *     the email or the toggle on the Freshness page);
 *   - an unreachable address (never verified and never signed in, the trialExpiry rule);
 *   - a workspace whose admins switched the digest off (freshness_settings.digest_enabled = 0).
 *
 * ⚠️ PRIMARY ONLY, BY ROW. On a scale-out replica every copied workspace and every user who belongs
 * to one is the primary's to email (LOCAL_USERS_SQL / LOCAL_ROWS_SQL, docs/scale-out-design.md
 * §5.5). A replica that sent its own would double every digest.
 *
 * ⚠️ NO EMAIL, NO DIGEST — AND NO ERROR. Self-hosted without a mail transport, or without APP_URL
 * (no absolute origin, so no working deep link and no unsubscribe link — and bulk mail without an
 * unsubscribe link is not something to send), the sweep does nothing at all. The in-app page and
 * chips work regardless. FRESHNESS_DIGEST=off switches the job off instance-wide.
 *
 * ONCE A WEEK. A daily sweep at a fixed hour; freshness_digest_prefs.last_sent_at is the marker, and
 * a person is mailed again only once it is more than 6.5 days old. Stamped after a send (or a dev
 * allow-list suppression, which is a deliberate non-send) so a transport failure retries tomorrow.
 * A week with nothing to say sends nothing and stamps nothing.
 */

const { db: defaultDb } = require('../db/database');
const defaultEmail = require('./email');
const freshness = require('../lib/freshness');
const { LOCAL_USERS_SQL, LOCAL_ROWS_SQL } = require('../lib/replica-proxy');

const RUN_HOUR_UTC = 9;
const RESEND_AFTER_SEC = Math.round(6.5 * 86400);
const MAX_LINES = 5;

/** Let everything queued (heartbeats, requests) run before the next step. */
const yieldNow = () => new Promise((r) => setImmediate(r));

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appBase(appUrl = process.env.APP_URL) {
  const b = String(appUrl || '').trim().replace(/\/+$/, '');
  return b ? `${b}/app` : null;
}

function enabled() {
  return String(process.env.FRESHNESS_DIGEST || '').toLowerCase() !== 'off';
}

/** People due a digest now: opted in, reachable, local, an admin/editor of a local workspace. */
function recipients(db, now) {
  return db.prepare(`
    SELECT u.id, u.email, u.name FROM users u
     WHERE COALESCE(u.email_alerts, 1) = 1
       AND (u.email_verified = 1 OR u.last_login IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM freshness_digest_prefs p
                        WHERE p.user_id = u.id AND (p.opted_out = 1 OR COALESCE(p.last_sent_at, 0) > ?))
       AND EXISTS (SELECT 1 FROM workspace_members wm
                    WHERE wm.user_id = u.id AND wm.role IN ('workspace_admin', 'workspace_editor') AND ${LOCAL_ROWS_SQL('wm')})
       AND ${LOCAL_USERS_SQL('u')}
  `).all(now - RESEND_AFTER_SEC);
}

/** The local workspaces one person edits, with the digest left on. */
function workspacesFor(db, userId) {
  return db.prepare(`
    SELECT w.id, w.name, o.name AS organization_name FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      LEFT JOIN organizations o ON o.id = w.organization_id
      LEFT JOIN freshness_settings fs ON fs.workspace_id = w.id
     WHERE wm.user_id = ? AND wm.role IN ('workspace_admin', 'workspace_editor') AND ${LOCAL_ROWS_SQL('wm')}
       AND COALESCE(fs.digest_enabled, 1) = 1
     ORDER BY w.name`).all(userId);
}

function hasNews(r) {
  if (!r) return false;
  const c = r.counts;
  return c.stale_screens + c.very_stale_screens + c.past_date_items + c.expired_assigned_items + c.out_of_season_items > 0;
}

/**
 * One workspace's section, as { text, html } — pure, so the content is testable without a transport.
 * Only things somebody can act on: stale screens, then items with a dated or expired problem.
 */
function section(ws, r, base) {
  const label = ws.organization_name && ws.organization_name !== ws.name ? `${ws.organization_name} · ${ws.name}` : ws.name;
  const page = `${base}#/freshness?ws=${encodeURIComponent(ws.id)}`;
  const screens = r.devices.filter((d) => !d.snoozed_until && (d.status === 'stale' || d.status === 'very_stale'))
    .sort((a, b) => (b.age_days || 0) - (a.age_days || 0));
  const dated = r.items.filter((i) => !i.snoozed_until && i.flags.some((f) => f.code === 'past_date' || f.code === 'expired_assigned' || f.code === 'out_of_season'));

  const text = [`${label}`, `${'-'.repeat(Math.min(60, label.length))}`];
  const html = [`<h3 style="margin:20px 0 6px;font-size:16px">${htmlEscape(label)}</h3>`];
  if (r.workspace.dark) {
    text.push('Nobody who edits this workspace has signed in for 90 days.');
    html.push('<p style="margin:0 0 8px;color:#b45309">Nobody who edits this workspace has signed in for 90 days.</p>');
  }
  if (screens.length) {
    text.push(`${screens.length} screen${screens.length === 1 ? '' : 's'} going stale:`);
    html.push(`<p style="margin:8px 0 4px"><strong>${screens.length} screen${screens.length === 1 ? '' : 's'} going stale</strong></p><ul style="margin:0 0 8px;padding-left:20px">`);
    for (const d of screens.slice(0, MAX_LINES)) {
      const link = `${base}#/device/${encodeURIComponent(d.id)}`;
      const age = `content last changed about ${Math.floor(d.age_days)} days ago`;
      text.push(`  - ${d.name}: ${age}\n    ${link}`);
      html.push(`<li><a href="${htmlEscape(link)}">${htmlEscape(d.name)}</a>: ${htmlEscape(age)}</li>`);
    }
    if (screens.length > MAX_LINES) { text.push(`  ...and ${screens.length - MAX_LINES} more`); html.push(`<li>…and ${screens.length - MAX_LINES} more</li>`); }
    html.push('</ul>');
  }
  if (dated.length) {
    text.push(`${dated.length} item${dated.length === 1 ? '' : 's'} that look out of date:`);
    html.push(`<p style="margin:8px 0 4px"><strong>${dated.length} item${dated.length === 1 ? '' : 's'} that look out of date</strong></p><ul style="margin:0 0 8px;padding-left:20px">`);
    for (const i of dated.slice(0, MAX_LINES)) {
      const why = (i.flags.find((f) => f.code === 'past_date' || f.code === 'expired_assigned' || f.code === 'out_of_season') || {}).explain || '';
      text.push(`  - ${i.name}: ${why}`);
      html.push(`<li><strong>${htmlEscape(i.name)}</strong>: ${htmlEscape(why)}</li>`);
    }
    if (dated.length > MAX_LINES) { text.push(`  ...and ${dated.length - MAX_LINES} more`); html.push(`<li>…and ${dated.length - MAX_LINES} more</li>`); }
    html.push('</ul>');
  }
  text.push(`Review and freshen up: ${page}`, '');
  html.push(`<p style="margin:8px 0 0"><a href="${htmlEscape(page)}" style="font-weight:600">Review and freshen up</a></p>`);
  return { text: text.join('\n'), html: html.join('\n'), screens: screens.length, dated: dated.length };
}

/** The whole email for one person, or null when none of their workspaces has anything to say. */
function composeDigest(user, entries, base) {
  const parts = entries.filter((e) => hasNews(e.report)).map((e) => section(e.ws, e.report, base));
  if (!parts.length) return null;
  const screens = parts.reduce((n, p) => n + p.screens, 0);
  const dated = parts.reduce((n, p) => n + p.dated, 0);
  const subject = screens
    ? `${screens} screen${screens === 1 ? ' is' : 's are'} going stale`
    : `${dated} item${dated === 1 ? '' : 's'} on your screens look${dated === 1 ? 's' : ''} out of date`;
  const name = (user.name && user.name.trim()) || String(user.email).split('@')[0];
  const intro = `Hi ${name},\n\nHere is what is going stale on the screens you look after this week.\n`;
  const text = `${intro}\n${parts.map((p) => p.text).join('\n')}\nThresholds and snoozes are on the Freshness page.`;
  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:600px">
<p>Hi ${htmlEscape(name)},</p>
<p>Here is what is going stale on the screens you look after this week.</p>
${parts.map((p) => p.html).join('\n')}
<p style="margin-top:20px;color:#64748b;font-size:13px">Thresholds and snoozes are on the Freshness page.</p>
</div>`;
  return { subject, text, html };
}

/**
 * One sweep. Injected db/email/now/appUrl so tests drive it directly. Returns a summary object.
 */
/*
 * ⚠️ NEVER COMPUTE A REPORT ON THIS THREAD, AND NEVER LOOP WITHOUT YIELDING.
 *
 * This sweep used to compute every workspace's report inline, and a person with nothing stale
 * `continue`d without ever reaching an await, so the whole run (1,018 workspaces on production) was
 * ONE synchronous block: a 28 s freeze of the entire server every morning at 09:00 UTC, during which
 * no screen could reach it. Reports now come from the worker (lib/freshness-runner.js), and the loop
 * yields once per person regardless.
 *
 * `reports` is injectable so a test can drive the sweep against its own database; the default is
 * the worker-backed runner when the sweep runs on the server's own database.
 */
async function runDigestSweep({ db = defaultDb, email = defaultEmail, now = Math.floor(Date.now() / 1000), appUrl = process.env.APP_URL, reports: source = null } = {}) {
  if (!enabled()) return { skipped: 'disabled', sent: 0 };
  if (!email.isConfigured()) return { skipped: 'email_not_configured', sent: 0 };
  const base = appBase(appUrl);
  if (!base) return { skipped: 'no_app_url', sent: 0 };

  const compute = source
    || (db === defaultDb
      ? (wsId) => require('../lib/freshness-runner').defaultRunner().report(wsId, { fresh: true, now, keep: false })
      : async (wsId) => { await yieldNow(); return freshness.computeWorkspace(db, wsId, { now, useCache: false, keep: false }); });
  const reports = new Map();
  const reportFor = async (wsId) => {
    if (!reports.has(wsId)) {
      let r = null;
      try { r = await compute(wsId); } catch (e) { console.warn(`[freshness] report failed for ${wsId}: ${e.message}`); }
      reports.set(wsId, r);
    }
    return reports.get(wsId);
  };
  const stamp = db.prepare(`INSERT INTO freshness_digest_prefs (user_id, last_sent_at) VALUES (?, ?)
                            ON CONFLICT(user_id) DO UPDATE SET last_sent_at = excluded.last_sent_at`);
  let sent = 0, considered = 0;
  for (const u of recipients(db, now)) {
    considered++;
    await yieldNow();
    const entries = [];
    for (const ws of workspacesFor(db, u.id)) entries.push({ ws, report: await reportFor(ws.id) });
    const msg = composeDigest(u, entries, base);
    if (!msg) continue;
    let r;
    try {
      r = await email.sendEmail({ to: u.email, subject: msg.subject, text: msg.text, html: msg.html,
        unsubscribeUserId: u.id, unsubscribeList: 'freshness' });
    } catch (e) { r = { sent: false, reason: 'error', error: e.message }; }
    if (r && (r.sent || r.reason === 'dev_restricted')) { stamp.run(u.id, now); if (r.sent) sent++; }
  }
  if (considered) console.log(`[freshness] digest sweep: ${sent} sent of ${considered} due`);
  return { sent, considered };
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_HOUR_UTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Self-correcting daily timer (recomputed each run, no drift), unref'd so it never holds the process.
function startFreshnessDigest() {
  if (!enabled()) { console.log('[freshness] FRESHNESS_DIGEST=off - weekly digest disabled'); return; }
  const schedule = () => {
    const t = setTimeout(() => {
      runDigestSweep().catch((e) => console.error('[freshness] digest sweep error:', e.message));
      schedule();
    }, msUntilNextRun());
    if (t.unref) t.unref();
  };
  schedule();
}

module.exports = { startFreshnessDigest, runDigestSweep, composeDigest, section, recipients, workspacesFor, msUntilNextRun, RESEND_AFTER_SEC };
