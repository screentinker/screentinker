'use strict';

// #100 (tightening #2): brute-force lockout for POST /api/auth/totp/verify. A 6-digit
// code is only 1e6 wide, and an attacker who has the password already holds a valid
// mfa_pending token - the verify endpoint is the real attack surface. Lock a key
// (the mfa_pending user id) after MAX_FAILS bad codes, on top of the per-route 10/min
// rate-limit. Same shape as lib/pair-lockout.js (#87). In-memory; resets on restart.

const MAX_FAILS = 5;                  // consecutive bad codes before lockout
const LOCKOUT_MS = 15 * 60 * 1000;    // how long the key is then blocked

const failures = new Map(); // key -> { count, lockedUntil }

function isLocked(key, now = Date.now()) {
  const rec = failures.get(key);
  return !!(rec && rec.lockedUntil > now);
}

function recordFailure(key, now = Date.now()) {
  const rec = failures.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) { rec.lockedUntil = now + LOCKOUT_MS; rec.count = 0; }
  failures.set(key, rec);
  return rec;
}

// A successful verify (or any reason to forgive) clears the key.
function reset(key) { failures.delete(key); }

module.exports = { isLocked, recordFailure, reset, MAX_FAILS, LOCKOUT_MS };
