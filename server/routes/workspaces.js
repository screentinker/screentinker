const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { canAdminWorkspace, canAccessWorkspace } = require('../lib/permissions');
const { isPlatformRole } = require('../middleware/auth');
const go2rtc = require('../lib/go2rtc');
const appConfig = require('../config');
const { logActivity, getClientIp } = require('../services/activity');
const { sendEmail } = require('../services/email');

// Workspace management routes. Operates on a target workspace specified by
// URL param, NOT the caller's currently active workspace - so this router
// does NOT use resolveTenancy. Permission is gated via canAdminWorkspace() /
// canAccessWorkspace() which evaluate against the target workspace, not
// req.workspaceRole.

const NAME_MAX = 80;
const SLUG_MAX = 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Markup characters are not legal here. The looser form admitted < > " ' and an admin-
// chosen email became stored XSS in the platform admin's user list.
const EMAIL_RE = /^[^\s@<>"'`\\;,()\[\]]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const WORKSPACE_ROLES = ['workspace_admin', 'workspace_editor', 'workspace_viewer'];
const WIDGET_SANDBOX_CONFIRM_PHRASE = 'I understand I am enabling a security hole';

// Operational policy - env-configurable with conservative defaults. Restart
// required to take effect. The guarded parseInt rejects garbage strings
// (e.g. INVITE_RATE_LIMIT_PER_HOUR=fifty) so an operator typo surfaces as
// "default fired" rather than silently sticking. Future cleanup: DB-backed
// platform_settings + admin UI for runtime tuning; env vars become fallback
// defaults when that lands. See handoff doc.
const INVITE_RATE_LIMIT_PER_HOUR = (() => {
  const parsed = parseInt(process.env.INVITE_RATE_LIMIT_PER_HOUR, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
})();
const INVITE_EXPIRY_DAYS = (() => {
  const parsed = parseInt(process.env.INVITE_EXPIRY_DAYS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
})();

/*
 * How many workspaces one organization may create.
 *
 * Not a plan limit — the plans table has no such column, and inventing one here would put a
 * billing decision in a routes file. This is a runaway guard: without any cap, a scripted caller
 * can mint workspaces until the switcher is unusable and the /me query that lists them is the
 * slowest thing on the dashboard. Same env-configurable shape as the invite limits above.
 */
const MAX_WORKSPACES_PER_ORG = (() => {
  const parsed = parseInt(process.env.MAX_WORKSPACES_PER_ORG, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();

/*
 * Which organization a create lands in.
 *
 * ⚠️ NEVER THE BODY ALONE. `organization_id` is honoured only after confirming the caller actually
 * administers that org — otherwise this endpoint mints a workspace inside somebody else's tenant,
 * and every workspace-scoped route downstream would treat it as legitimately theirs.
 *
 * With no id supplied we resolve it from membership, which is the normal case: one org, one
 * owner. Several orgs and no id is AMBIGUOUS and says so rather than guessing — picking "the first
 * one" would silently create the workspace in the wrong tenant.
 */
function resolveTargetOrg(req) {
  const requested = req.body && req.body.organization_id ? String(req.body.organization_id) : null;

  if (requested) {
    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(requested);
    if (!org) return { error: { status: 404, message: 'Organization not found' } };
    if (isPlatformRole(req.user.role)) return { organizationId: org.id };
    const om = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .get(org.id, req.user.id);
    if (!om || (om.role !== 'org_owner' && om.role !== 'org_admin')) {
      return { error: { status: 403, message: 'You do not administer that organization' } };
    }
    return { organizationId: org.id };
  }

  const owned = db.prepare(
    "SELECT organization_id FROM organization_members WHERE user_id = ? AND role IN ('org_owner','org_admin')"
  ).all(req.user.id);
  if (owned.length === 1) return { organizationId: owned[0].organization_id };
  if (owned.length === 0) {
    return { error: { status: 403, message: 'Only an organization owner or admin can create a workspace' } };
  }
  return { error: { status: 400, message: 'You administer more than one organization — specify organization_id' } };
}

/*
 * Create a workspace inside an organization the caller administers.
 *
 * ⚠️ ORG-LEVEL, SO IT NEEDS AN ORG ROLE. A workspace_admin administers ONE workspace; letting that
 * mint siblings would let a delegated editor grow the tenant they were given a corner of. Same
 * reasoning the org security-settings route already applies.
 *
 * The creator is added as workspace_admin, or they would create a workspace they cannot administer
 * and cannot invite anyone into — reachable only via their org role, which is a confusing half-state
 * for anyone who is org_admin today and not tomorrow.
 */
router.post('/', (req, res) => {
  const target = resolveTargetOrg(req);
  if (target.error) return res.status(target.error.status).json({ error: target.error.message });
  const organizationId = target.organizationId;

  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > NAME_MAX) return res.status(400).json({ error: `Name must be ${NAME_MAX} characters or fewer` });

  let slug = null;
  if (req.body && req.body.slug !== undefined && String(req.body.slug).trim() !== '') {
    slug = String(req.body.slug).trim().toLowerCase();
    if (slug.length > SLUG_MAX) return res.status(400).json({ error: `Slug must be ${SLUG_MAX} characters or fewer` });
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase letters, digits, and hyphens (no leading/trailing/double hyphens)' });
    }
  }

  const existing = db.prepare('SELECT COUNT(*) AS c FROM workspaces WHERE organization_id = ?').get(organizationId);
  if (existing.c >= MAX_WORKSPACES_PER_ORG) {
    return res.status(409).json({ error: `This organization already has the maximum of ${MAX_WORKSPACES_PER_ORG} workspaces` });
  }

  const id = crypto.randomUUID();
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO workspaces (id, organization_id, name, slug, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, organizationId, name, slug, req.user.id);
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
        .run(id, req.user.id);
    })();
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: 'Slug already used in this organization' });
    }
    throw e;
  }

  // Attribute the audit row to the workspace that was just created, not to whatever the caller
  // happened to be looking at — this router has no resolveTenancy, so nothing else would.
  req.workspaceId = id;
  logActivity(req.user.id, 'workspace_created', `Created workspace "${name}"`, null, getClientIp(req), id);

  const created = db.prepare('SELECT id, name, slug, organization_id, created_at FROM workspaces WHERE id = ?').get(id);
  res.status(201).json({ ...created, can_admin: true });
});

