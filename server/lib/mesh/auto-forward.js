'use strict';

const contentOffer = require('./content-offer');

/*
 * PASSING RECEIVED CONTENT ON, WITHOUT BEING ASKED EACH TIME.
 *
 * An MSP with one campaign and forty sites should not have to push it forty times, and the middle
 * node already holds the bytes — that is the whole point of it being in the middle.
 *
 * ⚠️ BUT THE DECISION IS THIS OPERATOR'S, NOT THEIR PARENT'S. Every server below granted content
 * push to THIS node; they have no relationship with whoever is above it and never agreed to
 * anything it sends. So a grandparent cannot switch this on, cannot address a specific grandchild,
 * and cannot tell whether it happened: `auto_forward` sits on a DOWN edge and is set by the
 * operator who holds that client relationship. What arrives from above is an offer this node may
 * choose to repeat — never an instruction to distribute.
 *
 * ⚠️ AND ONLY WHAT THE OWNER SAID MAY TRAVEL. Content arrives marked relayable or not
 * (mesh_content_provenance.relayable, set from the manifest by whoever sent it). Forwarding
 * something not so marked would take a decision that belongs to its owner, so this never does —
 * even where the local operator has turned auto-forward on for every client they have.
 *
 * Three answers again, and all three are still required: the owner said it may travel, this
 * operator chose to pass it on, and each server below applies its own grant on arrival.
 */

/** Down edges whose operator has asked for content to be passed on automatically. */
function autoForwardTargets(db) {
  try {
    return db.prepare(`
      SELECT * FROM mesh_edges
       WHERE direction = 'down' AND revoked_at IS NULL AND auto_forward = 1`).all();
  } catch (e) {
    return [];
  }
}

/**
 * Forward newly-received, relayable content to every client set to receive it automatically.
 *
 * @param {object}   db
 * @param {object[]} stored     what commitStagedAsset just landed: [{ localId, oid }]
 * @param {object}   fromEdge   the edge it arrived on — never a forwarding target itself
 * @param {object}   deps       { contentDir, offerTo, workspaceFor, logger }
 */
async function forwardReceived(db, stored, fromEdge, deps = {}) {
  const ids = (stored || []).map((s) => s && s.localId).filter(Boolean);
  if (!ids.length) return { forwarded: [], skipped: [] };

  /*
   * ⚠️ Filtered by what the OWNER allowed, read from the provenance this node wrote when the bytes
   * arrived — not from anything in the message that triggered this.
   */
  const relayable = ids.filter((id) => {
    try {
      const row = db.prepare(
        'SELECT relayable FROM mesh_content_provenance WHERE local_content_id = ?').get(id);
      return !!(row && row.relayable);
    } catch (e) { return false; }
  });
  if (!relayable.length) return { forwarded: [], skipped: ids.map((id) => ({ id, why: 'not marked for onward use' })) };

  const offerTo = deps.offerTo;
  if (typeof offerTo !== 'function') return { forwarded: [], skipped: [] };

  const forwarded = []; const skipped = [];
  for (const edge of autoForwardTargets(db)) {
    /*
     * ⚠️ Never back the way it came. Without this, two nodes each set to auto-forward would hand the
     * same asset to each other for ever — and the digest makes every hop after the first a no-op,
     * so it would be invisible traffic rather than an obvious loop.
     */
    if (fromEdge && edge.peer_node_id === fromEdge.peer_node_id) continue;

    const workspaceId = typeof deps.workspaceFor === 'function' ? deps.workspaceFor(edge) : null;
    if (!workspaceId) { skipped.push({ node: edge.peer_node_id, why: 'no workspace chosen for that client' }); continue; }

    const built = contentOffer.buildOffer(db, edge, relayable, {
      contentDir: deps.contentDir,
      // ⚠️ Passed on as relayable again: the owner allowed it to travel, and that permission does
      // not expire at the first hop. A node further down still decides for itself.
      relayable: true,
    });
    if (!built.ok) { skipped.push({ node: edge.peer_node_id, why: built.reason }); continue; }

    try {
      const answer = await offerTo(edge.peer_node_id, {
        manifest: built.manifest, tickets: built.tickets, workspaceId,
      });
      if (answer && answer.ok) forwarded.push({ node: edge.peer_node_id, stored: (answer.stored || []).length });
      else skipped.push({ node: edge.peer_node_id, why: (answer && answer.reason) || 'refused' });
    } catch (e) {
      skipped.push({ node: edge.peer_node_id, why: (e && e.message) || 'failed' });
    }
  }
  return { forwarded, skipped };
}

module.exports = { autoForwardTargets, forwardReceived };
