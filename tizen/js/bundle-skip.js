// #649: an HTML bundle may ask the player to skip it ("I have nothing to show right now").
//
//   parent.postMessage({ type: 'screentinker:skip', reason: 'offline' }, '*')
//
// The pure rules, shared by every JS player (web, legacy web, Tizen; BrightSign and Vega run the
// web player). CONTRACT: the same behaviour as the Android player's BundleSkip.kt and the native
// player's logic/bundle_skip.py. All three are checked against shared/bundle-skip-vectors.json, so
// a rule changed in one place and not the others fails a test instead of drifting.
//
//   isSkipMessage(data)   -> is this message a skip request at all (an object, type exactly
//                            'screentinker:skip'). WHO sent it is the caller's job: only the frame
//                            of the bundle that is on screen right now may be listened to.
//   sanitizeReason(raw)   -> the optional reason as a short, printable, single-line string, or null
//   Guard(minRunMs)       -> the anti-spin rule, one per rotation (the fullscreen playlist, or one zone)
//
// THE GUARD'S RULE. A skip from an item is honoured only if
//   1. the screen is not on a shared clock (a wall, a synced group): there, one screen moving on
//      alone would break the clock every other screen keeps, so the skip is ignored;
//   2. there is something else to move on to (not a one-item playlist or zone, and not the only
//      item its schedule allows right now) — skipping to itself would only reload it;
//   3. the same item has not already been skipped since the last time ANY item of that rotation
//      ran to its normal end. An item that ends in under minRunMs does not count as having run,
//      so a playlist of broken or instantly-skipping items cannot reset the guard by itself.
// Anything else is ignored and the item runs its normal duration. So when every item skips, each
// skips once, the next one plays its full duration (and resets the guard), and the screen is never
// in a loop faster than one full item duration.
//
// Dependency-free UMD: Node + browser/Tizen/BrightSign (window.BundleSkip). The browser global is
// set unconditionally, so a BrightSign widget with nodejs_enabled (where `module` also exists)
// still gets it.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BundleSkip = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MESSAGE_TYPE = 'screentinker:skip';
  var REASON_MAX = 64;
  var MIN_RUN_MS = 1000;

  function isSkipMessage(data) {
    return !!data && typeof data === 'object' && data.type === MESSAGE_TYPE;
  }

  /*
   * The reason ends up in the dashboard's device log, written by code we did not write. So it is a
   * label, not a message: control characters (newlines included) become spaces, runs of whitespace
   * collapse, and it is cut to REASON_MAX characters. Anything that is not a string is no reason.
   */
  function sanitizeReason(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    // Cut by code point, so a surrogate pair is never split in half.
    var cps = Array.from ? Array.from(s) : s.split('');
    if (cps.length > REASON_MAX) s = cps.slice(0, REASON_MAX).join('');
    return s;
  }

  function Guard(minRunMs) {
    this.minRunMs = typeof minRunMs === 'number' && minRunMs >= 0 ? minRunMs : MIN_RUN_MS;
    this.skipped = {};
  }
  /*
   * May the item `key` skip now? Returns 'skip' (honoured: advance now) or why not:
   * 'sync' (shared clock), 'alone' (nothing else to move on to), 'repeat' (already skipped since an
   * item last ran to its end). Only 'skip' records the key.
   */
  Guard.prototype.decide = function (key, canAdvance, syncDriven) {
    if (syncDriven) return 'sync';
    if (!canAdvance) return 'alone';
    var k = String(key);
    if (Object.prototype.hasOwnProperty.call(this.skipped, k)) return 'repeat';
    this.skipped[k] = true;
    return 'skip';
  };
  /* An item left the screen for any reason other than its own skip, after ranMs on screen. */
  Guard.prototype.ended = function (ranMs) {
    if (typeof ranMs === 'number' && ranMs >= this.minRunMs) this.skipped = {};
  };
  Guard.prototype.reset = function () { this.skipped = {}; };
  Guard.prototype.size = function () { return Object.keys(this.skipped).length; };

  return {
    MESSAGE_TYPE: MESSAGE_TYPE, REASON_MAX: REASON_MAX, MIN_RUN_MS: MIN_RUN_MS,
    isSkipMessage: isSkipMessage, sanitizeReason: sanitizeReason, Guard: Guard,
  };
});
