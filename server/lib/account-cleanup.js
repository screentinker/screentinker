'use strict';

/*
 * Stale-account cleanup (Platform → Cleanup).
 *
 * ⚠️ THIS DELETES CUSTOMERS' ACCOUNTS, so "stale" is defined narrowly and checked twice.
 *
 * An account is stale only when ALL of these hold:
 *   1. It is a customer (users.role = 'user') — never platform staff.
 *   2. It is not paying: no Stripe subscription in an active / trialing / past_due state.
 *   3. It is not on a free trial.
 *   4. No activity for `inactiveDays`. Activity is the LATEST of: signing in, signing up, using one
 *      of its API tokens (automation and the MCP server never "sign in"), and anything it did in the
 *      dashboard (activity_log — a session can outlive a sign-in, e.g. by switching workspace).
 *      A sign-up from yesterday is therefore never stale.
 *   5. No paired screen in any workspace it can reach.
 *   6. It shares no organization with anyone: it belongs only to organizations it owns alone.
 *      A member of somebody else's organization is that customer's business to remove, not ours,
 *      and deleteUserCascade refuses an owner of a shared organization anyway.
 *
 * NOTICE FIRST. warn() emails each account "this will be deleted on <date> unless you sign in" and
 * records when; purge() then deletes only accounts whose notice period has ended AND that have
 * done nothing since the warning. Signing in clears the notice (routes/auth.js stampLastLogin), and
 * any other activity after the warning voids it — so an account that comes back to life and later
 * goes quiet again gets a fresh notice, never an instant deletion on an old one. An admin can
 * override for obvious junk, with its own confirmation.
 *
 * The list the dashboard shows is a PREVIEW. purge() re-evaluates every id against the same rules
 * at the moment of deletion and skips any account that no longer qualifies (it signed in, paired a
 * screen, subscribed since the page was loaded), saying why.
 *
 * Deletion goes through lib/user-deletion.js deleteUserCascade — the same path as deleting one
 * user by hand — which also removes the deleted accounts' uploaded files (and their .history
 * copies) from disk after it commits, through lib/content-files unlinkIfUnreferenced so a file
 * another row still points at is never removed.
 */

const { deleteUserCascade, OrgHasOtherMembersError } = require('./user-deletion');

const DAY = 86400;
const TRIAL_SECS = 14 * DAY; // middleware/subscription.js TRIAL_DAYS
const MAX_BATCH = 500;
const ALLOWED_DAYS = [30, 90, 180, 365];
const NOTICE_DAYS = [14, 30];

/* The latest thing an account did (see rule 4). */
const LAST_ACTIVITY = `MAX(
  COALESCE(u.last_login, 0),
  COALESCE(u.created_at, 0),
  COALESCE((SELECT MAX(t.last_used_at) FROM api_tokens t WHERE t.user_id = u.id), 0),
  COALESCE((SELECT MAX(a.created_at) FROM activity_log a WHERE a.user_id = u.id), 0))`;

/*
 * One query for the rules, used by both preview and purge so they cannot drift apart. `ids` (optional)
 * restricts it to specific accounts — purge's re-check.
 */
