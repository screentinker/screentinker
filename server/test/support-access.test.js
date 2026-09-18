'use strict';

// Support access: a key we hold must not be a key to every install.
//
// The token is signed by us and verified everywhere with an embedded public key — the obvious
// design, and on its own a vendor backdoor. What makes it not one is the request code: the
// customer's instance mints it, the token has to name it, and it is single-use. These tests pin
// that property first, then the grant lifecycle (revocable, bounded, attributable) that the
// session inherits from lib/recovery-grant.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-support-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-support-' + crypto.randomBytes(4).toString('hex');

// A test key pair, so nothing here depends on (or could ever mint with) the real support key.
const kp = crypto.generateKeyPairSync('ed25519');
const PRIV_FILE = path.join(TMP, 'signing.pem');
fs.writeFileSync(PRIV_FILE, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
process.env.SUPPORT_PUBLIC_KEY = kp.publicKey.export({ type: 'spki', format: 'pem' });
process.env.SUPPORT_SIGNING_KEY_FILE = PRIV_FILE;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('../lib/support-access');
const { db } = require('../db/database');
const { generateSupportSessionToken, resolveSessionUser } = require('../middleware/auth');

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// The property that matters
// ---------------------------------------------------------------------------
test('a validly signed token is REFUSED without an open request code from this instance', () => {
  // The customer never asked. Our signature is perfect. It must not get in.
  const { token } = support.issueToken({ requestCode: support.newRequestCode(), org: 'Nobody Asked Ltd' });
  assert.doesNotThrow(() => support.verifyToken(token), 'the signature itself is fine');
  assert.throws(() => support.redeemToken(token), /does not match an open support request/);
  assert.equal(support.listActiveGrants().length, 0, 'and no session came of it');
});

test('a token is single-use: the request code is consumed on first redemption', () => {
  const { code } = support.createRequest({ requestedBy: 'admin@customer' });
  const { token } = support.issueToken({ requestCode: code, org: 'Acme', hours: 2, reason: 'ticket 42', issuedBy: 'me@screentinker.com' });
  const grant = support.redeemToken(token, { sourceIp: '203.0.113.5' });
  assert.equal(grant.org, 'Acme');
  assert.equal(grant.reason, 'ticket 42');
  assert.equal(grant.issuedBy, 'me@screentinker.com');
  assert.throws(() => support.redeemToken(token), /does not match an open support request/, 'same token again: the code is spent');
  assert.equal(support.listOpenRequests().find((r) => r.code === code), undefined, 'the request is no longer open');
  // A SECOND token minted against the same (now spent) code is refused too.
  const again = support.issueToken({ requestCode: code, org: 'Acme' });
  assert.throws(() => support.redeemToken(again.token), /does not match an open support request/);
});

test('a cancelled or expired request code refuses the token', () => {
  const a = support.createRequest();
  support.cancelRequest(a.code);
  assert.throws(() => support.redeemToken(support.issueToken({ requestCode: a.code }).token), /does not match/);

  const b = support.createRequest({ ttlSec: 60 });
  const later = now() + 3600;
  // A token that is itself still valid, presented after the REQUEST lapsed.
  const t = support.issueToken({ requestCode: b.code, hours: 72 }).token;
  assert.throws(() => support.redeemToken(t, { now: later }), /does not match/);
});

test('a token signed by a different key, or tampered with, is refused before the database is consulted', () => {
  const { code } = support.createRequest();
  const other = crypto.generateKeyPairSync('ed25519');
  const payload = Buffer.from(JSON.stringify({ v: 1, iss: support.ISSUER, sub: 'Evil', req: code, jti: 'x'.repeat(32), iat: now(), exp: now() + 3600 })).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(`${support.TOKEN_PREFIX}.${payload}`), other.privateKey).toString('base64url');
  assert.throws(() => support.redeemToken(`${support.TOKEN_PREFIX}.${payload}.${sig}`), /signature is invalid/);

  const good = support.issueToken({ requestCode: code, hours: 1 }).token;
  const [p, body, s] = good.split('.');
  const bumped = JSON.parse(Buffer.from(body, 'base64url').toString());
  bumped.exp += 86400 * 30;
  const forged = `${p}.${Buffer.from(JSON.stringify(bumped)).toString('base64url')}.${s}`;
  assert.throws(() => support.redeemToken(forged), /signature is invalid/);
  assert.throws(() => support.verifyToken('eyJhbGciOiJIUzI1NiJ9.e30.x'), /invalid support token/, 'a JWT is not a support token');
  assert.throws(() => support.verifyToken(''), /invalid support token/);
  assert.throws(() => support.verifyToken(null), /invalid support token/);
  // The request code is still open: none of that consumed it.
  assert.ok(support.listOpenRequests().some((r) => r.code === code));
});

