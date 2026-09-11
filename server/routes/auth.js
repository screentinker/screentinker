const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { generateToken, generateMfaPendingToken, verifyMfaPendingToken, requireAuth, requireAdmin, requireSuperAdmin, isPlatformRole, isPlatformStaff, PLATFORM_ROLES } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const totp = require('../lib/totp');
const totpLockout = require('../lib/totp-lockout');
const loginLockout = require('../lib/login-lockout');
const QRCode = require('qrcode');
const { sendSignupEmails, sendVerificationEmail, sendPasswordResetEmail } = require('../services/signupEmails');
const passwordReset = require('../lib/passwordReset');
const emailVerify = require('../lib/emailVerify');
const emailSvc = require('../services/email');
const { deleteUserCascade, OrgHasOtherMembersError } = require('../lib/user-deletion');
const config = require('../config');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const oidc = require('../lib/oidc');
const oidcProviders = require('../lib/oidc-providers');

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

/*
 * Stamp the moment this user was last handed a session.
 *
 * ⚠️ EVERY PATH THAT MINTS A SESSION MUST CALL THIS, not just /login. It was called from the two
 * interactive login finishers only, so a user who signed up and was handed a session on the spot
 * (POST /register, below) was never stamped and read as "never logged in" for ever. On the hosted
 * instance that was 132 of 349 accounts, 43 of which were actively publishing playlists and
 * uploading content at the time. The column is read by admin views and was about to be used to
 * pick accounts for deletion, so an under-report here is not cosmetic.
 *
 * Kept separate from logSuccessfulLogin because a signup is NOT a login: it must not write an
 * `auth:login_success` row that no interactive login produced. Workspace switching (which re-mints
 * a token for an already-authenticated user) deliberately does not call either.
 */
