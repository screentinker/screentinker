const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const oidcProviders = require('../lib/oidc-providers');
const { canAdminWorkspace } = require('../lib/permissions');
const { requirePlatformAdmin, requireAdmin } = require('../middleware/auth');
const { logActivity, getClientIp } = require('../services/activity');
const { deleteWorkspaceCascade, deleteOrgCascade } = require('../lib/user-deletion');
const { platformDefaultRow, HARDCODED_BRANDING, PLATFORM_DEFAULT_ID } = require('../lib/branding');

// Admin-provisioned user creation (#10). Operates on a target workspace
// specified in the body, NOT the caller's active workspace - so this router is
// mounted with requireAuth only (no resolveTenancy), mirroring routes/workspaces.js.
// Permission is gated per-handler via canAdminWorkspace() against the TARGET
// workspace, which:
//   - lets a platform_admin create users anywhere,
//   - scopes an org_admin / org_owner to workspaces in orgs they administer,
//   - and excludes platform_operator (isPlatformRole owner-only) - operators
//     have no user/role-management power (#13).

// Same email shape the invite-create endpoint validates against (workspaces.js).
// Markup characters are not legal here. The looser form admitted < > " ' and an admin-
// chosen email became stored XSS in the platform admin's user list.
const EMAIL_RE = /^[^\s@<>"'`\\;,()\[\]]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const WORKSPACE_ROLES = ['workspace_admin', 'workspace_editor', 'workspace_viewer'];
// Mirror the server-side minimum enforced by PUT /api/auth/me and register.
const MIN_PASSWORD_LENGTH = 8;

// POST /api/admin/users - create a user with an admin-set password and assign
// them to a workspace + role. The result is indistinguishable from an
// invite-accepted user (a global users row + a workspace_members row).
router.post('/users', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  // Accept workspaceId (preferred) or orgId as an alias for the target field.
  const workspaceId = String(req.body?.workspaceId || req.body?.orgId || '').trim();
  const role = String(req.body?.role || '').trim();
  const mustChangePassword = !!req.body?.mustChangePassword;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!WORKSPACE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor, or workspace_viewer' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId required' });
  }

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAdminWorkspace(db, req.user, ws)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  /*
   * ⚠️ An SSO-only organization must not have password accounts minted into it.
   *
   * This route creates a LOCAL account with an admin-chosen password, and it accepts any address —
   * so on a tenant that requires single sign-on it was a one-call backdoor: create
   * `contractor@somewhere-else.test` bound to the workspace, log in with the password, and every
   * control the customer turned SSO-only on for is behind you. A review did exactly that, and the
   * account it created could then mint another.
   *
   * platform_admin keeps the ability, because that is the operator break-glass — the same
   * exemption the login gate makes, for the same reason.
   */
  if (req.user.role !== 'platform_admin' && ws.organization_id) {
    // The table is absent on a single-tenant install; that simply means no organization requires
    // single sign-on, so creation proceeds.
    let org = null;
    try { org = db.prepare('SELECT sso_only, name FROM organizations WHERE id = ?').get(ws.organization_id); }
    catch { org = null; }
    if (org && org.sso_only) {
      return res.status(400).json({
        error: `${org.name || 'This organization'} requires single sign-on, so password accounts cannot be created. Invite the person through your identity provider instead.`,
        code: 'sso_only_org',
      });
    }
  }

  /*
   * ⚠️ And the ADDRESS's own domain, wherever it is being created.
   *
   * Gating only on the target workspace left the squat open through a different door: create your
   * own organization, then mint `cfo@theircompany.test` into YOUR workspace. Login is refused, so
   * it is not access — but the row now has a password_hash, and an SSO login will not adopt a row
   * that has one. The real CFO can then never sign in through their own identity provider, and a
   * password reset they CAN complete lands them at a login that refuses them. Permanent, with no
   * self-service way out, for any address at any SSO-only customer.
   */
  if (req.user.role !== 'platform_admin') {
    let ownedBy = null;
    try { ownedBy = oidcProviders.ssoOnlyForEmail(email); } catch { ownedBy = { unavailable: true }; }
    if (ownedBy) {
      return res.status(400).json({
        error: 'That email domain uses single sign-on, so a password account cannot be created for it.',
        code: 'sso_only_domain',
      });
    }
  }

  // Stamp the target workspace so the activityLogger middleware (and our
  // explicit audit row) attribute to the right tenant.
  req.workspaceId = ws.id;

  // Email uniqueness: clean 409, never overwrite an existing account.
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  // HOSTED_INSTANCE: an admin-provisioned user is already set up with a
  // password, so they must NOT receive the welcome email or enter the
  // activation-nudge lifecycle. We never call sendSignupEmails here, and the
  // nudge sweep already excludes them (they have a workspace_members row); we
  // additionally stamp both *_sent_at sentinels so any future sweep treats them
  // as already-handled. See services/signupEmails.js + services/activationNudge.js.
    //
    // email_verified = 1 for the same reason (#292). The column defaults to 0 and there is no
    // verification flow for a user an ADMIN created - nobody sent them a link. On an instance with
    // no SMTP configured that left them with a permanent "Please confirm your email address"
    // banner they could not clear, fixable only by editing the database by hand. An address chosen
    // by an administrator provisioning the account is as verified as this system can make it.
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (
        id, email, name, password_hash, auth_provider, role, plan_id,
        must_change_password, email_verified, welcome_email_sent_at, activation_nudge_sent_at
      ) VALUES (?, ?, ?, ?, 'local', 'user', 'free', ?, 1, strftime('%s','now'), strftime('%s','now'))
    `).run(id, email, name || email.split('@')[0], passwordHash, mustChangePassword ? 1 : 0);

    // Same membership footprint as an accepted invite: one workspace_members
    // row, invited_by = the admin who created them.
    db.prepare(`
      INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?)
    `).run(ws.id, id, role, req.user.id);
  });
  txn();

  // Explicit audit row - who created whom, where, with what role. Never the
  // plaintext password (and the generic activityLogger only summarizes name).
  logActivity(req.user.id, 'admin_create_user', `target: ${email}, role: ${role}`, null, getClientIp(req), ws.id);

  // Response never includes password or hash.
  const created = db.prepare(
    'SELECT id, email, name, role, auth_provider, plan_id, must_change_password, created_at FROM users WHERE id = ?'
  ).get(id);
  res.status(201).json({ ...created, workspace_id: ws.id, workspace_role: role });
});

// POST /api/admin/orgs - create a new organization + its first ("Default")
// workspace (#35). Platform-admin only. The MSP use case: provision a customer
// org without the signup/auto-org path (AUTO_CREATE_ORG_ON_SIGNUP=false).
//
// organizations.owner_user_id is NOT NULL, so a brand-new org can't be ownerless.
// We make the creating platform admin the owner + workspace_admin (mirrors the
// signup org-bootstrap in routes/auth.js), which also surfaces the org in their
// switcher immediately. Customer users are then added via the Add User /
// manage-memberships flow.
router.post('/orgs', requirePlatformAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name required' });
  if (name.length > 120) return res.status(400).json({ error: 'Organization name must be 120 characters or fewer' });

  const orgId = uuidv4();
  const wsId = uuidv4();
  const ownerId = req.user.id;
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'free', 'active')`
    ).run(orgId, name, ownerId);
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, ownerId);
    db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)`).run(wsId, orgId, ownerId);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(wsId, ownerId);
  });
  txn();

  req.workspaceId = wsId; // attribute the audit row to the new tenant
  logActivity(req.user.id, 'admin_create_org', `org: ${name}`, null, getClientIp(req), wsId);
  res.status(201).json({ id: orgId, name, owner_user_id: ownerId, workspace_id: wsId, workspace_name: 'Default' });
});

// GET /api/admin/orgs - list every organization with owner + resource counts and
// its workspaces (#36, drives the Organizations admin section). Platform-admin only.
router.get('/orgs', requirePlatformAdmin, (req, res) => {
  const orgs = db.prepare(`
    SELECT o.id, o.name, o.created_at, o.talk_enabled, o.ice_servers, u.email AS owner_email, u.name AS owner_name,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS member_count,
      (SELECT COUNT(*) FROM workspaces w WHERE w.organization_id = o.id) AS workspace_count,
      (SELECT COUNT(*) FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = o.id) AS device_count
    FROM organizations o
    LEFT JOIN users u ON u.id = o.owner_user_id
    ORDER BY o.created_at DESC
  `).all();
  const wsByOrg = {};
  for (const w of db.prepare(`
    SELECT w.id, w.name, w.organization_id,
      (SELECT COUNT(*) FROM devices d WHERE d.workspace_id = w.id) AS device_count,
      (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count
    FROM workspaces w ORDER BY w.created_at
  `).all()) {
    (wsByOrg[w.organization_id] = wsByOrg[w.organization_id] || []).push(w);
  }
  res.json(orgs.map(o => ({ ...o, workspaces: wsByOrg[o.id] || [] })));
});

// DELETE /api/admin/orgs/:id - cascade-delete an org and everything in it (#36).
// Platform-admin only. The frontend requires a type-the-name confirmation; this
// is irreversible. Uses the shared cascade helper so no tenant resource is orphaned.
router.delete('/orgs/:id', requirePlatformAdmin, (req, res) => {
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  try {
    // Also removes the org's uploaded files + .history copies once the rows are committed gone
    // (audit F23) - /uploads/content is public, so leaving them was not deleting the data.
    deleteOrgCascade(db, { orgId: org.id });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete organization' });
  }
  logActivity(req.user.id, 'admin_delete_org', `org: ${org.name} (${org.id})`, null, getClientIp(req), null);
  res.json({ deleted: true, id: org.id });
});

// PUT /api/admin/orgs/:id/talk - platform-admin toggle for the per-org #talk feature and an
// optional per-org ICE (STUN/TURN) override. talk_enabled gates the voice intercom / PA on top of
// the global TALK_ENABLED master switch; ice_servers (a JSON array of {urls, username?, credential?})
// overrides the sidecar's ICE servers for this org's live video AND talk, or NULL to fall back.
router.put('/orgs/:id/talk', requirePlatformAdmin, (req, res) => {
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const enabled = req.body?.talk_enabled ? 1 : 0;

  // ice_servers: accept null/'' (clear -> fall back to sidecar), or a JSON array of ICE entries.
  // Validate shape here so a malformed override can never reach a device's RTCPeerConnection.
  let iceJson = null;
  if (req.body?.ice_servers !== undefined && req.body.ice_servers !== null && req.body.ice_servers !== '') {
    let arr = req.body.ice_servers;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { return res.status(400).json({ error: 'ice_servers must be valid JSON' }); } }
    if (!Array.isArray(arr)) return res.status(400).json({ error: 'ice_servers must be a JSON array' });
    for (const e of arr) {
      if (!e || typeof e !== 'object') return res.status(400).json({ error: 'each ice_servers entry must be an object' });
      const urls = e.urls;
      const ok = typeof urls === 'string' || (Array.isArray(urls) && urls.length && urls.every(u => typeof u === 'string'));
      if (!ok) return res.status(400).json({ error: 'each ice_servers entry needs a urls string or non-empty string[]' });
    }
    iceJson = JSON.stringify(arr);
  }

  db.prepare("UPDATE organizations SET talk_enabled = ?, ice_servers = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(enabled, iceJson, org.id);
  logActivity(req.user.id, 'admin_org_talk', `org: ${org.name} (${org.id}) talk=${enabled} ice=${iceJson ? 'custom' : 'default'}`, null, getClientIp(req), null);
  res.json({ id: org.id, talk_enabled: enabled, ice_servers: iceJson });
});

// DELETE /api/admin/workspaces/:id - cascade-delete a single workspace + its
// tenant resources (#36); the parent org is left intact. Platform-admin only.
router.delete('/workspaces/:id', requirePlatformAdmin, (req, res) => {
  const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  /*
   * ⚠️ CORPORATE (risk R17): an org's head office workspace holds the corporate playlists its
   * mandates point at (a NO ACTION foreign key — the delete would fail at COMMIT with a bare
   * FOREIGN KEY error). Refuse while any mandate uses them, saying where; otherwise let it go and
   * clear the org's pointer to it.
   */
  {
    let hqOf = [];
    try { hqOf = db.prepare('SELECT id FROM organizations WHERE hq_workspace_id = ?').all(ws.id); } catch (_) { hqOf = []; /* pre-corporate schema */ }
    if (hqOf.length) {
      const inUse = db.prepare(`SELECT COUNT(*) AS n FROM corporate_mandates cm JOIN playlists p ON p.id = cm.playlist_id
          WHERE p.workspace_id = ?`).get(ws.id).n;
      if (inUse) {
        const screens = db.prepare(`SELECT COUNT(*) AS n FROM device_resolved_playlist r JOIN playlists p ON p.id = r.playlist_id
            WHERE p.workspace_id = ? AND r.source = 'corporate'`).get(ws.id).n;
        const corpGuard = require('../lib/corporate/guard');
        return corpGuard.send(res, corpGuard.err('CORPORATE_HQ_IN_USE', { workspace: ws.name, screens }), req);
      }
    }
  }
  try {
    // One transaction (audit F23 + corporate): the corporate cleanup runs INSIDE the cascade's own
    // transaction, so it commits only with the delete it belongs to, and the files still go after commit.
    deleteWorkspaceCascade(db, {
      workspaceId: ws.id,
      before: () => {
        require('../lib/corporate/cleanup').removeWorkspaceTargets(db, ws.id);
        try {
          db.prepare('UPDATE organizations SET hq_workspace_id = NULL, corporate_enabled = 0 WHERE hq_workspace_id = ?').run(ws.id);
        } catch (_) { /* pre-corporate schema: nothing points at it */ }
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete workspace' });
  }
  logActivity(req.user.id, 'admin_delete_workspace', `workspace: ${ws.name} (${ws.id})`, null, getClientIp(req), null);
  res.json({ deleted: true, id: ws.id });
});

// PUT /api/admin/users/:id/workspace - move/assign a SINGLE-workspace user to a
// different workspace (platform Users admin page). Platform-admin only: this is
// a cross-org, platform-level action (requirePlatformAdmin excludes
// platform_operator, mirroring the page gating).
//
// Single-workspace model: refuses (400) a user who belongs to >1 workspace -
// a single pick must never silently clobber multiple memberships; those are
// managed in the workspace members view. Mirrors the frontend guard.
router.put('/users/:id/workspace', requirePlatformAdmin, (req, res) => {
  const workspaceId = String(req.body?.workspaceId || '').trim();
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const memberships = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').all(target.id);
  if (memberships.length > 1) {
    return res.status(400).json({ error: 'User belongs to multiple workspaces - manage in the workspace members view' });
  }

  const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(ws.organization_id);

  // No-op if the chosen workspace is already their sole membership (preserve role).
  if (memberships.length === 1 && memberships[0].workspace_id === ws.id) {
    const cur = db.prepare('SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ?').get(target.id, ws.id);
    return res.json({ user_id: target.id, workspace_id: ws.id, workspace_name: ws.name, organization_name: org?.name || null, role: cur ? cur.role : 'workspace_viewer', unchanged: true });
  }

  req.workspaceId = ws.id; // audit attribution
  // Move (drop the existing single membership) or assign (none to drop), then
  // add the chosen one at the default role. Guarded above to <=1 membership, so
  // the DELETE removes at most one row.
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(target.id);
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
      .run(ws.id, target.id, 'workspace_viewer', req.user.id);
  });
  txn();

  logActivity(req.user.id, 'admin_set_user_workspace', `target: ${target.email}, workspace: ${ws.id}`, null, getClientIp(req), ws.id);

  res.json({ user_id: target.id, workspace_id: ws.id, workspace_name: ws.name, organization_name: org?.name || null, role: 'workspace_viewer' });
});

/*
 * Turn a user's alert email on or off, as a platform admin.
 *
 * This existed only as a hand-written UPDATE against prod. Two problems with that, and the second is
 * the one that bites: a raw UPDATE leaves NO activity_log row, so months later there is nothing
 * distinguishing "the customer asked us to stop emailing them" from "the alert service is broken and
 * nobody noticed a display went dark". The support answer and the incident response are opposite, and
 * the only thing that tells them apart is a record of the decision.
 *
 * ⚠️ email_alerts is one switch over several senders — offline-device alerts, trial reminders, setup
 * nudges and payment-failure notices. The response names them so an admin turning it off for a paying
 * customer can see that dunning goes quiet too, rather than discovering it at renewal.
 *
 * requirePlatformAdmin, not requireAdmin: this reaches any account on the box regardless of org, and
 * platform_operator has no user-management power (#13).
 */
router.put('/users/:id/email-alerts', requirePlatformAdmin, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    // Not coerced. `{"enabled":"false"}` is truthy in JavaScript, and silently enabling alerts for
    // somebody who asked for silence is the exact failure this endpoint exists to prevent.
    return res.status(400).json({ error: 'enabled must be true or false' });
  }

  const target = db.prepare('SELECT id, email, name, email_alerts FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const next = enabled ? 1 : 0;
  const was = target.email_alerts == null ? 1 : (target.email_alerts ? 1 : 0);   // nullable on old rows
  const changed = was !== next;

  if (changed) {
    db.prepare("UPDATE users SET email_alerts = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(next, target.id);
    logActivity(
      req.user.id,
      enabled ? 'admin_enabled_email_alerts' : 'admin_disabled_email_alerts',
      `target: ${target.email}`,
      null,
      getClientIp(req),
      null
    );
  }

  res.json({
    user_id: target.id,
    email: target.email,
    email_alerts: !!next,
    changed,
    // Named rather than implied, so the caller can see the blast radius of one boolean.
    affects: ['device offline alerts', 'trial reminders', 'setup nudges', 'payment-failure notices'],
  });
});

// ===================== Per-user workspace membership management =====================
// Platform-admin only (cross-org, platform-level). Unlike the single-workspace
// "move" above, these manage a user's FULL set of memberships - a user can
// belong to several workspaces, each with its own role - from the platform Users
// page "Manage workspaces" modal. requirePlatformAdmin excludes platform_operator
// (no user/role management, #13).

function userMembershipList(userId) {
  return db.prepare(`
    SELECT wm.workspace_id, w.name AS workspace_name, o.name AS organization_name, wm.role
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    JOIN organizations o ON o.id = w.organization_id
    WHERE wm.user_id = ?
    ORDER BY o.name, w.name
  `).all(userId);
}

// GET - list every workspace the user belongs to (with role + org/workspace name).
router.get('/users/:id/workspaces', requirePlatformAdmin, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  res.json(userMembershipList(req.params.id));
});

// POST - add the user to a workspace (or update their role if already a member).
router.post('/users/:id/workspaces', requirePlatformAdmin, (req, res) => {
  const role = String(req.body?.role || '').trim();
  const workspaceId = String(req.body?.workspaceId || '').trim();
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
  if (!WORKSPACE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor, or workspace_viewer' });
  }
  const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  req.workspaceId = ws.id;

  const existing = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws.id, target.id);
  if (existing) {
    db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, ws.id, target.id);
  } else {
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)').run(ws.id, target.id, role, req.user.id);
  }
  logActivity(req.user.id, 'admin_add_user_workspace', `target: ${target.email}, workspace: ${ws.id}, role: ${role}`, null, getClientIp(req), ws.id);
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(ws.organization_id);
  res.status(existing ? 200 : 201).json({ workspace_id: ws.id, workspace_name: ws.name, organization_name: org?.name || null, role });
});

// PUT - change the user's role in a specific workspace.
router.put('/users/:id/workspaces/:workspaceId', requirePlatformAdmin, (req, res) => {
  const role = String(req.body?.role || '').trim();
  if (!WORKSPACE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor, or workspace_viewer' });
  }
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.params.workspaceId, req.params.id);
  if (!member) return res.status(404).json({ error: 'Membership not found' });
  db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, req.params.workspaceId, req.params.id);
  req.workspaceId = req.params.workspaceId;
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  logActivity(req.user.id, 'admin_set_user_workspace_role', `target: ${target?.email}, workspace: ${req.params.workspaceId}, role: ${role}`, null, getClientIp(req), req.params.workspaceId);
  res.json({ workspace_id: req.params.workspaceId, role });
});

// DELETE - remove the user from a workspace. Allowed even if it's their last one
// (they become Unassigned - the no-workspace state from #12).
router.delete('/users/:id/workspaces/:workspaceId', requirePlatformAdmin, (req, res) => {
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.params.workspaceId, req.params.id);
  if (!member) return res.status(404).json({ error: 'Membership not found' });
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(req.params.workspaceId, req.params.id);
  req.workspaceId = req.params.workspaceId;
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  logActivity(req.user.id, 'admin_remove_user_workspace', `target: ${target?.email}, workspace: ${req.params.workspaceId}`, null, getClientIp(req), req.params.workspaceId);
  res.json({ success: true });
});

// ===================== Instance-level default branding (#15) =====================
// Platform-admin only. The "platform default" is a single white_labels row with
// workspace_id IS NULL that every workspace inherits unless it set its own
// (resolution lives in lib/branding.js). Editable here / in the Admin UI.

const BRANDING_FIELDS = ['brand_name', 'logo_url', 'favicon_url', 'primary_color', 'secondary_color', 'bg_color', 'custom_css', 'hide_branding'];

// GET - the current platform-default branding (falls back to hardcoded so the
// admin form always has values to show).
router.get('/branding', requirePlatformAdmin, (req, res) => {
  res.json(platformDefaultRow(db) || { ...HARDCODED_BRANDING });
});

// PUT - upsert the single platform-default row (workspace_id IS NULL).
router.put('/branding', requirePlatformAdmin, (req, res) => {
  const existing = platformDefaultRow(db);
  if (existing) {
    const updates = [];
    const values = [];
    for (const f of BRANDING_FIELDS) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(f === 'hide_branding' ? (req.body[f] ? 1 : 0) : (req.body[f] || null));
      }
    }
    if (updates.length) {
      updates.push("updated_at = strftime('%s','now')");
      values.push(existing.id);
      db.prepare(`UPDATE white_labels SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  } else {
    // Fixed id sentinel (not workspace_id IS NULL - see lib/branding.js).
    // user_id is NOT NULL on the legacy table; stamp the acting admin.
    db.prepare(`
      INSERT INTO white_labels (id, user_id, workspace_id, brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color, custom_css, hide_branding)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      PLATFORM_DEFAULT_ID, req.user.id,
      req.body.brand_name || 'ScreenTinker',
      req.body.logo_url || null, req.body.favicon_url || null,
      req.body.primary_color || '#3B82F6', req.body.secondary_color || '#1E293B', req.body.bg_color || '#111827',
      req.body.custom_css || null, req.body.hide_branding ? 1 : 0
    );
  }
  logActivity(req.user.id, 'admin_set_platform_branding', `brand: ${req.body.brand_name || ''}`, null, getClientIp(req), null);
  res.json(platformDefaultRow(db));
});

// ===================== /api/status debug exposure (#146) =====================
// Platform-admin only. Toggles whether /api/status includes the internal `debug` block
// (limiter/prune/OTA counters). Persisted in app_settings + cached, so it takes effect
// on the NEXT status poll with no restart. Default follows STATUS_DEBUG_ENABLED env.
const appSettings = require('../lib/app-settings');
const config = require('../config');

router.get('/status-debug', requirePlatformAdmin, (req, res) => {
  res.json({ enabled: appSettings.getBool('status_debug_enabled', config.statusDebugEnabled) });
});
router.put('/status-debug', requirePlatformAdmin, (req, res) => {
  const enabled = !!req.body.enabled;
  appSettings.setBool('status_debug_enabled', enabled);   // persists + refreshes the cache
  logActivity(req.user.id, 'admin_set_status_debug', `enabled: ${enabled}`, null, getClientIp(req), null);
  res.json({ enabled });
});

// ===================== Opt-in install statistics =====================
// Returns the decision state, the EXACT payload that would be sent, and what was last actually
// sent. Handing over the real payload rather than a description is the point: an operator can
// check instead of trusting a sentence, and the code is public so a mismatch would be visible.
const telemetry = require('../lib/telemetry');

router.get('/telemetry', requirePlatformAdmin, (req, res) => {
  res.json({
    state: telemetry.state(),                 // 'unasked' | 'on' | 'off'
    payload: telemetry.payload(db),           // what WOULD be sent, right now
    endpoint: telemetry.endpoint(),           // ours — the host an operator may need to allowlist
    extra_endpoint: telemetry.extraEndpoint(),// their own collector, if configured
    destinations: telemetry.destinations(),   // everywhere it actually goes, right now
    last_report: telemetry.getLastReport(),   // what was actually sent, and when
    last_error: telemetry.getLastError(),     // why the last attempt failed, if it did
  });
});

router.put('/telemetry', requirePlatformAdmin, async (req, res) => {
  // Both answers are recorded. Declining must persist as 'off' rather than staying 'unasked',
  // or the prompt returns after every update — which is how telemetry earns its bad name.
  const enabled = !!req.body.enabled;
  const state = telemetry.setEnabled(enabled);
  logActivity(req.user.id, 'admin_set_telemetry', `enabled: ${enabled}`, null, getClientIp(req), null);

  // Send once, now, rather than waiting for the next daily tick. Two reasons: the operator is
  // standing right here and "nothing has been sent" for the next 24h reads as broken, and an
  // egress-filtered network fails HERE where we can name the host to unblock — instead of
  // failing silently tonight where nobody is watching.
  let first = null;
  if (enabled) first = await telemetry.report(db);

  res.json({
    state,
    payload: telemetry.payload(db),
    endpoint: telemetry.endpoint(),
    extra_endpoint: telemetry.extraEndpoint(),
    destinations: telemetry.destinations(),
    first_report: first && { sent: first.sent, reason: first.reason || null },
    last_report: telemetry.getLastReport(),
    last_error: telemetry.getLastError(),
  });
});

// ===================== Version update indicator =====================
// check-update = requireAdmin — a read-only GHCR poll, operational.
// trigger-update / update-status = requirePlatformAdmin — they queue and watch an upgrade of
// the whole instance. The work is done by the separate host-side updater (lib/instance-updater.js,
// docs/instance-updater.md), never by this process.

const ghcrCheck = require('../lib/ghcr-check');
const VERSION = require('../version');

// POST /api/admin/check-update — force a fresh GHCR poll (bypasses cache)
// and return version comparison.
router.post('/check-update', requireAdmin, async (req, res) => {
  try {
    const result = await ghcrCheck.checkNow(VERSION);
    res.json({
      current: VERSION,
      latest: result.latest,
      update_available: result.update_available,
    });
  } catch (err) {
    res.status(502).json({ error: 'GHCR poll failed', detail: err.message });
  }
});

/*
 * How this instance is actually installed, so "Update Now" can hand back a command that works.
 *
 * This used to build a `docker compose` line unconditionally, with composeFilePath defaulting to
 * /opt/screentinker/docker-compose.yml whether or not that file existed. Self-hosters running the
 * git + systemd install documented in docs/operations.md were therefore told to run a docker
 * command against a compose file they do not have. One of them upgraded 1.9.39 to 2.0.8 only
 * because he had written his own update script; the dashboard's advice was useless to him.
 *
 * /.dockerenv is the reliable in-container signal, and it matters because the compose file lives
 * on the HOST, so testing for it from inside the container always fails. Outside a container, a
 * checkout with scripts/upgrade.sh in it is the documented path and that script already does the
 * right thing (backup, checkout the tag, npm ci --omit=dev, restart, report the running version).
 */
function detectInstall() {
  const fs = require('fs');
  const path = require('path');
  const config = require('../config');
  const appRoot = path.join(__dirname, '..', '..');
  const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

  if (exists('/.dockerenv') || exists(config.composeFilePath)) {
    const f = config.composeFilePath;
    return { kind: 'docker', command: `docker compose -f ${f} pull && docker compose -f ${f} up -d` };
  }
  if (exists(path.join(appRoot, '.git')) && exists(path.join(appRoot, 'scripts', 'upgrade.sh'))) {
    return { kind: 'git', command: `cd ${appRoot} && scripts/upgrade.sh` };
  }
  // Say so rather than guessing. A confidently wrong command costs more than an honest shrug.
  return { kind: 'unknown', command: null };
}

// POST /api/admin/trigger-update — queue an upgrade for the host-side updater, when one is
// installed; otherwise hand back the command that suits how this instance IS installed.
//
// ⚠️ This used to exec `docker compose pull && up -d` from inside the app (DOCKER_UPDATE_ENABLED).
// That could never work: the image has no docker CLI, and a container recreating itself kills the
// command half way. The updater is a separate process precisely so the upgrade outlives the restart.
router.post('/trigger-update', requirePlatformAdmin, (req, res) => {
  const updater = require('../lib/instance-updater');
  const u = updater.info();
  if (!u.available) {
    const install = detectInstall();
    return res.json({
      queued: false,
      updater: u,
      install: install.kind,
      instructions: install.command
        || 'This instance was not installed in a way the server recognises, so there is no safe command to suggest. See docs/operations.md for the upgrade steps.',
    });
  }
  const target = (req.body && req.body.target) || ghcrCheck.getLatestVersion();
  try {
    const job = updater.requestUpdate({ target, current: VERSION, userId: req.user.id });
    logActivity(req.user.id, 'admin_trigger_update', `queued upgrade v${VERSION} -> v${job.target} (${job.kind} updater)`, null, getClientIp(req), null);
    res.json({ queued: true, ...job });
  } catch (e) {
    if (e instanceof updater.UpdaterError) return res.status(e.code === 'busy' ? 409 : 400).json({ error: e.message, code: e.code });
    console.error('[updater] could not queue the request:', e && e.message);
    res.status(500).json({ error: 'Could not queue the upgrade request' });
  }
});

// GET /api/admin/update-status — what the dashboard polls while an upgrade runs (and across the
// restart: the status lives outside this process).
router.get('/update-status', requirePlatformAdmin, (req, res) => {
  const updater = require('../lib/instance-updater');
  const latest = ghcrCheck.getLatestVersion();
  res.json({
    current: VERSION,
    latest: latest || null,
    update_available: latest ? ghcrCheck.compareVersions(latest, VERSION) > 0 : false,
    updater: updater.info(),
    ...updater.status(),
  });
});

// QA-SNAT diagnostic. Auth rate-limit rejections are invisible everywhere else: the limiter is
// app.use middleware that returns 429 before the handler that would write activity_log, so the
// limit suppresses the record of itself. This exposes the in-memory tally so "is that IP one
// attacker or a NATed office?" can be answered from data instead of argued from a hunch.
//
// distinct_accounts is the signal, not rejections. Values are counts only — the identifiers are
// salted-hashed inside the telemetry module and never leave it, so this cannot become a roster
// of a customer's email addresses. Platform-admin only, and in-memory (a restart clears it).
// Platform-admin plan overview. Deliberately NOT the public /api/subscription/plans list, which
// filters `active = 1` because that is what the pricing page renders — so an intentionally hidden
// plan (a comped or beta tier) was invisible to the operator as well as to customers, with no way
// to see it existed or who was on it. This returns EVERY plan plus how many accounts sit on each,
// so a hidden tier is manageable rather than folklore.
router.get('/plans', requirePlatformAdmin, (req, res) => {
  const plans = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM users u WHERE u.plan_id = p.id) AS user_count,
           /*
            * ⚠️ Resolved through the OWNER, like device_count below — not from organizations.plan_id.
            * That column is written once when the org is created and never again: no Stripe webhook
            * touches it, so every organization reads 'pro' for ever regardless of what its owner
            * actually pays. Counting it told an operator that all 477 accounts were on Pro while one
            * of them was paying for Home.
            */
           (SELECT COUNT(*) FROM organizations o
              JOIN users u3 ON u3.id = o.owner_user_id
             WHERE u3.plan_id = p.id) AS org_count,
           (SELECT COUNT(*) FROM devices d
              JOIN workspaces w ON w.id = d.workspace_id
              JOIN organizations o2 ON o2.id = w.organization_id
              JOIN users u2 ON u2.id = o2.owner_user_id
             WHERE u2.plan_id = p.id) AS device_count
      FROM plans p
     ORDER BY p.active DESC, p.sort_order ASC
  `).all();
  // Accounts whose plan_id no longer resolves would otherwise be invisible in a per-plan view —
  // they are the ones that actually need attention (a deleted plan leaves them with no entitlements).
  const orphaned = db.prepare(`
    SELECT u.plan_id, COUNT(*) AS user_count FROM users u
     WHERE u.plan_id IS NOT NULL AND u.plan_id NOT IN (SELECT id FROM plans)
     GROUP BY u.plan_id
  `).all();
  res.json({ plans, orphaned });
});

