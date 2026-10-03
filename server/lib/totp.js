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
// otpauth:// URI for the QR. `instance` (the dashboard host, e.g. alpha.screentinker.com)
// is folded into the issuer so an authenticator app can tell apart accounts on more than
// one ScreenTinker — it shows "ScreenTinker (host)" instead of a bare, ambiguous "ScreenTinker".
function keyuri(email, secret, instance) {
  const issuer = instance ? `${ISSUER} (${instance})` : ISSUER;
  return authenticator.keyuri(email, issuer, secret);
}
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
//
// ⚠️ 128-BIT NOW (was 40-bit / 5 bytes). An unsalted SHA-256 of a 40-bit code is brute-forceable
// offline if totp_recovery_codes ever leaks, so the entropy is the whole defence and 40 bits is not
// enough. 16 bytes = 128 bits = 32 hex chars.
//
// ⚠️ OLDER ACCOUNTS ARE NOT LOCKED OUT. Their 40-bit codes are already stored as SHA-256 hashes, and
// verification (hashRecoveryCode -> hash lookup) is LENGTH-AGNOSTIC: it just hashes whatever the user
// types and looks the hash up, so a 10-hex code keeps matching its stored hash. Only newly-minted
// codes (at TOTP setup or a manual regenerate) are 128-bit; nothing forces an upgrade, so no printed
// code is invalidated.
//
// The plaintext is DISPLAYED grouped in fours for legibility, but the stored hash is of the RAW hex.
// hashRecoveryCode strips every non-hex char before hashing, so the grouped code the user types back
// normalises to the same raw hex and matches.
function generateRecoveryCodes(n = 10) {
  const plain = [], hashes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(16).toString('hex').toUpperCase(); // 32 hex chars, 128-bit
    plain.push(raw.replace(/(.{4})(?=.)/g, '$1-'));                    // shown as A1B2-C3D4-...
    hashes.push(hashToken(raw));                                       // hash the RAW hex
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