function stampLastLogin(userId) {
  try {
    db.prepare("UPDATE users SET last_login = strftime('%s','now') WHERE id = ?").run(userId);
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
  } catch {}
  stampLastLogin(userId);
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
  /*
   * Registration accepted anything with an @ in it, so `<img/src=q/onerror=alert(1)>@acme.test`
   * became a real row — markup with no spaces, which is why it also slipped the asserted-email
   * check. Rendering is escaped now, but an address that is not an address has no business being
   * stored: it is displayed on operator screens, put in emails, and compared against domains.
   */
  if (!ASSERTED_EMAIL_RE.test(String(email).toLowerCase()) || /[<>"'`\\]/.test(String(email))) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  /*
   * An organization that requires single sign-on must not have password accounts created at its
   * domains — not even by a stranger. Two things went wrong without this: the account was issued a
   * working session immediately (a bypass), and it then held the address forever, because
   * upsertFederatedUser refuses to adopt a row that has a password. Registering ceo@acme.test
   * before the real CEO's first login left that address dead in BOTH directions with no
   * self-service way out.
   */
  let ssoOnlyOrg = null;
  try {
    ssoOnlyOrg = oidcProviders.ssoOnlyForEmail(email);
  } catch (e) {
    console.error('[register] SSO-only status unavailable, refusing registration:', e && e.message);
    ssoOnlyOrg = { unavailable: true };
  }
  if (ssoOnlyOrg) {
    return res.status(403).json({
      error: 'That domain uses single sign-on. Sign in with your organization instead of creating a password.',
      code: 'sso_required',
    });
  }

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

  // Email verification: require it for a normal local signup only when we can actually send
  // the mail. The bootstrap (first) user is never gated — a fresh install must not lock out
  // its own admin — and neither is an instance with no email transport configured (a self-host
  // that can't send would otherwise strand every signup). email_verified column DEFAULTs to 1,
  // so we only ever write 0 here on the require-verification path.
  const requireVerify = !isFirstUser && emailSvc.isConfigured();
  const emailVerified = requireVerify ? 0 : 1;

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, trial_started, trial_plan, email_verified)
    VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?, ?)
  `).run(id, email.toLowerCase(), name || email.split('@')[0], passwordHash, role, plan, trialStarted, trialStarted ? 'pro' : null, emailVerified);

  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_ends, email_verified FROM users WHERE id = ?').get(id);
  // #12: org-on-create. Per-request createOrg overrides the deployment default
  // (config.autoCreateOrgOnSignup). The first user is always given an org so a
  // fresh install is never left headless. When neither applies, the user is
  // created org-less and lands on the "no workspaces yet" state until an admin
  // assigns them.
  const createOrgForUser = isFirstUser
    || (createOrg !== undefined ? !!createOrg : config.autoCreateOrgOnSignup);
  const workspaceId = ensureDefaultOrgForUser(user, { allowCreate: createOrgForUser });

  // Welcome + admin-notify emails (hosted instance only, idempotent, async).
  sendSignupEmails(user, req);

  // Verification email (issue a token first) whenever this signup needs to confirm its address.
  if (requireVerify) {
    const vtoken = emailVerify.issue(user.id);
    sendVerificationEmail(user, vtoken, req);
  }

  // Hosted (SELF_HOSTED unset) HARD-BLOCKS an unverified local signup: no session until they
  // click the link. Self-host is a soft nudge — fall through and issue the session; the client
  // shows a "verify your email" banner (user.email_verified === 0) with a resend button.
  if (requireVerify && !config.selfHosted) {
    return res.status(201).json({ verification_required: true, email: user.email });
  }

  // This signup is being handed a live session, so it counts as the user's most recent one. The
  // early return above (hosted + verification required) issues NO session and is deliberately not
  // stamped: those accounts really have never had one.
  stampLastLogin(user.id);
  const token = generateToken(user, workspaceId);
  res.status(201).json({ token, user, current_workspace_id: workspaceId });
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  /*
   * The DOMAIN check runs BEFORE the account lookup, deliberately.
   *
   * Answering `403 sso_required` only for addresses that exist turned this endpoint into an
   * account-existence oracle: a wrong password got 403 for a real address and 401 for an invented
   * one. Whether a domain uses single sign-on is already public — /sso/discover answers it for
   * anyone — so refusing on the domain alone reveals nothing new, and it reveals it identically
   * for addresses that exist and addresses that do not.
   */
  /*
   * SSO-only refusal, arranged so it is neither an account-existence oracle NOR a way to brick the
   * instance.
   *
   * Two constraints pull against each other. Answering 403 only for addresses that EXIST turned
   * this into an enumeration oracle. But hoisting the check above the account lookup — the obvious
   * cure — silently killed the platform_admin break-glass, because role is not known until the row
   * is read. That is worse than it sounds: on a self-hosted instance the operator IS the org owner,
   * and the guard that stops an admin locking themselves out GUARANTEES their address is inside the
   * enforced set. Approving a removal request needs a platform admin to be signed in, so the
   * recovery loop closed on itself and the only way back was a shell.
   *
   * Both hold if the operator is let through on a CORRECT PASSWORD and nothing else: every wrong
   * answer is the identical 403, whether the address exists, does not exist, or belongs to the
   * operator. The only observable difference needs the password, which an enumerator does not have.
   */
  const domainEnforced = (() => {
    try { return oidcProviders.ssoOnlyForEmail(email); } catch (e) {
      console.error('[login] SSO-only status unavailable, refusing password login:', e && e.message);
      return { unavailable: true };
    }
  })();
  const ssoRefusal = () => {
    logFailedLogin(email, getClientIp(req), 'Password login refused: domain requires SSO');
    return res.status(403).json({
      error: 'Your organization requires single sign-on. Use the single sign-on button to continue.',
      code: 'sso_required',
      sso_start: '/api/auth/sso/start',
    });
  };

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND auth_provider = ?').get(email.toLowerCase(), 'local');
  if (!user) {
    // An unknown address at an enforced domain answers exactly like a known one — see above.
    if (domainEnforced) return ssoRefusal();
    logFailedLogin(email, getClientIp(req), 'User not found');
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // The break-glass: the operator may still sign in with a password at an enforced domain, but a
  // WRONG password answers with the same refusal everyone else gets, so nothing is learned.
  const breakGlass = domainEnforced && user.role === 'platform_admin' && !domainEnforced.unavailable;
  if (domainEnforced && !breakGlass) return ssoRefusal();

  /*
   * SSO-ONLY. The organization that owns this VERIFIED domain requires its identity provider, so a
   * password is not an alternative way in — otherwise the MFA, conditional access and instant
   * deprovisioning the customer bought are all reachable around.
   *
   * ⚠️ platform_admin is exempt, and that exemption is load-bearing rather than a convenience. The
   * operator is the one who approves turning this OFF. If the operator's own address sits at an
   * SSO-only domain and that identity provider breaks, nobody can sign in to approve anything and
   * the instance is bricked with no path out. The exemption is the break-glass; it applies to the
   * people who run the server, never to a customer's own admins.
   *
   * Said plainly rather than as "invalid email or password": this is not a credential failure and
   * pretending otherwise sends the user to reset a password that will never work. The domain
   * already answered `sso: true` publicly, so naming it reveals nothing new.
   */
  if (user.role !== 'platform_admin') {
    /*
     * A throw here means we could not determine the answer (schema drift, a broken read). Treat
     * that as "SSO is required" rather than letting a 500 escape or, worse, letting the login
     * through: the whole point of this gate is that a password must not be an alternative way in,
     * and "we could not check" is not "there is nothing to check".
     */
    let enforced = null;
    try {
      // By MEMBERSHIP as well as by domain — an account inside the tenant at an outside address
      // was the demonstrated way around this.
      enforced = oidcProviders.ssoOnlyForUser(user);
    } catch (e) {
      console.error('[login] SSO-only status unavailable, refusing password login:', e && e.message);
      enforced = { unavailable: true };
    }
    if (enforced) {
      /*
       * Reached only when the ADDRESS's domain is not enforced but the user is a MEMBER of an
       * organization that requires single sign-on — an off-domain contractor, say. The generic 401
       * is deliberate: a distinct answer here would put the existence oracle back, for exactly the
       * accounts an attacker would most like to enumerate. These people cannot sign in by any
       * route (their domain is not verified, so their org's provider will not assert for them
       * either), which is why enabling SSO-only now names them to the admin up front instead of
       * leaving them to discover it here.
       */
      logFailedLogin(email, getClientIp(req), 'Password login refused: member of an SSO-only organization');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
  }

  // Per-ACCOUNT brute-force lockout (lib/login-lockout), on top of the per-IP limiter in
  // server.js. Checked BEFORE bcrypt so a locked account costs no hashing work.
  //
  // The response is deliberately IDENTICAL to a wrong password: a distinct 429 would tell
  // an attacker "this account exists and is under attack", turning the endpoint into an
  // account-existence oracle. The trade is that a locked-out legitimate user sees the
  // generic message, so the trip is written to activity_log for the operator instead.
  if (loginLockout.isLocked(user.id)) {
    logFailedLogin(email, getClientIp(req), 'Locked out (too many failed passwords)');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    if (breakGlass) {
      // Same answer as every other address at this domain: the operator's existence is not a fact
      // this endpoint gives away to someone who cannot type their password.
      loginLockout.recordFailure(user.id);
      return ssoRefusal();
    }
    const rec = loginLockout.recordFailure(user.id);
    if (rec.lockedUntil) logActivity(null, 'auth:login_locked', `${email} - locked after repeated failures`, null, getClientIp(req));
    logFailedLogin(email, getClientIp(req), 'Wrong password');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Password proven. Clear the counter HERE rather than in issueSession: the TOTP and
  // email-verification branches below return before issueSession is ever reached, so a
  // reset placed there would never fire for those accounts.
  loginLockout.reset(user.id);

  // Email verification gate. Unverified LOCAL accounts are asked to confirm on login — this
  // covers both new signups AND existing users who predate the feature (grandfathered locals are
  // email_verified=0). Gated ONLY where we can actually send the mail (isConfigured), so an
  // instance with no email transport never locks anyone out. Existing users never received a
  // signup email, so (re)send one here (guarded against re-mailing a still-valid token). HOSTED
  // hard-blocks — no session, no MFA step; self-host is a soft nudge (login proceeds, client
  // shows a banner). SSO + platform admins are grandfathered to 1, so this never trips for them.
  if (!user.email_verified && emailSvc.isConfigured()) {
    ensureVerificationEmail(user, req);
    if (!config.selfHosted) {
      return res.json({ verification_required: true, email: user.email });
    }
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
  const safeUser = publicUser(user);
  res.json({ token, user: safeUser, current_workspace_id: workspaceId, ...extra });
}

// ==================== Email verification (signup) ====================
// (Re)send a verification email for an unverified user, UNLESS a still-valid token is already
// pending — so a login-gated user isn't re-mailed on every attempt. Callers have already checked
// emailSvc.isConfigured(). `user` is a SELECT * row (carries email_verify_expires).
function ensureVerificationEmail(user, req) {
  const now = Math.floor(Date.now() / 1000);
  if (user.email_verify_expires && user.email_verify_expires > now) return; // valid token still out
  const token = emailVerify.issue(user.id);
  sendVerificationEmail(user, token, req);
}

// The emailed link lands here (GET, unauthenticated — the user isn't logged in yet). We flip
// the flag and redirect into the app with a flash flag, so there's no separate frontend route.
router.get('/verify-email', (req, res) => {
  const ok = emailVerify.consume(req.query.token);
  return res.redirect(ok ? '/app#/login?verified=1' : '/app#/login?verify_error=1');
});

// Resend the verification email. Unauthenticated (the hosted gate blocks the session, so the
// user has no token) and rate-limited in server.js. Always returns a generic success so it
// never reveals whether an address exists or is already verified.
router.post('/resend-verification', (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (email) {
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND auth_provider = 'local'").get(email);
    if (user && !user.email_verified) {
      const token = emailVerify.issue(user.id);
      sendVerificationEmail(user, token, req);
    }
  }
  res.json({ ok: true });
});

// ==================== Self-service password reset ====================
// Two endpoints, both unauthenticated by necessity (the user cannot log in).
//
// The request endpoint ALWAYS answers the same way — same status, same body — whether the
// address exists, is an SSO identity with no local password, or is malformed. Anything
// else turns it into an account-existence oracle, which is the classic mistake here.
//
// Completing a reset deliberately does NOT return a session. The user logs in afterwards,
// so a TOTP-enabled account still has to clear its second factor; issuing a token here
// would turn "read one email" into a full session and quietly bypass MFA.
const RESET_GENERIC_OK = { ok: true, message: 'If that address has an account, a reset link is on its way.' };

/*
 * An account whose identity provider no longer exists — and why it may reset a password.
 *
 * A federated row normally must NOT be resettable: the identity provider owns that account, and
 * offering a password would be a way around it. But a provider can be deleted, and the row it
 * created outlives it, pointing at a slug nothing answers to. Such an account cannot log in by any
 * route: no provider to authenticate against, no password to reset, and registration refuses the
 * address as taken.
 *
 * That is not only an accident. A tenant can claim a domain it does not own (claims are not yet
 * verified — see the README), sign in as an address there, delete its provider, and leave the real
 * owner permanently unable to reach an account bearing their own address.
 *
 * Proving control of the MAILBOX is the right way out, and it is strictly stronger evidence than
 * the identity-provider assertion that created the row. So an orphaned account may reset, and doing
 * so returns it to a local account. A row whose provider still exists is untouched by this.
 */
/*
 * What an identity provider is allowed to call an email address.
 *
 * Exactly one @, no whitespace, no control characters, a domain with at least one dot. Deliberately
 * stricter than the RFC — this is not validating what may exist in the world, it is deciding what
 * this system will key an ACCOUNT on, and every exotic form is a way for two spellings to look like
 * one address to a human and two to the database.
 */
const ASSERTED_EMAIL_RE = /^[^\s@\x00-\x1f]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * May this provider speak for this address?
 *
 * A pure function on purpose: the confinement it implements is the single control standing between
 * per-organization SSO and an account-takeover primitive, and a control that can only be exercised
 * by standing up a hostile identity provider is a control that does not get tested. It was in fact
 * shipped untested once — the test named after it asserted only that a provider row carried two
 * fields, and passed with the guard deleted.
 *
 * `provider.emailDomains` is the VERIFIED set (see rowToProvider), so this cannot be satisfied by a
 * domain the tenant merely typed.
 */
function emailAllowedForProvider(provider, email) {
  // Instance-wide providers are the operator's own choice and keep the trust they have always had.
  if (!provider.organizationId) return true;
  const addr = String(email || '').toLowerCase();
  /*
   * Malformed addresses are refused rather than tidied. `victim@evil.test@acme.test\n` used to pass
   * — lastIndexOf('@') took `acme.test\n`, and trimming turned it into an allowed domain — so an
   * address that is not one thing got treated as belonging to a domain it only ended with. Anything
   * carrying whitespace, control characters or a second @ is not an address this will reason about.
   */
  if (!ASSERTED_EMAIL_RE.test(addr)) return false;
  const at = addr.lastIndexOf('@');
  if (at === -1) return false;
  const domain = addr.slice(at + 1).trim();
  if (!domain) return false;
  // Lowercased on both sides: forEmail lowercases when routing, and a row that differed in case
  // would otherwise route a user in and then reject them at the callback.
  const allowed = String(provider.emailDomains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(domain);
}

function isOrphanedFederated(user) {
  if (!user || user.auth_provider === 'local') return false;
  /*
   * ⚠️ ONLY an organization provider's slug, never an instance one.
   *
   * This used to ask "does anything answer to that slug?", which cannot tell DELETED apart from
   * NOT CURRENTLY CONFIGURED. Unsetting GOOGLE_CLIENT_ID — or fat-fingering MICROSOFT_TENANT_ID to
   * `common`, a typo the provider code already refuses — therefore made every account on that
   * provider password-resettable instance-wide, and irreversibly: the reset rewrites auth_provider
   * to 'local', so restoring the variable does not restore the binding. An organization that chose
   * SSO to enforce its IdP's MFA would have had that silently downgraded to mailbox access.
   *
   * Org slugs are generated as `org` + 12 hex (see org-sso.js), so the shape is decisive: an env
   * provider can never match it, and an unconfigured env provider is UNAVAILABLE, not deleted.
   *
   * Deleting an org provider now returns its users to local accounts outright (org-sso.js), so this
   * only catches rows stranded some other way — an interrupted delete, a restored backup.
   */
  if (!/^org[0-9a-f]{12}$/.test(String(user.auth_provider))) return false;
  return !oidcProviders.ownerOf(user.auth_provider);
}

router.post('/forgot-password', (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  // Respond identically no matter what happens below.
  try {
    if (email) {
      const candidate = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      // A local account, or one stranded by a deleted provider — see isOrphanedFederated above.
      const user = candidate && (candidate.auth_provider === 'local' || isOrphanedFederated(candidate))
        ? candidate : null;
      if (user) {
        if (!emailSvc.isConfigured()) {
          // Loud, because the user will wait for an email that can never arrive and the
          // generic response cannot tell them.
          console.error(`[password-reset] NO EMAIL TRANSPORT CONFIGURED — reset requested for ${email} cannot be delivered.`);
        } else {
          const token = passwordReset.issue(user.id);
          sendPasswordResetEmail(user, token, req).catch(e =>
            console.error('[password-reset] send failed:', e && e.message));
          logActivity(user.id, 'auth:password_reset_requested', null, null, getClientIp(req));
        }
      }
    }
  } catch (e) {
    console.error('[password-reset] request error:', e && e.message);
  }
  return res.json(RESET_GENERIC_OK);
});

router.post('/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < passwordReset.MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${passwordReset.MIN_PASSWORD_LENGTH} characters` });
  }
  const userId = passwordReset.consume(token, String(password));
  if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  // Someone who locked themselves out guessing must not stay locked out after proving
  // control of the mailbox and choosing a new password.
  loginLockout.reset(userId);
  const u = db.prepare('SELECT email, auth_provider FROM users WHERE id = ?').get(userId);
  /*
   * Return a stranded federated row to a local account. Without this the reset would "succeed" and
   * change nothing anyone can use: POST /login only ever looks at auth_provider = 'local', so the
   * new password would be unreachable and the account still lost.
   */
  if (isOrphanedFederated(u)) {
    db.prepare("UPDATE users SET auth_provider = 'local', provider_id = NULL WHERE id = ?").run(userId);
    console.log(`[password-reset] ${u.email} reclaimed from deleted provider ${u.auth_provider}`);
    logActivity(userId, 'auth:federated_account_reclaimed', `was ${u.auth_provider}`, null, getClientIp(req));
  }
  logActivity(userId, 'auth:password_reset_completed', null, null, getClientIp(req));
  console.log(`[password-reset] password changed for ${u ? u.email : userId}`);
  // No session on purpose — see above.
  return res.json({ ok: true, message: 'Password updated. You can now sign in.' });
});

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