// ─── Sales / limited-time discounts (lib/promotions.js) ─────────────────────────
// Platform admin only: a sale changes what every customer is charged.
router.get('/promotions', requirePlatformAdmin, (req, res) => {
  const promotions = require('../lib/promotions');
  const cur = promotions.current();
  res.json({
    promotions: promotions.list(),
    current_id: cur ? cur.id : null,
    stripe_configured: !!require('../lib/stripe-client').get(),
    // Why sales cannot run here, if they cannot (self-hosted, or no Stripe). One rule for every surface.
    unavailable_reason: promotions.salesAvailable(require('../lib/stripe-client').get()).reason,
  });
});

router.post('/promotions', requirePlatformAdmin, async (req, res) => {
  const promotions = require('../lib/promotions');
  try {
    const promo = await promotions.create(req.body, require('../lib/stripe-client').get(), req.user.id);
    res.status(201).json({ promotion: promo });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not create the sale' });
  }
});

router.post('/promotions/:id/end', requirePlatformAdmin, async (req, res) => {
  const promotions = require('../lib/promotions');
  try {
    const out = await promotions.end(req.params.id, require('../lib/stripe-client').get());
    res.json({ promotion: out.promo, stripe_warning: out.stripeWarning });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not end the sale' });
  }
});

router.put('/promotions/:id', requirePlatformAdmin, async (req, res) => {
  const promotions = require('../lib/promotions');
  try {
    const out = await promotions.update(req.params.id, req.body, require('../lib/stripe-client').get());
    res.json({ promotion: out.promo, stripe_warning: out.stripeWarning });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the sale' });
  }
});

