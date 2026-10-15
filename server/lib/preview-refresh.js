'use strict';

/*
 * 3.0.1 preview refresh: one fresh screenshot after a screen's picture has changed.
 *
 * A screen card's preview is the last screenshot anybody asked for. Nothing asked after pairing,
 * so a web player paired from the dashboard went on showing its pairing code on the Simple view's
 * cards (and on the grid until its next 30s poll) while its status already said "Playing". The
 * same after new content was pushed: the card kept the old picture until somebody pressed
 * Screenshot.
 *
 * So the two moments when the picture is known to change — the pair endpoint, and a playlist
 * update actually delivered to a connected screen (lib/command-queue.js queueOrEmitPlaylistUpdate,
 * where every push path meets) — call noteChange(), and the screen is asked for ONE screenshot a
 * few seconds later, through the same device:screenshot-request the Screenshot button sends.
 *
 * ⚠️ BOUNDED BY DESIGN — a fleet-wide publish or a mass reconnect must not become a screenshot storm:
 *   - debounced: one pending ask per screen; more changes while it waits push it back a little
 *     (never past MAX_WAIT_MS after the first), they never add a second;
 *   - a floor per screen (config.previewRefreshMinGapMs) between two asks of ours;
 *   - a cap across the node (config.previewRefreshPerMinute); asks over it wait for the next minute,
 *     spread by a per-screen jitter so a publish to 500 screens is a trickle, not a burst;
 *   - only to a screen connected to THIS node, online, that declares remote.screenshot (the
 *     requester wired by ws/deviceSocket checks all three when it fires, not when it is queued);
 *   - a frame that arrives on its own after the settle time (the dashboard's poll, the detail
 *     page) cancels the pending ask: the preview is fresh already;
 *   - reconnects do NOT call this: the register path re-sends the playlist directly, not through
 *     queueOrEmitPlaylistUpdate, so a server restart reconnecting the whole fleet asks for nothing.
 *   - the pending map is capped (MAX_PENDING); past it, a change is simply not followed up.
 */

const config = require('../config');

const MAX_WAIT_MS = 30 * 1000;   // a screen whose content keeps changing still gets its ask
const MAX_PENDING = 5000;
const TICK_MS = 1000;

const pending = new Map();       // deviceId -> { firstAt, due }
const lastAsked = new Map();     // deviceId -> ms of our last ask (deleted on offline)
let requester = null;            // (deviceId) => boolean, wired by ws/deviceSocket
let windowStart = 0;
let windowCount = 0;
let timer = null;

function settleMs() { return config.previewRefreshSettleMs; }
function minGapMs() { return config.previewRefreshMinGapMs; }
function perMinute() { return config.previewRefreshPerMinute; }

// Stable per screen, up to half the settle time: screens changed together are asked apart.
function jitter(deviceId) {
  let h = 0;
  for (let i = 0; i < deviceId.length; i++) h = (h * 31 + deviceId.charCodeAt(i)) >>> 0;
  return h % Math.max(1, Math.floor(settleMs() / 2));
}

function ensureTimer() {
  if (timer || !pending.size) return;
  timer = setInterval(() => { try { runDue(); } catch (_) { /* best effort */ } }, TICK_MS);
  if (timer.unref) timer.unref();
}
function stopTimerIfIdle() {
  if (timer && !pending.size) { clearInterval(timer); timer = null; }
}

/** The screen's picture is about to change (paired, new content delivered). Never throws. */
function noteChange(deviceId, nowMs = Date.now()) {
  if (!deviceId || typeof deviceId !== 'string') return false;
  const p = pending.get(deviceId);
  if (p) {
    p.due = Math.min(p.firstAt + MAX_WAIT_MS, Math.max(p.due, nowMs + settleMs()));
    return true;
  }
  if (pending.size >= MAX_PENDING) return false;
  const floor = (lastAsked.get(deviceId) || 0) + minGapMs();
  pending.set(deviceId, { firstAt: nowMs, due: Math.max(nowMs + settleMs() + jitter(deviceId), floor) });
  ensureTimer();
  return true;
}

/** A screenshot arrived (whoever asked). One taken after the settle time makes our ask pointless. */
function noteFrame(deviceId, nowMs = Date.now()) {
  const p = pending.get(deviceId);
  if (p && nowMs >= p.firstAt + settleMs()) { pending.delete(deviceId); stopTimerIfIdle(); }
}

/** The screen went offline: nothing to ask, and its floor need not be remembered. */
function forget(deviceId) {
  pending.delete(deviceId);
  lastAsked.delete(deviceId);
  stopTimerIfIdle();
}

/** Ask every screen whose time has come, within the node-wide budget. Returns how many were asked. */
function runDue(nowMs = Date.now()) {
  if (nowMs - windowStart >= 60 * 1000) { windowStart = nowMs; windowCount = 0; }
  let asked = 0;
  for (const [deviceId, p] of pending) {
    if (p.due > nowMs) continue;
    if (windowCount >= perMinute()) break;   // the rest wait for the next minute
    pending.delete(deviceId);
    lastAsked.set(deviceId, nowMs);
    let ok = false;
    try { ok = !!(requester && requester(deviceId)); } catch (_) { ok = false; }
    if (ok) { windowCount++; asked++; }
  }
  stopTimerIfIdle();
  return asked;
}

function setRequester(fn) { requester = typeof fn === 'function' ? fn : null; }

function _reset() {
  pending.clear(); lastAsked.clear(); windowStart = 0; windowCount = 0;
  if (timer) { clearInterval(timer); timer = null; }
}
function _pending(deviceId) { return pending.get(deviceId) || null; }

module.exports = { noteChange, noteFrame, forget, runDue, setRequester, MAX_WAIT_MS, MAX_PENDING, _reset, _pending };
