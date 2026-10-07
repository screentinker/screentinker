'use strict';

/*
 * ⚠️ A DEAD BUCKET MUST COST NOTHING, NOT TEN SECONDS PER PLAYLIST.
 *
 * The read path picks a location from what it already knows; it never asks a store whether it is
 * up. Without a breaker, a MinIO that has gone away would be tried — and timed out on — by every
 * file request until someone noticed, and a playlist push to 200 screens would queue 200 of those
 * timeouts behind each other. This remembers that the profile is failing so the next read goes
 * straight to the next copy.
 *
 * Per PROFILE, in memory, short. 3 failures inside 30 s open it for 60 s; after that ONE request is
 * let through as the probe (half-open): success closes it, failure re-opens it for another 60 s. A
 * background prober (lib/storage/index.js) does that probe on a timer so a quiet server recovers
 * without waiting for a viewer to be the guinea pig.
 *
 * ⚠️ In memory on purpose. A restart forgets every open breaker, which is right: the store may well
 * have come back while we were down, and the first failures re-open it within seconds if not.
 * Persisting it would mean a bucket that recovered at 03:00 stays "down" until someone clears a row.
 */
const FAILURES_TO_OPEN = 3;
const WINDOW_MS = 30 * 1000;
const OPEN_MS = 60 * 1000;

const state = new Map(); // profileId -> { failures: number[], openUntil: number, probing: boolean }

let now = () => Date.now();

function entry(id) {
  let e = state.get(id);
  if (!e) { e = { failures: [], openUntil: 0, probing: false, lastError: null }; state.set(id, e); }
  return e;
}

/** Local disk is never broken by this breaker; a missing local file is checked per file. */
const keyOf = (profileId) => profileId || 'local';

/**
 * May a request go to this profile right now? Read-only (no side effects): the picker calls this
 * for every location on every payload, and it must not claim the half-open probe slot by looking.
 */
function isOpen(profileId) {
  const e = state.get(keyOf(profileId));
  if (!e || !e.openUntil) return false;
  return now() < e.openUntil || e.probing;
}

/**
 * Claim the right to actually send a request. Closed: always yes. Open and cooling: no. Cooled:
 * yes, once — the caller is the probe, and everyone else is refused until it reports back.
 */
function tryAcquire(profileId) {
  const e = entry(keyOf(profileId));
  if (!e.openUntil) return true;
  if (now() < e.openUntil || e.probing) return false;
  e.probing = true;
  return true;
}

function success(profileId) {
  const e = entry(keyOf(profileId));
  e.failures = []; e.openUntil = 0; e.probing = false; e.lastError = null;
}

function failure(profileId, err) {
  const e = entry(keyOf(profileId));
  const t = now();
  e.lastError = err ? { code: err.code || 'unknown', at: Math.floor(t / 1000) } : null;
  if (e.probing || e.openUntil) {          // a failed probe re-opens at once
    e.probing = false; e.openUntil = t + OPEN_MS; e.failures = [];
    return;
  }
  e.failures = e.failures.filter((x) => t - x < WINDOW_MS);
  e.failures.push(t);
  if (e.failures.length >= FAILURES_TO_OPEN) { e.openUntil = t + OPEN_MS; e.failures = []; }
}

/** Profiles whose cool-down has elapsed and that are waiting for a probe. */
function dueForProbe() {
  const out = [];
  for (const [id, e] of state) if (e.openUntil && now() >= e.openUntil && !e.probing) out.push(id === 'local' ? null : id);
  return out;
}

function snapshot(profileId) {
  const e = state.get(keyOf(profileId));
  if (!e) return { open: false };
  return { open: isOpen(profileId), open_until: e.openUntil ? Math.floor(e.openUntil / 1000) : null, last_error: e.lastError };
}

/** Tests only. */
function _reset() { state.clear(); }
function _setClock(fn) { now = fn || (() => Date.now()); }
/** Tests only: force a profile open, as three real failures would. */
function _forceOpen(profileId, ms = OPEN_MS) { const e = entry(keyOf(profileId)); e.openUntil = now() + ms; e.probing = false; }

module.exports = { isOpen, tryAcquire, success, failure, dueForProbe, snapshot, FAILURES_TO_OPEN, WINDOW_MS, OPEN_MS, _reset, _setClock, _forceOpen };
