'use strict';

// #237: a video added to a playlist got the flat 10s default, so a 32s clip was cut off at
// 10s unless the operator looked up the runtime and typed it in — per item, every time. The
// content row already carries the probed length, so that becomes the default. Shared by
// every playlist_items insert path (dashboard, device assign, group assign, agency portal,
// schedules, public API) because the operator sees one product, not six routes.

const DEFAULT_ITEM_DURATION = 10;

// IPTV: a live stream's duration_sec is DWELL (how long to stay on the channel), not clip
// length. Default 5 minutes when added; 0 is a valid, meaningful value ("stay until skipped")
// and is SAFE only because every player special-cases a live item's 0 dwell (no finite advance
// timer). It must never be applied to finite media, where 0 self-loops into a black screen.
const LIVE_MIMES = ['video/hls', 'video/rtsp'];
const LIVE_DEFAULT_DWELL = 300;

// A probe that reports longer than this is a broken container (streams and truncated files
// report absurd or near-infinite lengths), not a clip anyone means to schedule — honoring it
// would park a display on one item for days with no obvious cause. 12h.
const MAX_CONTENT_DURATION = 43200;

// The content's own length, or null when there isn't a trustworthy one: images, widgets,
// YouTube and remote-URL rows carry no duration, and a failed ffprobe leaves null/0. Rounded
// UP so a 31.7s clip gets 32 and not a 31 that clips the tail; whole seconds because the
// Android player reads duration_sec with optInt (a fractional value silently truncates) and
// an operator expects to see a round number in the duration box.
function contentDefaultDuration(content) {
  const n = Number(content && content.duration_sec);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CONTENT_DURATION) return null;
  return Math.max(1, Math.ceil(n));
}

// The duration to STORE on a new playlist_item. An explicit operator value always wins; the
// content's own length is only a default for when none was given.
//
// Anything that isn't a usable number falls back rather than reaching the DB: a duration of
// 0 (or NaN, from a client that sent a string) makes the players schedule a 0ms advance,
// which self-loops and black-screens the TV (#widget zero-duration loop).
function resolveItemDuration(requested, content) {
  const n = Number(requested);
  // A live stream keeps dwell 0 (stay until skipped) and defaults to 5 minutes, never the
  // content length (it has none). 0 is safe here BECAUSE the item is live; the players gate on it.
  // null/undefined/'' mean "no value given" -> the default; only an EXPLICIT 0 stays 0 (Number(null)
  // is 0, so guard the not-given cases before coercing).
  if (content && LIVE_MIMES.indexOf(content.mime_type) !== -1) {
    if (requested === undefined || requested === null || requested === '') return LIVE_DEFAULT_DWELL;
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    return LIVE_DEFAULT_DWELL;
  }
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return contentDefaultDuration(content) ?? DEFAULT_ITEM_DURATION;
}

module.exports = { resolveItemDuration, contentDefaultDuration, DEFAULT_ITEM_DURATION, MAX_CONTENT_DURATION, LIVE_DEFAULT_DWELL, LIVE_MIMES };
