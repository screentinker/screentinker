// Player media-surface health decision (#146 web-player fix).
//
// THE BUG (hypothesis A): a NO-NEW-CONTENT refresh in handlePlaylistUpdate returned early
// ("Playlist unchanged") without verifying the media surface is still attached. If the
// <video> element had been detached from the DOM while still decoding (audio keeps playing,
// video surface gone), the re-attach — which lived ONLY in the content-changed branch —
// never ran, so the video never came back. This module is the branch-selection decision the
// no-change path now consults: re-attach ONLY when playback should be happening but the
// surface is actually lost, so a healthy poll stays a no-op (no flicker every refresh).
//
// Pure + dependency-free so it is unit-testable without a DOM: the caller extracts the DOM
// facts (is the <video> in the document? ended? errored?) into a plain state object.
//
// Dependency-free UMD: Node (require) + browser/Tizen (window.PlayerMediaHealth).
(function (root, factory) {
  // BOTH, not either/or — see schedule-eval.js. Node integration in a BrightSign widget made the
  // browser branch unreachable, so the player ran without its media-health decision there.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PlayerMediaHealth = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // state = {
  //   isPlaying:      boolean  // the player believes an item is playing
  //   hasCurrentItem: boolean  // playlist[currentIndex] exists
  //   itemKind:       'video' | 'youtube' | 'image' | 'widget' | 'other'
  //   videoEl:        { attached, ended, errored } | null   // for a plain <video> item
  //   surfaceAttached:boolean  // for non-video: a rendered surface is present in the DOM
  // }
  // Returns true iff the no-change refresh must re-render/re-attach the current item.
  function needsReattach(state) {
    var s = state || {};
    // Idle or no content: nothing to re-attach — leave the idle/waiting screen alone.
    if (!s.isPlaying || !s.hasCurrentItem) return false;

    if (s.itemKind === 'video') {
      // The exact bug: a <video> that is gone or detached from the DOM (its element may
      // still be emitting audio) — or one that ended/errored — must be re-attached.
      if (!s.videoEl) return true;
      if (!s.videoEl.attached) return true;
      if (s.videoEl.ended || s.videoEl.errored) return true;
      return false; // attached + live -> healthy, do NOT re-render (avoids flicker)
    }

    // Non-video surfaces (image / youtube iframe / widget): healthy iff a surface is mounted.
    return !s.surfaceAttached;
  }

  // Whether the idle "Waiting for content..." screen should be shown, given player state.
  // THE RECONNECT BUG: the server re-emits device:paired on every re-register of an already-
  // paired device, and the player showed the idle overlay UNCONDITIONALLY — covering live
  // content (audio kept playing underneath), and the following "Playlist unchanged" left it
  // up. Rule: only fall to idle when nothing is playing AND there is genuinely no content to
  // play. Already playing, or content present and about to render, is NEVER idle.
  function shouldShowIdle(state) {
    var s = state || {};
    if (s.isPlaying) return false;   // something is playing -> never cover it with idle
    return !s.hasContent;            // idle only when there's genuinely no content
  }

  return { needsReattach: needsReattach, shouldShowIdle: shouldShowIdle };
});