// Rename a workspace. MVP scope: name + slug only. Permission: platform_admin,
// org_owner/admin of the parent org, or workspace_admin of the target ws.
router.patch('/:id', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAdminWorkspace(db, req.user, ws)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Stamp the target workspace_id so activityLogger captures the right
  // tenant attribution. This route doesn't use resolveTenancy (operates on
  // a URL-param target, not the caller's active workspace), so req.workspaceId
  // would otherwise be undefined and the audit row would have NULL workspace.
  req.workspaceId = ws.id;

  const updates = [];
  const values = [];

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    if (name.length > NAME_MAX) return res.status(400).json({ error: `Name must be ${NAME_MAX} characters or fewer` });
    updates.push('name = ?');
    values.push(name);
  }

  if (req.body.slug !== undefined) {
    // Empty string -> NULL (workspace has no slug). Otherwise normalize +
    // validate against the URL-safe segment pattern.
    const raw = String(req.body.slug || '').trim().toLowerCase();
    if (raw === '') {
      updates.push('slug = NULL');
    } else {
      if (raw.length > SLUG_MAX) return res.status(400).json({ error: `Slug must be ${SLUG_MAX} characters or fewer` });
      if (!SLUG_RE.test(raw)) {
        return res.status(400).json({ error: 'Slug must be lowercase letters, digits, and hyphens (no leading/trailing/double hyphens)' });
      }
      updates.push('slug = ?');
      values.push(raw);
    }
  }

  // #go2rtc: opt this workspace into live video. Off by default; only meaningful when the server
  // master switch (LIVE_VIDEO_ENABLED) is also on. Admin-gated by the canAdminWorkspace check above.
  if (req.body.live_video_enabled !== undefined) {
    updates.push('live_video_enabled = ?');
    values.push(req.body.live_video_enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push("updated_at = strftime('%s','now')");
  values.push(req.params.id);

  try {
    db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: 'Slug already used in this organization' });
    }
    throw e;
  }

  const updated = db.prepare('SELECT id, name, slug, organization_id, live_video_enabled FROM workspaces WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Organization security settings for the workspace's parent org.
// Update is restricted to org_owner/org_admin (or platform admin); workspace_admin
// alone is intentionally insufficient for this org-wide security switch.
router.put('/:id/security-settings', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAdminWorkspace(db, req.user, ws)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const isPlatformAdmin = isPlatformRole(req.user.role);
  const orgMember = db.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(ws.organization_id, req.user.id);
  const isOrgAdmin = !!(orgMember && (orgMember.role === 'org_owner' || orgMember.role === 'org_admin'));
  if (!isPlatformAdmin && !isOrgAdmin) {
    return res.status(403).json({ error: 'Organization admin required' });
  }

  if (typeof req.body?.widgetSandboxIsolationDisabled !== 'boolean') {
    return res.status(400).json({ error: 'widgetSandboxIsolationDisabled must be boolean' });
  }
  const next = req.body.widgetSandboxIsolationDisabled ? 1 : 0;
  if (next === 1) {
    const typed = String(req.body?.confirmationPhrase || '').trim();
    if (typed !== WIDGET_SANDBOX_CONFIRM_PHRASE) {
      return res.status(400).json({ error: 'Exact confirmation phrase required' });
    }
  }

  const current = db.prepare(
    'SELECT COALESCE(widget_sandbox_isolation_disabled, 0) AS v FROM organizations WHERE id = ?'
  ).get(ws.organization_id);
  db.prepare(
    "UPDATE organizations SET widget_sandbox_isolation_disabled = ?, updated_at = strftime('%s','now') WHERE id = ?"
  ).run(next, ws.organization_id);
  req.workspaceId = ws.id; // stamp tenant for activityLogger row
  logActivity(
    req.user.id,
    'org_widget_sandbox_isolation_setting_changed',
    `organization_id=${ws.organization_id} widgetSandboxIsolationDisabled=${next}`,
    null,
    getClientIp(req),
    ws.id
  );

  res.json({
    organization_id: ws.organization_id,
    widgetSandboxIsolationDisabled: !!next,
    changed: !!current && Number(current.v || 0) !== next,
  });
});

