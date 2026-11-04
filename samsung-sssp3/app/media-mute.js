'use strict';

/*
 * Whether a playlist item should be playing silently, right now.
 *
 * This existed three times and agreed nowhere. `<video>` honoured the per-item mute (#129); the
 * YouTube embed did not, because it is a cross-origin iframe where `el.muted` reaches nothing —
 * so an item flagged muted in the admin console played with sound on the web player, while Tizen
 * hardcoded `mute=1` into the embed URL and could never unmute at all. Same feature, opposite
 * failures, neither visible from the dashboard.
 *
 * Four inputs, and the order between them is the whole point:
 *
 *   1. wallFollower  — a video wall has ONE audio source. Every follower is silent regardless of
 *                      what the item says, or a room gets the same track from six panels a few
 *                      milliseconds apart. This outranks everything.
 *   2. remoteMuted   — a live operator toggle. They are looking at the screen; honour it over the
 *                      item's stored setting.
 *   3. itemMuted     — the per-item setting from the admin console.
 *   4. userGesture   — browser autoplay policy. Without a gesture, unmuted playback is REFUSED,
 *                      so "unmuted" is not a state we can grant; asking for it loses the video
 *                      rather than the audio.
 *
 * Kept pure and shared so the players cannot drift again: the web player loads it from
 * /player/media-mute.js (single source, same trick as schedule-eval.js), Tizen mirrors it, and
 * Android implements the same order in Kotlin.
 */

/**
 * @param {object} s
 * @param {boolean} s.wallFollower    this panel is a follower in a video wall
 * @param {boolean|null} s.remoteMuted live operator override, null when not set
 * @param {boolean} s.itemMuted       the item's stored mute flag
 * @param {boolean} s.userGesture     a user gesture has unlocked audio in this document
 * @returns {boolean} true when playback must be silent
 */
function resolveMuted(s) {
  const st = s || {};
  if (st.wallFollower) return true;
  // Autoplay policy is a hard constraint, not a preference: unmuted playback without a gesture is
  // blocked outright, which costs the VIDEO, not just the audio.
  if (!st.userGesture) return true;
  if (st.remoteMuted !== null && st.remoteMuted !== undefined) return !!st.remoteMuted;
  return !!st.itemMuted;
}

/*
 * Should the player offer a "click to unmute" prompt?
 *
 * Only when a gesture is the ONLY thing standing between the viewer and audio. Prompting on an
 * item that is deliberately muted trains people to click a button that then un-mutes something an
 * operator silenced on purpose — worse than not offering it.
 */
function shouldOfferUnmute(s) {
  const st = s || {};
  if (st.userGesture) return false;
  if (st.wallFollower) return false;
  if (st.remoteMuted !== null && st.remoteMuted !== undefined) return !st.remoteMuted;
  return !st.itemMuted;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveMuted, shouldOfferUnmute };
}
if (typeof window !== 'undefined') {
  window.MediaMute = { resolveMuted, shouldOfferUnmute };
}
