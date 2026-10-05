'use strict';

/*
 * Per-item play window stamps (local YYYY-MM-DDTHH:MM, inclusive) — the merge rules.
 *
 * Shared by nesting (routes/playlists.js expandChildPlaylists: a nested child's items keep only the
 * part of their window that lies inside the parent row's window) and by corporate composition
 * (lib/corporate/compose.js: a store's slot items keep only the part inside head office's slot
 * window). One definition, so the two can never disagree about what "inside" means.
 *
 * Stamps are fixed-width strings, so lexical order IS chronological order.
 */

/** The later of two "from" stamps (either may be empty). */
function laterStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

/** The earlier of two "until" stamps (either may be empty). */
function earlierStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a <= b ? a : b;
}

module.exports = { laterStamp, earlierStamp };