// Step 1: mint a pending secret + return the otpauth:// URI + a ready-to-render QR
// data URL (drawn server-side with the already-bundled `qrcode` lib, same as the
// device-owner provisioning QR). The raw secret is also returned for manual entry.
router.post('/totp/setup', requireAuth, asyncRoute(async (req, res) => {
  const u = db.prepare('SELECT auth_provider, totp_enabled, email FROM users WHERE id = ?').get(req.user.id);
  if (u.auth_provider !== 'local') return res.status(400).json({ error: 'TOTP is only for password accounts; your identity provider manages MFA.' });
  if (u.totp_enabled) return res.status(409).json({ error: 'TOTP already enabled. Disable it first to re-enroll.' });
  const secret = totp.generateSecret();
  db.prepare("UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, updated_at = strftime('%s','now') WHERE id = ?")
    .run(totp.encryptSecret(secret), req.user.id);
  // Fold the instance host into the QR label so users with accounts on more than one
  // ScreenTinker can tell them apart in their authenticator app (#100). trust-proxy is set,
  // so req.get('host') is the public host even behind Cloudflare/nginx.
  const host = (req.get('host') || '').replace(/[^A-Za-z0-9.:-]/g, '').slice(0, 60);
  const otpauth_uri = totp.keyuri(u.email, secret, host || undefined);
  let qr_data_url = null;
  // QR is a convenience — if it fails, the client still has otpauth_uri + secret for manual entry.
  try { qr_data_url = await QRCode.toDataURL(otpauth_uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 }); }
  catch (e) { /* fall through with qr_data_url = null */ }
  res.json({ otpauth_uri, secret, qr_data_url });
}));

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
  // verifyMfaPendingToken is the ONLY accessor that accepts the pre-TOTP audience; a full
  // session token presented here is rejected by it (audience mismatch).
  try { decoded = verifyMfaPendingToken(mfa_token); } catch { return res.status(401).json({ error: 'mfa session expired' }); }
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

