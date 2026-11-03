'use strict';
/*
 * #777: a per-device floor on heartbeat SIDE EFFECTS.
 *
 * Every heartbeat ran ~5 synchronous statements (status read + write, battery override read,
 * telemetry insert, the at-cap prune) and pushed dashboard:device-status to every dashboard in the
 * workspace. Nothing bounded the rate on an accepted socket, so a 1.9.0 Android screen beating ~20
 * times a second (bold-media-group, ~250 screens) meant 100+ main-thread statements a second and 20
 * re-renders a second in every open dashboard tab, and filled its 6,000-row telemetry cap in under
 * five minutes.
 *
 * Every current player beats every 15s or slower (BrightSign 30s), so the default 5s floor never
 * touches a well-behaved screen. Inside the floor the caller still records LIVENESS (the in-memory
 * heartbeat), so a flooding screen never reads as offline; only the DB writes and the dashboard push
 * are skipped. The next admitted beat carries fresh telemetry, so the dashboard sees at most one
 * update per device per floor, which is the coalescing.
 *
 * Per-device, in-memory, resets on restart (like content-ack-limiter). Logs ONCE per device per
 * window when a screen goes over, naming it and its rate, so an operator can find it without a query.
 */
const config = require('../config');

const LOG_WINDOW_MS = 60 * 1000;
// deviceId -> { lastPass, winStart, beats, notified }
const state = new Map();

/**
 * @returns {{ pass: true } | { pass: false, logStart: boolean, beats: number, windowMs: number, floorMs: number }}
 */
function admit(deviceId, now = Date.now()) {
  const floorMs = config.heartbeatMinIntervalMs;
  let s = state.get(deviceId);
  if (!s) { s = { lastPass: 0, winStart: now, beats: 0, notified: false }; state.set(deviceId, s); }
  if (now - s.winStart >= LOG_WINDOW_MS) { s.winStart = now; s.beats = 0; s.notified = false; }
  s.beats++;
  if (!(floorMs > 0) || now - s.lastPass >= floorMs) { s.lastPass = now; return { pass: true }; }
  const logStart = !s.notified;
  s.notified = true;
  return { pass: false, logStart, beats: s.beats, windowMs: now - s.winStart, floorMs };
}

/** Forget a device (it went offline): its first beat back is admitted immediately. */
function clear(deviceId) { state.delete(deviceId); }

// Evict idle buckets so churned device ids can't grow the Map (same rule as content-ack-limiter).
function sweep(now = Date.now()) {
  let n = 0;
  for (const [k, s] of state) if (now - s.lastPass > LOG_WINDOW_MS * 4 && now - s.winStart > LOG_WINDOW_MS * 4) { state.delete(k); n++; }
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), LOG_WINDOW_MS * 4);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function reset() { state.clear(); } // tests

module.exports = { admit, clear, sweep, startSweep, reset, LOG_WINDOW_MS };
