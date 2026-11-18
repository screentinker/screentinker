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

// Record one failed claim from an IP; trip the lockout once MAX_FAILS is reached. Failures older
// than LOCKOUT_MS are forgotten, so a long rollout's occasional typo never adds up to a lockout.
function recordFailure(ip, now = Date.now()) {
  const rec = failures.get(ip) || { count: 0, lockedUntil: 0, firstAt: now };
  if (!rec.firstAt || now - rec.firstAt > LOCKOUT_MS) { rec.count = 0; rec.firstAt = now; }
  rec.count += 1;
  if (rec.count >= MAX_FAILS) { rec.lockedUntil = now + LOCKOUT_MS; rec.count = 0; }
  failures.set(ip, rec);
  return rec;
}

// Clears an IP's record outright. Tests and operator tooling only: a successful claim must NOT call
// this. Pairing a code of one's own is free (provision a code, claim it), so a success that wiped the
// count let a guesser interleave one decoy claim per four guesses and never lock.
function reset(ip) { failures.delete(ip); }

// A successful claim forgives ONE earlier failure: a person who mistyped and then got it right is
// even again, but a decoy success buys a guesser one extra try, not a clean slate.
function noteSuccess(ip) {
  const rec = failures.get(ip);
  if (rec && rec.count > 0) rec.count -= 1;
}

// A provisioning code is stale once the device has not been seen for longer than the TTL.
//
// The caller passes a LIVENESS timestamp (devices.last_heartbeat, falling back to
// created_at for a row that has never checked in) — NOT the row's creation time. A player
// keeps its device_id and its code across restarts and re-registers with them forever, so
// created_at never advances; keying on it made a still-connected screen permanently
// unpairable 15 minutes after first boot. See the comment at the call site in server.js.
function isCodeExpired(lastSeenSec, now = Date.now()) {
  return Math.floor(now / 1000) - lastSeenSec > PAIRING_TTL_SEC;
}

// What the operator is told when a code is refused as expired. It says what actually helps: the
// code comes back to life as soon as its screen checks in again. It used to say "restart the
// display to get a new code", which cannot work — a restart re-registers with the same stored
// identity and shows the same code.
const CODE_EXPIRED_MESSAGE = 'Pairing code expired - this screen has not been online for over 15 minutes. '
  + 'Make sure it is on and connected to the internet, then type the code again';

module.exports = { isLocked, recordFailure, reset, noteSuccess, isCodeExpired, MAX_FAILS, LOCKOUT_MS, PAIRING_TTL_SEC, CODE_EXPIRED_MESSAGE };
