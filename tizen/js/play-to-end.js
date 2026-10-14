// #624 "Play to end": a YouTube item moves on when the video ends, not after its duration_sec.
//
// The YouTube iframe looped (loop=1&playlist=<id>) and the item's duration (10 s by default) cut
// it off, because nothing told the player when a video ended. With the flag set, the embed stops
// looping and this module listens to the embed itself: the IFrame API's own "listening" handshake
// over postMessage (the same channel the live mute toggle already uses), so no YouTube script has to
// be loaded into the .wgt.
//
// Same contract as Android PlayToEnd.kt, native playlist_logic.py and server/lib/play-to-end.js:
//  - duration_sec is NOT a cap: only the fallback while, or if, the video's length never arrives;
//  - a sync group or wall ignores the flag (the shared clock needs fixed durations);
//  - a one-item playlist keeps looping;
//  - ENDED is unreliable (#215), so the reported length + slack is the safety net, and an ENDED in
//    the first seconds is spurious.
//
// Dependency-free UMD: Node (tests) + Tizen (window.StPlayToEnd).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StPlayToEnd = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var YOUTUBE_MIME = 'video/youtube';
  var LENGTH_WAIT_MS = 30000;
  var SLACK_MS = 3000;
  var MIN_PLAY_MS = 3000;
  var HANDSHAKE_EVERY_MS = 250;
  var HANDSHAKE_TRIES = 40;          // 10 s: the embed answers within a second or two once loaded

  function applies(item, synced, playableCount) {
    return !!(item && item.play_to_end) && item.mime_type === YOUTUBE_MIME && !synced && playableCount > 1;
  }

  // Before the embed reports the length: the item's duration, never less than the wait.
  function waitMs(slotMs) { return Math.max(Number(slotMs) || 0, LENGTH_WAIT_MS); }

  // Once the length is known: the rest of the video + slack, from the item's start. null when the
  // length is unusable (0 before metadata, NaN, infinite), so the wait stands.
  function safetyMs(lengthSec, elapsedMs) {
    var n = Number(lengthSec);
    if (!(n > 0) || !isFinite(n)) return null;
    var rest = Math.floor(n * 1000) - Math.max(Number(elapsedMs) || 0, 0);
    return Math.max(rest, 0) + SLACK_MS;
  }

  function endedCounts(elapsedMs) { return elapsedMs >= MIN_PLAY_MS; }

  function loopParams(videoId, playToEnd) { return playToEnd ? '' : '&loop=1&playlist=' + videoId; }

  // One message from the embed -> { length } and/or { ended }, or null for anything else.
  function parse(data) {
    var m = data;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { return null; } }
    if (!m || typeof m !== 'object') return null;
    if (m.event === 'onStateChange') return m.info === 0 ? { ended: true } : null;
    if ((m.event === 'infoDelivery' || m.event === 'initialDelivery') && m.info && typeof m.info === 'object') {
      var out = {};
      var d = Number(m.info.duration);
      if (d > 0 && isFinite(d)) out.length = d;
      if (m.info.playerState === 0) out.ended = true;
      return (out.length || out.ended) ? out : null;
    }
    return null;
  }

  /*
   * Subscribe to one embed's length and end. The embed only starts reporting after a "listening"
   * message, and may not be ready when the iframe's load fires, so the handshake repeats until it
   * answers (what the IFrame API does itself). Only messages from THIS iframe count. Each callback
   * fires once per value (the embed repeats its info several times a second). Returns stop().
   */
  function listen(iframe, onLength, onEnded, env) {
    var w = (env && env.win) || (typeof window !== 'undefined' ? window : null);
    var setI = (env && env.setInterval) || setInterval;
    var clearI = (env && env.clearInterval) || clearInterval;
    if (!w || !iframe) return function () {};
    var answered = false, tries = 0, lastLength = 0, ended = false, stopped = false;
    function onMessage(e) {
      if (stopped || !e || e.source !== iframe.contentWindow) return;
      var r = parse(e.data);
      if (!r) return;
      answered = true;
      if (r.length && r.length !== lastLength) { lastLength = r.length; onLength(r.length); }
      if (r.ended && !ended) { ended = true; onEnded(); }
    }
    w.addEventListener('message', onMessage);
    var timer = setI(function () {
      if (answered || ++tries > HANDSHAKE_TRIES) { clearI(timer); return; }
      try {
        iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
      } catch (e) { /* not loaded yet; the next tick retries */ }
    }, HANDSHAKE_EVERY_MS);
    return function stop() {
      stopped = true;
      clearI(timer);
      try { w.removeEventListener('message', onMessage); } catch (e) {}
    };
  }

  return {
    YOUTUBE_MIME: YOUTUBE_MIME, LENGTH_WAIT_MS: LENGTH_WAIT_MS, SLACK_MS: SLACK_MS, MIN_PLAY_MS: MIN_PLAY_MS,
    applies: applies, waitMs: waitMs, safetyMs: safetyMs, endedCounts: endedCounts,
    loopParams: loopParams, parse: parse, listen: listen
  };
});
