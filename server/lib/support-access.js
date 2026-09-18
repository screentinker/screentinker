'use strict';

/*
 * Support access: how ScreenTinker staff get into a customer's self-hosted instance — with the
 * customer's say-so, for a bounded time, revocably, and on the record.
 *
 * The login page has had a "Support Access — paste support token" field, and Settings a token
 * generator, since the first open-source release. Neither ever had a server behind it: both
 * endpoints 404'd. This is that server, built around one rule:
 *
 *   ⚠️ A KEY WE HOLD MUST NOT BE A KEY TO EVERY INSTALL.
 *
 * The obvious design — we sign a token with our private key, every install carries the public
 * key and lets the bearer in — is a vendor backdoor. Anyone holding (or stealing) that one key
 * could log into every self-hosted ScreenTinker on the internet, and nothing on the customer's
 * side would have to happen first. For a product whose whole pitch to self-hosters is that they
 * own their data, that is disqualifying, however convenient.
 *
 * So the token is only half of it. The customer's instance mints a REQUEST CODE first (an admin
 * clicks "Request support access" in Settings), and a support token is only honoured if it names
 * an outstanding request code from THIS instance. The signature proves the token came from us;
 * the request code proves the customer asked. Without a fresh code from the customer our key
 * mints nothing usable anywhere. That is the same shape as a bank's "read me the code on your
 * screen" — consent is a secret the customer generates, not a claim we make.
 *
 * Once redeemed, the session follows lib/recovery-grant exactly: a synthetic identity in the
 * session JWT, honoured only while a grant row exists. DELETE revokes it (the very next request
 * fails), SELECT enumerates it, expires_at bounds it, and the audit log records who asked, what
 * was issued, when it was redeemed and from where. The identity is a `platform_operator` (#13):
 * cross-org read/write for actually fixing things, and NONE of the owner powers — no user or
 * role management, no billing, no deleting orgs or workspaces, no branding. Any owner endpoint
 * added later is denied to it automatically.
 *
 * Token format — deliberately NOT a JWT. `STSUP1.<payload>.<sig>`, Ed25519 over the prefix and
 * payload, no algorithm field to confuse, and unmistakable as a session token to a human or a
 * log grep. jsonwebtoken (the version pinned here) cannot sign EdDSA anyway.
 *
 * Key handling. The PUBLIC key below ships with every install; the PRIVATE key exists only on the
 * instance that issues tokens (SUPPORT_SIGNING_KEY_FILE) — the hosted one. A self-hoster who runs
 * their own support desk, or simply does not want ours, sets SUPPORT_PUBLIC_KEY to a key of their
 * own and our tokens verify nowhere on their install. scripts/support-keygen.js makes a pair.
 */

const crypto = require('crypto');
const fs = require('fs');
const { db } = require('../db/database');

const TOKEN_PREFIX = 'STSUP1';
const ISSUER = 'screentinker-support';

