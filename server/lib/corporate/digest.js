'use strict';

/*
 * Digests that let the corporate machinery notice a published snapshot written by code that does
 * not know about it — in practice, an older server version booted on the same database (a rollback,
 * then a re-upgrade). Such a version rewrites published_snapshot but never published_rev or
 * published_composable, so a rev-only check would keep serving the loop from before the rollback.
 *
 *   playlists.published_composable_of — the digest of the published_snapshot that the playlist's
 *     published_composable was built with. publishPlaylist writes both together; the in-place
 *     patchers (mute-sync, the content-delete scrub) move it along with the snapshot they patch.
 *     A mismatch at boot means "published by something else": lib/corporate/reconcile.js republishes.
 *   composition inputs_rev — carries the digest of every input's snapshot next to its rev
 *     (lib/corporate/composition.js), so a cached composition notices the same thing.
 */

const crypto = require('node:crypto');
const probe = require('./schema-probe');

function snapshotDigest(text) {
  if (text === null || text === undefined) return null;
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * A patcher rewrote playlist X's published_snapshot from `oldText` to `newText`: if the composable
 * was paired with the old snapshot, it is paired with the new one now. Never throws.
 */
function followSnapshot(db, playlistId, oldText, newText) {
  try {
    if (!probe.hasColumn(db, 'playlists', 'published_composable_of')) return;
    const before = snapshotDigest(oldText);
    if (!before) return;
    db.prepare('UPDATE playlists SET published_composable_of = ? WHERE id = ? AND published_composable_of = ?')
      .run(snapshotDigest(newText), playlistId, before);
  } catch (_) { /* best effort: a mismatch only costs a republish at the next boot */ }
}

module.exports = { snapshotDigest, followSnapshot };
