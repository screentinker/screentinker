// Public API token auth — a parallel front door to requireAuth, used ONLY on the
// documented public routers (see server.js). A token (Authorization: Bearer st_...)
// authenticates as its owner user, bound to ONE workspace, with a scope
// (read|write|full).
//
// SECURITY MODEL: a token NEVER carries platform/cross-org powers. apiTokenAuth
// forces the effective platform role to 'user', so every PLATFORM_ROLES /
// ELEVATED_ROLES / isPlatformStaff check downstream evaluates false and the token
// acts purely as a workspace member — workspace permissions still come from
// req.workspaceRole (resolved by resolveTenancy from the token's bound workspace),
// exactly as for a JWT session. Combined with mount-by-exclusion (tokens are never
// attached to /api/admin, auth, billing, workspaces, provisioning, status), a token
// cannot reach any privileged surface.

const crypto = require('crypto');
const { db } = require('../db/database');
const { requireAuth, isPlatformRole } = require('./auth');

const TOKEN_PREFIX = 'st_';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Generate a new token string: st_ + 32 random bytes, base64url (~43 chars).
function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

// Display prefix kept in the DB for the UI list (never the secret).
function displayPrefix(token) {
  return token.slice(0, TOKEN_PREFIX.length + 8); // e.g. 'st_a1b2c3d4'
}

// Throttle last_used_at writes to at most once/min per token (no write per request).
const lastUsedThrottle = new Map();
function touchLastUsed(tokenId) {
  const now = Date.now();
  if (now - (lastUsedThrottle.get(tokenId) || 0) < 60_000) return;
  lastUsedThrottle.set(tokenId, now);
  try { db.prepare("UPDATE api_tokens SET last_used_at = strftime('%s','now') WHERE id = ?").run(tokenId); } catch { /* best-effort */ }
}

function apiTokenAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw.startsWith(TOKEN_PREFIX)) {
    return res.status(401).json({ error: 'Invalid API token' });
  }
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashToken(raw));
  if (!row || row.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked API token' });
  }
  const user = db.prepare(
    'SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password FROM users WHERE id = ?'
  ).get(row.user_id);
  if (!user) return res.status(401).json({ error: 'Token owner not found' });
  if (user.must_change_password) {
    return res.status(403).json({ error: 'Token owner must change their password before using the API' });
  }

  // Act AS the owner but with platform powers stripped (role forced to 'user').
  req.user = { ...user, role: 'user' };
  // The token's workspace is authoritative: drop X-Workspace-Id / ?workspace_id so a
  // token can't be steered out of its bound workspace into another the owner happens
  // to have access to (resolveTenancy precedence is header > query > jwt).
  delete req.headers['x-workspace-id'];
  if (req.query) delete req.query.workspace_id;
  req.jwtWorkspaceId = row.workspace_id;   // resolveTenancy scopes to the bound workspace
  req.viaToken = true;
  req.tokenScope = row.scope;
  // #73: auto_publish read from the TOKEN ROW (admin-set), so the agency endpoint can
  // never take it from the request body. `|| 0` keeps it fail-safe for any row predating it.
  // #158: upload_folder_id (admin-set) confines agency uploads to a folder subtree; read from
  // the token row, never the request body. `|| null` keeps it fail-safe for pre-#158 rows.
  req.apiToken = { id: row.id, prefix: row.prefix, name: row.name, workspace_id: row.workspace_id, auto_publish: row.auto_publish || 0, upload_folder_id: row.upload_folder_id || null };
  touchLastUsed(row.id);
  next();
}

// Front door: token path for "Bearer st_...", else the existing JWT requireAuth
// (unchanged). Used in place of requireAuth on the public routers only.
function bearerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ' + TOKEN_PREFIX)) return apiTokenAuth(req, res, next);
  return requireAuth(req, res, next);
}

// Scope ordering: read < write < full.
const SCOPE_RANK = { read: 1, write: 2, full: 3 };
function scopeAllows(have, need) {
  return (SCOPE_RANK[have] || 0) >= (SCOPE_RANK[need] || 99);
}

// Method-based scope gate, mounted on the token routers AFTER resolveTenancy.
// JWT sessions pass straight through (their role gates apply). For tokens:
// GET/HEAD -> 'read', any mutation -> 'write'. Operational routes additionally
// apply requireScope('full').
function tokenScopeGate(req, res, next) {
  if (!req.viaToken) return next();
  const need = (req.method === 'GET' || req.method === 'HEAD') ? 'read' : 'write';
  if (!scopeAllows(req.tokenScope, need)) {
    return res.status(403).json({ error: `API token scope '${req.tokenScope}' cannot perform a '${need}' operation` });
  }
  next();
}

// Per-route override for fleet-affecting actions (device/group commands, reboot).
function requireScope(need) {
  return (req, res, next) => {
    if (!req.viaToken) return next();
    if (!scopeAllows(req.tokenScope, need)) {
      return res.status(403).json({ error: `API token scope '${req.tokenScope}' insufficient (need '${need}')` });
    }
    next();
  };
}

// #73: mount seam for capability-restricted ('agency') tokens. SCOPE/off-ladder check ONLY:
// only an agency token reaches the agency router (a read/write/full token or a JWT is
// rejected). The PER-TARGET check CANNOT live here - Express doesn't populate req.params at
// app.use-level middleware (params land at route match, inside the router), so a mount-level
// target check is silently bypassed (the integration bite-suite caught exactly this). The
// target check is router.param('playlistId') in routes/agency.js - it fires WITH the param
// before the handler and can't be skipped by any :playlistId route. Two single-registration,
// drift-proof seams: scope (here) + target (router.param).
function agencyGate(req, res, next) {
  if (!req.viaToken || req.tokenScope !== 'agency') {
    return res.status(403).json({ error: 'agency token required' });
  }
  next();
}

// #146 BILLING: dual-path gate for GET /api/billing/usage. Authorize if EITHER path holds,
// written as an EXPLICIT OR so neither can lock out the other:
//   (a) a valid API token whose scope is 'billing:read'  (tooling / invoice-time pulls), OR
//   (b) an authenticated platform-admin SESSION (no token) — admins keep read access but
//       are NOT required.
// 'billing:read' is OFF the read/write/full ladder (not in SCOPE_RANK), so tokenScopeGate
// rejects a billing token on every PUBLIC_ROUTER and JWT-only routers reject any st_ token
// (jwt.verify → 401): the scope grants billing-read and NOTHING else.
function requireBillingRead(req, res, next) {
  const viaBillingToken = req.viaToken && req.tokenScope === 'billing:read';
  const viaAdminSession = !req.viaToken && req.user && isPlatformRole(req.user.role);
  if (viaBillingToken || viaAdminSession) return next();
  return res.status(403).json({ error: 'billing read requires a billing:read token or a platform-admin session' });
}

module.exports = {
  bearerAuth, apiTokenAuth, tokenScopeGate, requireScope, agencyGate, requireBillingRead,
  hashToken, generateToken, displayPrefix, TOKEN_PREFIX,
};
