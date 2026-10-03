'use strict';

/*
 * ACTING AS A RELAY — holding media somebody sent, so it can be passed on to servers below.
 *
 * ⚠️ THIS NODE NEVER DECIDES ON ITS OWN THAT SOMETHING MAY TRAVEL FURTHER. Three separate answers
 * are required and they belong to three different parties:
 *
 *   the content's owner   — `relayable` on the provenance row, set from the manifest when they
 *                           pushed it. Their file, their call.
 *   this node's operator  — the `redistributes-content` capability. A resource decision: am I
 *                           willing to spend disk holding things for onward use.
 *   each server below     — its own write grant, checked on arrival exactly as for any other push.
 *
 * A single setting would have collapsed those into whoever runs the middle node — the party that
 * BENEFITS from caching rather than the one giving something up. That is the defect the write grant
 * already had once (the parent authored the grant the child enforced) and it took an amendment to
 * I2 to fix; repeating it in the tier that inverts I2's direction would be careless.
 *
 * ⚠️ AND THE RELAY DOES NOT FAN OUT BY ITSELF. It makes content available for its operator to send
 * onward; it never forwards automatically. The servers below granted THIS node the right to push to
 * them — they have no relationship with whoever is above it, and automatic forwarding would let a
 * grandparent decide what lands on them through a grant they gave somebody else.
 */

/** What this node is holding that it may pass on, with whether anything local still needs it. */
function relayableContent(db, { originNodeId = null } = {}) {
  const rows = db.prepare(`
    SELECT p.origin_node_id, p.origin_content_id, p.local_content_id, p.bytes, p.relayable,
           p.last_seen_at, c.filename, c.file_size, c.workspace_id
      FROM mesh_content_provenance p
      JOIN content c ON c.id = p.local_content_id
     ${originNodeId ? 'WHERE p.origin_node_id = ?' : ''}
     ORDER BY c.file_size DESC
     LIMIT 500`).all(...(originNodeId ? [originNodeId] : []));

  return rows.map((r) => ({
    localId: r.local_content_id,
    originNodeId: r.origin_node_id,
    originContentId: r.origin_content_id,
    filename: r.filename,
    bytes: r.file_size || r.bytes || 0,
    workspaceId: r.workspace_id,
    // ⚠️ The owner's answer, reported as-is. A relay showing "you may pass this on" for something
    // nobody agreed to would be inventing a permission on the operator's behalf.
    relayable: !!r.relayable,
    receivedAt: r.last_seen_at ? r.last_seen_at * 1000 : null,
  }));
}

/**
 * Drop cached copies of content a peer sent us, at that peer's request.
 *
 * ⚠️ SCOPED TO WHAT THAT PEER ORIGINATED, and that is the whole safety of the verb. A purge names
 * origin content ids and is matched against provenance rows for THIS edge's peer — so a parent can
 * ask this node to forget what IT sent and can reach nothing else. Anything uploaded here, and
 * anything another parent sent, is untouchable through this door.
 *
 * ⚠️ CONTENT SOMETHING STILL PLAYS IS NOT REMOVED. A purge is the owner withdrawing a copy, not an
 * instruction that outranks the screens in front of people — a file yanked out from under a
 * published playlist is a blank slot on a wall, decided by a server nobody at that site controls.
 * Refused per item and reported, so the peer learns it is still in use rather than believing it
 * gone.
 *
 * @param {(contentId:string)=>boolean} isReferenced  supplied so the caller owns the definition of
 *   "in use" — playlist items AND published snapshots, which outlive the items they were built from
 * @param {(row:object)=>void} removeLocal  performs the actual deletion (refcounted unlink, row,
 *   provenance, allowance refund) — kept out of here so there is ONE deletion path, not a second
 */
function applyPurge(db, edge, originContentIds, { isReferenced, removeLocal }) {
  const ids = Array.isArray(originContentIds)
    ? originContentIds.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return { ok: false, reason: 'A purge must name what to remove.' };

  const removed = []; const kept = []; const unknown = [];
  for (const oid of ids) {
    const row = db.prepare(`SELECT * FROM mesh_content_provenance
                             WHERE origin_node_id = ? AND origin_content_id = ?`)
      .get(edge.peer_node_id, oid);
    // Same answer for "never sent" and "already gone": neither is something a peer needs to tell
    // apart, and the difference would map what this node holds.
    if (!row) { unknown.push(oid); continue; }

    if (isReferenced(row.local_content_id)) {
      kept.push({ oid, why: 'still used by a playlist here' });
      continue;
    }
    try {
      removeLocal(row);
      removed.push(oid);
    } catch (e) {
      kept.push({ oid, why: 'could not be removed' });
    }
  }
  return { ok: true, removed, kept, unknown: unknown.length };
}

module.exports = { relayableContent, applyPurge };