/*
 * REMOVED 2026-08-10: POST /api/auth/google and POST /api/auth/microsoft.
 *
 * Both authenticated with an ACCESS token and neither checked who it was issued for. Google's path
 * fell back to `tokeninfo?access_token=` and read the email out of the reply; Microsoft's handed the
 * bearer token to Graph /me and trusted that. Graph — and tokeninfo — will describe the user behind
 * a token minted for SOMEBODY ELSE'S application, so any site a user signed into that requested
 * `email` or `User.Read` could replay their token here and be handed a session as them.
 *
 * Nothing is lost by deleting them: the login page called `google.accounts.oauth2` and
 * `new msal.PublicClientApplication`, and neither SDK was ever loaded by any page in this app, so
 * both buttons threw ReferenceError on click. The feature had never worked.
 *
 * Replaced by the OIDC routes at the bottom of this file, which verify an ID token's signature,
 * issuer, audience and our own nonce, and which cover Google, Microsoft and any other provider
 * through one code path. See lib/oidc.js.
 */


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
               COALESCE(w.live_video_enabled, 0) AS live_video_enabled,
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
               COALESCE(w.live_video_enabled, 0) AS live_video_enabled,
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
    ? db.prepare('SELECT id, name, COALESCE(widget_sandbox_isolation_disabled, 0) AS widget_sandbox_isolation_disabled FROM organizations WHERE id = ?').get(req.organizationId)
    : null;

  res.json({
    ...req.user,
    // Read straight from the row (the JWT predates this field) so the client's verify banner
    // reflects live state after reload. Fail-open to verified if somehow absent.
    email_verified: db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id)?.email_verified ?? 1,
    hide_billing: config.hideBilling, // #116: client hides the Subscription nav + guards #/billing
    // #329: same idea as hide_billing above — a capability the client cannot infer without asking.
    // `enroll` decides whether the Servers nav appears (the honest "is this node part of a mesh in
    // any way?"); `hub` gates the aggregate reads (/mesh/orgs, /alerts, /uptime, /devices), which
    // live in the hub router and 404 on a node that only reports upward.
    mesh: {
      enroll: !!(req.app.locals.mesh && req.app.locals.mesh.enroll),
      hub: !!(req.app.locals.mesh && req.app.locals.mesh.hub),
    },
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
  /*
   * `providers` is the whole SSO surface now: slug + display name, nothing else. The browser no
   * longer needs a client id, because it never talks to a provider itself — it follows a link to
   * /api/auth/oidc/<slug>/start and the server builds the authorization request. That is what
   * removed the need for a provider SDK on this page, and with it the CSP exception one would need.
   */
  const providers = oidcProviders.publicList();
  res.json({
    providers,
    // Kept so a cached older login page hides its buttons rather than drawing dead ones. The client
    // ids are deliberately no longer echoed — nothing in the browser has any use for them.
    googleEnabled: providers.some((p) => p.slug === 'google'),
    microsoftEnabled: providers.some((p) => p.slug === 'microsoft'),
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


// ==================== OpenID Connect (generic SSO) ====================
/*
 * ONE flow for every provider — Google, Microsoft, Okta, Keycloak, Authentik, anything that speaks
 * OIDC. Authorization Code + PKCE, run server-side, which is why there is no provider SDK on the
 * login page and no third-party script origin in the CSP.
 *
 * It replaces two endpoints that could not tell WHO a token was minted for. Detail in lib/oidc.js;
 * the short version is that identity now comes from an ID token whose signature, issuer, audience
 * and OUR nonce are all checked, instead of from an access token handed to a userinfo endpoint.
 *
 * ⚠️ TOTP: an SSO login does not prompt for it, matching the existing documented behaviour at the
 * password-login branch above ("The SSO routes and the API-token path never reach here"). The
 * second factor is the identity provider's job in this flow. Changing that is a product decision,
 * not something this refactor should do silently.
 */

// The transaction is held in a short-lived signed cookie rather than server memory so that a
// restart mid-login, or a second server process, does not strand the user on a dead state.
const OIDC_TX_COOKIE = 'st_oidc_tx';
// Holds a completed session for the seconds between the provider redirect and the page claiming it.
const SSO_CLAIM_COOKIE = 'st_sso_claim';
const OIDC_TX_TTL_S = 600;

/*
 * The only shape of a user row that may leave the server.
 *
 * Two call sites each stripped `password_hash, totp_secret_enc, totp_last_step` and stopped there,
 * so every login response also carried `password_reset_hash` and `email_verify_hash` — live
 * credentials for taking the account over, handed to the browser. They are hashes of random tokens
 * and only ever went to the account's own page, so this is hygiene rather than a takeover, but it
 * means a logged-in XSS reads a working reset hash. Denylisted in ONE place so the next field
 * nobody thinks about has somewhere obvious to go.
 */
const PRIVATE_USER_FIELDS = [
  'password_hash', 'totp_secret_enc', 'totp_last_step',
  'password_reset_hash', 'password_reset_expires',
  'email_verify_hash', 'email_verify_expires',
];

function publicUser(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of PRIVATE_USER_FIELDS) delete out[f];
  return out;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    /*
     * ⚠️ decodeURIComponent THROWS on a malformed escape — `Cookie: st_oidc_tx=%` is a URIError.
     * Anyone can send that, and this function is called before the handler's try block, so the
     * throw used to reach the async boundary and take the process down (see asyncRoute below).
     * A cookie we cannot decode is a cookie we do not have.
     */
    try { return decodeURIComponent(value); } catch { return null; }
  }
  return null;
}

/*
 * Wrap an async handler so a rejection becomes a 500 instead of killing the server.
 *
 * Express 4 does not await handlers, so an async one that throws produces an unhandled rejection,
 * and server.js turns that into process.exit(1) — one malformed request, one dead instance, on a
 * restart loop. This has now bitten three separate times on these routes (a state comparison, a
 * cookie decode, a provider whose secret would not decrypt), each time because something threw
 * OUTSIDE the handler's own try block. Fixing the individual throws does not fix the shape, so
 * every async route here goes through this instead.
 */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((err) => {
    console.error(`[auth] unhandled error in ${req.method} ${req.path}:`, err && err.message);
    // Wrapped: if responding THROWS, the rejection has no handler and kills the process — the
    // guard against process death causing process death.
    try {
      if (res.headersSent) return;
      // These are browser redirects, not API calls; a JSON body would be shown as text.
      if (req.path.startsWith('/oidc/')) return backToApp(res, { sso_error: 'server_error' });
      res.status(500).json({ error: 'Something went wrong' });
    } catch (e2) {
      console.error('[auth] failed to report an error:', e2 && e2.message);
    }
  });
}

