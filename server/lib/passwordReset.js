'use strict';

// Self-service password-reset tokens. Deliberately the same shape as lib/emailVerify.js:
// the emailed token is random, stored ONLY as a SHA-256 hash (single-use, same discipline
// as recovery codes and api tokens), with the plaintext living just in the email link. One
// pending token per user on the users row, so re-requesting overwrites the previous one.
//
// TTL is much shorter than email verification's 24h: this token changes a credential, so
// the window in which a leaked link is useful should be small.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db/database');
const { hashToken } = require('../middleware/apiToken');

const TTL_SEC = 60 * 60;        // 1 hour
// A NEW account's set-password link (routes/admin.js, hosted creates). Longer because it is an
// invitation people open the next day, and safer to give a week: the account has no password and
// nothing in it yet, so a leaked link opens an empty account, not someone's established one. Still
// single use, still overwritten by any later forgot-password request.
const INVITE_TTL_SEC = 7 * 24 * 60 * 60;   // 7 days
const MIN_PASSWORD_LENGTH = 8;  // same minimum as registration and PUT /api/auth/me

// Mint a token for a user, store its hash + expiry, return the PLAINTEXT (emailed once).
function issue(userId, { ttlSec = TTL_SEC } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  db.prepare('UPDATE users SET password_reset_hash = ?, password_reset_expires = ? WHERE id = ?')
    .run(hashToken(token), expires, userId);
  return token;
}

// Consume a token and set the new password. Returns the user id on success, else null
// (unknown / expired / already used). Single-use: the hash is cleared in the same statement
// that sets the password, and that UPDATE is conditioned on the hash still being present,
// so two concurrent redemptions cannot both win.
//
// Clears must_change_password too — the user has just chosen a password, which is exactly
// what that flag was demanding.
//
// And marks the address verified: the token only ever reaches a person through a link mailed to
// that address, so redeeming it proves the inbox as well as a verification link would. Without
// this, someone added on hosted (routes/admin.js POST /users, which mails only this link) set a
// password and was then stopped at login to confirm the same mailbox a second time. An
// outstanding verification link is left alone: redeeming it later is a harmless no-op.
function consume(token, newPassword) {
  if (!token || typeof token !== 'string') return null;
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) return null;
  const hash = hashToken(token);
  const row = db.prepare('SELECT id, password_reset_expires FROM users WHERE password_reset_hash = ?').get(hash);
  if (!row) return null;
  if (!row.password_reset_expires || row.password_reset_expires < Math.floor(Date.now() / 1000)) return null;
  const res = db.prepare(`UPDATE users SET password_hash = ?, password_reset_hash = NULL,
      password_reset_expires = NULL, must_change_password = 0, email_proven = 1, email_verified = 1, updated_at = strftime('%s','now')
    WHERE id = ? AND password_reset_hash = ?`).run(bcrypt.hashSync(newPassword, 10), row.id, hash);
  return res.changes === 1 ? row.id : null;
}

module.exports = { issue, consume, TTL_SEC, INVITE_TTL_SEC, MIN_PASSWORD_LENGTH };
