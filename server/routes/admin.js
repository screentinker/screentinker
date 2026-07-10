const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (
        id, email, name, password_hash, auth_provider, role, plan_id,
        must_change_password, welcome_email_sent_at, activation_nudge_sent_at
      ) VALUES (?, ?, ?, ?, 'local', 'user', 'free', ?, strftime('%s','now'), strftime('%s','now'))
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
    SELECT o.id, o.name, o.created_at, u.email AS owner_email, u.name AS owner_name,
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
    deleteOrgCascade(db, { orgId: org.id });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete organization' });
  }
  logActivity(req.user.id, 'admin_delete_org', `org: ${org.name} (${org.id})`, null, getClientIp(req), null);
  res.json({ deleted: true, id: org.id });
});

// DELETE /api/admin/workspaces/:id - cascade-delete a single workspace + its
// tenant resources (#36); the parent org is left intact. Platform-admin only.
router.delete('/workspaces/:id', requirePlatformAdmin, (req, res) => {
  const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  try {
    deleteWorkspaceCascade(db, { workspaceId: ws.id });
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

// ===================== Version update indicator =====================
// requireAdmin (admin, superadmin, platform_admin) — operational endpoints,
// not restricted to platform-owner level.

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

// POST /api/admin/trigger-update — run docker compose pull && up -d,
// or return manual instructions when docker is disabled.
router.post('/trigger-update', requireAdmin, async (req, res) => {
  const { exec } = require('child_process');
  const composeFile = require('../config').composeFilePath;
  const cmd = `docker compose -f ${composeFile} pull && docker compose -f ${composeFile} up -d`;

  if (!require('../config').dockerUpdateEnabled) {
    return res.json({
      docker_enabled: false,
      instructions: cmd,
    });
  }

  exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
    const output = (stdout || '') + (stderr || '');
    if (err) {
      return res.json({ success: false, output, docker_enabled: true, error: err.message });
    }
    logActivity(req.user.id, 'admin_trigger_update', `docker compose up -d`, null, getClientIp(req), null);
    res.json({ success: true, output, docker_enabled: true });
  });
});

module.exports = router;
