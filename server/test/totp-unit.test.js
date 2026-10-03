'use strict';

// #100 unit tests: the security-critical assertions that don't need a full server.
// The bite-test (#1) injects an in-memory db with a real user row so that REMOVING the
// mfa_pending rejection in requireAuth makes it go red (the pending token would then
// find the user and call next()).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { authenticator } = require('otplib');

// Inject the db BEFORE requiring middleware/auth so requireAuth queries this one.
const mem = new Database(':memory:');
mem.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT,
  auth_provider TEXT, avatar_url TEXT, plan_id TEXT, email_alerts INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0)`);
mem.prepare("INSERT INTO users (id,email,name,role,auth_provider) VALUES ('u1','u1@x','U1','user','local')").run();
require.cache[require.resolve('../db/database')] = {
  id: require.resolve('../db/database'), loaded: true, exports: { db: mem },
};

const { requireAuth, generateMfaPendingToken, generateToken } = require('../middleware/auth');
const totp = require('../lib/totp');
const totpLockout = require('../lib/totp-lockout');

function runRequireAuth(token) {
  const req = { headers: { authorization: 'Bearer ' + token }, originalUrl: '/api/devices' };
  let status = 200, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  requireAuth(req, res, () => { nexted = true; });
  return { status, nexted, req };
}

test('#100 BITE: requireAuth rejects an mfa_pending token (no password-only session)', () => {
  const pending = runRequireAuth(generateMfaPendingToken({ id: 'u1' }));
  assert.equal(pending.status, 401, 'mfa_pending token must be 401');
  assert.equal(pending.nexted, false, 'must NOT call next() for an mfa_pending token');
  // Contrast: a FULL token for the SAME user passes - so the user EXISTS in the db,
  // which means removing the mfa_pending check would let the pending token through too
  // (next() called). That's what makes this a real bite-test, not a vacuous 401.
  const full = runRequireAuth(generateToken({ id: 'u1', email: 'u1@x', role: 'user' }, null));
  assert.equal(full.nexted, true, 'a full token for the same user must pass requireAuth');
  assert.equal(full.req.user.id, 'u1');
});

test('#100 lockout: locks after MAX_FAILS, lifts after the window, reset clears', () => {
  const k = 'user-' + crypto.randomUUID();
  for (let i = 0; i < totpLockout.MAX_FAILS - 1; i++) totpLockout.recordFailure(k, 1000);
  assert.equal(totpLockout.isLocked(k, 1000), false);
  totpLockout.recordFailure(k, 1000);
  assert.equal(totpLockout.isLocked(k, 1000), true, 'locked at MAX_FAILS');
  assert.equal(totpLockout.isLocked(k, 1000 + totpLockout.LOCKOUT_MS + 1), false, 'lifts after window');
  totpLockout.reset(k);
  assert.equal(totpLockout.isLocked(k, 1000), false, 'reset clears');
});

test('#100 replay: a TOTP code from an already-consumed step is rejected', () => {
  const secret = totp.generateSecret();
  const code = authenticator.generate(secret);
  const step = totp.currentStep();
  assert.equal(totp.verifyCode(code, secret, step - 1), step, 'fresh code accepted, returns the step');
  assert.equal(totp.verifyCode(code, secret, step), null, 'same code at the consumed step is blocked');
});

test('#100 key-mismatch is graceful: decrypt failure -> null (no throw); verifyCode tolerates null', () => {
  // If the secretbox key changes (rotated JWT_SECRET, non-persisted .jwt_secret), the
  // stored TOTP secret becomes undecryptable. That must degrade, not 500.
  assert.equal(totp.decryptSecret('!!!not-decryptable'), null, 'undecryptable -> null, not a throw');
  assert.doesNotThrow(() => totp.verifyCode('123456', null, 0), 'null secret must not throw on the login path');
  assert.equal(totp.verifyCode('123456', null, 0), null, 'null secret -> null (recovery path then handles it)');
});

test('#100 recovery codes: stored hashed, never plaintext; input normalized', () => {
  const { plain, hashes } = totp.generateRecoveryCodes(10);
  assert.equal(plain.length, 10);
  assert.equal(hashes.length, 10);
  assert.match(plain[0], /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/, 'plaintext is a 128-bit code, grouped in fours (shown once)');
  assert.match(hashes[0], /^[0-9a-f]{64}$/, 'stored value is a SHA-256 hash');
  assert.notEqual(plain[0], hashes[0], 'the stored value is not the plaintext');
  // typed with stray spaces/lowercase/re-grouping still matches the stored hash
  const raw = plain[0].replace(/[^0-9A-F]/g, '');
  const messy = ' ' + raw.toLowerCase().slice(0, 6) + ' ' + raw.toLowerCase().slice(6) + ' ';
  assert.equal(totp.hashRecoveryCode(messy), hashes[0], 'normalized input matches');
});

test('keyuri: bare issuer by default; folds the instance host in so multi-instance accounts are distinguishable', () => {
  const secret = totp.generateSecret();

  const plain = totp.keyuri('user@x.com', secret);
  assert.match(plain, /^otpauth:\/\/totp\//);
  assert.match(plain, /issuer=ScreenTinker(&|$)/, 'bare "ScreenTinker" issuer when no instance given');

  const scoped = totp.keyuri('user@x.com', secret, 'alpha.screentinker.com');
  const decoded = decodeURIComponent(scoped);
  assert.ok(decoded.includes('ScreenTinker (alpha.screentinker.com)'), 'issuer carries the host');
  assert.notEqual(scoped, plain, 'a different instance yields a different label');
});

test('recovery codes are 128-bit and round-trip through the grouped display', () => {
  const { plain, hashes } = totp.generateRecoveryCodes(10);
  assert.equal(plain.length, 10);
  assert.equal(hashes.length, 10);
  for (let i = 0; i < plain.length; i++) {
    assert.equal(plain[i].replace(/[^0-9A-F]/gi, '').length, 32, 'code carries 128 bits (32 hex)');
    assert.match(plain[i], /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/, 'shown grouped in fours');
    // A user typing the grouped code back must verify against the stored hash of the raw hex.
    assert.equal(totp.hashRecoveryCode(plain[i]), hashes[i], 'grouped code normalises to the stored hash');
  }
});

test('an older 40-bit recovery code still verifies (no lockout after the entropy bump)', () => {
  const { hashToken } = require('../middleware/apiToken');
  const oldCode = crypto.randomBytes(5).toString('hex').toUpperCase();   // the pre-bump 10-hex format
  const storedHash = hashToken(oldCode);                                 // exactly how it was stored
  // Verification is length-agnostic (hash the typed code, look the hash up), so a pre-bump code
  // already in the table keeps matching.
  assert.equal(totp.hashRecoveryCode(oldCode), storedHash, 'a 40-bit code still hashes to its stored value');
});
