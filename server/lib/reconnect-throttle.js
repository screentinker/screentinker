// #142 step 3 — load-aware per-device reconnect throttle (the outage fix).
//
// A single device stuck in a tight websocket reconnect loop can flood the server
// with full register cycles (DB writes + playlist build) and saturate the event
// loop. This module gates genuine reconnects PER DEVICE, before that heavy work
// runs in deviceSocket.js.
//
// Design (mirrors the issue's suggested mitigation + the lastPlayLogAt pattern):
//   - WHO is always per-device: a device is "flagged" only when it exceeds
//     reconnectBaseMax genuine reconnects within reconnectWindowMs. Global lag
//     NEVER flags a healthy device.
//   - Load-awareness is BANDED (normal/elevated/critical from services/loop-lag),
//     not a continuous controller — deterministic and testable. The band only
//     MULTIPLIES the backoff applied to an ALREADY-flagged device.
//   - Hysteresis: escalate immediately while storming (tighten fast); decay the
//     escalation level one step per reconnectReleaseMs of calm (release slow).
//   - HARD CEILING: independent of band and of warm-up, no device may exceed
//     reconnectHardCeiling/window — a slow-ramp attacker can't train through it.
//   - COLD START: for reconnectWarmupMs after process start, force the 'normal'
//     band and apply only the hard ceiling, so a full-fleet reconnect right after
//     a deploy doesn't throttle healthy screens.
//   - State is in-memory (resets on restart), like pair-lockout / totp-lockout.

const config = require('../config');
const loopLag = require('../services/loop-lag');

// deviceId -> { hits: number[], level: number, blockedUntil: ms, lastThrottleAt: ms, lastSeen: ms }
const state = new Map();
let startedAt = Date.now();

function bandMultiplier(band) {
  if (band === 'critical') return config.reconnectBandCriticalMult;
  if (band === 'elevated') return config.reconnectBandElevatedMult;
  return 1;
}

function reject(s, now, band, reason, observed, allowed) {
  s.level = Math.min(s.level + 1, config.reconnectMaxLevel);
  const backoff = Math.min(
    config.reconnectBaseBackoffMs * Math.pow(2, s.level - 1) * bandMultiplier(band),
    config.reconnectMaxBackoffMs
  );
  s.blockedUntil = now + backoff;
  s.lastThrottleAt = now;
  return { allow: false, retryAfterMs: backoff, reason, observed, allowed, band, level: s.level };
}

// Decide whether to allow a genuine reconnect for `deviceId`.
// `now` and `bandOverride` are injectable for deterministic tests; production
// passes only deviceId.
function check(deviceId, now = Date.now(), bandOverride = null) {
  const warmup = (now - startedAt) < config.reconnectWarmupMs;
  const band = bandOverride !== null ? bandOverride : (warmup ? 'normal' : loopLag.getBand());

  let s = state.get(deviceId);
  if (!s) { s = { hits: [], level: 0, blockedUntil: 0, lastThrottleAt: 0, lastSeen: now }; state.set(deviceId, s); }
  // #146: a device quiet longer than the idle window starts fresh — so a long-gone
  // device_id never carries stale escalation, and (with sweep below) its bucket is
  // reclaimed. Mirrors ota-breaker's reset-on-access + sweep pair.
  if (now - s.lastSeen > config.reconnectIdleResetMs) { s.hits = []; s.level = 0; s.blockedUntil = 0; s.lastThrottleAt = 0; }
  s.lastSeen = now;

  /*
   * Already inside an enforced backoff window: refuse, but DO NOT extend it.
   *
   * ⚠️ THIS USED TO ESCALATE, AND THAT MADE THE THROTTLE PERMANENT (#314). Every retry inside the
   * window called reject(), which bumped the level and recomputed blockedUntil FROM NOW — so each
   * attempt pushed the release further away. A player reconnects on its own timer and cannot know
   * it is making things worse, so a device that once tripped the limit stayed tripped: measured
   * still-throttled after 70s of complete silence, having been told to retry after 60s.
   *
   * That matters far more than it sounds, because a throttled register returns BEFORE the playlist
   * push in ws/deviceSocket.js — the screen shows "Waiting for content" for as long as this lasts,
   * with every byte of its content already cached. Reported from a fleet after an OTA, where the
   * post-update relaunch cascade supplies the reconnect burst.
   *
   * So the window is now what it says it is: the device is refused until blockedUntil, told how
   * long remains, and the next attempt after that is evaluated normally. The escalation that
   * defends against a genuinely storming device still happens — on the rate path below, which is
   * reached once the window expires — so a device that really is flapping is caught again
   * immediately, while one that simply waited is let back in.
   */
  if (now < s.blockedUntil) {
    return {
      allow: false,
      retryAfterMs: Math.max(0, s.blockedUntil - now),
      reason: 'in-backoff',
      observed: s.hits.length,
      allowed: config.reconnectBaseMax,
      band,
      level: s.level,
    };
  }

  // Sliding window of genuine reconnects.
  s.hits = s.hits.filter((t) => now - t < config.reconnectWindowMs);
  s.hits.push(now);
  const observed = s.hits.length;

  // Hard ceiling — always enforced, regardless of band or warm-up.
  if (observed > config.reconnectHardCeiling) {
    return reject(s, now, band, 'hard-ceiling', observed, config.reconnectHardCeiling);
  }

  // Cold start: only the hard ceiling applies; never rate-throttle during warm-up.
  if (warmup) return allow(s, now, band);

  // Healthy device: under the per-device threshold -> always allowed.
  if (observed <= config.reconnectBaseMax) return allow(s, now, band);

  // Flagged: storming beyond the per-device threshold -> throttle (band-scaled).
  return reject(s, now, band, 'rate', observed, config.reconnectBaseMax);
}

function allow(s, now, band) {
  // Release slow: decay one escalation level per reconnectReleaseMs of calm.
  if (s.level > 0 && now - s.lastThrottleAt > config.reconnectReleaseMs) {
    s.level = Math.max(0, s.level - 1);
    s.lastThrottleAt = now;
  }
  return { allow: true, band, level: s.level };
}

// #146: actively EVICT idle per-device buckets so keyed state can't grow unbounded
// over churned device_ids (reinstalls mint new ids; reset-on-access alone never
// deletes). The OTA breaker grew this exact sweep in #144; the #142 throttle missed
// it. Bounded, off the hot path, runs on its own interval.
function sweep(now = Date.now()) {
  let n = 0;
  for (const [k, s] of state) if (now - s.lastSeen > config.reconnectIdleResetMs) { state.delete(k); n++; }
  if (n > 0) console.log(`[throttle] swept ${n} idle reconnect bucket(s) (idle > ${Math.round(config.reconnectIdleResetMs / 60000)}m); ${state.size} remain`);
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), config.reconnectIdleResetMs);
  if (sweepTimer.unref) sweepTimer.unref();   // don't keep the process alive on this timer
  return sweepTimer;
}

// Test-only: clear state and optionally rewind the warm-up origin.
function __resetForTest(opts = {}) {
  state.clear();
  if (opts.startedAt !== undefined) startedAt = opts.startedAt;
}

module.exports = { check, sweep, startSweep, _size: () => state.size, __resetForTest };