router.delete('/promotions/:id', requirePlatformAdmin, async (req, res) => {
  const promotions = require('../lib/promotions');
  try {
    const out = await promotions.remove(req.params.id, require('../lib/stripe-client').get());
    res.json({ ok: true, stripe_warning: out.stripeWarning });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not delete the sale' });
  }
});

// ─── Platform overview (frontend: views/admin.js, #/platform/overview) ─────────────
// The numbers an operator checks first plus the things waiting on them. Counts only — no names,
// no emails. Each count is independent and tolerant: a table an older install lacks reads as 0
// instead of failing the whole page.
router.get('/overview', requirePlatformAdmin, (req, res) => {
  const n = (sql, ...args) => { try { return db.prepare(sql).get(...args).n || 0; } catch (_) { return 0; } };
  const now = Math.floor(Date.now() / 1000);
  const TRIAL_SECS = 14 * 86400; // middleware/subscription.js TRIAL_DAYS
  const latest = require('../lib/ghcr-check').getLatestVersion();
  const cmp = latest ? require('../lib/ghcr-check').compareVersions(latest, VERSION) : 0;
  res.json({
    version: VERSION,
    latest_version: latest || null,
    update_available: cmp > 0,
    users: n('SELECT COUNT(*) AS n FROM users'),
    platform_staff: n("SELECT COUNT(*) AS n FROM users WHERE role IN ('platform_admin','superadmin','platform_operator')"),
    organizations: n('SELECT COUNT(*) AS n FROM organizations'),
    workspaces: n('SELECT COUNT(*) AS n FROM workspaces'),
    devices: n('SELECT COUNT(*) AS n FROM devices'),
    devices_online: n("SELECT COUNT(*) AS n FROM devices WHERE status = 'online'"),
    paying_accounts: n("SELECT COUNT(*) AS n FROM users WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id != '' AND COALESCE(subscription_status,'active') IN ('active','trialing','past_due')"),
    trialing: n('SELECT COUNT(*) AS n FROM users WHERE trial_started IS NOT NULL AND trial_started + ? > ?', TRIAL_SECS, now),
    sso_only_requests: n("SELECT COUNT(*) AS n FROM org_sso_only_requests WHERE status = 'pending'"),
    // lib/plugins/submissions.js: a submission awaiting review is 'pending'. Only meaningful when
    // plugins are on — with them off there is no page to review them on.
    plugin_submissions: require('../config').pluginsEnabled ? n("SELECT COUNT(*) AS n FROM plugin_submissions WHERE status = 'pending'") : 0,
    orphaned_plan_users: n('SELECT COUNT(*) AS n FROM users WHERE plan_id IS NOT NULL AND plan_id NOT IN (SELECT id FROM plans)'),
    // Activity and health
    new_users_7d: n('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - 7 * 86400),
    inactive_30d: n("SELECT COUNT(*) AS n FROM users WHERE COALESCE(last_login, created_at) < ?", now - 30 * 86400),
    never_signed_in: n('SELECT COUNT(*) AS n FROM users WHERE last_login IS NULL'),
    unverified_emails: n('SELECT COUNT(*) AS n FROM users WHERE email_verified = 0'),
    trials_ending_7d: n('SELECT COUNT(*) AS n FROM users WHERE trial_started IS NOT NULL AND trial_started + ? BETWEEN ? AND ?', TRIAL_SECS, now, now + 7 * 86400),
    // A customer account with no paired screen in any workspace it can reach.
    accounts_no_screens: n(`
      SELECT COUNT(*) AS n FROM users u
       WHERE u.role = 'user' AND NOT EXISTS (
         SELECT 1 FROM devices d JOIN workspaces w ON w.id = d.workspace_id
          WHERE w.id IN (SELECT workspace_id FROM workspace_members WHERE user_id = u.id)
             OR w.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = u.id))`),
    orgs_no_screens: n('SELECT COUNT(*) AS n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = o.id)'),
    screens_offline_24h: n("SELECT COUNT(*) AS n FROM devices WHERE status != 'online' AND workspace_id IS NOT NULL AND COALESCE(last_heartbeat, 0) < ?", now - 86400),
    storage_bytes: n('SELECT COALESCE(SUM(file_size), 0) AS n FROM content'),
    stale_accounts_180d: require('../lib/account-cleanup').countStale(db, { inactiveDays: 180, now }),
  });
});

// ─── Overview → "Needs your attention" details ───────────────────────────────────────
// The overview itself returns counts only; the specifics (which orgs, which screens, which
// accounts) load here when an item is expanded. Each list is capped: this is a briefing that
// links to the page that fixes it, not a second copy of that page.
const ATTENTION_LIMIT = 25;
router.get('/overview/attention/:item', requirePlatformAdmin, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const q = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch (_) { return []; } };
  switch (req.params.item) {
    case 'sso':
      return res.json({ rows: q(`
        SELECT o.name AS organization, u.email AS requested_by, r.reason, r.created_at
          FROM org_sso_only_requests r
          LEFT JOIN organizations o ON o.id = r.organization_id
          LEFT JOIN users u ON u.id = r.requested_by
         WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT ?`, ATTENTION_LIMIT) });
    case 'plugins':
      return res.json({ rows: q(`
        SELECT s.plugin_id, s.name, s.version, s.size_bytes, u.email AS submitted_by, s.submitted_at
          FROM plugin_submissions s LEFT JOIN users u ON u.id = s.submitted_by
         WHERE s.status = 'pending' ORDER BY s.submitted_at ASC LIMIT ?`, ATTENTION_LIMIT) });
    case 'update': {
      const latest = require('../lib/ghcr-check').getLatestVersion();
      return res.json({ current: VERSION, latest: latest || null });
    }
    case 'orphans':
      return res.json({ rows: q(`
        SELECT u.plan_id, COUNT(*) AS accounts, GROUP_CONCAT(u.email, ', ') AS emails
          FROM users u WHERE u.plan_id IS NOT NULL AND u.plan_id NOT IN (SELECT id FROM plans)
         GROUP BY u.plan_id ORDER BY accounts DESC LIMIT ?`, ATTENTION_LIMIT)
        .map((r) => ({ ...r, emails: String(r.emails || '').split(', ').slice(0, 5).join(', ') })) });
    case 'offline':
      return res.json({ rows: q(`
        SELECT d.name AS screen, o.name AS organization, w.name AS workspace, d.last_heartbeat, d.app_version
          FROM devices d
          JOIN workspaces w ON w.id = d.workspace_id
          JOIN organizations o ON o.id = w.organization_id
         WHERE d.status != 'online' AND COALESCE(d.last_heartbeat, 0) < ?
         ORDER BY COALESCE(d.last_heartbeat, 0) DESC LIMIT ?`, now - 86400, ATTENTION_LIMIT) });
    case 'stale': {
      const r = require('../lib/account-cleanup').findStale(db, { inactiveDays: 180, now });
      return res.json({
        counts: r.counts,
        rows: r.accounts.slice(0, ATTENTION_LIMIT).map((a) => ({ email: a.email, last_activity: a.last_activity, notice: a.notice, content_bytes: a.content_bytes })),
      });
    }
    default:
      return res.status(404).json({ error: 'Unknown item' });
  }
});

