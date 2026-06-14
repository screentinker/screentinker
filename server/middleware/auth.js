const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');

// Phase 2.1: JWT now optionally carries the user's current workspace_id so
// the tenancy middleware can resolve scope without an extra DB lookup on
// every request. Callers that don't know the workspace yet (legacy paths,
// recovery tokens) pass null and the tenancy resolver falls back to the
// user's first accessible workspace.
function generateToken(user, currentWorkspaceId) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, current_workspace_id: currentWorkspaceId || null },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiry }
  );
}

// #100: issued after password verification but BEFORE the TOTP step, so the client
// can complete MFA. It is NOT a session token - it carries mfa_pending:true and is
// accepted ONLY by POST /api/auth/totp/verify. requireAuth/optionalAuth reject it
// (see below) - otherwise password-alone would yield a usable token and TOTP would
// be decorative. Short-lived.
function generateMfaPendingToken(user) {
  return jwt.sign(
    { id: user.id, mfa_pending: true },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

// Synthetic user record for recovery tokens (scripts/reset-admin.js). Not
// persisted; only exists for the lifetime of the request.
function recoveryUser(decoded) {
  return {
    id: decoded.id,
    email: decoded.email || 'admin@localhost',
    name: 'Recovery Admin',
    role: decoded.role || 'platform_admin',
    auth_provider: 'recovery',
    avatar_url: null,
    plan_id: 'enterprise'
  };
}

// Express middleware - requires valid JWT
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (decoded.recovery) {
      req.user = recoveryUser(decoded);
      req.jwtWorkspaceId = null;
      return next();
    }
    // #100 (tightening #1): an mfa_pending token has cleared the password but NOT the
    // TOTP step. It must never authorize a protected route - only /api/auth/totp/verify
    // accepts it. If this check is removed, password-alone yields a working session and
    // TOTP is bypassed. (Covered by the mfa_pending bite-test.)
    if (decoded.mfa_pending) return res.status(401).json({ error: 'mfa_required' });
    const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    // Tenancy middleware reads this on the resolver step.
    req.jwtWorkspaceId = decoded.current_workspace_id || null;
    // #7: enforce the forced first-login password change SERVER-SIDE (was a
    // frontend-only redirect, so a provisioned temp password worked indefinitely
    // via the API). While the flag is set, allow only reading/updating one's own
    // profile (the password change is PUT /api/auth/me, which clears the flag)
    // and logout; block everything else.
    if (user.must_change_password) {
      const url = (req.originalUrl || '').split('?')[0].replace(/\/$/, '');
      const allowed = url === '/api/auth/me' || url === '/api/auth/logout';
      if (!allowed) return res.status(403).json({ error: 'password_change_required' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth - sets req.user if token present, continues either way
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = verifyToken(token);
      if (decoded.mfa_pending) return next(); // #100: pre-TOTP token is not a session
      req.user = decoded.recovery
        ? recoveryUser(decoded)
        : db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(decoded.id);
      req.jwtWorkspaceId = decoded.current_workspace_id || null;
    } catch (err) {
      // Token invalid, continue without user
    }
  }
  next();
}

// Phase 2.1: role rename. Phase 1 renamed 'superadmin' to 'platform_admin' and
// dropped the in-between 'admin' role. These two guards are widened to accept
// either spelling so existing callers keep working without per-route edits.
// New code should prefer requirePlatformAdmin / requireOrgAdmin / workspace
// role guards from server/lib/permissions.js.
//
// Issue #14 (role normalization): the data migration in db/database.js collapses
// any legacy 'superadmin' -> 'platform_admin' and 'admin' -> 'user'. 'superadmin'
// is kept in PLATFORM_ROLES purely as back-compat belt-and-suspenders (recovery
// tokens, stray strings) - no row should carry it post-migration. Owner-level
// power lives here in PLATFORM_ROLES; anything not in this set is denied.

const PLATFORM_ROLES = ['superadmin', 'platform_admin'];
const ELEVATED_ROLES = ['admin', 'superadmin', 'platform_admin'];

// isPlatformRole: single predicate for "is this string a platform-owner role".
// Use this instead of a bare `role === 'platform_admin'` so a stray 'superadmin'
// is never silently treated as lower-privileged (the act-as bug fixed in #14).
// NOTE: this is the OWNER tier only - it deliberately does NOT include
// 'platform_operator' (issue #13), which is cross-org staff, not an owner.
function isPlatformRole(role) {
  return PLATFORM_ROLES.includes(role);
}

// Issue #13: platform_operator is cross-org STAFF - it can see and act-as into
// every org and read/write workspace-scoped resources there, but holds NO
// owner-level power (no billing, no org/workspace deletion, no user/role
// management, no shared/template asset curation, no branding). The owner powers
// stay gated on PLATFORM_ROLES / isPlatformRole, which operator is deliberately
// NOT a member of - so every owner capability is deny-by-default for operators,
// and any NEW owner endpoint added later inherits that denial automatically.
//
// PLATFORM_STAFF / isPlatformStaff is the union used ONLY for cross-org
// VISIBILITY + act-as + workspace-scoped read/write. It must never gate an
// owner action.
const PLATFORM_STAFF = ['superadmin', 'platform_admin', 'platform_operator'];
function isPlatformStaff(role) {
  return PLATFORM_STAFF.includes(role);
}

function requireAdmin(req, res, next) {
  if (!req.user || !ELEVATED_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !PLATFORM_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

// Preferred alias for new code.
const requirePlatformAdmin = requireSuperAdmin;

module.exports = { generateToken, generateMfaPendingToken, verifyToken, requireAuth, optionalAuth, requireAdmin, requireSuperAdmin, requirePlatformAdmin, isPlatformRole, isPlatformStaff, PLATFORM_ROLES, PLATFORM_STAFF, ELEVATED_ROLES };
