const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const { db } = require('../db/database');
const { generateToken, generateMfaPendingToken, verifyToken, requireAuth, requireAdmin, requireSuperAdmin, isPlatformRole, isPlatformStaff, PLATFORM_ROLES } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const totp = require('../lib/totp');
const totpLockout = require('../lib/totp-lockout');
const { sendSignupEmails } = require('../services/signupEmails');
const { deleteUserCascade, OrgHasOtherMembersError } = require('../lib/user-deletion');
const config = require('../config');

// Phase 2.1: find or create the user's default org+workspace. Returns the
// workspace_id to embed in the JWT. Idempotent: if the user already has
// memberships (e.g. migrated from Phase 1), returns the first one without
// creating anything.
// #12: allowCreate gates the MINT path only. An existing membership is always
// returned (idempotent). When allowCreate is false and the user has no
// membership, returns null - the caller is created org-less and an admin /
// operator assigns them to a workspace afterward.
function ensureDefaultOrgForUser(user, { allowCreate = true } = {}) {
  const existing = db.prepare(`
    SELECT w.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY wm.joined_at ASC LIMIT 1
  `).get(user.id);
  if (existing) return existing.id;
  if (!allowCreate) return null;

  // No memberships -> mint a fresh org and Default workspace owned by user.
  const orgId = uuidv4();
  const wsId  = uuidv4();
  const orgName = (user.name && user.name.trim())
    ? `${user.name}'s organization`
    : `${user.email}'s organization`;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO organizations (
      id, name, owner_user_id, plan_id,
      stripe_customer_id, stripe_subscription_id,
      subscription_status, subscription_ends
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      orgId, orgName, user.id, user.plan_id || 'free',
      user.stripe_customer_id || null, user.stripe_subscription_id || null,
      user.subscription_status || 'active', user.subscription_ends || null
    );
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, user.id);
    db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)`).run(wsId, orgId, user.id);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(wsId, user.id);
  });
  tx();
  return wsId;
}

function logFailedLogin(email, ip, reason) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (NULL, ?, ?, ?)')
      .run('auth:login_failed', `${email} - ${reason}`, ip);
  } catch {}
}

function logSuccessfulLogin(userId, email, ip) {
  try {
    // Phase 2.2 writer-leak fix: stamp the user's oldest workspace so this
    // login event is queryable in tenant-scoped activity views. Multi-workspace
    // users still land on one row; the activity dashboard already shows
    // per-user context separately from per-workspace context.
    const ws = db.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1'
    ).get(userId);
    db.prepare('INSERT INTO activity_log (user_id, action, details, ip_address, workspace_id) VALUES (?, ?, ?, ?, ?)')
      .run(userId, 'auth:login_success', email, ip, ws?.workspace_id || null);
    db.prepare("UPDATE users SET last_login = strftime('%s','now') WHERE id = ?").run(userId);
  } catch {}
}

// ==================== Local Auth ====================

// Returns true if new account creation is allowed at this moment.
// First-user setup (empty DB) is always allowed so a fresh install can be initialized.
function canRegister() {
  if (!config.disableRegistration) return true;
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  return userCount === 0;
}

// Register
router.post('/register', (req, res) => {
  if (!canRegister()) {
    return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
  }
  const { email, password, name, createOrg } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  // First user becomes platform_admin with enterprise plan (self-hosted) or free plan with Pro trial.
  // Phase 1 renamed the legacy 'superadmin' role to 'platform_admin'; new bootstrap users get the new name directly.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const role = userCount === 0 ? 'platform_admin' : 'user';
  const isFirstUser = userCount === 0;
  const plan = (isFirstUser && config.selfHosted) ? 'enterprise' : 'pro'; // Start on Pro trial
  const trialStarted = isFirstUser && config.selfHosted ? null : Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, trial_started, trial_plan)
    VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?)
  `).run(id, email.toLowerCase(), name || email.split('@')[0], passwordHash, role, plan, trialStarted, trialStarted ? 'pro' : null);

  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_ends FROM users WHERE id = ?').get(id);
  // #12: org-on-create. Per-request createOrg overrides the deployment default
  // (config.autoCreateOrgOnSignup). The first user is always given an org so a
  // fresh install is never left headless. When neither applies, the user is
  // created org-less and lands on the "no workspaces yet" state until an admin
  // assigns them.
  const createOrgForUser = isFirstUser
    || (createOrg !== undefined ? !!createOrg : config.autoCreateOrgOnSignup);
  const workspaceId = ensureDefaultOrgForUser(user, { allowCreate: createOrgForUser });
  const token = generateToken(user, workspaceId);

  res.status(201).json({ token, user, current_workspace_id: workspaceId });

  // Welcome + admin-notify emails (hosted instance only, idempotent, async).
  sendSignupEmails(user, req);
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND auth_provider = ?').get(email.toLowerCase(), 'local');
  if (!user) {
    logFailedLogin(email, getClientIp(req), 'User not found');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    logFailedLogin(email, getClientIp(req), 'Wrong password');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // #100: password OK. If TOTP is enabled, DON'T issue a session yet - return an
  // mfa_pending token; the client completes via POST /api/auth/totp/verify. This is
  // the ONLY place TOTP gates (interactive password login). The SSO routes and the
  // API-token path never reach here, so both bypass TOTP by construction.
  if (user.totp_enabled) {
    return res.json({ mfa_required: true, mfa_token: generateMfaPendingToken(user) });
  }
  issueSession(req, res, user);
});

