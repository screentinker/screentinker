'use strict';

// Per-ACCOUNT brute-force lockout for POST /api/auth/login. Same shape as
// lib/totp-lockout.js (#100) and lib/pair-lockout.js (#87) — deliberately, so there is one
// recognisable lockout idiom in this codebase rather than three.
//
// WHY per-account and not just per-IP: the existing login throttle in server.js is keyed on
// the client IP, which is the right control for a single noisy source but bounds nothing
// against a distributed one — and IP attribution is only as good as the deployment's proxy
// configuration. A counter tied to the account being attacked is independent of where the
// attempts come from.
//
// KEYED ON user.id, never on the submitted email. The email is attacker-supplied and
// unbounded, so keying on it would let anyone grow this Map without limit — the same
// mistake this campaign fixed elsewhere. A user id only exists for a real account, so the
// key space is bounded by the user table and needs no eviction sweep (matching
// totp-lockout, which is bounded the same way).
//
// In-memory; resets on restart. That is a deliberate trade, not an oversight: a restart
// forgiving an in-progress lockout is preferable to persisting one, and the per-IP limiter
// still applies across restarts.

const MAX_FAILS = 10;                 // failed passwords before the account is locked
const LOCKOUT_MS = 15 * 60 * 1000;    // how long it is then locked

const failures = new Map(); // user.id -> { count, lockedUntil }

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

// Whole minutes left on a lock (at least 1 while locked), 0 when not locked.
function minutesLeft(key, now = Date.now()) {
  const rec = failures.get(key);
  if (!rec || rec.lockedUntil <= now) return 0;
  return Math.max(1, Math.ceil((rec.lockedUntil - now) / 60000));
}

// #472: the HTTP answer for a locked account has to stay identical to a wrong password (see
// auth.js), so the SERVER CONSOLE is where a locked-out operator finds out. activity_log alone
// was not enough: on a single-admin self-host, the one person who can read it is the one locked
// out, and "Invalid email or password" for the correct password looked like a broken reset.
// One line when the lock trips, then at most one a minute per account while attempts keep
// arriving, so an attack against one account cannot flood the log.
const LOG_EVERY_MS = 60 * 1000;
const lastLogged = new Map(); // user.id -> ms; bounded by the user table, like `failures`

function warnLocked(key, label, now = Date.now(), log = console.warn) {
  const last = lastLogged.get(key) || 0;
  if (now - last < LOG_EVERY_MS) return false;
  lastLogged.set(key, now);
  log(`[auth] Login for ${label} is LOCKED for ${minutesLeft(key, now)} more minute(s) after ` +
    `${MAX_FAILS} failed passwords. Every login answers "Invalid email or password" until then, ` +
    `even with the correct password. To clear it now: complete a password reset, or restart the server.`);
  return true;
}

// A correct password clears the key — including for accounts that then go on to a TOTP or
// email-verification step, since the password itself has been proven at that point.
function reset(key) { failures.delete(key); lastLogged.delete(key); }

module.exports = { isLocked, recordFailure, reset, minutesLeft, warnLocked, MAX_FAILS, LOCKOUT_MS };