// ==================== Members / invites ====================

// Load workspace by req.params.id and verify caller has the required level
// of access. Returns the workspace row on success. On failure, sends the
// appropriate response and returns null - caller bails on null. Also stamps
// req.workspaceId so the activityLogger middleware captures the right
// tenant attribution (mirrors the rename pattern).
function loadWorkspace(req, res, requireAdmin) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  const allowed = requireAdmin
    ? canAdminWorkspace(db, req.user, ws)
    : canAccessWorkspace(db, req.user, ws);
  if (!allowed) {
    res.status(403).json({ error: requireAdmin ? 'Admin access required' : 'Workspace access required' });
    return null;
  }
  req.workspaceId = ws.id;
  return ws;
}

function countWorkspaceAdmins(workspaceId) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ? AND role = 'workspace_admin'"
  ).get(workspaceId).c;
}

// Members listing: direct workspace_members + the org_owner/admin users who
// reach this workspace via org-level access.
//
// Response shape contract: entries with via_org=true are READ-ONLY from the
// workspace context. They cannot have their role changed or be removed via
// these endpoints because they aren't managed via workspace_members - their
// access lives in organization_members. UI must render them with reduced
// affordances (no role select, no remove button). The role field on a
// via_org entry reflects their ORG role (org_owner / org_admin), not a
// workspace role - it's display-only.
function listMembers(workspaceId, organizationId) {
  const direct = db.prepare(`
    SELECT u.id AS user_id, u.email, u.name, wm.role, wm.joined_at
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
    ORDER BY wm.joined_at ASC
  `).all(workspaceId);
  const directIds = new Set(direct.map(r => r.user_id));

  const viaOrg = db.prepare(`
    SELECT u.id AS user_id, u.email, u.name, om.role, om.joined_at
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = ? AND om.role IN ('org_owner', 'org_admin')
  `).all(organizationId);

  const out = direct.map(r => ({ ...r, via_org: false }));
  for (const r of viaOrg) {
    if (directIds.has(r.user_id)) continue;
    out.push({ ...r, via_org: true });
  }
  return out;
}

function buildInviteEmail({ workspaceName, organizationName, inviterName, role, acceptUrl }) {
  const subject = `You've been invited to ${workspaceName} on ScreenTinker`;
  const roleLabel = role.replace(/^workspace_/, '');
  const text = [
    `${inviterName || 'A ScreenTinker user'} invited you to join ${workspaceName}`
      + (organizationName ? ` (${organizationName})` : '') + ` as ${roleLabel}.`,
    '',
    `To accept, sign in to ScreenTinker and open:`,
    acceptUrl,
    '',
    `This invite expires in ${INVITE_EXPIRY_DAYS} days.`,
  ].join('\n');
  return { subject, text };
}

// GET /:id/members - any member (or org-level/platform admin) of the workspace
router.get('/:id/members', (req, res) => {
  const ws = loadWorkspace(req, res, false);
  if (!ws) return;
  res.json(listMembers(ws.id, ws.organization_id));
});