// #100: finish an interactive login - shared by /login (no TOTP) and /totp/verify
// (after TOTP). Logs the successful login + issues the full session JWT.
function issueSession(req, res, user, extra = {}) {
  logSuccessfulLogin(user.id, user.email, getClientIp(req));
  const workspaceId = ensureDefaultOrgForUser(user, { allowCreate: config.autoCreateOrgOnSignup });
  const token = generateToken(user, workspaceId);
  // #100: callers pass a SELECT * row. Strip password_hash AND the TOTP internals
  // (the encrypted secret + the replay counter) so no secret/internal rides in the
  // response body - "secrets never in responses", same as the API token work.
  const { password_hash, totp_secret_enc, totp_last_step, ...safeUser } = user;
  res.json({ token, user: safeUser, current_workspace_id: workspaceId, ...extra });
}

// ==================== TOTP MFA (#100) ====================
// Opt-in per-user, LOCAL accounts only (SSO IdPs own MFA). Enrollment is a two-step
// confirm (setup -> enable) so a mistyped secret can't lock anyone out. Recovery
// codes are shown ONCE at enable, stored SHA-256-hashed, single-use.

const RECOVERY_CODE_COUNT = 10;

function recoveryCodesRemaining(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;
}

// Atomically replace a user's recovery codes - no window where old + new both verify
// (tightening #3). Returns the plaintext set (shown ONCE).
function resetRecoveryCodes(userId) {
  const { plain, hashes } = totp.generateRecoveryCodes(RECOVERY_CODE_COUNT);
  db.transaction(() => {
    db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
    for (const h of hashes) ins.run(uuidv4(), userId, h);
  })();
  return plain;
}

