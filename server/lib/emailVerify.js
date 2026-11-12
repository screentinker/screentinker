'use strict';

// Signup email-verification tokens. The emailed token is random and stored ONLY as a
// SHA-256 hash (single-use, same discipline as recovery codes / api tokens) — the
// plaintext lives just in the email link. One pending token per user, kept on the users
// row (email_verify_hash + email_verify_expires), so a resend simply overwrites the old.

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

// Consume a token: mark the matching user verified + clear the token. Returns the user id on
// success, else null (unknown / expired / already-used). Single-use — the hash is cleared.
function consume(token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT id, email_verify_expires FROM users WHERE email_verify_hash = ?')
    .get(hashToken(token));
  if (!row) return null;
  if (!row.email_verify_expires || row.email_verify_expires < Math.floor(Date.now() / 1000)) return null;
  db.prepare("UPDATE users SET email_verified = 1, email_proven = 1, email_verify_hash = NULL, email_verify_expires = NULL, updated_at = strftime('%s','now') WHERE id = ?")
    .run(row.id);
  return row.id;
}

module.exports = { issue, consume, TTL_SEC };
