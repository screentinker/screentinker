'use strict';

// #624 "Play to end": a YouTube item advances when the video ends, not after its duration_sec.
//
// Only YouTube carries the flag. An uploaded or remote video already advances on its own 'ended'
// everywhere; an image, a widget or a live channel has no end to wait for. The server cannot learn
// a YouTube video's length (oEmbed has none, and the Data API needs a key), so the PLAYER decides
// when it ended: on YouTube's ENDED event, with the length the embed reports (+ slack) as the safety
// net for an ENDED that never comes (#215: Shorts, some Android TV WebViews).
//
// ⚠️ duration_sec is NOT a cap for a play-to-end item. New items default to 10 s, so a cap would cut
// every video at 10 s, which is the bug. It is only the fallback for a player that never learns the
// video's length.
//
// ⚠️ A sync group or wall ignores the flag: every member computes the current item from a shared
// clock and each item's duration_sec, and a video that runs "until it ends" would break that clock.
// The players gate on that themselves; the server still stores and sends the flag.

const YOUTUBE_MIME = 'video/youtube';

function appliesTo(mime) {
  return mime === YOUTUBE_MIME;
}

// The stored value: 1 or NULL. Anything truthy-looking turns it on; false/0/''/null turn it off.
function normalizePlayToEnd(v) {
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') return 1;
  return null;
}

// The value to STORE on a newly added item. A YouTube item plays to the end unless the request
// says otherwise; anything else never carries the flag. Images and widgets keep their duration.
function resolvePlayToEnd(requested, mime) {
  if (!appliesTo(mime)) return null;
  if (requested === undefined) return 1;
  return normalizePlayToEnd(requested);
}

module.exports = { appliesTo, normalizePlayToEnd, resolvePlayToEnd, YOUTUBE_MIME };
