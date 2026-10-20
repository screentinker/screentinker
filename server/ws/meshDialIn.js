'use strict';

/*
 * The PRIMARY's door for a replica that dials in (lib/mesh/dial-out.js, docs/scale-out.md
 * "A replica behind NAT").
 *
 * The ordinary mesh has the child (here: the primary) dial its parent (the replica). A replica behind
 * NAT cannot be dialled, so it dials this namespace instead, and the socket it opens is handed to the
 * primary's existing Uplink for that edge (services/mesh-uplink.js attachInbound). From there it is
 * the same link doing the same job: the replica asks over mesh:read / mesh:write, this server answers
 * and reports over mesh:envelope, and every answer re-reads the edge first.
 *
 * ⚠️ ONLY WITH MESH_ALLOW_UPLINK, and only edges this server created from an invite it minted
 * ('they-dial' up edges). The namespace is never created otherwise (I1) — a stock install has
 * nothing here to find. The token is compared by HASH and never logged, as on /mesh.
 */

const pairing = require('../lib/mesh/pairing');

/**
 * @param {import('socket.io').Server} io
 * @param {object} deps
 * @param {(tokenHash: string) => object|null} deps.findInboundEdge  the 'they-dial' up edge for a token hash
 * @param {(edgeId: string, socket) => boolean} deps.attach         hand the socket to that edge's Uplink
 */
function setupMeshDialIn(io, deps) {
  const log = deps.logger || console;
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const ns = io.of('/mesh-in');

  ns.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    if (!auth.edgeToken || typeof auth.edgeToken !== 'string') {
      return next(new Error('This endpoint is for replicas that joined with an invite. No edge token was presented.'));
    }
    let edge = null;
    try { edge = deps.findInboundEdge(pairing.hashEdgeToken(auth.edgeToken)); } catch (e) {
      log.warn(`[mesh] dial-in edge lookup failed: ${e && e.message}`);
      return next(new Error('Could not verify this connection. Try again shortly.'));
    }
    // ⚠️ Identical for "no such token" and "revoked", as on /mesh: a stale token learns only that it no longer works.
    if (!edge || !pairing.edgeIsActive(edge, nowSeconds())) {
      return next(new Error('This connection is no longer authorised. It may have been disconnected on the ' +
                            'primary, or its token expired — join again with a new invite.'));
    }
    // The token is the credential; the node id must still be the one that redeemed it.
    if (auth.nodeId !== edge.peer_node_id) {
      return next(new Error('This token belongs to a different server.'));
    }
    socket.data.edge = edge;
    return next();
  });

  ns.on('connection', (socket) => {
    const edge = socket.data.edge;
    let ok = false;
    try { ok = deps.attach(edge.id, socket); } catch (e) { log.warn(`[mesh] dial-in attach: ${e && e.message}`); }
    if (!ok) {
      log.warn(`[mesh] replica ${edge.peer_node_id} dialled in but there is no live link for edge ${edge.id}; closing`);
      socket.disconnect(true);
      return;
    }
    log.log(`[mesh] replica ${edge.peer_node_id} dialled in on edge ${edge.id}`);
    socket.on('disconnect', (reason) => log.log(`[mesh] replica ${edge.peer_node_id} disconnected (${reason})`));
  });

  return ns;
}

module.exports = setupMeshDialIn;
