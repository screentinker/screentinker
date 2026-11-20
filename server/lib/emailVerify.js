'use strict';

// Signup email-verification tokens. The emailed token is random and stored ONLY as a
// SHA-256 hash (same discipline as recovery codes / api tokens) — the plaintext lives just in
// the email link. One pending token per user, kept on the users row (email_verify_hash +
// email_verify_expires), so a resend simply overwrites the old.
//
// ⚠️ #876: corporate mail filters (Defender Safe Links, Mimecast, Proofpoint) open links before
// the person does. So the link's GET only LOOKS (peek) and the confirm button's POST acts
// (consume). And a used token is not forgotten: it stays as a "used" marker until its expiry
// (email_verify_expires stored NEGATIVE), so a second click says "already verified" instead of
// an error. A used marker never verifies anything: it only answers for an account that IS
// verified, so a token from before an email change cannot verify the new address.

const crypto = require('crypto');
const { db } = require('../db/database');
const { hashToken } = require('../middleware/apiToken');

const TTL_SEC = 24 * 3600; // link valid for 24h

// Mint a fresh token for the user, store its hash + expiry, return the PLAINTEXT (emailed once).
function issue(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + TTL_SEC;
  db.prepare('UPDATE users SET email_verify_hash = ?, email_verify_expires = ? WHERE id = ?')
    .run(hashToken(token), expires, userId);
  return token;
}

/**
 * What a token is, WITHOUT changing anything (safe on GET).
 * 'valid'   - unused and unexpired: the confirm button will verify the account
 * 'already' - used before, and the account is verified: nothing left to do
 * 'invalid' - unknown, expired, or a used marker on an account that is not verified (any more)
 */
function peek(token) {
  if (!token || typeof token !== 'string') return { state: 'invalid' };
  const row = db.prepare('SELECT id, email_verified, email_verify_expires FROM users WHERE email_verify_hash = ?')
    .get(hashToken(token));
  if (!row || !row.email_verify_expires) return { state: 'invalid' };
  const now = Math.floor(Date.now() / 1000);
  if (row.email_verify_expires > 0) {
    return row.email_verify_expires >= now ? { state: 'valid', userId: row.id } : { state: 'invalid' };
  }
  // negative = used; the absolute value is the original expiry
  if (-row.email_verify_expires >= now && row.email_verified === 1) return { state: 'already', userId: row.id };
  return { state: 'invalid' };
}

/**
 * Redeem a token (POST only). Returns { id, already } or null.
 * A fresh token verifies the account and becomes a used marker; a used marker on a verified
 * account returns { already: true } and writes nothing.
 */
function consume(token) {
  const p = peek(token);
  if (p.state === 'already') return { id: p.userId, already: true };
  if (p.state !== 'valid') return null;
  const r = db.prepare(`UPDATE users SET email_verified = 1, email_proven = 1,
      email_verify_expires = -email_verify_expires, updated_at = strftime('%s','now')
    WHERE id = ? AND email_verify_hash = ? AND email_verify_expires > 0`)
    .run(p.userId, hashToken(token));
  if (!r.changes) {
    // Lost a race: a parallel click verified it first (-> already), or a resend replaced it (-> null).
    const again = peek(token);
    return again.state === 'already' ? { id: again.userId, already: true } : null;
  }
  return { id: p.userId, already: false };
}

module.exports = { issue, peek, consume, TTL_SEC };