// Consume one single-use recovery code (mark used). True if a fresh code matched.
function consumeRecoveryCode(userId, input) {
  if (!input) return false;
  const row = db.prepare('SELECT id FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .get(userId, totp.hashRecoveryCode(input));
  if (!row) return false;
  db.prepare("UPDATE totp_recovery_codes SET used_at = strftime('%s','now') WHERE id = ?").run(row.id);
  return true;
}

router.get('/totp/status', requireAuth, (req, res) => {
  const u = db.prepare('SELECT totp_enabled, auth_provider FROM users WHERE id = ?').get(req.user.id);
  res.json({
    enabled: !!u.totp_enabled,
    eligible: u.auth_provider === 'local',
    recovery_codes_remaining: u.totp_enabled ? recoveryCodesRemaining(req.user.id) : 0,
  });
});

// Step 1: mint a pending secret + return the otpauth:// URI (frontend renders the QR).
router.post('/totp/setup', requireAuth, (req, res) => {
  const u = db.prepare('SELECT auth_provider, totp_enabled, email FROM users WHERE id = ?').get(req.user.id);
  if (u.auth_provider !== 'local') return res.status(400).json({ error: 'TOTP is only for password accounts; your identity provider manages MFA.' });
  if (u.totp_enabled) return res.status(409).json({ error: 'TOTP already enabled. Disable it first to re-enroll.' });
  const secret = totp.generateSecret();
  db.prepare("UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, updated_at = strftime('%s','now') WHERE id = ?")
    .run(totp.encryptSecret(secret), req.user.id);
  res.json({ otpauth_uri: totp.keyuri(u.email, secret), secret });
});

// Step 2: confirm a code from the user's app, THEN enable + issue recovery codes (once).
router.post('/totp/enable', requireAuth, (req, res) => {
  const u = db.prepare('SELECT totp_secret_enc, totp_enabled, totp_last_step, auth_provider FROM users WHERE id = ?').get(req.user.id);
  if (u.auth_provider !== 'local') return res.status(400).json({ error: 'TOTP unavailable for SSO accounts.' });
  if (u.totp_enabled) return res.status(409).json({ error: 'TOTP already enabled.' });
  if (!u.totp_secret_enc) return res.status(400).json({ error: 'Start with POST /api/auth/totp/setup.' });
  const step = totp.verifyCode(req.body.code, totp.decryptSecret(u.totp_secret_enc), u.totp_last_step);
  if (!step) return res.status(400).json({ error: 'Invalid code' });
  db.prepare("UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(step, req.user.id);
  res.json({ enabled: true, recovery_codes: resetRecoveryCodes(req.user.id) }); // shown ONCE
});

// Disable: re-auth with a current code (or a recovery code) so a hijacked session
// can't silently strip MFA. Clears the secret + all recovery codes.
router.post('/totp/disable', requireAuth, (req, res) => {
  const u = db.prepare('SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = ?').get(req.user.id);
  if (!u.totp_enabled) return res.status(400).json({ error: 'TOTP is not enabled.' });
  const ok = !!totp.verifyCode(req.body.code, totp.decryptSecret(u.totp_secret_enc), u.totp_last_step)
    || consumeRecoveryCode(req.user.id, req.body.code);
  if (!ok) return res.status(400).json({ error: 'Invalid code' });
  db.transaction(() => {
    db.prepare("UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0, updated_at = strftime('%s','now') WHERE id = ?").run(req.user.id);
    db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(req.user.id);
  })();
  res.json({ enabled: false });
});

// Regenerate recovery codes: re-auth (current code) + ATOMIC replace (tightening #3).
router.post('/totp/recovery-codes/regenerate', requireAuth, (req, res) => {
  const u = db.prepare('SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = ?').get(req.user.id);
  if (!u.totp_enabled) return res.status(400).json({ error: 'TOTP is not enabled.' });
  const step = totp.verifyCode(req.body.code, totp.decryptSecret(u.totp_secret_enc), u.totp_last_step);
  if (!step) return res.status(400).json({ error: 'Invalid code' });
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, req.user.id);
  res.json({ recovery_codes: resetRecoveryCodes(req.user.id) });
});

// Second login step: exchange an mfa_pending token + a code (TOTP or recovery) for a
// full session. Per-route 10/min rate-limit (server.js) + per-user lockout (#87 model).
router.post('/totp/verify', (req, res) => {
  const { mfa_token, code } = req.body;
  if (!mfa_token || !code) return res.status(400).json({ error: 'mfa_token and code required' });
  let decoded;
  try { decoded = verifyToken(mfa_token); } catch { return res.status(401).json({ error: 'mfa session expired' }); }
  if (!decoded.mfa_pending || !decoded.id) return res.status(401).json({ error: 'invalid mfa token' });
  if (totpLockout.isLocked(decoded.id)) return res.status(429).json({ error: 'Too many invalid codes. Try again later.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'invalid mfa token' });

  // TOTP first (with intra-window replay block via totp_last_step), then a recovery code.
  const step = totp.verifyCode(code, totp.decryptSecret(user.totp_secret_enc), user.totp_last_step);
  let viaRecovery = false;
  if (step) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  } else if (consumeRecoveryCode(user.id, code)) {
    viaRecovery = true;
  } else {
    totpLockout.recordFailure(decoded.id);
    logFailedLogin(user.email, getClientIp(req), 'Bad TOTP/recovery code');
    return res.status(401).json({ error: 'Invalid code' });
  }
  totpLockout.reset(decoded.id);
  issueSession(req, res, user, {
    via_recovery: viaRecovery,
    recovery_codes_remaining: recoveryCodesRemaining(user.id),
  });
});

// ==================== Google OAuth ====================

router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });

  try {
    // Verify the Google ID token
    const payload = await verifyGoogleToken(credential);
    if (!payload) return res.status(401).json({ error: 'Invalid Google token' });

    const { email, name, picture, sub: googleId } = payload;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    const isNewUser = !user;

    if (!user) {
      if (!canRegister()) {
        return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
      }
      const id = uuidv4();
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'platform_admin' : 'user';
      const isFirst = userCount === 0;
      const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
      const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO users (id, email, name, auth_provider, provider_id, avatar_url, role, plan_id, trial_started, trial_plan)
        VALUES (?, ?, ?, 'google', ?, ?, ?, ?, ?, ?)
      `).run(id, email.toLowerCase(), name || '', googleId, picture || '', role, plan, trialStarted, trialStarted ? 'pro' : null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (user.auth_provider !== 'google') {
      // Existing account with different provider — do NOT silently overwrite auth_provider.
      // If they have a local password, require them to log in locally and link from settings.
      if (user.password_hash) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in with your password.' });
      }
      // No password (e.g. Microsoft → Google switch) — allow linking
      db.prepare('UPDATE users SET auth_provider = ?, provider_id = ?, avatar_url = ? WHERE id = ?')
        .run('google', googleId, picture || user.avatar_url, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const workspaceId = ensureDefaultOrgForUser(user, { allowCreate: config.autoCreateOrgOnSignup });
    const token = generateToken(user, workspaceId);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser, current_workspace_id: workspaceId });

    // Welcome + admin-notify only when this Google login created a new account.
    if (isNewUser) sendSignupEmails(user, req);
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

async function verifyGoogleToken(credential) {
  const client = new OAuth2Client(config.googleClientId);
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId || undefined,
    });
    return ticket.getPayload();
  } catch (e) {
    // Fallback: if credential is an access token, verify via tokeninfo
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${credential}`);
      if (!res.ok) throw new Error('Invalid token');
      return await res.json();
    } catch {
      throw new Error('Google token verification failed: ' + e.message);
    }
  }
}

