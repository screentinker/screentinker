'use strict';

/*
 * 3.0: passkeys (WebAuthn). Mounted by routes/auth.js at /api/auth/passkeys, because sign-in must
 * finish through the same issueSession() a password does — one place logs the login, stamps
 * last_login and mints the token.
 *
 *   GET    /                      this account's passkeys + whether passkeys work here
 *   POST   /register/options      re-authenticate (password, plus TOTP code if enabled) → creation options
 *   POST   /register/verify       store the new passkey
 *   PATCH  /:id                   rename
 *   DELETE /:id                   remove (ends every other session; see below)
 *   POST   /login/options         public: discoverable-credential request options
 *   POST   /login/verify          public: a passkey as the WHOLE sign-in
 *   POST   /mfa/options           public, needs the mfa_pending token: a passkey in place of the TOTP code
 *   POST   /mfa/verify
 *
 * Rate limits for the public and re-auth endpoints are in server.js next to the login ones.
 *
 * Passkeys belong to an ACCOUNT, not a workspace: every query is scoped by user_id and nothing here
 * reads or writes workspace data, the same as the TOTP routes. A workspace_viewer manages their own
 * sign-in methods like anyone else (read-only is about the workspace's content, not your account).
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { db } = require('../db/database');
const passkeys = require('../lib/passkeys');
const totp = require('../lib/totp');
const totpLockout = require('../lib/totp-lockout');
const loginLockout = require('../lib/login-lockout');
const oidcProviders = require('../lib/oidc-providers');
const emailSvc = require('../services/email');
const config = require('../config');
const { audit, auditFromReq } = require('../lib/audit');
const { getClientIp } = require('../services/activity');
const { requireAuth, bumpTokenVersion, generateToken, verifyMfaPendingToken } = require('../middleware/auth');

const TIMEOUT_MS = passkeys.CHALLENGE_TTL_S * 1000;

module.exports = function passkeyRoutes({ issueSession, logFailedLogin, ensureVerificationEmail }) {
  const router = express.Router();

  const unavailable = (res, rp) => res.status(409).json({
    error: 'Passkeys are not available on this server.', code: 'passkeys_unavailable', reason: rp.reason,
  });

  // A sign-in that failed for any reason looks the same from outside: which part failed (unknown
  // credential, bad signature, wrong origin) is for the server log, not for whoever is probing.
  const signInFailed = (res, code = 'passkey_failed') =>
    res.status(401).json({ error: 'That passkey could not be used to sign in.', code });

  const isSynthetic = (req) => !req.user || String(req.user.id).includes(':');

  function loadLocalUser(id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return u && u.auth_provider === 'local' ? u : null;
  }

  /*
   * May this account use a passkey at all, given its organization's single sign-on policy?
   *
   * ⚠️ MIRRORS POST /login, deliberately. An organization that requires its identity provider
   * requires it for EVERY way in, or the MFA, conditional access and instant deprovisioning it
   * bought are reachable around — a passkey is just as much "not the IdP" as a password is. The
   * same break-glass applies: platform_admin is exempt, because the operator is who approves
   * turning SSO-only off and must never be locked out by a broken provider. And the same
   * fail-closed rule: "could not determine" is "required", never "not required".
   *
   * Returns null when allowed, else the refusal reason.
   */
  function ssoRefusal(user) {
    try {
      if (user.role === 'platform_admin') {
        oidcProviders.ssoOnlyForEmail(user.email);   // only to fail closed if the check itself breaks
        return null;
      }
      return oidcProviders.ssoOnlyForUser(user) ? 'sso_required' : null;
    } catch (e) {
      console.error('[passkeys] SSO-only status unavailable, refusing passkey:', e && e.message);
      return 'sso_required';
    }
  }

  const ssoRequiredBody = {
    error: 'Your organization requires single sign-on. Use the single sign-on button to continue.',
    code: 'sso_required',
    sso_start: '/api/auth/sso/start',
  };

  // ---------------------------------------------------------------------------------------------
  // Managing your own passkeys
  // ---------------------------------------------------------------------------------------------

  router.get('/', requireAuth, (req, res) => {
    const rp = passkeys.rpConfig(req);
    const user = isSynthetic(req) ? null : loadLocalUser(req.user.id);
    res.json({
      available: rp.enabled,
      reason: rp.enabled ? null : rp.reason,
      origin: rp.origin || null,
      eligible: !!user && !ssoRefusal(user),
      totp_enabled: !!(user && user.totp_enabled),
      passkeys: user ? passkeys.listForUser(user.id) : [],
      max: passkeys.MAX_PER_USER,
    });
  });

  /*
   * Adding a passkey adds a way into the account that outlives every session, so it asks for the
   * account's credentials again rather than trusting the session alone: a token lifted by XSS or
   * from an unlocked laptop must not be able to plant a permanent key. When TOTP is on, the code is
   * required too — otherwise password + stolen session would mint a passkey that then signs in
   * WITHOUT the second factor. Wrong passwords count toward the per-account lockout, so this is not
   * a password-guessing oracle for whoever holds a session.
   */
  router.post('/register/options', requireAuth, async (req, res) => {
    try {
      if (isSynthetic(req)) return res.status(400).json({ error: 'Not available for this session' });
      const rp = passkeys.rpConfig(req);
      if (!rp.enabled) return unavailable(res, rp);
      const user = loadLocalUser(req.user.id);
      if (!user) return res.status(400).json({ error: 'Passkeys are only for password accounts; your identity provider manages sign-in.' });
      if (ssoRefusal(user)) return res.status(403).json(ssoRequiredBody);
      if (passkeys.countForUser(user.id) >= passkeys.MAX_PER_USER) {
        return res.status(409).json({ error: `You already have ${passkeys.MAX_PER_USER} passkeys. Remove one first.`, code: 'passkey_limit' });
      }

      if (loginLockout.isLocked(user.id)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!user.password_hash || !password || !bcrypt.compareSync(password, user.password_hash)) {
        loginLockout.recordFailure(user.id);
        return res.status(403).json({ error: 'Current password is incorrect', code: 'reauth_failed' });
      }
      if (user.totp_enabled) {
        if (totpLockout.isLocked(user.id)) return res.status(429).json({ error: 'Too many invalid codes. Try again later.' });
        const step = totp.verifyCode(req.body?.code, totp.decryptSecret(user.totp_secret_enc), user.totp_last_step);
        if (!step) {
          totpLockout.recordFailure(user.id);
          return res.status(403).json({ error: 'Invalid code', code: 'reauth_code_required' });
        }
        db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
        totpLockout.reset(user.id);
      }
      loginLockout.reset(user.id);

      const handle = passkeys.userHandleFor(user.id);
      const options = await generateRegistrationOptions({
        rpName: passkeys.rpName(),
        rpID: rp.rpID,
        userName: user.email,
        userDisplayName: user.name || user.email,
        userID: new Uint8Array(handle),
        timeout: TIMEOUT_MS,
        attestationType: 'none',
        excludeCredentials: passkeys.descriptorsForUser(user.id),
        // Discoverable + user verification: the passkey must be able to stand in for the whole
        // sign-in (no email typed, no password), and a credential that never checks for its owner
        // (no PIN, no biometric) cannot do that safely.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const challengeId = passkeys.storeChallenge({
        challenge: options.challenge, purpose: 'register', userId: user.id,
        userHandle: Buffer.from(handle).toString('base64url'), rp,
      });
      res.json({ challenge_id: challengeId, options });
    } catch (e) {
      console.error('[passkeys] register/options failed:', e && e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  router.post('/register/verify', requireAuth, async (req, res) => {
    try {
      if (isSynthetic(req)) return res.status(400).json({ error: 'Not available for this session' });
      const { challenge_id: challengeId, response } = req.body || {};
      const row = passkeys.consumeChallenge(challengeId, { purpose: 'register', userId: req.user.id });
      if (!row) return res.status(400).json({ error: 'That request has expired. Try again.', code: 'challenge_expired' });
      const rp = passkeys.rpConfig(req);
      if (!rp.enabled) return unavailable(res, rp);
      // The address the ceremony started on must still be this server's address.
      if (rp.rpID !== row.rp_id || rp.origin !== row.origin) return res.status(400).json({ error: 'Passkey could not be verified.', code: 'passkey_failed' });
      const user = loadLocalUser(req.user.id);
      if (!user) return res.status(400).json({ error: 'Passkeys are only for password accounts.' });
      if (ssoRefusal(user)) return res.status(403).json(ssoRequiredBody);
      if (!response || typeof response !== 'object') return res.status(400).json({ error: 'response required' });

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: row.challenge,
          expectedOrigin: row.origin,
          expectedRPID: row.rp_id,
          requireUserVerification: true,
        });
      } catch (e) {
        console.warn('[passkeys] registration rejected:', e && e.message);
        return res.status(400).json({ error: 'Passkey could not be verified.', code: 'passkey_failed' });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Passkey could not be verified.', code: 'passkey_failed' });
      }
      if (passkeys.countForUser(user.id) >= passkeys.MAX_PER_USER) {
        return res.status(409).json({ error: `You already have ${passkeys.MAX_PER_USER} passkeys. Remove one first.`, code: 'passkey_limit' });
      }
      if (passkeys.findByCredentialId(verification.registrationInfo.credential.id)) {
        return res.status(409).json({ error: 'That passkey is already registered.', code: 'passkey_exists' });
      }
      const name = passkeys.cleanName(req.body.name) || 'Passkey';
      const id = passkeys.insertCredential({
        userId: user.id, info: verification.registrationInfo, userHandle: row.user_handle, name, rpID: row.rp_id,
      });
      /*
       * ⚠️ NO token_version BUMP ON ADD, unlike enabling TOTP. Enabling TOTP raises the bar for
       * signing in, so sessions that never cleared it are ended. Adding a passkey raises nothing —
       * the password still works exactly as before — so ending the user's other devices would be
       * a cost with no security return. REMOVING one does bump (below).
       */
      auditFromReq(req, 'auth:passkey_added', { passkey_id: id, name, rp_id: row.rp_id });
      res.json({ ok: true, passkey: passkeys.listForUser(user.id).find((p) => p.id === id) });
    } catch (e) {
      console.error('[passkeys] register/verify failed:', e && e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  router.patch('/:id', requireAuth, (req, res) => {
    if (isSynthetic(req)) return res.status(400).json({ error: 'Not available for this session' });
    const name = passkeys.cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name required' });
    // Scoped to the caller's own rows: someone else's id is simply "not found".
    const r = db.prepare('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?').run(name, String(req.params.id), req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Passkey not found' });
    auditFromReq(req, 'auth:passkey_renamed', { passkey_id: String(req.params.id), name });
    res.json({ ok: true });
  });

  /*
   * Removing a passkey ENDS EVERY OTHER SESSION (token_version), and this one carries on with a new
   * token. The usual reason to remove one is that the device holding it is lost, sold or stolen —
   * and that device is very likely still signed in. Without the bump, "remove the passkey from my
   * stolen laptop" would leave the laptop's session running.
   */
  router.delete('/:id', requireAuth, (req, res) => {
    if (isSynthetic(req)) return res.status(400).json({ error: 'Not available for this session' });
    const row = db.prepare('SELECT id, name FROM webauthn_credentials WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
    if (!row) return res.status(404).json({ error: 'Passkey not found' });
    db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(row.id, req.user.id);
    bumpTokenVersion(req.user.id);
    auditFromReq(req, 'auth:passkey_removed', { passkey_id: row.id, name: row.name });
    res.json({ ok: true, token: generateToken(req.user, req.jwtWorkspaceId || null, { authTime: req.authTime }) });
  });

  // ---------------------------------------------------------------------------------------------
  // Signing in
  // ---------------------------------------------------------------------------------------------

  /*
   * Verify one assertion against one stored credential. Every failure is caught and reported as
   * `false`; a counter that went BACKWARDS is audited on its own, because it is the one failure
   * that says something about the authenticator rather than the request: two devices answering
   * with the same key (a cloned security key). Per the library's guidance a regression is refused.
   * Synced passkeys report a counter of 0 every time, which the library correctly does not treat
   * as a regression.
   */
  async function verifyAssertion(req, { response, challengeRow, cred, requireUV }) {
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: challengeRow.origin,
        expectedRPID: challengeRow.rp_id,
        credential: passkeys.toLibraryCredential(cred),
        requireUserVerification: requireUV,
      });
      if (!v.verified) return false;
      passkeys.markUsed(cred.id, { newCounter: v.authenticationInfo.newCounter, backedUp: v.authenticationInfo.credentialBackedUp });
      return true;
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/counter/i.test(msg)) {
        console.warn(`[passkeys] signature counter went backwards for passkey ${cred.id} (user ${cred.user_id}) - possible cloned authenticator; refused`);
        audit('auth:passkey_counter_regression', {
          userId: cred.user_id, ip: getClientIp(req), details: { passkey_id: cred.id, name: cred.name },
        });
      }
      return false;
    }
  }

  function challengeStillValid(req, row) {
    const rp = passkeys.rpConfig(req);
    return rp.enabled && rp.rpID === row.rp_id && rp.origin === row.origin;
  }

  router.post('/login/options', async (req, res) => {
    try {
      const rp = passkeys.rpConfig(req);
      if (!rp.enabled) return unavailable(res, rp);
      // No allowCredentials: the authenticator offers whichever passkeys it holds for this site, so
      // nothing about which accounts exist is sent to an unauthenticated caller.
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: TIMEOUT_MS });
      const challengeId = passkeys.storeChallenge({ challenge: options.challenge, purpose: 'login', rp });
      res.json({ challenge_id: challengeId, options });
    } catch (e) {
      console.error('[passkeys] login/options failed:', e && e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  router.post('/login/verify', async (req, res) => {
    try {
      const { challenge_id: challengeId, response } = req.body || {};
      const ip = getClientIp(req);
      // Spent FIRST, before anything about the response is looked at — see consumeChallenge.
      const row = passkeys.consumeChallenge(challengeId, { purpose: 'login' });
      if (!row) return signInFailed(res, 'challenge_expired');
      if (!challengeStillValid(req, row)) return signInFailed(res);
      if (!response || typeof response !== 'object' || typeof response.id !== 'string') return signInFailed(res);

      const cred = passkeys.findByCredentialId(response.id);
      if (!cred) { logFailedLogin('(passkey)', ip, 'Unknown passkey'); return signInFailed(res); }
      // A discoverable sign-in names its account through the user handle; it must be the handle
      // this credential was registered with, or the response is not what it claims to be.
      const handle = response.response && response.response.userHandle;
      if (typeof handle !== 'string' || handle !== cred.user_handle) {
        logFailedLogin('(passkey)', ip, 'Passkey user handle mismatch');
        return signInFailed(res);
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(cred.user_id);
      if (!user || user.auth_provider !== 'local') { logFailedLogin('(passkey)', ip, 'Passkey account unavailable'); return signInFailed(res); }

      if (!(await verifyAssertion(req, { response, challengeRow: row, cred, requireUV: true }))) {
        logFailedLogin(user.email, ip, 'Passkey verification failed');
        return signInFailed(res);
      }

      // Policy AFTER the signature: only the holder of the passkey learns what the policy says.
      if (ssoRefusal(user)) {
        logFailedLogin(user.email, ip, 'Passkey login refused: organization requires SSO');
        return res.status(403).json(ssoRequiredBody);
      }
      // Deactivated by the organization's identity provider (SCIM): the same refusal, and the same
      // answer, as a password login (see POST /login) — said only after the signature is proven.
      if (user.disabled_at) {
        logFailedLogin(user.email, ip, 'Account deactivated by its organization');
        return res.status(403).json({ error: 'This account has been deactivated by your organization.', code: 'account_disabled' });
      }
      // Same email-verification gate as a password login (see POST /login).
      if (!user.email_verified && emailSvc.isConfigured()) {
        ensureVerificationEmail(user, req);
        if (!config.selfHosted) return res.json({ verification_required: true, email: user.email });
      }
      /*
       * ⚠️ NO TOTP STEP AFTER A PASSKEY, by design. Registration and sign-in both REQUIRE user
       * verification, so a passkey sign-in is already two factors: the device (possession) and its
       * PIN or biometric (knowledge/inherence) — and, unlike a password + code, it cannot be phished,
       * because the browser will not produce it for any other origin. Asking for a TOTP code on top
       * would add friction and no protection.
       */
      audit('auth:passkey_login', { userId: user.id, ip, details: { passkey_id: cred.id, name: cred.name } });
      issueSession(req, res, user, { via_passkey: true });
    } catch (e) {
      console.error('[passkeys] login/verify failed:', e && e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  /*
   * A passkey in place of the TOTP code. Reachable only with the mfa_pending token a CORRECT
   * PASSWORD earned, and only for that token's own account: allowCredentials lists that account's
   * passkeys, the challenge is bound to the account, and a credential belonging to anybody else is
   * refused even if its signature is perfect. Failures share the TOTP lockout, so codes and
   * passkey attempts draw from one budget.
   */
  function mfaUser(req, res) {
    const token = req.body && req.body.mfa_token;
    if (!token) { res.status(400).json({ error: 'mfa_token required' }); return null; }
    let decoded;
    try { decoded = verifyMfaPendingToken(token); } catch { res.status(401).json({ error: 'mfa session expired' }); return null; }
    if (!decoded.mfa_pending || !decoded.id) { res.status(401).json({ error: 'invalid mfa token' }); return null; }
    if (totpLockout.isLocked(decoded.id)) { res.status(429).json({ error: 'Too many invalid codes. Try again later.' }); return null; }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user || !user.totp_enabled) { res.status(401).json({ error: 'invalid mfa token' }); return null; }
    return user;
  }

  router.post('/mfa/options', async (req, res) => {
    try {
      const user = mfaUser(req, res);
      if (!user) return;
      const rp = passkeys.rpConfig(req);
      if (!rp.enabled) return unavailable(res, rp);
      const allow = passkeys.descriptorsForUser(user.id);
      if (!allow.length) return res.status(404).json({ error: 'No passkeys on this account.', code: 'no_passkeys' });
      // 'preferred': here the passkey is the SECOND factor after a password, so possession is what
      // is being proven; a security key without a PIN is a perfectly good second factor.
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, allowCredentials: allow, userVerification: 'preferred', timeout: TIMEOUT_MS });
      const challengeId = passkeys.storeChallenge({ challenge: options.challenge, purpose: 'mfa', userId: user.id, rp });
      res.json({ challenge_id: challengeId, options });
    } catch (e) {
      console.error('[passkeys] mfa/options failed:', e && e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  router.post('/mfa/verify', async (req, res) => {
    try {
      const user = mfaUser(req, res);
      if (!user) return;
      const ip = getClientIp(req);
      const { challenge_id: challengeId, response } = req.body || {};
      const fail = (reason, code) => {
        totpLockout.recordFailure(user.id);
        logFailedLogin(user.email, ip, reason);
        return signInFailed(res, code);
      };
      const row = passkeys.consumeChallenge(challengeId, { purpose: 'mfa', userId: user.id });
      if (!row) return fail('Passkey second factor: challenge invalid or expired', 'challenge_expired');
      if (!challengeStillValid(req, row)) return fail('Passkey second factor: server address changed');
      if (!response || typeof response !== 'object' || typeof response.id !== 'string') return fail('Passkey second factor: malformed response');
      const cred = passkeys.findByCredentialId(response.id);
      // ⚠️ Another account's passkey is refused here, signature or not.
      if (!cred || cred.user_id !== user.id) return fail('Passkey second factor: not this account\'s passkey');
      if (!(await verifyAssertion(req, { response, challengeRow: row, cred, requireUV: false }))) {
        return fail('Passkey second factor: verification failed');
      }
      totpLockout.reset(user.id);
      // Deactivated after the password step: the same refusal as /login/verify, after the signature.
      if (user.disabled_at) {
        logFailedLogin(user.email, ip, 'Account deactivated by its organization');
        return res.status(403).json({ error: 'This account has been deactivated by your organization.', code: 'account_disabled' });
      }
      audit('auth:passkey_login', { userId: user.id, ip, details: { passkey_id: cred.id, name: cred.name, second_factor: true } });
      issueSession(req, res, user, { via_passkey: true });
    } catch (e) {
      console.error('[passkeys] mfa/verify failed:', e && e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  return router;
};