test('an expired token is refused even with an open request', () => {
  const { code } = support.createRequest();
  const { token } = support.issueToken({ requestCode: code, hours: 1 });
  assert.throws(() => support.redeemToken(token, { now: now() + 2 * 3600 }), /has expired/);
});

test('hours are clamped to a support window, never a standing account', () => {
  const { code } = support.createRequest();
  const p = support.verifyToken(support.issueToken({ requestCode: code, hours: 10000 }).token);
  assert.ok(p.exp - p.iat <= support.MAX_HOURS * 3600);
  const q = support.verifyToken(support.issueToken({ requestCode: support.createRequest().code, hours: 0 }).token);
  assert.ok(q.exp - q.iat >= support.MIN_HOURS * 3600);
});

test('request codes survive being read out: any case, with or without dashes', () => {
  const { code } = support.createRequest();
  const sloppy = code.toLowerCase().replace(/-/g, ' ');
  const { token } = support.issueToken({ requestCode: sloppy });
  assert.equal(support.verifyToken(token).req, code);
  assert.equal(support.normaliseRequestCode('ABCD-EFGH-JKMN-PQR0'), null, '0 is not in the alphabet');
  assert.equal(support.normaliseRequestCode('ABCD-EFGH-JKMN'), null, 'too short');
});

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------
test('a redeemed grant is a platform_operator session that lives exactly as long as the grant', () => {
  const { code } = support.createRequest();
  const grant = support.redeemToken(support.issueToken({ requestCode: code, org: 'Acme', hours: 3, issuedBy: 'me@screentinker.com' }).token);
  const jwt = generateSupportSessionToken(grant);
  const s = resolveSessionUser(jwt, { sourceIp: '198.51.100.7' });
  assert.equal(s.viaSupport, true);
  assert.equal(s.user.role, 'platform_operator', 'cross-org read/write, no owner powers (#13)');
  assert.equal(s.user.id, `support:${grant.jti}`);
  assert.match(s.user.name, /me@screentinker\.com/);
  const row = db.prepare('SELECT first_used_at, source_ip FROM support_grants WHERE jti = ?').get(grant.jti);
  assert.ok(row.first_used_at, 'first use is stamped');
  // The JWT's own expiry matches the grant's, to the minute.
  const decoded = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  assert.ok(Math.abs(decoded.exp - grant.expiresAt) <= 1);
});

test('revoking the grant ends the session on the very next request', () => {
  const { code } = support.createRequest();
  const grant = support.redeemToken(support.issueToken({ requestCode: code }).token);
  const jwt = generateSupportSessionToken(grant);
  assert.doesNotThrow(() => resolveSessionUser(jwt));
  assert.equal(support.revokeGrant(grant.jti), 1);
  assert.throws(() => resolveSessionUser(jwt), (e) => e.code === 'support_grant_invalid');
});

test('a support session JWT with no grant row is refused on the claim alone', () => {
  const jwt = generateSupportSessionToken({ jti: 'deadbeef'.repeat(4), expiresAt: now() + 3600 });
  assert.throws(() => resolveSessionUser(jwt), (e) => e.code === 'support_grant_invalid');
});

test('revokeAll clears every live session; listing shows what is outstanding', () => {
  const a = support.redeemToken(support.issueToken({ requestCode: support.createRequest().code }).token);
  const b = support.redeemToken(support.issueToken({ requestCode: support.createRequest().code }).token);
  const live = support.listActiveGrants().map((g) => g.jti);
  assert.ok(live.includes(a.jti) && live.includes(b.jti));
  assert.ok(support.revokeAllGrants() >= 2);
  assert.equal(support.listActiveGrants().length, 0);
});

test('an instance without the signing key cannot issue', () => {
  const saved = process.env.SUPPORT_SIGNING_KEY_FILE;
  delete process.env.SUPPORT_SIGNING_KEY_FILE;
  try {
    assert.equal(support.canIssue(), false);
    assert.throws(() => support.issueToken({ requestCode: support.createRequest().code }), /not configured/);
  } finally {
    process.env.SUPPORT_SIGNING_KEY_FILE = saved;
  }
  assert.equal(support.canIssue(), true);
});

test('the embedded public key is a well-formed Ed25519 key (the one every install trusts)', () => {
  const k = crypto.createPublicKey(support.SUPPORT_PUBLIC_KEY_PEM);
  assert.equal(k.asymmetricKeyType, 'ed25519');
});