// ─── Stale-account cleanup (lib/account-cleanup.js; #/platform/cleanup) ─────────────
// GET previews; POST deletes. The POST re-checks every account server-side, and must carry a
// typed confirmation naming the count, so a stale page or a stray click cannot delete anybody.
router.get('/cleanup/stale-accounts', requirePlatformAdmin, (req, res) => {
  res.json({
    ...require('../lib/account-cleanup').findStale(db, { inactiveDays: req.query.days }),
    email_configured: require('../services/email').isConfigured(),
  });
});

router.post('/cleanup/stale-accounts', requirePlatformAdmin, (req, res) => {
  const cleanup = require('../lib/account-cleanup');
  const { ids, days, confirm, skip_notice: skipNotice } = req.body || {};
  const count = Array.isArray(ids) ? new Set(ids).size : 0;
  // Deleting without the notice period is an override, and it has its own, longer phrase.
  const phrase = skipNotice ? `DELETE ${count} WITHOUT NOTICE` : `DELETE ${count}`;
  if (confirm !== phrase) {
    return res.status(400).json({ error: `Type ${phrase} to confirm` });
  }
  const { unlinkIfUnreferenced } = require('../lib/content-files');
  try {
    const out = cleanup.purge(db, {
      ids, inactiveDays: days, actingAdminId: req.user.id, skipNotice: !!skipNotice,
      unlink: (rel, column) => unlinkIfUnreferenced(rel, '__deleted_account__', column),
    });
    logActivity(req.user.id, 'cleanup_stale_accounts',
      `deleted=${out.deleted.length} skipped=${out.skipped.length} days=${out.inactive_days} files=${out.files_removed} notice=${skipNotice ? 'skipped' : 'required'} ` +
      `emails=${out.deleted.map((d) => d.email).join(',').slice(0, 1500)}`, null, getClientIp(req));
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Cleanup failed' });
  }
});