/*
 * The origin the provider will redirect back to. APP_URL pins it, exactly as the signup and invite
 * mails do, because the redirect_uri must match what is registered with the provider CHARACTER FOR
 * CHARACTER — deriving it from the request Host would break the moment someone reaches the box by
 * a second name, and would be attacker-controlled input in the bargain.
 */
function publicOrigin(req) {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

const redirectUriFor = (req, slug) => `${publicOrigin(req)}/api/auth/oidc/${slug}/callback`;

// Send the browser back to the SPA. Errors travel as a code the login page can translate; the
// token travels in the FRAGMENT, which browsers do not send to servers and proxies do not log.
function backToApp(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.redirect(`/app#/login?${qs}`);
}

// A link attempt starts from Settings while signed in, so it must end there — bouncing an
// authenticated user to the login page to report the outcome reads as "you were signed out".
function backToSettings(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.redirect(`/app#/settings?${qs}`);
}

// Which providers this instance offers. Public: it is what draws the login buttons.
router.get('/providers', (req, res) => {
  res.json({ providers: oidcProviders.publicList() });
});

/*
 * Does this email address belong to an organization with its own identity provider?
 *
 * ⚠️ Answers with a BOOLEAN and nothing else. It deliberately does not return the provider's slug
 * or its display name, because both identify a CUSTOMER: a lookup that answered
 * "yes — Acme Corp SSO" would turn a guessed domain into confirmation that Acme buys this product,
 * and the slug would hand out a working entry point to their tenant's login.
 *
 * "example.com uses SSO" is the smallest answer that still lets the page draw the right button, and
 * it is something anyone could infer by watching an employee log in. The domain-to-provider mapping
 * stays server-side: POST /sso/start does the lookup again and redirects, so the browser never
 * learns which provider it is being sent to until the provider itself says so.
 *
 * It also never reveals whether the ACCOUNT exists — only the domain is matched — so this cannot be
 * walked to enumerate users.
 */
router.get('/sso/discover', (req, res) => {
  const provider = oidcProviders.forEmail(req.query.email);
  /*
   * `required` says the organization has turned off password sign-in for this domain, so the login
   * page can hide the password box instead of letting someone type a password that is going to be
   * refused. It is only ever present when `sso` is already true, so it tells an outsider nothing
   * they could not learn by asking the same question one field earlier.
   *
   * ⚠️ Presentation only. The refusal is enforced in POST /login — a hidden field is a courtesy,
   * not a control, and anyone can post the form directly.
   */
  res.json({
    sso: !!provider,
    required: provider ? !!oidcProviders.ssoOnlyForEmail(req.query.email) : false,
  });
});

/*
 * Begin an organization SSO login for an email address.
 *
 * POST, so the address travels in a body rather than in a URL that lands in browser history, proxy
 * logs and any Referer sent by the provider's page. The lookup happens here rather than in the
 * browser for the reason above: the slug is never published.
 */
router.post('/sso/start', express.urlencoded({ extended: false }), (req, res) => {
  const provider = oidcProviders.forEmail((req.body && req.body.email) || req.query.email);
  /*
   * ⚠️ ANSWER WITH JSON when the page asks for it, rather than a redirect.
   *
   * This used to be a plain <form method="POST"> that 302'd on to the provider. Chrome applies
   * `form-action` to the WHOLE redirect chain, and the dashboard's CSP sets `form-action 'self'`
   * (server.js), so the hop to the identity provider was aborted — silently. The user clicked
   * "Continue with single sign-on" and NOTHING happened: no navigation, no error, an unchanged
   * page. Per-organization SSO, the whole point of this feature, could never work in a browser.
   *
   * The origins cannot simply be allowlisted: they are supplied by customers at runtime. So the
   * page fetches this, then navigates itself — a script-initiated navigation is not governed by
   * form-action. The redirect is kept for a caller without JavaScript, where the chain is
   * same-origin up to the point the provider's own page takes over.
   *
   * The slug in the answer is not a disclosure: following the old redirect put it in the address
   * bar, the network log and history anyway. What stays private is the mapping for a domain the
   * caller cannot name — an unknown domain answers exactly like a disabled one.
   */
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  if (!provider) {
    if (wantsJson) return res.status(404).json({ error: 'unknown_provider', code: 'unknown_provider' });
    return res.redirect('/app#/login?sso_error=unknown_provider');
  }
  const startUrl = `/api/auth/oidc/${encodeURIComponent(provider.slug)}/start`;
  if (wantsJson) return res.json({ start_url: startUrl });
  res.redirect(startUrl);
});

/**
 * Begin an OIDC round trip.
 *
 * `extra` is merged into the signed transaction, which is how LINK mode is carried: the tx is
 * server-signed and lives in an httpOnly cookie, so the browser can neither read nor forge which
 * account a link is for. Login and link therefore share one flow — the same PKCE, state, nonce and
 * verification — instead of a second copy that drifts.
 */
async function beginOidc(req, res, provider, extra = {}, onError = backToApp, asJson = false) {
  try {
    const doc = await oidc.discover(provider.issuer);
    const pkce = oidc.createPkce();
    const nonce = oidc.randomToken();
    const state = oidc.randomToken();

    const tx = jwt.sign(
      { typ: 'oidc-tx', slug: provider.slug, nonce, verifier: pkce.verifier, state, ...extra },
      config.jwtSecret,
      // HS256 explicitly, and a `typ` the session verifier does not accept: two token kinds signed
      // with one secret must never be interchangeable, even if today only `slug` happens to stop it.
      { expiresIn: OIDC_TX_TTL_S, algorithm: 'HS256' },
    );
    res.cookie(OIDC_TX_COOKIE, tx, {
      httpOnly: true,
      sameSite: 'lax',            // the provider returns via a top-level GET, which Lax allows
      secure: req.protocol === 'https',
      maxAge: OIDC_TX_TTL_S * 1000,
      path: '/api/auth',
    });

    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', redirectUriFor(req, provider.slug));
    url.searchParams.set('scope', provider.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
    /*
     * A LINK start is fetched, not navigated to.
     *
     * The session lives in localStorage and travels as an Authorization header, so a top-level
     * `location.href` to an authenticated route arrives anonymous — which is exactly how this first
     * shipped, and it 401'd every time. The caller therefore fetches this with its token and gets
     * the authorize URL back to navigate to itself. The transaction cookie is still set by this
     * response, because a same-origin fetch stores Set-Cookie normally.
     */
    if (asJson) return res.json({ url: url.toString() });
    res.redirect(url.toString());
  } catch (err) {
    console.error(`[oidc] ${provider.slug} start failed:`, err.message);
    if (asJson) return res.status(502).json({ error: 'The provider could not be reached' });
    onError(res, { sso_error: 'provider_unavailable' });
  }
}

router.get('/oidc/:slug/start', asyncRoute(async (req, res) => {
  const provider = oidcProviders.get(req.params.slug);
  if (!provider) return backToApp(res, { sso_error: 'unknown_provider' });
  await beginOidc(req, res, provider);
}));

/*
 * Link an EXISTING account to an instance-wide provider.
 *
 * Signing in with a provider never adopts an account that has a password — that would let anyone who
 * can make a provider assert an address inherit the account behind it. So the owner proves they are
 * the owner first, by being signed in, and starts the link themselves. The account is taken from the
 * SESSION, never from the email in the returned token.
 *
 * ⚠️ INSTANCE-WIDE PROVIDERS ONLY. An organization's provider is chosen by a customer; letting one
 * attach itself to a platform account would hand that customer whatever the account can do. Org
 * membership arrives through the normal org SSO path, which is domain-confined.
 */
/*
 * Unlink, and set a password in the SAME operation.
 *
 * Not two steps. An account whose only credential is a provider has nothing to fall back on the
 * moment that link is removed, so "unlink now, set a password next" leaves a window — and a failure
 * in between leaves an account nobody can sign into at all. The new password is therefore required
 * up front and written in one transaction with the unlink.
 */
router.post('/oidc/unlink', requireAuth, (req, res) => {
  const password = String((req.body || {}).password || '');
  const user = db.prepare('SELECT id, email, auth_provider, password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.auth_provider === 'local') {
    return res.status(400).json({ error: 'This account already signs in with a password' });
  }
  if (password.length < passwordReset.MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${passwordReset.MIN_PASSWORD_LENGTH} characters` });
  }

  const was = user.auth_provider;
  db.prepare("UPDATE users SET auth_provider = 'local', provider_id = NULL, password_hash = ? WHERE id = ?")
    .run(bcrypt.hashSync(password, 10), user.id);
  logActivity(user.id, 'auth:sso_unlinked', `was ${was}`, null, getClientIp(req));
  console.log(`[oidc] ${was} unlinked from ${user.email} (password set)`);
  res.json({ ok: true, auth_provider: 'local' });
});

router.get('/oidc/:slug/link/start', requireAuth, asyncRoute(async (req, res) => {
  const provider = oidcProviders.get(req.params.slug);
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });
  if (provider.organizationId) {
    return res.status(400).json({ error: 'Only this server\'s own providers can be linked' });
  }
  // JSON, not a redirect — see beginOidc. The browser cannot send a bearer token on a navigation.
  await beginOidc(req, res, provider, { link: req.user.id }, backToSettings, true);
}));

router.get('/oidc/:slug/callback', asyncRoute(async (req, res) => {
  const provider = oidcProviders.get(req.params.slug);
  if (!provider) return backToApp(res, { sso_error: 'unknown_provider' });

  // The provider itself can refuse (consent declined, admin policy). That is not an error here.
  if (req.query.error) {
    console.warn(`[oidc] ${provider.slug} returned ${req.query.error}`);
    return backToApp(res, { sso_error: 'provider_refused' });
  }

  const raw = readCookie(req, OIDC_TX_COOKIE);
  res.clearCookie(OIDC_TX_COOKIE, { path: '/api/auth' });
  if (!raw) return backToApp(res, { sso_error: 'expired' });

  let tx;
  try {
    tx = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'] });
    if (tx.typ !== 'oidc-tx') throw new Error('not a login transaction');
  } catch {
    return backToApp(res, { sso_error: 'expired' });
  }

  // CSRF: the state we minted, in the cookie only we could set, must match the one coming back.
  // Compared in constant time so a wrong state cannot be discovered a character at a time.
  const got = String(req.query.state || '');
  const want = String(tx.state || '');
  /*
   * Compared as BYTES, not characters.
   *
   * `got.length` is UTF-16 code units; Buffer.from() produces UTF-8 bytes. A state of 43 characters
   * containing one multi-byte character is 43 chars but 44 bytes, so the guard passed and
   * timingSafeEqual threw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH — inside an async handler, which
   * Express 4 does not catch, which server.js turns into process.exit. One crafted request per
   * restart was enough to take an instance down.
   */
  const gotBuf = Buffer.from(got, 'utf8');
  const wantBuf = Buffer.from(want, 'utf8');
  if (gotBuf.length !== wantBuf.length || !crypto.timingSafeEqual(gotBuf, wantBuf)) {
    return backToApp(res, { sso_error: 'bad_state' });
  }
  if (tx.slug !== provider.slug) return backToApp(res, { sso_error: 'bad_state' });
  if (!req.query.code) return backToApp(res, { sso_error: 'no_code' });

  let claims;
  try {
    const tokens = await oidc.exchangeCode({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      code: String(req.query.code),
      redirectUri: redirectUriFor(req, provider.slug),
      verifier: tx.verifier,
    });
    claims = await oidc.verifyIdToken(tokens.id_token, {
      issuer: provider.issuer,
      clientId: provider.clientId,
      nonce: tx.nonce,
    });
  } catch (err) {
    console.error(`[oidc] ${provider.slug} verification failed:`, err.message);
    return backToApp(res, { sso_error: 'verification_failed' });
  }

  const email = String(claims.email || '').toLowerCase().trim();
  const linking = !!tx.link;
  const fail = linking ? backToSettings : backToApp;
  if (!email) return fail(res, { sso_error: 'no_email' });

  /*
   * ⚠️ AN ORGANIZATION'S PROVIDER MAY ONLY SPEAK FOR ITS OWN DOMAINS.
   *
   * Without this, per-org SSO is an account-takeover primitive, demonstrated end to end twice in
   * review: any org owner can point us at an identity provider they fully control, and such a
   * provider can assert ANY email with email_verified:true — including a platform_admin's. Every
   * check passes honestly, because the attacker IS the issuer.
   *
   * Instance-wide providers are exempt: the OPERATOR chose them, which is the trust they have
   * always had. An org provider is chosen by a customer, so it is confined to the domains that
   * customer registered — and a domain cannot be registered while another organization holds it.
   *
   * The domains are the VERIFIED ones — proved by a DNS record published in the domain itself — so
   * this is confinement to what the tenant demonstrably controls, not to what they typed.
   */
  /*
   * SSO-ONLY applies to EVERY route in, not just the password box.
   *
   * Confinement stops an org provider speaking for domains it does not own. This is the mirror
   * image: when an organization requires its identity provider, no OTHER provider may speak for
   * its people either — including the instance's own Google or Microsoft, which are not
   * domain-confined and would otherwise be an open side door around the MFA and deprovisioning the
   * customer turned this on for. Blocking passwords while leaving "Continue with Google" is not
   * requiring single sign-on; it is renaming the bypass.
   */
  const enforcedOrg = oidcProviders.ssoOnlyForEmail(email);
  if (enforcedOrg && enforcedOrg.slug !== provider.slug) {
    console.warn(`[oidc] ${provider.slug} asserted ${email}, but that organization requires ${enforcedOrg.slug}`);
    return backToApp(res, { sso_error: 'sso_required' });
  }

  if (!emailAllowedForProvider(provider, email)) {
    console.warn(`[oidc] ${provider.slug} asserted ${email}, outside its verified domains [${provider.emailDomains}]`);
    return backToApp(res, { sso_error: 'domain_not_allowed' });
  }
  /*
   * An unverified email is refused. The whole account model keys on email — linking, invites,
   * password reset — so accepting an address the provider itself will not vouch for would let
   * anyone who can type an address into a sloppy IdP arrive as its owner. Providers that omit the
   * claim entirely are treated as "not asserted", which is the same answer.
   */
  // `=== false` accepted an OMITTED claim, which is the opposite of what the comment above says.
  // But requiring `=== true` refused every Microsoft login, because Azure AD v2 omits the claim
  // entirely — so the policy now depends on WHO the provider is, not only on what it sent. An
  // explicit false is still refused, and an org-configured provider still cannot assume anything.
  // See oidcProviders.emailIsVerified() for why that division is the safe one.
  if (!oidcProviders.emailIsVerified(claims, provider)) {
    return fail(res, { sso_error: 'email_unverified' });
  }

  /*
   * LINK: attach this provider to the account that STARTED the link, and drop its password.
   *
   * The account comes from the signed transaction (i.e. from the session that began this), never
   * from the returned email — otherwise "linking" would be the very email-keyed takeover the login
   * path refuses. The email must still match the account's own, because login resolves an account by
   * the address the provider asserts: linking a different address would produce an account that
   * cannot be signed into, or would collide with someone else's.
   *
   * The password is DELETED rather than kept alongside. One credential at a time is the whole point
   * — a password left behind is a second way in that the user believes they replaced.
   */
  if (linking) {
    const target = db.prepare('SELECT id, email, auth_provider FROM users WHERE id = ?').get(tx.link);
    if (!target) return backToSettings(res, { sso_error: 'server_error' });
    if (target.email.toLowerCase() !== email) {
      console.warn(`[oidc] link refused: ${provider.slug} asserted ${email} for account ${target.email}`);
      return backToSettings(res, { sso_error: 'link_email_mismatch' });
    }
    // Someone else already signed in with this provider identity. Two accounts must never share one
    // provider subject, or whoever signs in second silently takes the first one's place.
    const taken = db.prepare('SELECT id FROM users WHERE provider_id = ? AND auth_provider = ? AND id != ?')
      .get(String(claims.sub), provider.slug, target.id);
    if (taken) return backToSettings(res, { sso_error: 'link_already_used' });

    db.prepare('UPDATE users SET auth_provider = ?, provider_id = ?, password_hash = NULL, avatar_url = COALESCE(?, avatar_url) WHERE id = ?')
      .run(provider.slug, String(claims.sub), claims.picture || null, target.id);
    logActivity(target.id, 'auth:sso_linked', `provider=${provider.slug}`, null, getClientIp(req));
    console.log(`[oidc] ${provider.slug} linked to ${target.email} (password cleared)`);
    return backToSettings(res, { sso_linked: provider.slug });
  }

  try {
    const result = upsertFederatedUser({ claims, email, provider, req });
    if (result.error) return backToApp(res, { sso_error: result.error });
    const { user, isNew } = result;

    /*
     * A provider that belongs to an ORGANIZATION vouches for its own people, so anyone who signs in
     * through it becomes a member of that organization — otherwise a customer would configure SSO,
     * their staff would authenticate successfully, and each would land in a fresh empty org of their
     * own, which is the opposite of what they asked for.
     *
     * Membership is added, never changed: an existing member keeps whatever role they already have,
     * so an org_owner cannot be demoted by logging in, and a plain member cannot be promoted by one.
     * Instance-wide providers do none of this — they say nothing about which tenant anyone is in.
     */
    if (provider.organizationId) {
      const already = db.prepare(
        'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(provider.organizationId, user.id);
      if (!already) {
        db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_member')")
          .run(provider.organizationId, user.id);
        /*
         * ⚠️ And a WORKSPACE, or they land somewhere else entirely.
         *
         * ensureDefaultOrgForUser (below) looks for a workspace_members row, not an
         * organization_members one — so writing only the org membership left it finding nothing and
         * minting the user a brand-new personal organization, which then became their CURRENT one.
         * The customer's Members page still read "Members (1)": their staff signed in successfully
         * and were invisible to the admin, managing a private org of their own. That is precisely
         * the outcome the comment above says this code exists to prevent.
         */
        const target = db.prepare(
          'SELECT id FROM workspaces WHERE organization_id = ? ORDER BY created_at LIMIT 1'
        ).get(provider.organizationId);
        if (target) {
          db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')")
            .run(target.id, user.id);
        } else {
          console.warn(`[oidc] org ${provider.organizationId} has no workspace; ${user.email} has no place to land`);
        }
        // (userId, action, details, deviceId, ipAddress, workspaceId) — the org id is NOT the 4th
        // arg; it was landing in device_id, which has no FK to catch it.
        logActivity(user.id, 'org_sso_joined', `via ${provider.name} org=${provider.organizationId}`, null, getClientIp(req));
      }
    }

    logSuccessfulLogin(user.id, user.email, getClientIp(req));
    const workspaceId = ensureDefaultOrgForUser(user, { allowCreate: config.autoCreateOrgOnSignup });
    const token = generateToken(user, workspaceId);
    if (isNew) sendSignupEmails(user, req);

    /*
     * ⚠️ The session token is NOT put in the redirect URL.
     *
     * An earlier version returned it in the fragment. That is a login-CSRF hole: anyone could send
     * a victim `/app#/login?sso_token=<their own token>` and the page would install it, silently
     * signing that person into the ATTACKER'S account — after which their uploads, playlists and
     * settings all land somewhere the attacker can read.
     *
     * Instead the token goes into a one-shot httpOnly cookie that only this origin can set, and the
     * page exchanges it at /sso/claim. A link cannot forge that cookie, so a token can only be
     * claimed by the browser that actually completed the login.
     */
    /*
     * The cookie carries a CLAIM token, not the session token itself. Two reasons, both learned:
     * every token here is signed with the same secret, so a token minted for another purpose (a
     * pre-TOTP `mfa_pending` one, say) was accepted by /sso/claim and returned the full user row;
     * and the session token lives for days, so a copy of it sitting in a Set-Cookie header is worth
     * stealing long after the login. This wrapper is good for 120 seconds and for nothing else.
     */
    const claimToken = jwt.sign(
      { typ: 'sso-claim', tok: token, wsp: workspaceId || null },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: 120 },
    );
    res.cookie(SSO_CLAIM_COOKIE, claimToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: 120 * 1000,
      path: '/api/auth',
    });
    backToApp(res, { sso: '1' });
  } catch (err) {
    console.error(`[oidc] ${provider.slug} sign-in failed:`, err.message);
    backToApp(res, { sso_error: 'server_error' });
  }
}));

