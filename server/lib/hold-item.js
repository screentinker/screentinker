'use strict';

/*
 * A HOLD: a playlist item that shows nothing new for its duration. It is how a timeline is written
 * across screens — "Vid A on screen 1 for 30s, then Vid B on screen 2 for 60s" is two zones that
 * each hold while the other plays, and on the shared clock both loop on the same 90s period.
 *
 *   hold://blank   the zone (or screen) goes to its background colour
 *   hold://freeze  the last frame of the item before it stays up, paused
 *
 * Stored as content like a YouTube link (no bytes, filepath ''), so it is added to a playlist,
 * reordered and timed like anything else. Its duration is the playlist item's duration_sec.
 *
 * ⚠️ Gated on playback.hold, which is in NO baseline: a player that has never heard of it would
 * treat it as an unknown type and skip it, which silently shortens the timeline it exists to keep.
 * The deviceSocket strip keeps it off such a screen instead — same outcome, but on purpose.
 */
const HOLD_MIME = 'application/x-st-hold';
const HOLD_MODES = ['blank', 'freeze'];

function holdUrl(mode) {
  return 'hold://' + (HOLD_MODES.includes(mode) ? mode : 'blank');
}

function isHoldItem(item) {
  return !!(item && item.mime_type === HOLD_MIME);
}

module.exports = { HOLD_MIME, HOLD_MODES, holdUrl, isHoldItem };
