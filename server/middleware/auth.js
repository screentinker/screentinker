const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');

// Audience marker for the pre-TOTP token minted by generateMfaPendingToken below.
// Session tokens (generateToken, and the recovery token from scripts/reset-admin.js)
// carry NO `aud`, so verifyToken can refuse anything that does. That way a token minted
// for one narrow purpose can only be redeemed through its own accessor, and a future
// hand-rolled verify site that forgets a check fails CLOSED instead of accepting a
// half-authenticated token.
const MFA_TOKEN_AUDIENCE = 'st:mfa';

// Raised when a token is cryptographically valid but is not a usable session: the TOTP
// step is outstanding, the user row is gone, or a forced password change is pending.
// `code` lets each caller map the outcome onto the status/body it already returned, so
// no existing response shape changes.
class SessionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SessionError';
    this.code = code;
  }
}

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
// accepted ONLY by POST /api/auth/totp/verify (via verifyMfaPendingToken) - otherwise
// password-alone would yield a usable token and TOTP would be decorative. Short-lived.
// Two independent guards keep it off session paths: the mfa_pending check in
// resolveSessionUser, and the audience below (which verifyToken refuses outright, so
// even a caller that skips resolveSessionUser cannot accept this token).
function generateMfaPendingToken(user) {
  return jwt.sign(
    { id: user.id, mfa_pending: true },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m', audience: MFA_TOKEN_AUDIENCE }
  );
}

// Session for a redeemed support grant (lib/support-access). Carries `support: true` + the
// grant's jti, which resolveSessionUser checks against support_grants on every request; the
// token expires exactly when the grant does, so nothing outlives the window the customer agreed
// to. The identity claims (name shown in the UI) ride along; the ROLE is fixed in supportUser().
function generateSupportSessionToken(grant) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { id: `support:${grant.jti}`, support: true, jti: grant.jti, by: grant.issuedBy || null, current_workspace_id: null },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: Math.max(60, grant.expiresAt - now) }
  );
}

// Verify a SESSION token. Rejects any token carrying an audience: those are minted for a
// single narrower purpose and must go through their own accessor (verifyMfaPendingToken),
// never through a session path.
function verifyToken(token) {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (decoded && decoded.aud !== undefined) {
    // The pre-TOTP audience is a KNOWN narrow purpose: report it as such so callers can
    // still tell the client to complete MFA rather than "your token is broken". Any other
    // audience is unrecognised here and refused generically - the fail-closed default.
    const aud = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
    if (aud.includes(MFA_TOKEN_AUDIENCE)) throw new SessionError('mfa_required');
    throw new SessionError('invalid_audience', 'token is scoped to another purpose');
  }
  return decoded;
}

// The ONLY accepted path for a pre-TOTP token: POST /api/auth/totp/verify. Requires the
// audience, so a session token can't be presented here either.
function verifyMfaPendingToken(token) {
  const decoded = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    audience: MFA_TOKEN_AUDIENCE,
  });
  if (!decoded.mfa_pending) throw new SessionError('invalid_token', 'not a pre-TOTP token');
  return decoded;
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