function staleQuery(db, { inactiveDays, now, ids }) {
  const cutoff = now - inactiveDays * DAY;
  const idFilter = ids ? `AND u.id IN (${ids.map(() => '?').join(',')})` : '';
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.created_at, u.last_login, u.plan_id,
           u.cleanup_warned_at, u.cleanup_delete_after, ${LAST_ACTIVITY} AS last_activity
      FROM users u
     WHERE u.role = 'user'
       AND NOT (COALESCE(u.stripe_subscription_id, '') != ''
                AND COALESCE(u.subscription_status, 'active') IN ('active', 'trialing', 'past_due'))
       AND NOT (u.trial_started IS NOT NULL AND u.trial_started + ? > ?)
       AND ${LAST_ACTIVITY} < ?
       -- 6: every organization it belongs to, it owns, and nobody else is in it
       AND NOT EXISTS (
             SELECT 1 FROM organization_members om
              WHERE om.user_id = u.id
                AND (om.role != 'org_owner'
                     OR EXISTS (SELECT 1 FROM organization_members o2
                                 WHERE o2.organization_id = om.organization_id AND o2.user_id != u.id)))
       AND NOT EXISTS (
             SELECT 1 FROM workspace_members wm
               JOIN workspaces w ON w.id = wm.workspace_id
               JOIN organizations o ON o.id = w.organization_id
              WHERE wm.user_id = u.id AND o.owner_user_id != u.id)
       AND NOT EXISTS (
             SELECT 1 FROM workspace_members wm2
               JOIN workspace_members wm3 ON wm3.workspace_id = wm2.workspace_id AND wm3.user_id != u.id
              WHERE wm2.user_id = u.id)
       -- 5: no paired screen anywhere it can reach
       AND NOT EXISTS (
             SELECT 1 FROM devices d
               JOIN workspaces w ON w.id = d.workspace_id
               JOIN organizations o ON o.id = w.organization_id
              WHERE o.owner_user_id = u.id)
       ${idFilter}
     ORDER BY last_activity ASC
  `).all(TRIAL_SECS, now, cutoff, ...(ids || []));
}

/*
 * Where an account is in the notice process:
 *   'not_warned' — no notice, or a notice voided by activity since it was sent
 *   'notice'     — warned; the notice period is still running
 *   'ready'      — warned, the period is over, and nothing has happened since the warning
 */
function noticeStatus(r, now) {
  if (!r.cleanup_warned_at || r.last_activity > r.cleanup_warned_at) return 'not_warned';
  return r.cleanup_delete_after && r.cleanup_delete_after <= now ? 'ready' : 'notice';
}

/* What an account holds: organizations, workspaces, content items and their bytes. */
function footprint(db, userId) {
  const orgs = db.prepare('SELECT id FROM organizations WHERE owner_user_id = ?').all(userId).map((r) => r.id);
  if (!orgs.length) return { organizations: 0, workspaces: 0, content_items: 0, content_bytes: 0 };
  const ph = orgs.map(() => '?').join(',');
  const ws = db.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE organization_id IN (${ph})`).get(...orgs).n;
  const c = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(c.file_size), 0) AS bytes
      FROM content c JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.organization_id IN (${ph})`).get(...orgs);
  return { organizations: orgs.length, workspaces: ws, content_items: c.n, content_bytes: c.bytes };
}

function normaliseDays(days) {
  const d = parseInt(days, 10);
  return ALLOWED_DAYS.includes(d) ? d : 180;
}

/** The preview: every stale account, with what deleting it would remove. */
function findStale(db, { inactiveDays = 180, now = Math.floor(Date.now() / 1000) } = {}) {
  const days = normaliseDays(inactiveDays);
  const rows = staleQuery(db, { inactiveDays: days, now });
  const accounts = rows.map((r) => ({ ...r, never_signed_in: !r.last_login, notice: noticeStatus(r, now), ...footprint(db, r.id) }));
  return {
    inactive_days: days,
    accounts,
    total: accounts.length,
    counts: {
      not_warned: accounts.filter((a) => a.notice === 'not_warned').length,
      notice: accounts.filter((a) => a.notice === 'notice').length,
      ready: accounts.filter((a) => a.notice === 'ready').length,
    },
    reclaimable_bytes: accounts.reduce((a, r) => a + (r.content_bytes || 0), 0),
  };
}

/** The Overview's count (cheap: no footprint). */
function countStale(db, { inactiveDays = 180, now = Math.floor(Date.now() / 1000) } = {}) {
  try { return staleQuery(db, { inactiveDays: normaliseDays(inactiveDays), now }).length; } catch (_) { return 0; }
}

/**
 * Delete the given accounts — each only if it STILL qualifies. Returns what happened to every id.
 * `unlink(rel, column)` removes a no-longer-referenced upload (injectable for tests).
 */
function purge(db, { ids, inactiveDays, actingAdminId, now = Math.floor(Date.now() / 1000), unlink, skipNotice = false }) {
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('Choose at least one account'), { status: 400 });
  if (ids.length > MAX_BATCH) throw Object.assign(new Error(`At most ${MAX_BATCH} accounts at a time`), { status: 400 });
  const days = normaliseDays(inactiveDays);
  const unique = [...new Set(ids.map(String))];
  const stillRows = new Map(staleQuery(db, { inactiveDays: days, now, ids: unique }).map((r) => [r.id, r]));
  const deleted = [];
  const skipped = [];
  let filesRemoved = 0;
  let bytesFreed = 0;
  for (const id of unique) {
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
    if (!user) { skipped.push({ id, reason: 'Account no longer exists' }); continue; }
    const row = stillRows.get(id);
    if (!row) { skipped.push({ id, email: user.email, reason: 'No longer stale (active again, paired a screen, subscribed, or joined a shared organization)' }); continue; }
    if (!skipNotice) {
      const st = noticeStatus(row, now);
      if (st === 'not_warned') { skipped.push({ id, email: user.email, reason: 'Not warned yet: send the notice first' }); continue; }
      if (st === 'notice') { skipped.push({ id, email: user.email, reason: `Notice period runs until ${new Date(row.cleanup_delete_after * 1000).toISOString().slice(0, 10)}` }); continue; }
    }
    // The cascade removes the deleted orgs' files itself once its transaction commits (audit F23:
    // it used to be rows only, so this was the one caller that unlinked anything, and it missed
    // subtitles and the .history copies). `unlink` is passed through for the tests.
    let files;
    try {
      files = deleteUserCascade(db, { targetId: id, actingAdminId, unlink });
    } catch (e) {
      skipped.push({ id, email: user.email, reason: e instanceof OrgHasOtherMembersError ? 'Owns an organization with other members' : 'Could not be deleted' });
      continue;
    }
    deleted.push({ id, email: user.email });
    filesRemoved += files.files_removed;
    bytesFreed += files.bytes_freed;
  }
  return { inactive_days: days, deleted, skipped, files_removed: filesRemoved, bytes_freed: bytesFreed };
}

/**
 * Send the deletion notice to each account that is still stale and not already under notice.
 * `send({ user, deleteAfter })` delivers the email (injectable for tests); the notice is recorded
 * only when it was actually handed to the mail transport, so an account nobody was able to warn is
 * never deleted "after notice".
 */
async function warn(db, { ids, inactiveDays, noticeDays = 14, now = Math.floor(Date.now() / 1000), send }) {
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('Choose at least one account'), { status: 400 });
  if (ids.length > MAX_BATCH) throw Object.assign(new Error(`At most ${MAX_BATCH} accounts at a time`), { status: 400 });
  const grace = NOTICE_DAYS.includes(Number(noticeDays)) ? Number(noticeDays) : 14;
  const days = normaliseDays(inactiveDays);
  const unique = [...new Set(ids.map(String))];
  const rows = new Map(staleQuery(db, { inactiveDays: days, now, ids: unique }).map((r) => [r.id, r]));
  const warned = [];
  const skipped = [];
  const deleteAfter = now + grace * DAY;
  for (const id of unique) {
    const r = rows.get(id);
    if (!r) { skipped.push({ id, reason: 'Not stale' }); continue; }
    const st = noticeStatus(r, now);
    if (st !== 'not_warned') { skipped.push({ id, email: r.email, reason: st === 'ready' ? 'Already warned; notice period over' : 'Already under notice' }); continue; }
    let delivered = false;
    try { delivered = !!(await send({ user: r, deleteAfter })); } catch (_) { delivered = false; }
    if (!delivered) { skipped.push({ id, email: r.email, reason: 'The email could not be sent' }); continue; }
    db.prepare('UPDATE users SET cleanup_warned_at = ?, cleanup_delete_after = ? WHERE id = ?').run(now, deleteAfter, id);
    warned.push({ id, email: r.email, delete_after: deleteAfter });
  }
  return { notice_days: grace, delete_after: deleteAfter, warned, skipped };
}

/** The notice email. Plain and specific: what happens, when, and the one thing that stops it. */
function noticeEmail({ user, deleteAfter, appUrl }) {
  const date = new Date(deleteAfter * 1000).toUTCString().slice(0, 16);
  const subject = `Your inactive account will be deleted on ${date}`;
  const text = [
    `Hi${user.name ? ` ${user.name}` : ''},`,
    '',
    `Your account (${user.email}) has not been used for a long time and has no screens connected, so we plan to delete it, together with its workspaces and uploaded files, on ${date}.`,
    '',
    'To keep it, just sign in before then:',
    `${appUrl}/app`,
    '',
    'If you no longer need the account, you do not have to do anything.',
  ].join('\n');
  return { subject, text };
}

module.exports = { findStale, countStale, purge, warn, noticeEmail, noticeStatus, ALLOWED_DAYS, NOTICE_DAYS, MAX_BATCH };
