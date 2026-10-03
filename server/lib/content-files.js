'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const config = require('../config');

/*
 * ⚠️ NEVER UNLINK A FILE ANOTHER ROW IS STILL USING.
 *
 * For most of this product's life one row meant one file, because every upload minted its own uuid
 * filename and two rows could not collide. Content received over the mesh is stored under the
 * sha256 of its bytes instead, so the same file legitimately backs one row per workspace — that is
 * tenancy working correctly, and it means a delete can no longer assume it owns what it points at.
 *
 * Without this check, deleting one customer's copy of a shared asset unlinks the bytes out from
 * under every other workspace holding it, and every panel that has not already cached the file
 * 404s. The thumbnail is worse: its name is derived from the filepath, so it is shared even when
 * only one row records a thumbnail_path of its own.
 *
 * ⚠️ It lives in lib/ rather than beside its first caller because "who else points at these bytes"
 * is one question with one answer, and the moment it is answered in two places they disagree. That
 * is the fan-out-helper lesson (lib/devices-playing.js) applied to deletion.
 *
 * Counted, not assumed. The column name is interpolated, so it is checked against a fixed set
 * first — it is never caller data, and this keeps it never being caller data by accident.
 */
const REFCOUNTED_COLUMNS = Object.freeze(['filepath', 'thumbnail_path', 'subtitle_url']);

function unlinkIfUnreferenced(rel, keeperId, column) {
  if (!rel) return { unlinked: false, reason: 'nothing to remove' };
  if (!REFCOUNTED_COLUMNS.includes(column)) throw new Error(`refusing to refcount on ${column}`);

  const base = path.basename(rel);
  const others = db.prepare(
    `SELECT COUNT(*) AS n FROM content
      WHERE ${column} IS NOT NULL AND ${column} != '' AND id != ?
        AND (${column} = ? OR ${column} LIKE ?)`,
  ).get(keeperId, base, `%/${base}`);

  if (others && others.n > 0) return { unlinked: false, reason: 'still referenced', others: others.n };

  const p = path.join(config.contentDir, base);
  if (!fs.existsSync(p)) return { unlinked: false, reason: 'already gone' };
  try {
    fs.unlinkSync(p);
    return { unlinked: true };
  } catch (e) {
    return { unlinked: false, reason: 'best-effort' };
  }
}

module.exports = { unlinkIfUnreferenced, REFCOUNTED_COLUMNS };

/*
 * ⚠️ RETURNING THE ALLOWANCE WHEN MESH-RECEIVED CONTENT IS DELETED.
 *
 * write_bytes_used only ever went up. There was one mutation of it in the tree and it was `+ ?`,
 * so an operator's storage grant was a one-way ratchet: a 20 GB allowance that had cycled through
 * 20 GB of rotated campaigns was permanently exhausted, with no remedy short of editing SQLite.
 * Worse, the route that sets a budget refuses any value below `used` and tells the operator to
 * "remove some of it first" — advice that could not work, because removing it changed nothing.
 *
 * The number was written as CONSUMPTION ("bytes ever pushed") and presented as CAPACITY ("storage
 * you are lending"). Those are the same figure only until something is deleted, which for signage
 * is weekly.
 *
 * Called with the provenance row still present, and does both halves in one transaction: a refund
 * without the deletion would double-refund on the next delete.
 */
function releaseMeshProvenance(contentId) {
  const prov = db.prepare(
    'SELECT edge_id, bytes FROM mesh_content_provenance WHERE local_content_id = ?',
  ).all(contentId);
  if (!prov.length) return { released: 0 };

  let released = 0;
  db.transaction(() => {
    for (const row of prov) {
      if (row.edge_id && row.bytes > 0) {
        db.prepare(`UPDATE mesh_edges
                       SET write_bytes_used = MAX(0, COALESCE(write_bytes_used,0) - ?)
                     WHERE id = ?`).run(row.bytes, row.edge_id);
        released += row.bytes;
      }
    }
    db.prepare('DELETE FROM mesh_content_provenance WHERE local_content_id = ?').run(contentId);
  })();
  return { released };
}

module.exports.releaseMeshProvenance = releaseMeshProvenance;

/*
 * Remove a content row that NOTHING references, and everything that goes with it.
 *
 * ⚠️ ONLY VALID FOR UNREFERENCED CONTENT, and the caller must have established that. The general
 * deletion path is purgeContentRow in routes/content.js, which additionally rewrites published
 * snapshots and tells the affected panels — work that is precisely what is unnecessary here,
 * because "unreferenced" already means no playlist item and no snapshot mentions it. Calling this
 * on referenced content would leave a playlist pointing at a row that no longer exists.
 *
 * It exists so the mesh purge verb does not hand-roll a fourth deletion. Refcounted unlink, the
 * provenance row, and the storage allowance all belong together — that is the whole reason they are
 * in one place.
 */
function removeUnreferencedContent(contentId) {
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!row) return { removed: false, reason: 'already gone' };

  unlinkIfUnreferenced(row.filepath, row.id, 'filepath');
  unlinkIfUnreferenced(row.thumbnail_path, row.id, 'thumbnail_path');
  unlinkIfUnreferenced(row.subtitle_url, row.id, 'subtitle_url');
  releaseMeshProvenance(row.id);
  db.prepare('DELETE FROM content WHERE id = ?').run(row.id);
  return { removed: true, bytes: row.file_size || 0 };
}

module.exports.removeUnreferencedContent = removeUnreferencedContent;
