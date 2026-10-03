// Phase 2.1: per-request tenancy resolver.
//
// Runs after requireAuth (which sets req.user and req.jwtWorkspaceId).
// Resolves the active workspace context for this request and attaches:
//
//   req.workspaceId      string | null   the workspace this request operates in
//   req.workspace        object | null   the full workspaces row
//   req.organizationId   string | null   parent org of req.workspace
//   req.workspaceRole    string | null   'workspace_admin' | 'workspace_editor' | 'workspace_viewer'
//   req.orgRole          string | null   'org_owner' | 'org_admin'
//   req.isPlatformAdmin  boolean         true when req.user.role is a platform-owner role
//                                        (isPlatformRole: platform_admin / legacy superadmin)
//   req.actingAs         boolean         true when the user reached this workspace via
//                                        org-level or platform-level access rather than
//                                        a direct workspace_members row
//
// Resolution order, top wins:
//   1. X-Workspace-Id header                (for explicit per-request override)
//   2. ?workspace_id= query param           (same purpose, easier in browser dev)
//   3. JWT current_workspace_id             (the user's last switched-to workspace)
//   4. First workspace_members row for user (sorted by joined_at ASC)
//   5. For platform_admin only: any workspace
//
// Steps 1-3 are validated against access. If a stale value (e.g. user was
// removed from the workspace) is found, it's discarded and we fall through.

'use strict';

const { db } = require('../db/database');
const { isPlatformRole, isPlatformStaff } = require('../middleware/auth');
const replicaProxy = require('./replica-proxy');
const config = require('../config');

function membershipOf(userId, workspaceId) {
  return db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId);
}

function orgMembershipOf(userId, organizationId) {
  return db.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(organizationId, userId);
}

function loadWorkspace(workspaceId) {
  if (!workspaceId) return null;
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
}

function firstAccessibleWorkspace(userId) {
  return db.prepare(`
    SELECT w.* FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY wm.joined_at ASC
    LIMIT 1
  `).get(userId);
}

// Check whether userId can access workspace via any path (member, org admin,
// or platform staff). Returns the access context: { workspaceRole, actingAs }
// or null if no access.
function accessContext(userId, role, workspace) {
  const wsMembership = membershipOf(userId, workspace.id);
  if (wsMembership) {
    return { workspaceRole: wsMembership.role, actingAs: false };
  }
  const orgMembership = orgMembershipOf(userId, workspace.organization_id);
  if (orgMembership && (orgMembership.role === 'org_owner' || orgMembership.role === 'org_admin')) {
    return { workspaceRole: null, actingAs: true };
  }
  // #14: isPlatformRole (not a bare === 'platform_admin') so a legacy
  // 'superadmin' can act-as too. #13: isPlatformStaff additionally lets
  // platform_operator act-as into any org. actingAs:true (workspaceRole null)
  // is what skips the viewer-deny on resource writes, so staff get read/write
  // in any workspace - while canAdmin()/canAdminWorkspace() stay owner-gated,
  // so operators still can't perform workspace-admin actions.
  if (isPlatformStaff(role)) {
    return { workspaceRole: null, actingAs: true };
  }
  return null;
}