// Send the deletion notice ("will be deleted on <date> unless you sign in"). Outward-facing: it
// emails customers, so it is platform-admin only and records only notices that were actually sent.
router.post('/cleanup/stale-accounts/warn', requirePlatformAdmin, async (req, res) => {
  const cleanup = require('../lib/account-cleanup');
  const { sendEmail, isConfigured } = require('../services/email');
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Email is not configured on this server, so no notice can be sent. Configure email, or delete without notice.' });
  }
  const appUrl = String(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const { ids, days, notice_days: noticeDays } = req.body || {};
  try {
    const out = await cleanup.warn(db, {
      ids, inactiveDays: days, noticeDays,
      send: async ({ user, deleteAfter }) => {
        const mail = cleanup.noticeEmail({ user, deleteAfter, appUrl });
        const r = await sendEmail({ to: user.email, subject: mail.subject, text: mail.text });
        return !!(r && r.sent === true); // suppressed (dev allow-list) or failed = not warned
      },
    });
    logActivity(req.user.id, 'cleanup_stale_accounts_warned',
      `warned=${out.warned.length} skipped=${out.skipped.length} notice_days=${out.notice_days} ` +
      `emails=${out.warned.map((w) => w.email).join(',').slice(0, 1500)}`, null, getClientIp(req));
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not send the notices' });
  }
});

router.get('/limiter-rejections', requirePlatformAdmin, (req, res) => {
  const rows = require('../lib/limiter-telemetry').snapshot();
  res.json({
    rows,
    shared_egress_suspects: rows.filter(r => r.likelySharedEgress).length,
    note: 'In-memory since last restart. distinct_accounts >= 3 from one IP suggests a shared egress rather than a single attacker.',
  });
});

// Plugin inventory. The sub-router 404s when PLUGINS_ENABLED is unset (P1). requirePlatformAdmin
// runs first, so a non-admin probing this path gets the same 403 as every other /api/admin/* handler.
router.use('/plugins', requirePlatformAdmin, require('./admin-plugins'));

module.exports = router;
module.exports.detectInstall = detectInstall;   // exported for admin-update-command.test.js