/** The ScreenTinker support desk's Ed25519 public key. Overridable, see module comment. */
const SUPPORT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1LKETrhl1hnim3ODTBeEh4kzmYSO6egfcYJnsr9rVO0=
-----END PUBLIC KEY-----
`;

const REQUEST_TTL_SEC = 24 * 3600;    // how long a request code waits for a token
const MIN_HOURS = 1;
const MAX_HOURS = 72;                 // a support session is hours, never a standing account
const DEFAULT_HOURS = 4;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

let cachedPublicKey = null;
function publicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  const pem = (process.env.SUPPORT_PUBLIC_KEY || SUPPORT_PUBLIC_KEY_PEM).replace(/\\n/g, '\n');
  cachedPublicKey = crypto.createPublicKey(pem);
  if (cachedPublicKey.asymmetricKeyType !== 'ed25519') throw new Error('support public key must be Ed25519');
  return cachedPublicKey;
}

/**
 * The issuing key, or null when this instance does not issue tokens (every self-hosted install).
 * Read on each call so a key dropped in after boot is picked up, and a removed one stops issuing.
 */
function signingKey() {
  const file = process.env.SUPPORT_SIGNING_KEY_FILE;
  if (!file) return null;
  let pem;
  try { pem = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('support signing key must be Ed25519');
  return key;
}

function canIssue() {
  try { return !!signingKey(); } catch (_) { return false; }
}

/** For tests and diagnostics: forget the cached public key so an env override takes effect. */
function _resetKeyCache() { cachedPublicKey = null; }

// ---------------------------------------------------------------------------
// Request codes — the customer's half
// ---------------------------------------------------------------------------

// Crockford-style base32 without the look-alikes (0/O, 1/I/L), so the code survives being read
// out over the phone. 16 symbols = 80 bits: far past guessing within a 24h window under the
// per-IP limiter, and still short enough to type.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
function newRequestCode() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s.match(/.{4}/g).join('-');
}

/** Accept what a human typed: any case, with or without the dashes/spaces. */
function normaliseRequestCode(code) {
  if (typeof code !== 'string') return null;
  const s = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 16 || /[^ABCDEFGHJKMNPQRSTVWXYZ23456789]/.test(s)) return null;
  return s.match(/.{4}/g).join('-');
}

/**
 * An admin asks for support. Returns { code, expiresAt }. The code is what they send us; it is
 * also what makes any token we then mint valid on this instance and nowhere else.
 */
function createRequest({ requestedBy = null, note = null, ttlSec = REQUEST_TTL_SEC } = {}) {
  const code = newRequestCode();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  db.prepare('INSERT INTO support_requests (code, expires_at, requested_by, note) VALUES (?, ?, ?, ?)')
    .run(code, expiresAt, requestedBy, note);
  return { code, expiresAt };
}

function listOpenRequests(now = Math.floor(Date.now() / 1000)) {
  return db.prepare(
    'SELECT code, created_at, expires_at, requested_by, note FROM support_requests WHERE redeemed_at IS NULL AND expires_at > ? ORDER BY created_at DESC'
  ).all(now);
}

function cancelRequest(code) {
  const c = normaliseRequestCode(code);
  if (!c) return 0;
  return db.prepare('DELETE FROM support_requests WHERE code = ? AND redeemed_at IS NULL').run(c).changes;
}

// ---------------------------------------------------------------------------
// Tokens — our half
// ---------------------------------------------------------------------------

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

/**
 * Mint a support token against a customer's request code. Only the issuing instance can do this.
 * Returns { token, jti, expiresAt }.
 */
function issueToken({ requestCode, org, hours = DEFAULT_HOURS, reason = null, issuedBy = null } = {}) {
  const key = signingKey();
  if (!key) throw new Error('support token signing is not configured on this instance');
  const req = normaliseRequestCode(requestCode);
  if (!req) throw new Error('a valid support request code from the customer is required');
  const h = Math.min(MAX_HOURS, Math.max(MIN_HOURS, parseInt(hours, 10) || DEFAULT_HOURS));
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    iss: ISSUER,
    sub: String(org || 'Customer').slice(0, 120),
    req,
    reason: reason ? String(reason).slice(0, 200) : null,
    by: issuedBy ? String(issuedBy).slice(0, 120) : null,
    jti: crypto.randomBytes(16).toString('hex'),
    iat,
    exp: iat + h * 3600,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(`${TOKEN_PREFIX}.${body}`), key);
  return { token: `${TOKEN_PREFIX}.${body}.${b64u(sig)}`, jti: payload.jti, expiresAt: payload.exp };
}

/**
 * Check a token's signature and shape. Does NOT consult the database — that is redeem()'s job.
 * Returns the payload, or throws with a short, non-leaky message.
 */
function verifyToken(token, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('invalid support token');
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) throw new Error('invalid support token');
  const [, body, sig] = parts;
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(`${TOKEN_PREFIX}.${body}`), publicKey(), Buffer.from(sig, 'base64url'));
  } catch (_) { ok = false; }
  if (!ok) throw new Error('support token signature is invalid');
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { throw new Error('invalid support token'); }
  if (!p || p.v !== 1 || p.iss !== ISSUER || typeof p.jti !== 'string' || typeof p.req !== 'string') throw new Error('invalid support token');
  if (!Number.isInteger(p.exp) || p.exp <= now) throw new Error('support token has expired');
  if (Number.isInteger(p.iat) && p.iat > now + 300) throw new Error('support token is not valid yet');
  return p;
}

/**
 * The customer's instance accepts a token: signature good, names one of OUR open request codes,
 * not yet used. Consumes the request and records a grant. Returns the grant, or throws.
 *
 * All in one transaction so two redemptions of the same token cannot both succeed.
 */
function redeemToken(token, { sourceIp = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const p = verifyToken(token, now);
  return db.transaction(() => {
    const req = db.prepare('SELECT code, expires_at, redeemed_at FROM support_requests WHERE code = ?').get(p.req);
    // One message for "never asked", "cancelled", "expired" and "already used": a caller holding a
    // token but no live request learns nothing about which it is.
    if (!req || req.redeemed_at || req.expires_at <= now) throw new Error('support token does not match an open support request on this instance');
    if (db.prepare('SELECT 1 FROM support_grants WHERE jti = ?').get(p.jti)) throw new Error('support token has already been used');
    db.prepare('UPDATE support_requests SET redeemed_at = ?, redeemed_jti = ? WHERE code = ?').run(now, p.jti, p.req);
    db.prepare('INSERT INTO support_grants (jti, request_code, org, reason, issued_by, expires_at, source_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.jti, p.req, p.sub, p.reason, p.by, p.exp, sourceIp);
    return { jti: p.jti, org: p.sub, reason: p.reason, issuedBy: p.by, expiresAt: p.exp, requestCode: p.req };
  })();
}

// ---------------------------------------------------------------------------
// Grants — the live session, mirroring lib/recovery-grant
// ---------------------------------------------------------------------------

/**
 * Is this support session still good? Checked on EVERY request by resolveSessionUser, which is
 * what makes revocation immediate. Stamps first use like a recovery grant.
 */
function grantActive(jti, { sourceIp = null, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!jti || typeof jti !== 'string') return false;
  const row = db.prepare('SELECT jti, expires_at, first_used_at FROM support_grants WHERE jti = ?').get(jti);
  if (!row) return false;                 // never redeemed here, or revoked
  if (row.expires_at <= now) return false;
  if (!row.first_used_at) {
    db.prepare('UPDATE support_grants SET first_used_at = ?, source_ip = COALESCE(source_ip, ?) WHERE jti = ? AND first_used_at IS NULL')
      .run(now, sourceIp, jti);
  }
  return true;
}

function listActiveGrants(now = Math.floor(Date.now() / 1000)) {
  return db.prepare(
    'SELECT jti, request_code, org, reason, issued_by, created_at, first_used_at, expires_at, source_ip FROM support_grants WHERE expires_at > ? ORDER BY created_at DESC'
  ).all(now);
}

function revokeGrant(jti) { return db.prepare('DELETE FROM support_grants WHERE jti = ?').run(jti).changes; }
function revokeAllGrants() { return db.prepare('DELETE FROM support_grants').run().changes; }

/** Housekeeping only; every reader already refuses expired rows. */
function pruneExpired(now = Math.floor(Date.now() / 1000), graceSec = 30 * 86400) {
  const a = db.prepare('DELETE FROM support_requests WHERE expires_at < ?').run(now - graceSec).changes;
  const b = db.prepare('DELETE FROM support_grants WHERE expires_at < ?').run(now - graceSec).changes;
  return a + b;
}

/** The synthetic identity a support session runs as. Not a users row; see module comment. */
function supportUser(decoded) {
  return {
    id: decoded.id,
    email: 'support@screentinker.com',
    name: `ScreenTinker Support${decoded.by ? ` (${decoded.by})` : ''}`,
    role: 'platform_operator',
    auth_provider: 'support',
    avatar_url: null,
    plan_id: 'enterprise',
  };
}

module.exports = {
  TOKEN_PREFIX, ISSUER, SUPPORT_PUBLIC_KEY_PEM, REQUEST_TTL_SEC, MIN_HOURS, MAX_HOURS, DEFAULT_HOURS,
  publicKey, signingKey, canIssue, _resetKeyCache,
  newRequestCode, normaliseRequestCode, createRequest, listOpenRequests, cancelRequest,
  issueToken, verifyToken, redeemToken,
  grantActive, listActiveGrants, revokeGrant, revokeAllGrants, pruneExpired, supportUser,
};
