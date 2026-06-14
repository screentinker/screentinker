'use strict';

// #100: TOTP (RFC 6238) helper. The shared secret is REVERSIBLE (the server must
// recompute codes), so it's stored via secretbox (AES-256-GCM) - NOT hashed like the
// API token / recovery codes. Recovery codes ARE hashed (SHA-256, same discipline as
// api_tokens) - see generateRecoveryCodes / hashRecoveryCode.

const { authenticator } = require('otplib');
const crypto = require('crypto');
const secretbox = require('./secretbox');
const { hashToken } = require('../middleware/apiToken');

const STEP_SEC = 30;
const ISSUER = 'ScreenTinker';
authenticator.options = { window: 1 }; // accept ±1 step (±30s) for clock skew

function generateSecret() { return authenticator.generateSecret(); }            // base32 plaintext
function keyuri(email, secret) { return authenticator.keyuri(email, ISSUER, secret); } // otpauth:// for the QR
function encryptSecret(secret) { return secretbox.encrypt(secret); }            // for storage
function decryptSecret(enc) { return secretbox.decrypt(enc); }                  // for verification

function currentStep(now = Date.now()) { return Math.floor(now / 1000 / STEP_SEC); }

// Verify a 6-digit code against the PLAINTEXT secret, blocking intra-window replay
// via lastStep. Returns the matched step (always > lastStep) on success, else null.
// The caller persists the returned step as the user's new totp_last_step.
function verifyCode(token, secret, lastStep = 0, now = Date.now()) {
  if (!secret || !/^[0-9]{6}$/.test(String(token || '').trim())) return null;
  const delta = authenticator.checkDelta(String(token).trim(), secret); // -1|0|1 or null
  if (delta == null) return null;
  const step = currentStep(now) + delta;
  if (step <= lastStep) return null; // a code from an already-consumed step (replay)
  return step;
}

// 10 single-use recovery codes. Returns plaintext (shown ONCE) + SHA-256 hashes (stored).
function generateRecoveryCodes(n = 10) {
  const plain = [], hashes = [];
  for (let i = 0; i < n; i++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    plain.push(code);
    hashes.push(hashToken(code));
  }
  return { plain, hashes };
}

// Normalize user input (strip spaces/hyphens, uppercase) then hash, so a code typed
// with stray formatting still matches the stored hash.
function hashRecoveryCode(input) {
  return hashToken(String(input || '').toUpperCase().replace(/[^0-9A-F]/g, ''));
}

module.exports = {
  generateSecret, keyuri, encryptSecret, decryptSecret,
  verifyCode, currentStep, generateRecoveryCodes, hashRecoveryCode, STEP_SEC,
};
