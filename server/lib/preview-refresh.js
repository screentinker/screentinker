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
 * So the two moments when the picture is known to change call in, and the screen is asked for ONE
 * screenshot a few seconds later, through the same device:screenshot-request the Screenshot button
 * sends:
 *   - the pair endpoint: noteChange(), always;
 *   - a playlist update delivered to a connected screen (lib/command-queue.js
 *     queueOrEmitPlaylistUpdate, where every push path meets): notePush(), and ONLY when what the
 *     screen was told to play actually changed. Data-source refreshes, local-conditions pushes and
 *     replica re-pushes repeat the same payload; they must never cost a screenshot. The comparison
 *     is signature() below, against the last payload this screen was sent — including the one the
 *     register path sends on connect, which seen() records without asking.
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

const crypto = require('crypto');
const config = require('../config');

const MAX_WAIT_MS = 30 * 1000;   // a screen whose content keeps changing still gets its ask
const MAX_PENDING = 5000;
const TICK_MS = 1000;

const pending = new Map();       // deviceId -> { firstAt, due }
const lastAsked = new Map();     // deviceId -> ms of our last ask (deleted on offline)
const lastSig = new Map();       // deviceId -> signature() of the last payload it was sent (deleted on offline)
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

/*
 * What the screen was told to SHOW, as a short hash. The item part is the web player's own
 * structural fingerprint, field for field (server/player/index.html, "STRUCTURAL fingerprint
 * only"): the project's rule is that a screen restarts — and so draws something new — exactly when
 * that changes, and that it is never "fixed" by adding a field. Beside it, the top-level fields that
 * change the picture without entering that fingerprint: the zone layout, orientation, the letterbox
 * colour and the standby content. Everything else in a payload (triggers, endpoints, power schedule,
 * time zone, local API, sync and wall clocks) changes nothing on the screen and is left out.
 */
function itemFingerprint(a) {
  return `${a.content_id || ''}|${a.widget_id || ''}|${a.widget_rev || ''}|${a.zone_id || ''}|${a.remote_url || ''}|${a.filepath || ''}|${a.filename || ''}|${JSON.stringify(a.schedules || [])}|${a.play_from || ''}|${a.play_until || ''}|${a.enabled === 0 ? 0 : 1}|${a.log_play === 0 ? 0 : 1}|${a.fit_mode || ''}|${JSON.stringify(a.play_when || null)}|${JSON.stringify(a.tags || [])}|${JSON.stringify(a.meta || {})}|${JSON.stringify(a.transition || null)}`;
}
function signature(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const items = Array.isArray(payload.assignments) ? payload.assignments.map((a) => itemFingerprint(a || {})).join(',') : '';
  const top = JSON.stringify([payload.layout || null, payload.orientation || null, payload.background_color || null,
    payload.default_content || null, payload.provisioning ? 1 : 0]);
  return crypto.createHash('sha1').update(items).update('\n').update(top).digest('base64');
}

/** The register path sent this payload: remember it as the baseline, ask nothing. Returns payload. */
function seen(deviceId, payload) {
  try { if (deviceId) lastSig.set(deviceId, signature(payload)); } catch (_) { /* best effort */ }
  return payload;
}

/**
 * A playlist update was delivered. Followed up only when it differs from the last one this screen
 * was sent. Every register path records a baseline (seen()), so after a restart each connected
 * screen has one before any routine push reaches it; a screen with none was never sent anything by
 * this process and is treated as changed.
 */
function notePush(deviceId, payload, nowMs = Date.now()) {
  if (!deviceId || typeof deviceId !== 'string') return false;
  let sig;
  try { sig = signature(payload); } catch (_) { return false; }
  const before = lastSig.get(deviceId);
  lastSig.set(deviceId, sig);
  if (before === sig) return false;
  return noteChange(deviceId, nowMs);
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
  lastSig.delete(deviceId);
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
  pending.clear(); lastAsked.clear(); lastSig.clear(); windowStart = 0; windowCount = 0;
  if (timer) { clearInterval(timer); timer = null; }
}
function _pending(deviceId) { return pending.get(deviceId) || null; }

module.exports = { noteChange, notePush, seen, signature, noteFrame, forget, runDue, setRequester, MAX_WAIT_MS, MAX_PENDING, _reset, _pending };