// GET /:id/invites - admin only. Pending (non-expired) rows.
router.get('/:id/invites', (req, res) => {
  const ws = loadWorkspace(req, res, true);
  if (!ws) return;
  const invites = db.prepare(`
    SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
           inv.email AS invited_by_email
    FROM workspace_invites i
    LEFT JOIN users inv ON inv.id = i.invited_by
    WHERE i.workspace_id = ? AND i.expires_at > strftime('%s','now')
    ORDER BY i.created_at DESC
  `).all(ws.id);
  res.json(invites);
});

// POST /:id/invites - admin only. Rate-limited (per-user, per-workspace,
// hour window). Idempotent against in-flight duplicate invites via a
// transaction-bounded collision check (workspace_invites has no UNIQUE
// constraint on (workspace_id, email), so the txn is what prevents the
// TOCTOU race between two simultaneous POSTs).
router.post('/:id/invites', async (req, res) => {
  const ws = loadWorkspace(req, res, true);
  if (!ws) return;

  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = String(req.body?.role || '').trim();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!WORKSPACE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor, or workspace_viewer' });
  }

  // Block invite to existing direct member of this workspace. (Org-level
  // members are not "members" of this specific workspace via workspace_members,
  // so they're allowed to also be invited as direct members if desired.)
  const existingMember = db.prepare(`
    SELECT 1 FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND lower(u.email) = ?
  `).get(ws.id, email);
  if (existingMember) {
    return res.status(400).json({ error: 'User is already a member of this workspace' });
  }

  // Rate limit: per-(inviter, workspace), hour window, counts rows actually
  // created. Generic 429 message - don't echo the configured limit value
  // (info leak about deployment policy).
  const recentCount = db.prepare(`
    SELECT COUNT(*) AS c FROM workspace_invites
    WHERE invited_by = ? AND workspace_id = ?
      AND created_at > strftime('%s','now') - 3600
  `).get(req.user.id, ws.id).c;
  if (recentCount >= INVITE_RATE_LIMIT_PER_HOUR) {
    return res.status(429).json({ error: 'Invite rate limit reached - try again later' });
  }

  // Transaction-bounded collision-check-then-insert. Closes the race where
  // two simultaneous POSTs both pass the SELECT and both INSERT.
  const inviteId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + (INVITE_EXPIRY_DAYS * 86400);
  const txn = db.transaction(() => {
    const dupe = db.prepare(`
      SELECT id FROM workspace_invites
      WHERE workspace_id = ? AND lower(email) = ? AND expires_at > strftime('%s','now')
    `).get(ws.id, email);
    if (dupe) return { collision: true };
    db.prepare(`
      INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(inviteId, ws.id, email, role, req.user.id, expiresAt);
    return { collision: false };
  });
  const txnResult = txn();
  if (txnResult.collision) {
    return res.status(409).json({ error: 'An invite for this email is already pending' });
  }

  // Build accept URL. APP_URL env var (when set) pins the public-facing
  // origin regardless of how the request arrived - recommended in prod so
  // invites triggered from non-browser sources (curl, future API automation)
  // always carry the canonical origin. Same env var the rest of the codebase
  // uses for Stripe callbacks (see README env-var table). Falls back to
  // request-derived for local dev and when APP_URL isn't set; with trust
  // proxy on, req.protocol + req.get('host') reflect Cloudflare-forwarded
  // X-Forwarded-Proto + Host. Path is /app#/accept-invite/<id> - the SPA
  // lives at /app, so a bare /#/accept-invite/<id> would land on the
  // marketing landing page in dev (and rely on the DISABLE_HOMEPAGE
  // redirect in prod). /app is explicit.
  const publicBase = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const acceptUrl = `${publicBase}/app#/accept-invite/${inviteId}`;
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(ws.organization_id);
  const { subject, text } = buildInviteEmail({
    workspaceName: ws.name,
    organizationName: org?.name || '',
    inviterName: req.user.name || req.user.email,
    role,
    acceptUrl,
  });

  const sendResult = await sendEmail({ to: email, subject, text });

  // Rollback rule: only graph_error (real send attempted, Graph rejected)
  // deletes the row. not_configured and dev_restricted are intentional
  // non-sends - keep the row, count against the rate limit, allow local
  // accept-invite testing to proceed.
  if (sendResult.reason === 'graph_error') {
    db.prepare('DELETE FROM workspace_invites WHERE id = ?').run(inviteId);
    return res.status(502).json({ error: 'Email send failed - invite not created' });
  }

  res.status(201).json({ id: inviteId, email, role, expires_at: expiresAt });
});

// DELETE /:id/invites/:inviteId - admin only. Cancels a pending invite.
router.delete('/:id/invites/:inviteId', (req, res) => {
  const ws = loadWorkspace(req, res, true);
  if (!ws) return;
  const invite = db.prepare('SELECT id FROM workspace_invites WHERE id = ? AND workspace_id = ?')
    .get(req.params.inviteId, ws.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  db.prepare('DELETE FROM workspace_invites WHERE id = ?').run(invite.id);
  res.json({ success: true });
});

// PUT /:id/members/:userId - admin only. Change role.
router.put('/:id/members/:userId', (req, res) => {
  const ws = loadWorkspace(req, res, true);
  if (!ws) return;
  const newRole = String(req.body?.role || '').trim();
  if (!WORKSPACE_ROLES.includes(newRole)) {
    return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor, or workspace_viewer' });
  }
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(ws.id, req.params.userId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (member.role === 'workspace_admin' && newRole !== 'workspace_admin') {
    if (countWorkspaceAdmins(ws.id) <= 1) {
      return res.status(409).json({ error: 'Cannot demote the last admin' });
    }
  }
  db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
    .run(newRole, ws.id, req.params.userId);
  res.json({ user_id: req.params.userId, role: newRole });
});

// DELETE /:id/members/:userId - admin only. Removes the workspace_members
// row. Blocks (a) removing the parent-org's org_owner via the workspace path,
// since their access comes from org_members anyway, and (b) removing the
// last workspace_admin which would leave the workspace headless.
router.delete('/:id/members/:userId', (req, res) => {
  const ws = loadWorkspace(req, res, true);
  if (!ws) return;
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(ws.id, req.params.userId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const orgOwner = db.prepare(
    "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? AND role = 'org_owner'"
  ).get(ws.organization_id, req.params.userId);
  if (orgOwner) {
    return res.status(403).json({ error: 'Cannot remove the organization owner' });
  }
  if (member.role === 'workspace_admin' && countWorkspaceAdmins(ws.id) <= 1) {
    return res.status(409).json({ error: 'Cannot remove the last admin' });
  }
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .run(ws.id, req.params.userId);
  res.json({ success: true });
});

/*
 * #talk broadcast (one-way PA to every device in the workspace). Same shape as the per-group
 * routes in device-groups.js: the operator publishes their mic to the workspace's shared go2rtc
 * stream, and the dashboard tells every device in the workspace to listen. Gated on the live-video
 * master switch + the workspace flag + a live sidecar. Any workspace member may talk.
 */
function loadTalkWorkspace(req, res) {
  const ws = db.prepare('SELECT id, live_video_enabled FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) { res.status(404).json({ error: 'Workspace not found' }); return null; }
  if (!canAccessWorkspace(db, req.user, ws)) { res.status(403).json({ error: 'Access denied' }); return null; }
  return ws;
}

router.get('/:id/talk', async (req, res) => {
  const ws = loadTalkWorkspace(req, res); if (!ws) return;
  if (!(appConfig.liveVideoEnabled && ws.live_video_enabled)) return res.json({ mode: 'off', reason: 'disabled' });
  if (!go2rtc.enabled()) return res.json({ mode: 'off', reason: 'no_sidecar' });
  if (!(await go2rtc.healthy())) return res.json({ mode: 'off', reason: 'sidecar_down' });
  res.json({
    mode: 'webrtc',
    scope: { kind: 'workspace', id: ws.id },
    publishPath: `/api/workspaces/${ws.id}/talk/publish`,
    iceServers: go2rtc.iceServers(),
    expiresAt: Date.now() + 30000,
  });
});

router.post('/:id/talk/publish', express.text({ type: ['application/sdp', 'text/plain'], limit: '256kb' }), async (req, res) => {
  const ws = loadTalkWorkspace(req, res); if (!ws) return;
  if (!(appConfig.liveVideoEnabled && ws.live_video_enabled) || !go2rtc.enabled()) {
    return res.status(409).json({ error: 'Talk is not available for this workspace' });
  }
  const name = go2rtc.broadcastTalkStreamName('workspace', ws.id);
  const offer = typeof req.body === 'string' ? req.body : '';
  if (!offer) return res.status(400).json({ error: 'SDP offer required' });
  try { await go2rtc.ensureStream(name); } catch (_) { /* go2rtc may auto-create on dst */ }
  const answer = await go2rtc.webrtcExchange(name, offer, 'pub');
  if (!answer) return res.status(502).json({ error: 'go2rtc did not answer' });
  res.type('application/sdp').send(answer.sdp);
});

module.exports = router;