function resolveTenancy(req, res, next) {
  if (!req.user) {
    // Should not happen when chained after requireAuth; defensive for any future
    // caller that runs this resolver without an authenticated user.
    return next();
  }

  // isPlatformAdmin = OWNER tier (drives canAdmin/canWrite owner short-circuits).
  // isPlatformStaff = OWNER + platform_operator; drives cross-org visibility and
  // act-as only. Operators get isPlatformStaff=true but isPlatformAdmin=false,
  // so they can see/act-as everywhere yet hold no owner power (#13).
  const isPlatformAdmin = isPlatformRole(req.user.role);
  const isPlatformStaffUser = isPlatformStaff(req.user.role);
  req.isPlatformAdmin = isPlatformAdmin;
  req.isPlatformOperator = isPlatformStaffUser && !isPlatformAdmin;
  req.isPlatformStaff = isPlatformStaffUser;

  // Build the ordered candidate list of workspace_ids to try.
  const candidates = [];
  const headerWs = (req.headers['x-workspace-id'] || '').trim();
  if (headerWs) candidates.push(headerWs);
  if (req.query && req.query.workspace_id) candidates.push(String(req.query.workspace_id));
  if (req.jwtWorkspaceId) candidates.push(req.jwtWorkspaceId);

  let workspace = null;
  let context = null;
  for (const wsId of candidates) {
    const ws = loadWorkspace(wsId);
    if (!ws) continue;
    const ctx = accessContext(req.user.id, req.user.role, ws);
    if (!ctx) continue;
    workspace = ws;
    context = ctx;
    break;
  }

  if (!workspace) {
    // Fall back to the user's first workspace_members row.
    const first = firstAccessibleWorkspace(req.user.id);
    if (first) {
      workspace = first;
      const wm = membershipOf(req.user.id, first.id);
      context = { workspaceRole: wm.role, actingAs: false };
    } else if (isPlatformStaffUser) {
      // Platform staff (admin or operator) with no direct memberships: pick any
      // workspace (acting-as) so they land in a usable context. #13: operators
      // included here too - they have no memberships of their own but must be
      // able to act-as across orgs.
      const any = db.prepare('SELECT * FROM workspaces LIMIT 1').get();
      if (any) {
        workspace = any;
        context = { workspaceRole: null, actingAs: true };
      }
    }
  }

  if (workspace) {
    req.workspaceId = workspace.id;
    req.workspace = workspace;
    req.organizationId = workspace.organization_id;
    req.workspaceRole = context.workspaceRole;
    req.actingAs = context.actingAs;
    const orgMembership = orgMembershipOf(req.user.id, workspace.organization_id);
    req.orgRole = orgMembership ? orgMembership.role : null;
  } else {
    req.workspaceId = null;
    req.workspace = null;
    req.organizationId = null;
    req.workspaceRole = null;
    req.orgRole = null;
    req.actingAs = false;
  }

  /*
   * Scale-out (docs/scale-out-design.md §5.2): THE interceptor. A workspace whose origin_node_id is
   * set is a copy held on this replica; a request that could change it is forwarded to the primary
   * (or refused) and never reaches a route handler here. One check, on the row the resolver already
   * loaded, on every mutating route — test_every_mutating_route_passes_resolveTenancy holds that
   * "every" is true, because a route that skipped this resolver would be a second writer.
   */
  if (req.workspace && replicaProxy.shouldIntercept(req, req.workspace)) {
    replicaProxy.proxyToPrimary(req, res, config);
    return;
  }

  next();
}

// Enumerate every workspace_id the given user has any path into:
//   - direct workspace_members rows
//   - any workspace in an org where they are org_owner / org_admin
//   - platform_admin / superadmin: every workspace in the system
// Used by socket.io rooms (Phase 2.3) to scope outbound broadcasts. /me's
// accessible_workspaces query mirrors this access logic but selects full rows
// rather than reusing this helper (different shape needs).
function accessibleWorkspaceIds(userId, role) {
  if (!userId) return [];
  // #13: platform staff (admin OR operator) see every workspace - visibility,
  // not an owner power.
  if (isPlatformStaff(role)) {
    return db.prepare('SELECT id FROM workspaces').all().map(r => r.id);
  }
  return db.prepare(`
    SELECT workspace_id AS id FROM workspace_members WHERE user_id = ?
    UNION
    SELECT w.id FROM workspaces w
    JOIN organization_members om ON om.organization_id = w.organization_id
    WHERE om.user_id = ? AND om.role IN ('org_owner', 'org_admin')
  `).all(userId, userId).map(r => r.id);
}

// A read-only member (workspace_viewer in the ACTIVE workspace, and not platform staff acting-as)
// may not write in it. Returns true, after sending a 403, when the caller is read-only. Use on
// routes scoped to the active workspace that lacked a role check — chiefly create routes, which
// have no resource yet, plus a couple of delete routes that only scoped by workspace. The
// resource-scoped checkXWrite helpers already cover the rest. req.workspaceRole / req.actingAs are
// set by resolveTenancy for the active workspace, so this must run after it.
function denyReadOnly(req, res) {
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' });
    return true;
  }
  return false;
}

module.exports = {
  resolveTenancy,
  // Exported for testing / direct use by routes that need ad-hoc checks.
  accessContext,
  denyReadOnly,
  membershipOf,
  orgMembershipOf,
  firstAccessibleWorkspace,
  accessibleWorkspaceIds,
};
