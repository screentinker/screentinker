const setupDeviceSocket = require('./deviceSocket');
const playerTermination = require('../lib/mesh/player-termination');   // scale-out C2
const setupDashboardSocket = require('./dashboardSocket');

module.exports = function setupWebSockets(io) {
  const deviceNs = setupDeviceSocket(io);
  const dashboardNs = setupDashboardSocket(io);

  /*
   * ⚠️ THE MESH NAMESPACE IS NOT CREATED UNLESS THE FLAG IS ON.
   *
   * Not a disabled handler, not one that returns early — required and registered only when
   * MESH_ACCEPT_ENROLLMENT is set. With the flag off there is no /mesh endpoint to reach and no code
   * loaded, which is what "a user who never sets it must not be able to tell the mesh exists" means
   * in practice (I1). An early-returning handler would still answer the socket and still be a surface.
   *
   * Required INSIDE the branch for the same reason: a top-level require would load the transport,
   * its client library and the backpressure accounting into every ordinary install's memory to do
   * nothing.
   */
  let replica = null;
  let meshNs = null;
  const config = require('../config');
  if (config.meshAcceptEnrollment) {
    try {
      const setupMeshSocket = require('./meshSocket');
      const store = require('../lib/mesh/store');
      const mirrorStore = require('../lib/mesh/mirror-store');
      const { db } = require('../db/database');

      const thisNodeId = store.ensureNodeIdentity(db);
      if (!thisNodeId) {
        console.warn('[mesh] MESH_ACCEPT_ENROLLMENT is set but this node has no identity yet — ' +
                     'the mesh tables are missing. Skipping the mesh listener.');
      } else {
        meshNs = setupMeshSocket(io, {
          thisNodeId,
          acceptEnrollment: () => true,
          findEdgeByTokenHash: (hash) => store.findEdgeByTokenHash(db, hash),
          // Re-read per envelope so revocation and token expiry take effect on a socket that is
          // already open — see the note in meshSocket.js.
          reloadEdge: (edgeId) => store.reloadEdge(db, edgeId),
          /*
           * ⚠️ WRAPPED, AND THE EDGE IS TOUCHED FIRST. A storage failure — a disk full, a constraint
           * we did not anticipate from a newer child — must not make the node look unreachable as
           * well. Recording that we HEARD from it is true regardless of whether we managed to keep
           * what it said, and conflating the two would show a healthy site as offline (I6).
           */
          onConnect: (edge) => {
            if (replica) replica.onConnect(edge);
            // Scale-out C2: buffered player events for this primary go now, not after the backoff.
            const ob = playerTermination.getOutbox();
            if (ob) { try { ob.resume(edge); } catch (e) { /* the 1 s tick covers it */ } }
          },
          onEnvelope: (edge, env, meta) => {
            store.touchEdge(db, edge.id);
            if (meta && meta.relayOnly) return;   // I5: relayed, not interpreted, not stored

            /*
             * Scale-out: a replica edge sees the same stream. A change-notice is consumed here
             * (it is a nudge to pull, never a row); a device-summary is ALSO handed over so
             * liveness lands on the copied devices row. Everything else falls through to the
             * mirror store exactly as before.
             */
            if (replica) {
              try {
                if (meta && Array.isArray(meta.batch)) { for (const item of meta.batch) replica.onEnvelope(edge, item); }
                else if (replica.onEnvelope(edge, env)) return;
              } catch (e) { /* the copy is best-effort; the mirror below still lands */ }
            }
            /*
             * Scale-out C2: a primary asking this node to deliver something to a screen attached
             * HERE. Consumed, never stored, never relayed further (the screen is on this node or it
             * is nowhere). deliverRelay checks the edge terminates players and the device is one of
             * that primary's before it emits anything.
             */
            if (env && env.type === 'command-relay') {
              try {
                const r = playerTermination.deliverRelay(db, deviceNs, edge, env.body);
                if (!r.ok) console.warn(`[mesh] command-relay from ${edge.peer_node_id} not delivered: ${r.reason}`);
              } catch (e) { console.warn(`[mesh] command-relay: ${e && e.message}`); }
              return;
            }

            /*
             * ⚠️ A BATCH IS APPLIED IN ONE TRANSACTION, and its items IN ORDER.
             *
             * One transaction because four hundred separate writes mean four hundred fsyncs, which
             * is most of what batching set out to save. In order because a tombstone followed by an
             * upsert for the same screen must land that way round — as a set, the screen comes back
             * deleted.
             *
             * Validation already happened per item upstream, so everything here is known-good: the
             * transaction cannot roll back a good item because of a bad neighbour, since bad
             * neighbours never reached it.
             */
            if (meta && Array.isArray(meta.batch)) {
              try {
                db.transaction(() => {
                  for (const item of meta.batch) mirrorStore.storeEnvelope(db, edge, item);
                })();
              } catch (e) {
                console.warn(`[mesh] could not store a batch from ${edge.peer_node_id}: ${e && e.message}`);
              }
              return;
            }

            try {
              mirrorStore.storeEnvelope(db, edge, env);
            } catch (e) {
              console.warn(`[mesh] could not store ${env && env.type} from ${edge.peer_node_id}: ${e && e.message}`);
            }
          },
        });
        /*
         * ⚠️ Published so the HTTP layer can ask a child for its live data. The socket is the only
         * path: the child dialled out because it may have no inbound route at all, which is the
         * deployment shape this feature exists for.
         */
        if (meshNs && meshNs.readFrom) {
          /*
           * Scale-out replica loop (lib/mesh/replica.js): for every down edge carrying
           * serves-dashboard + workspace-replication, keep a row copy of the shared workspaces by
           * asking through readFrom. Started only here, because readFrom is the only way it may
           * obtain a row, and readFrom exists only once the mesh namespace is up.
           */
          try {
            replica = require('../lib/mesh/replica').createReplica(db, {
              readFrom: meshNs.readFrom, logger: console,
              // Scale-out C2: re-push the playlist to every screen attached here in a workspace
              // that just changed. Same payload builder, same dedup on the player's side.
              onApplied: (wsIds) => {
                // Scale-out C3: prefetch/sweep cached media for these workspaces (no-op without a caches-content edge).
                try { require('../lib/mesh/content-cache').onApplied(wsIds); } catch (e) { /* */ }
                const commandQueue = require('../lib/command-queue');
                const build = require('./deviceSocket').buildPlaylistPayload;
                for (const wsId of wsIds) {
                  for (const d of db.prepare('SELECT id FROM devices WHERE workspace_id = ?').all(wsId)) {
                    const room = deviceNs.adapter.rooms.get(d.id);
                    if (room && room.size > 0) commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, build);
                  }
                }
              },
            });
            replica.start();
            global.__meshReplica = replica;
          } catch (e) { console.warn(`[mesh] replica loop not started: ${e && e.message}`); }
          /*
           * Scale-out C2: players on a replica. The outbox drains player events to their primary
           * through writeTo; verification asks through readFrom; a reply the primary collected
           * while applying (a play-offline ack) lands on the local socket.
           */
          // Scale-out C3: hands db/config to the content cache. Creates no timer; the worker starts on
          // the first cacheable row, which a node without a caches-content edge never has.
          try { require('../lib/mesh/content-cache').attach({ db, config: require('../config') }); } catch (e) { /* */ }
          try {
            playerTermination.attach({
              db, readFrom: meshNs.readFrom, writeTo: meshNs.writeTo, logger: console,
              onReply: (deviceId, event, payload) => { try { deviceNs.to(deviceId).emit(event, payload); } catch (e) { /* */ } },
            });
          } catch (e) { console.warn(`[mesh] player termination not started: ${e && e.message}`); }
          global.__meshReadFrom = meshNs.readFrom;
          // Same publication as the read side: routes reach the live socket layer through this
          // rather than importing it, because the sockets are constructed after routes are mounted.
          global.__meshWriteTo = meshNs.writeTo;
          // Same publication, same reason. Content moves over HTTP; this is how the OFFER reaches a
          // child that dialled out and may have no inbound route of its own.
          global.__meshContentOfferTo = meshNs.contentOfferTo;
          global.__meshContentPurgeTo = meshNs.contentPurgeTo;
        }
        console.log(`[mesh] listening for child nodes as ${thisNodeId}`);
      }
    } catch (e) {
      /*
       * ⚠️ The mesh must never be the reason a server fails to boot. It is an optional observer
       * relationship; the node's own job — scheduling, playback, its local dashboard — is unaffected
       * by it being unavailable (I1).
       */
      console.warn(`[mesh] listener not started: ${e && e.message}`);
    }
  }

  return { deviceNs, dashboardNs, meshNs };
};