/*
 * Exchange the one-shot cookie for the session token.
 *
 * POST so it cannot be triggered by a link or an <img>, and the cookie is cleared on the way out.
 *
 * ⚠️ Clearing a cookie asks the BROWSER to forget it; it does not invalidate anything. What bounds
 * a leaked copy is the claim token's own 120-second expiry, which is why the session token is
 * wrapped rather than handed over directly. Do not restore the comment that used to claim this was
 * "already spent" — it was not, and a review demonstrated the same cookie claiming twice.
 */
router.post('/sso/claim', (req, res) => {
  const token = readCookie(req, SSO_CLAIM_COOKIE);
  res.clearCookie(SSO_CLAIM_COOKIE, { path: '/api/auth' });
  if (!token) return res.status(401).json({ error: 'No sign-in to complete' });

  let claims;
  try {
    // Pinned algorithm and an explicit `typ`: two token kinds signed with one secret must never be
    // interchangeable, and this endpoint accepted anything the secret had touched.
    claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'That sign-in has expired' });
  }
  if (claims.typ !== 'sso-claim' || !claims.tok) {
    return res.status(401).json({ error: 'That sign-in has expired' });
  }

  let session;
  try {
    session = jwt.verify(claims.tok, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'That sign-in has expired' });
  }
  /*
   * The wrapped token must be an ordinary SESSION token. Forging the wrapper needs the signing
   * secret, so this is not exploitable — but a `mfa_pending` token nested inside a valid wrapper
   * was accepted, which is the same interchangeability the outer typ check was added to close.
   * A session token carries no `aud` and no `mfa_pending`; anything else is a different kind.
   */
  if (session.mfa_pending || session.aud || !session.id) {
    return res.status(401).json({ error: 'That sign-in has expired' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.id);
  if (!user) return res.status(401).json({ error: 'That sign-in has expired' });

  const safeUser = publicUser(user);
  res.json({ token: claims.tok, user: safeUser, current_workspace_id: claims.wsp || null });
});