// ==================== Microsoft OAuth ====================

router.post('/microsoft', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Microsoft access token required' });

  try {
    // Use the access token to get user profile from Microsoft Graph
    const profile = await getMicrosoftProfile(access_token);
    if (!profile || !profile.mail && !profile.userPrincipalName) {
      return res.status(401).json({ error: 'Could not get Microsoft profile' });
    }

    const email = (profile.mail || profile.userPrincipalName).toLowerCase();
    const name = profile.displayName || '';
    const microsoftId = profile.id;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const isNewUser = !user;

    if (!user) {
      if (!canRegister()) {
        return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
      }
      const id = uuidv4();
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'platform_admin' : 'user';
      const isFirst = userCount === 0;
      const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
      const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO users (id, email, name, auth_provider, provider_id, role, plan_id, trial_started, trial_plan)
        VALUES (?, ?, ?, 'microsoft', ?, ?, ?, ?, ?)
      `).run(id, email, name, microsoftId, role, plan, trialStarted, trialStarted ? 'pro' : null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (user.auth_provider !== 'microsoft') {
      // Existing account with different provider — do NOT silently overwrite auth_provider.
      if (user.password_hash) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in with your password.' });
      }
      db.prepare('UPDATE users SET auth_provider = ?, provider_id = ? WHERE id = ?')
        .run('microsoft', microsoftId, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const workspaceId = ensureDefaultOrgForUser(user, { allowCreate: config.autoCreateOrgOnSignup });
    const token = generateToken(user, workspaceId);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser, current_workspace_id: workspaceId });

    // Welcome + admin-notify only when this Microsoft login created a new account.
    if (isNewUser) sendSignupEmails(user, req);
  } catch (err) {
    console.error('Microsoft auth error:', err);
    res.status(401).json({ error: 'Microsoft authentication failed' });
  }
});

function getMicrosoftProfile(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.microsoft.com',
      path: '/v1.0/me',
      headers: { Authorization: `Bearer ${accessToken}` }
    };
    https.get(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ==================== User Management ====================

// Get current user + tenancy context.
// Phase 2.1: response shape extended with current_workspace, current_organization,
// roles, and the list of accessible workspaces. Legacy fields (user object at
// the top level) are preserved so existing frontend code continues to work.
router.get('/me', requireAuth, resolveTenancy, (req, res) => {
  // Platform admins see every workspace in the system (via the LEFT JOIN they
  // still get their own workspace_role for direct memberships; NULL elsewhere,
  // matching accessContext's actingAs semantics). Regular users see every
  // workspace they can reach via either path: direct workspace_members row, OR
  // org_owner / org_admin on the parent organization. Mirrors the access
  // logic in accessibleWorkspaceIds() (lib/tenancy.js); kept as a separate
  // query rather than reusing it because /me needs full row shape, not just
  // IDs. Role is read from the signed JWT (not user-supplied), so non-admins
  // cannot reach the admin branch. No cap on the admin list yet - revisit at
  // 50+ workspaces when dropdown UX without search starts to degrade.
  //
  // Each accessible_workspaces entry also carries `can_admin: bool` so the
  // UI can render admin affordances (rename pencil etc.) only where the
  // caller has permission. The server still enforces permission on the
  // actual mutation routes regardless of this advisory flag.
  // device_count: correlated subquery on workspaces.id. Equality fails on NULL
  // so unclaimed pair-pool devices (workspace_id IS NULL) are correctly excluded.
  // Microseconds per row at current scale (~37 rows worst case for platform_admin);
  // not optimizing - revisit if the admin list grows past a few hundred workspaces.
  // #13: platform staff (admin OR operator) SEE every workspace (visibility).
  // can_admin below is computed separately from isPlatformRole (owner only), so
  // operators see all workspaces but get can_admin:false on each.
  const isPlatformStaffUser = isPlatformStaff(req.user.role);
  const isPlatformAdmin = isPlatformRole(req.user.role);
  const accessible = isPlatformStaffUser
    ? db.prepare(`
        SELECT w.id, w.name, w.organization_id, o.name AS organization_name,
               wm.role AS workspace_role, om.role AS org_role,
               (SELECT COUNT(*) FROM devices WHERE workspace_id = w.id) AS device_count
        FROM workspaces w
        JOIN organizations o ON o.id = w.organization_id
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ?
        LEFT JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = ?
        ORDER BY o.name, w.name
      `).all(req.user.id, req.user.id)
    : db.prepare(`
        SELECT w.id, w.name, w.organization_id, o.name AS organization_name,
               wm.role AS workspace_role, om.role AS org_role,
               (SELECT COUNT(*) FROM devices WHERE workspace_id = w.id) AS device_count
        FROM workspaces w
        JOIN organizations o ON o.id = w.organization_id
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ?
        LEFT JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = ?
        WHERE wm.user_id IS NOT NULL
           OR (om.user_id IS NOT NULL AND om.role IN ('org_owner', 'org_admin'))
        ORDER BY o.name, w.name
      `).all(req.user.id, req.user.id);

  // Compute can_admin per workspace. Mirrors canAdminWorkspace() in lib/permissions.js
  // but uses already-joined org_role to avoid another N+1 query per workspace.
  for (const w of accessible) {
    w.can_admin = isPlatformAdmin
      || w.org_role === 'org_owner' || w.org_role === 'org_admin'
      || w.workspace_role === 'workspace_admin';
    delete w.org_role; // internal-only; don't leak to client
  }

  const currentOrg = req.organizationId
    ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.organizationId)
    : null;

  res.json({
    ...req.user,
    current_workspace_id: req.workspaceId,
    current_workspace: req.workspace ? { id: req.workspace.id, name: req.workspace.name, organization_id: req.workspace.organization_id } : null,
    current_organization: currentOrg,
    current_workspace_role: req.workspaceRole,
    current_org_role: req.orgRole,
    is_platform_admin: req.isPlatformAdmin,
    acting_as: req.actingAs,
    accessible_workspaces: accessible,
  });
});

// Switch the active workspace. Validates the user has access (direct
// workspace_member, org-level admin in the parent org, or platform_admin),
// then mints a fresh JWT with the new current_workspace_id.
router.post('/switch-workspace', requireAuth, (req, res) => {
  const { workspace_id } = req.body || {};
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace_id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  // #13: platform staff (admin OR operator) can switch into any workspace.
  const isPlatformStaffUser = isPlatformStaff(req.user.role);
  const wsMember = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws.id, req.user.id);
  const orgMember = db.prepare(`
    SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?
  `).get(ws.organization_id, req.user.id);
  const canAct = isPlatformStaffUser
    || !!wsMember
    || (orgMember && (orgMember.role === 'org_owner' || orgMember.role === 'org_admin'));

  if (!canAct) return res.status(403).json({ error: 'Access denied to that workspace' });

  const token = generateToken(req.user, ws.id);
  res.json({ token, current_workspace_id: ws.id });
});

// Update current user
router.put('/me', requireAuth, (req, res) => {
  const { name, password, current_password, email_alerts } = req.body;
  if (name) {
    db.prepare('UPDATE users SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(name, req.user.id);
  }
  if (email_alerts !== undefined) {
    db.prepare('UPDATE users SET email_alerts = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(email_alerts ? 1 : 0, req.user.id);
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const row = db.prepare('SELECT password_hash, auth_provider FROM users WHERE id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.auth_provider !== 'local') {
      return res.status(400).json({ error: `Your account signs in via ${row.auth_provider}. Manage your password there.` });
    }
    if (row.password_hash) {
      if (!current_password || !bcrypt.compareSync(current_password, row.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }
    const hash = bcrypt.hashSync(password, 10);
    // #10: a successful password change clears must_change_password, releasing
    // the first-login change-password gate.
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(hash, req.user.id);
  }
  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// List users - platform admins see all, admins see team members only
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  if (PLATFORM_ROLES.includes(req.user.role)) {
    // One aggregate query (no N+1): each user carries workspace_count, and for
    // an exactly-one membership the single workspace id/name + org name (used by
    // the admin Users page Workspace column). MAX() over a single grouped row
    // yields that row's values; the CASE blanks them when count != 1 so we never
    // surface a single workspace name for a multi-membership user.
    const users = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.auth_provider, u.avatar_url, u.plan_id, u.created_at, u.last_login,
             COUNT(wm.workspace_id) AS workspace_count,
             CASE WHEN COUNT(wm.workspace_id) = 1 THEN MAX(w.id)   END AS workspace_id,
             CASE WHEN COUNT(wm.workspace_id) = 1 THEN MAX(w.name) END AS workspace_name,
             CASE WHEN COUNT(wm.workspace_id) = 1 THEN MAX(o.name) END AS organization_name
      FROM users u
      LEFT JOIN workspace_members wm ON wm.user_id = u.id
      LEFT JOIN workspaces w ON w.id = wm.workspace_id
      LEFT JOIN organizations o ON o.id = w.organization_id
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `).all();
    res.json(users);
  } else {
    // Admin sees themselves + users in their teams
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.email, u.name, u.role, u.auth_provider, u.avatar_url, u.plan_id, u.created_at
      FROM users u
      LEFT JOIN team_members tm ON u.id = tm.user_id
      WHERE u.id = ? OR tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
      ORDER BY u.created_at ASC
    `).all(req.user.id, req.user.id);
    res.json(users);
  }
});

// Delete user (superadmin only)
router.delete('/users/:id', requireAuth, requireSuperAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // #18: a bare DELETE FROM users fails the FK constraints (23 uncascaded refs).
  // deleteUserCascade resolves every reference in one transaction: hard-deletes
  // orgs the user solely owns, preserves (unlinks/reassigns) resources in orgs
  // they don't own, and refuses if they own a shared org.
  try {
    deleteUserCascade(db, { targetId: target.id, actingAdminId: req.user.id });
  } catch (e) {
    if (e instanceof OrgHasOtherMembersError) return res.status(409).json({ error: e.message });
    throw e;
  }
  logActivity(req.user.id, 'delete_user', `target: ${target.email}`, null, getClientIp(req));
  res.json({ success: true });
});

// Update user platform role (platform admin only).
// #14: this manages users.role (the PLATFORM-level role) only - workspace and
// org roles are managed in the members views. Whitelist is the current model:
// 'user' and 'platform_admin' (the legacy 'admin'/'superadmin' strings are gone
// after normalization and are no longer accepted here).
const ASSIGNABLE_PLATFORM_ROLES = ['user', 'platform_operator', 'platform_admin'];
router.put('/users/:id/role', requireAuth, requireSuperAdmin, (req, res) => {
  const { role } = req.body;
  if (!ASSIGNABLE_PLATFORM_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Self-demotion guard: a platform admin can't strip their own platform role
  // (would lock themselves out of platform admin actions).
  if (req.params.id === req.user.id && !isPlatformRole(role)) return res.status(400).json({ error: 'Cannot demote yourself' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ success: true });
});

// Admin password reset for another user.
// Superadmins: can reset any local user. Admins: can reset members of teams
// they own (and never a superadmin). Self-reset routes through PUT /me with
// current_password — this endpoint is the override path.
router.put('/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Use Settings > Change Password for your own account' });
  }
  const target = db.prepare('SELECT id, email, role, auth_provider FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.auth_provider !== 'local') {
    return res.status(400).json({ error: `User signs in via ${target.auth_provider} — password reset does not apply` });
  }

  if (!PLATFORM_ROLES.includes(req.user.role)) {
    // Admin path: must own a team that includes the target, and target must
    // be a regular user (cannot reset another admin's or a platform_admin's
    // password — that would be a lateral-takeover vector).
    if (target.role !== 'user') {
      return res.status(403).json({ error: 'Admins can only reset passwords for regular users' });
    }
    const sharedOwnedTeam = db.prepare(`
      SELECT 1 FROM team_members tm_admin
      JOIN team_members tm_target ON tm_admin.team_id = tm_target.team_id
      WHERE tm_admin.user_id = ? AND tm_admin.role = 'owner'
        AND tm_target.user_id = ?
      LIMIT 1
    `).get(req.user.id, req.params.id);
    if (!sharedOwnedTeam) {
      return res.status(403).json({ error: 'You can only reset passwords for members of teams you own' });
    }
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(hash, req.params.id);

  // Explicit audit entry — the generic activity logger captures the route
  // and target id, but a labeled detail string makes the audit log readable.
  // Never include the password; just who reset whose password.
  logActivity(req.user.id, 'password_reset_for_user', `target: ${target.email}`, null, getClientIp(req));
  res.json({ success: true });
});

// Get auth config (public - tells frontend which providers are available)
router.get('/config', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  res.json({
    googleEnabled: !!config.googleClientId,
    googleClientId: config.googleClientId,
    microsoftEnabled: !!config.microsoftClientId,
    microsoftClientId: config.microsoftClientId,
    microsoftTenantId: config.microsoftTenantId,
    localEnabled: true,
    needsSetup: userCount === 0,
    registration_enabled: !config.disableRegistration || userCount === 0,
  });
});

// Accept a workspace invite. Mounted here (under /api/auth) rather than in
// routes/workspaces.js because the invite id is the only thing the caller
// has - they don't necessarily know which workspace it targets yet, so
// /api/workspaces/:id/... wouldn't fit. requireAuth gates access; the
// invite's email is matched against the authenticated user's email
// case-insensitively, so a logged-in account can only accept invites
// addressed to its own email.
router.post('/accept-invite/:inviteId', requireAuth, (req, res) => {
  const invite = db.prepare('SELECT * FROM workspace_invites WHERE id = ?').get(req.params.inviteId);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });

  const now = Math.floor(Date.now() / 1000);
  if (invite.expires_at <= now) {
    db.prepare('DELETE FROM workspace_invites WHERE id = ?').run(invite.id);
    return res.status(410).json({ error: 'Invite has expired' });
  }

  if (String(invite.email).toLowerCase() !== String(req.user.email).toLowerCase()) {
    return res.status(403).json({ error: 'This invite is for a different email address' });
  }

  const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(invite.workspace_id);
  if (!ws) {
    // Workspace was deleted between invite creation and accept. Clean up.
    db.prepare('DELETE FROM workspace_invites WHERE id = ?').run(invite.id);
    return res.status(410).json({ error: 'Workspace no longer exists' });
  }

  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(ws.organization_id);

  // Idempotent: if the user already has a workspace_members row, return
  // success without changing the role (don't silently demote/upgrade), and
  // still consume the invite. The invitee's intent ("I want access") is
  // already satisfied either way.
  const existing = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(ws.id, req.user.id);

  const txn = db.transaction(() => {
    if (!existing) {
      db.prepare(`
        INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
        VALUES (?, ?, ?, ?)
      `).run(ws.id, req.user.id, invite.role, invite.invited_by);
    }
    db.prepare('DELETE FROM workspace_invites WHERE id = ?').run(invite.id);
  });
  txn();

  // Stamp workspaceId so activityLogger captures tenant attribution.
  req.workspaceId = ws.id;

  res.json({
    workspace_id: ws.id,
    workspace_name: ws.name,
    organization_name: org?.name || null,
    role: existing ? existing.role : invite.role,
    already_member: !!existing,
  });
});

module.exports = router;
