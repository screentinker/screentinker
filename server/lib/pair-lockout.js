'use strict';

// #87: brute-force hardening for device pairing. The 6-digit pairing code is generated
// client-side, so the server can't raise its entropy without a player change - but it can
// (a) lock out an IP after repeated failed claims and (b) expire stale provisioning codes
// so a code is not claimable indefinitely. Together with the 5/min rate-limit on
// /api/provision (#88), guessing the ~1M code space becomes infeasible (a locked-out IP
// gets ~5 tries per 15 min, and each code only lives 15 min).

const MAX_FAILS = 5;                 // consecutive failed claims from an IP before lockout
const LOCKOUT_MS = 15 * 60 * 1000;   // how long the IP is then blocked from /pair
const PAIRING_TTL_SEC = 15 * 60;     // how long a provisioning code stays claimable

const failures = new Map(); // ip -> { count, lockedUntil }

function isLocked(ip, now = Date.now()) {
  const rec = failures.get(ip);
  return !!(rec && rec.lockedUntil > now);
}

// Record one failed claim from an IP; trip the lockout once MAX_FAILS is reached.
function recordFailure(ip, now = Date.now()) {
  const rec = failures.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) { rec.lockedUntil = now + LOCKOUT_MS; rec.count = 0; }
  failures.set(ip, rec);
  return rec;
}

// A successful pair (or any reason to forgive an IP) clears its failure record.
function reset(ip) { failures.delete(ip); }

// A provisioning code is stale once it is older than the TTL (devices.created_at is the
// register time for a provisioning device).
function isCodeExpired(createdAtSec, now = Date.now()) {
  return Math.floor(now / 1000) - createdAtSec > PAIRING_TTL_SEC;
}

module.exports = { isLocked, recordFailure, reset, isCodeExpired, MAX_FAILS, LOCKOUT_MS, PAIRING_TTL_SEC };
