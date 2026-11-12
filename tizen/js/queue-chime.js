// "Now serving" chime (server/lib/queue/widget.js): the queue widget never makes a sound itself. Once
// per called number it ASKS its player, from inside its iframe:
//
//   window.parent.postMessage({ type: 'st-queue-chime', volume: <0..1>, widget_id: <id> }, '*')
//
// and the player decides whether a sound may play and plays it. These are the player's rules, the
// same as the web player's playQueueChime (server/player/index.html) and Android's QueueChime.kt:
//   - only a frame the player mounted for a widget render may ask (player.js checks the source);
//   - the same mute decision every other sound on the screen obeys says silent -> nothing plays
//     (wall follower or a zone this panel does not voice, the operator's live mute, the item's mute);
//   - a chime played in the last 3 s -> nothing plays (a burst of calls is one chime, never a run);
//   - volume 0..1 times the player's media volume; 0 plays nothing.
// The sound is two synthesised Web Audio tones, ~0.9 s, never looped: 880 Hz from t=0 for 0.35 s,
// then 660 Hz from t=0.38 s for 0.5 s, each ramping 0.0001 -> 0.5*v in 20 ms and back down.
//
// ES5, dependency-free UMD: Node (tests) + Tizen (window.StQueueChime).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StQueueChime = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MESSAGE_TYPE = 'st-queue-chime';
  var GAP_MS = 3000;
  var DEFAULT_VOLUME = 0.6;            // the web player's fallback for a missing/garbled volume
  // [frequency Hz, start s, length s]
  var TONES = [[880, 0, 0.35], [660, 0.38, 0.5]];

  function isChimeMessage(data) {
    return !!data && typeof data === 'object' && data.type === MESSAGE_TYPE;
  }

  function clamp01(n) { return Math.max(0, Math.min(1, n)); }

  // The level to play: the widget's volume (0..1) times the player's media volume (0..1, or null
  // when none was ever set). 0 means nothing plays.
  function level(volume, mediaVolume) {
    var v = Number(volume);
    if (!isFinite(v)) v = DEFAULT_VOLUME;
    v = clamp01(v);
    if (typeof mediaVolume === 'number' && isFinite(mediaVolume)) v *= clamp01(mediaVolume);
    return v;
  }

  // The mute decision for the frame that asked. Same precedence as lib/media-mute.js resolveMuted:
  // a wall follower (or a wall zone this panel does not voice) is silent regardless; the operator's
  // live toggle, when one arrived, wins over the item's stored flag.
  //   s = { follower, liveMuted (true/false, or null/undefined when none), itemMuted }
  function silent(s) {
    var st = s || {};
    if (st.follower) return true;
    if (st.liveMuted !== null && st.liveMuted !== undefined) return !!st.liveMuted;
    return !!st.itemMuted;
  }

  // The 3 s gap, one per player (a chime from any frame counts).
  function Gate(gapMs) { this.gapMs = typeof gapMs === 'number' ? gapMs : GAP_MS; this.at = null; }
  Gate.prototype.open = function (now) { return this.at === null || now - this.at >= this.gapMs; };
  Gate.prototype.take = function (now) { this.at = now; };

  // One request -> { play, level, why }. The gate is only taken when the chime will play, as the web
  // player does: a muted or zero-volume request does not hold off the next one.
  //   o = { silent, volume, mediaVolume, now, gate }
  function decide(o) {
    if (o.silent) return { play: false, level: 0, why: 'muted' };
    var v = level(o.volume, o.mediaVolume);
    if (!(v > 0)) return { play: false, level: 0, why: 'volume' };
    if (o.gate && !o.gate.open(o.now)) return { play: false, level: v, why: 'gap' };
    if (o.gate) o.gate.take(o.now);
    return { play: true, level: v, why: 'ok' };
  }

  // Schedule the two tones on an AudioContext at level v. A suspended context is resumed first; if
  // it will not run, nothing plays. Returns nothing; never throws.
  function play(ctx, v) {
    if (!ctx || !(v > 0)) return;
    var go = function () {
      try {
        if (ctx.state && ctx.state !== 'running') return;
        var t0 = ctx.currentTime + 0.02;
        for (var i = 0; i < TONES.length; i++) {
          var freq = TONES[i][0], at = TONES[i][1], len = TONES[i][2];
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0 + at);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.5 * v), t0 + at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(t0 + at); osc.stop(t0 + at + len + 0.05);
        }
      } catch (e) { /* sound is optional; never disturb playback */ }
    };
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(go, function () { /* refused: stay silent */ });
        else go();
      } else {
        go();
      }
    } catch (e) { /* stay silent */ }
  }

  return {
    MESSAGE_TYPE: MESSAGE_TYPE, GAP_MS: GAP_MS, DEFAULT_VOLUME: DEFAULT_VOLUME, TONES: TONES,
    isChimeMessage: isChimeMessage, level: level, silent: silent, Gate: Gate, decide: decide, play: play,
  };
});