/*
 * Find or create the account behind a verified set of claims.
 *
 * The linking rule is the one the Google path already used, kept deliberately: an existing account
 * WITH a password is never taken over by an SSO login — the owner proves control by logging in
 * locally and linking from Settings. An account with no password (already federated) is re-pointed
 * at whichever provider just authenticated it.
 */
function upsertFederatedUser({ claims, email, provider, req }) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!existing) {
    if (!canRegister()) return { error: 'registration_disabled' };
    const id = uuidv4();
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const isFirst = userCount === 0;
    const role = isFirst ? 'platform_admin' : 'user';
    const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
    const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO users (id, email, name, auth_provider, provider_id, avatar_url, role, plan_id, trial_started, trial_plan, email_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, email, claims.name || '', provider.slug, String(claims.sub), claims.picture || '',
      role, plan, trialStarted, trialStarted ? 'pro' : null);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(id), isNew: true };
  }

  if (existing.auth_provider !== provider.slug) {
    /*
     * An account WITH a password is normally never taken over by an SSO login — the owner proves
     * control by signing in locally. There is exactly one case where refusing is worse than
     * adopting, and it is a trap the previous design walked into:
     *
     * an organization that REQUIRES single sign-on, asserting an address at a domain it has PROVED
     * by DNS. There, the password is already refused by policy (403 sso_required), so refusing the
     * SSO login too shuts both doors — the member cannot sign in by any route, password reset
     * "succeeds" and changes nothing, and if that member is the last org admin the removal request
     * that would undo it can never be filed. A review locked an admin out of their own tenant this
     * way, with no route back short of SQL.
     *
     * Adopting is safe precisely because of what the two conditions already establish: the tenant
     * proved control of the domain (a DNS record they published), and the confinement check above
     * has already refused anything outside it. This is what every hosted identity product does with
     * a verified domain, and it is the only reading under which "requires single sign-on" is a
     * statement about the domain rather than about whoever happened to register first.
     */
    const ssoOnlyAdoption = !!provider.organizationId
      && !!oidcProviders.ssoOnlyForEmail(email)
      && emailAllowedForProvider(provider, email);
    if (existing.password_hash && !ssoOnlyAdoption) return { error: 'account_exists_local' };
    if (existing.password_hash && ssoOnlyAdoption) {
      // The password is dead by policy; clear it rather than leave a credential nobody may use.
      db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(existing.id);
      console.log(`[oidc] ${provider.slug} adopted ${email} (organization requires SSO for its verified domain)`);
    }
    /*
     * `password_hash IS NULL` was the wrong test for "safe to relink". Every SSO-created account has
     * a null password, so it meant "any federated account may be adopted by whichever provider spoke
     * last" — fine when the operator chose them all, an account takeover once a customer can add
     * one. An ORG provider therefore never adopts an account another provider established; the user
     * links it deliberately instead.
     */
    if (provider.organizationId) {
      /*
       * `existing.auth_provider && … !== 'local'` failed OPEN on an empty string, and compared
       * SLUGS, which got the two interesting cases backwards:
       *
       *   - a customer replacing their identity provider (or an admin who deleted one and made
       *     another) got a new random slug, so their own org could no longer sign its own people in
       *     — every SSO account in the tenant bricked, with no recovery route;
       *   - meanwhile an account owned by a DELETED provider looked adoptable to everyone.
       *
       * Ownership is therefore asked of the ORGANIZATION behind the slug, and the only states an
       * org provider may take over are its own org's, and `local` with no password — an invited
       * user who has not set one yet, which is a real and wanted case.
       *
       * An account established by a provider that no longer exists is deliberately NOT adoptable:
       * see the squatting note in the callback. It is recovered by proving control of the email
       * through password reset, not by another identity provider asserting it.
       */
      const owner = oidcProviders.ownerOf(existing.auth_provider);
      const sameOrg = !!(owner && owner.organizationId && owner.organizationId === provider.organizationId);
      const neverFederated = existing.auth_provider === 'local';
      if (!sameOrg && !neverFederated) return { error: 'account_exists_other_provider' };
    }
    db.prepare('UPDATE users SET auth_provider = ?, provider_id = ?, avatar_url = ? WHERE id = ?')
      .run(provider.slug, String(claims.sub), claims.picture || existing.avatar_url, existing.id);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id), isNew: false };
  }

  /*
   * Same provider, but a DIFFERENT subject. `sub` is the provider's stable id and the email is not:
   * addresses get reassigned, especially inside companies. Refusing here is what stops a recycled
   * address inheriting the previous holder's account.
   */
  if (existing.provider_id && String(existing.provider_id) !== String(claims.sub)) {
    return { error: 'subject_mismatch' };
  }
  if (!existing.provider_id) {
    db.prepare('UPDATE users SET provider_id = ? WHERE id = ?').run(String(claims.sub), existing.id);
  }
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id), isNew: false };
}


module.exports = router;
// Exported for tests: these two carry the security decisions of the SSO flow, and testing them
// through a live identity provider only is how they shipped unverified the first time.
module.exports.emailAllowedForProvider = emailAllowedForProvider;
module.exports.upsertFederatedUser = upsertFederatedUser;
module.exports.isOrphanedFederated = isOrphanedFederated;
