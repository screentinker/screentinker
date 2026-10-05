'use strict';

/*
 * "Does this database have column X?" — for the few hot shared paths (buildSnapshotItems,
 * publishPlaylist, revisions capture) that gained a corporate column in Stage B.
 *
 * The boot migration always adds them, so on a real server the answer is yes, cached for good. It
 * exists for the hand-built test fixtures (embedded-renderer, slide-deck-publish, ...) that create
 * playlists/playlist_items with exactly the columns they need and then call publishPlaylist: naming
 * `pi.slot_id` unconditionally would turn every one of those into "no such column".
 *
 * Only a YES is cached. A NO is re-probed (one PRAGMA) so code that ran before the late migration
 * block added the column cannot pin "absent" for the life of the process.
 */

const _cache = new WeakMap();   // db -> Set("table.column")

function hasColumn(db, table, column) {
  if (!db) return false;
  let known = _cache.get(db);
  if (!known) { known = new Set(); _cache.set(db, known); }
  const key = `${table}.${column}`;
  if (known.has(key)) return true;
  let ok = false;
  try { ok = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column); } catch (_) { ok = false; }
  if (ok) known.add(key);
  return ok;
}

module.exports = { hasColumn };