// THE single definition of "this token is a usable session, and here is whose it is".
// requireAuth below is a thin wrapper over it, and every site that verifies a JWT by
// hand calls it too (the status backup/export/import routes, the screenshot + content
// gates, the dashboard socket handshake) - so those checks cannot drift apart from
// requireAuth's again.
//
// Returns { user, decoded, viaRecovery }. Throws:
//   - a jsonwebtoken error            bad signature / expired / malformed
//   - SessionError 'invalid_audience' token minted for a narrower purpose (pre-TOTP)
//   - SessionError 'mfa_required'     password accepted, TOTP step NOT completed. #100
//     (tightening #1): if this check is missing, password-alone yields a working session
//     and TOTP is decorative.
//   - SessionError 'user_not_found'   the token's user id no longer exists
//   - SessionError 'password_change_required'  #7: forced first-login change outstanding,
//     enforced SERVER-SIDE so a provisioned temp password doesn't work indefinitely.
//
// allowPasswordChange lets requireAuth keep its two exempt endpoints (the change itself,
// PUT /api/auth/me, and logout) while every other caller stays hard-denied.
function resolveSessionUser(token, { allowPasswordChange = false, sourceIp = null } = {}) {
  const decoded = verifyToken(token);
  // Recovery identities are synthetic (scripts/reset-admin.js) and have no users row, so
  // they skip the users lookup — but they are NOT accepted on the strength of the claim
  // alone. A `recovery: true` JWT is only honoured while a matching grant row exists,
  // unexpired and unused (lib/recovery-grant), which is what makes break-glass revocable
  // (DELETE the row), enumerable, and single-use. Redemption stamps used_at, so the same
  // token cannot be replayed.
  if (decoded.recovery) {
    const grants = require('../lib/recovery-grant');
    if (!decoded.jti || !grants.redeem(decoded.jti, { sourceIp })) {
      throw new SessionError('recovery_grant_invalid');
    }
    return { user: recoveryUser(decoded), decoded, viaRecovery: true };
  }
  // Support sessions (lib/support-access) are the same shape: a synthetic platform_operator
  // identity with no users row, honoured only while its support_grants row exists and is
  // unexpired. Revoking the row from Settings ends the session on the very next request.
  if (decoded.support) {
    const support = require('../lib/support-access');
    if (!decoded.jti || !support.grantActive(decoded.jti, { sourceIp })) {
      throw new SessionError('support_grant_invalid');
    }
    return { user: support.supportUser(decoded), decoded, viaRecovery: false, viaSupport: true };
  }
  if (decoded.mfa_pending) throw new SessionError('mfa_required');
  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password FROM users WHERE id = ?').get(decoded.id);
  if (!user) throw new SessionError('user_not_found');
  if (user.must_change_password && !allowPasswordChange) {
    throw new SessionError('password_change_required');
  }
  return { user, decoded, viaRecovery: false };
}

// Express middleware - requires valid JWT
/*
 * RFC 9728 §5.1: a 401 from a protected resource points at its own metadata, so a client that
 * arrived without a credential can find out what this resource is and how it is authenticated
 * without having to guess a well-known path. Costs one header; saves an agent a round of blind
 * probing, which is the behaviour the auth guide is written to prevent.
 */
function wwwAuthenticate(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const base = `${proto}://${host}`;
  return `Bearer realm="ScreenTinker", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', wwwAuthenticate(req));
    return res.status(401).json({ error: 'Authentication required' });
  }

  // #7: while must_change_password is set, allow only reading/updating one's own profile
  // (PUT /api/auth/me clears the flag) and logout; block everything else.
  const url = (req.originalUrl || '').split('?')[0].replace(/\/$/, '');
  const allowPasswordChange = url === '/api/auth/me' || url === '/api/auth/logout';

  let session;
  try {
    session = resolveSessionUser(authHeader.split(' ')[1], { allowPasswordChange, sourceIp: req.ip || null });
  } catch (err) {
    if (err.code === 'mfa_required') return res.status(401).json({ error: 'mfa_required' });
    // No grant, spent, expired or revoked — indistinguishable from any other bad token.
    if (err.code === 'recovery_grant_invalid') return res.status(401).json({ error: 'Invalid or expired token' });
    if (err.code === 'support_grant_invalid') return res.status(401).json({ error: 'Invalid or expired token' });
    if (err.code === 'user_not_found') return res.status(401).json({ error: 'User not found' });
    if (err.code === 'password_change_required') return res.status(403).json({ error: 'password_change_required' });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = session.user;
  // Tenancy middleware reads this on the resolver step.
  req.jwtWorkspaceId = (session.viaRecovery || session.viaSupport) ? null : (session.decoded.current_workspace_id || null);
  next();
}

// (optionalAuth removed: it was exported but never mounted on any route, and it carried
// its own copy of the token-resolution logic - a different user column list, no forced-
// password-change check. A "set req.user if a token happens to be present" middleware is
// reintroducible on top of resolveSessionUser in a few lines if a route ever needs one.)

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

module.exports = { wwwAuthenticate, generateToken, generateMfaPendingToken, generateSupportSessionToken, verifyToken, verifyMfaPendingToken, resolveSessionUser, SessionError, MFA_TOKEN_AUDIENCE, requireAuth, requireAdmin, requireSuperAdmin, requirePlatformAdmin, isPlatformRole, isPlatformStaff, PLATFORM_ROLES, PLATFORM_STAFF, ELEVATED_ROLES };
