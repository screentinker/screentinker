'use strict';

/*
 * The parent side of an edge: accepting a child node's connection.
 *
 * ⚠️ ITS OWN NAMESPACE, `/mesh`, and that is a deliberate isolation boundary rather than tidiness.
 * `/device` has been through #146, #148, the mass-reconnect payload work and the command-queue
 * flush-on-reconnect. Putting node traffic through it would mean a misbehaving PEER — a remote
 * machine on a version we do not control — sharing a connection handler with every screen in the
 * fleet, and a bug there would present as displays dropping. Separate namespace, separate handler,
 * separate failure (I6).
 *
 * ⚠️ NOTHING HERE IS REGISTERED UNLESS MESH_ACCEPT_ENROLLMENT IS ON. Not a disabled handler, not a
 * handler that returns early — the namespace is never created. With the flag off there is no route
 * to reach, which is what "invisible" in the directive actually means (I1).
 *
 * ⚠️ THERE IS NO DOWNWARD COMMAND HANDLER, AND THAT ABSENCE IS THE ENFORCEMENT (I2). This file
 * listens; it never emits an instruction to a child. A parent that wanted to reach down would have
 * nothing to call.
 */

const { Backpressure } = require('../lib/mesh/backpressure');
const envelope = require('../lib/mesh/envelope');
const pairing = require('../lib/mesh/pairing');

/**
 * @param {import('socket.io').Server} io
 * @param {object} deps
 * @param {() => boolean} deps.acceptEnrollment   the MESH_ACCEPT_ENROLLMENT flag
 * @param {(tokenHash: string) => object|null} deps.findEdgeByTokenHash
 * @param {(edge, env) => void} deps.onEnvelope   persist an accepted payload
 * @param {(edge) => void}      [deps.onConnect]  optional; called once per accepted connection
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 */
function setupMeshSocket(io, deps) {
  if (!deps || !deps.acceptEnrollment || !deps.acceptEnrollment()) return null;

  const now = deps.now || (() => Date.now());
  /*
   * ⚠️ SECONDS, and it needs its own accessor. now() is MILLISECONDS — the backpressure window is a
   * ms budget — while every timestamp column in this database is unix seconds. Comparing
   * token_expires_at (≈1.8e9) against Date.now() (≈1.8e12) makes every token look long expired, so
   * the handshake refused every child with "this connection's token expired" and the mesh simply
   * never connected. Two units in one function is how that happens, so they are two names now.
   */
  const nowSeconds = () => Math.floor(now() / 1000);
  const log = deps.logger || console;
  const backpressure = new Backpressure();
  const meshNs = io.of('/mesh');

  /*
   * Authenticate the edge, not the machine.
   *
   * ⚠️ THE TOKEN IS COMPARED BY HASH and never logged. A parent verifies; it has no reason to be able
   * to reproduce a child's token, so storing or printing the plaintext only converts one leaked log
   * file into standing access to a client's data.
   */
  meshNs.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.edgeToken;
    if (!token || typeof token !== 'string') {
      return next(new Error('This endpoint is for connected nodes. No edge token was presented.'));
    }
    let edge = null;
    try {
      edge = deps.findEdgeByTokenHash(pairing.hashEdgeToken(token));
    } catch (e) {
      log.warn(`[mesh] edge lookup failed: ${e && e.message}`);
      return next(new Error('Could not verify this connection. Try again shortly.'));
    }

    if (!edge) {
      // ⚠️ Deliberately identical for "no such token" and "revoked": a caller holding a stale token
      // learns only that it no longer works, not whether the edge still exists.
      return next(new Error('This connection is no longer authorised. It may have been revoked, or ' +
                            'its token may have expired — reconnect it from either end.'));
    }
    if (!pairing.edgeIsActive(edge, nowSeconds())) {
      return next(new Error(
        pairing.edgeInactiveReason(edge, nowSeconds()) || 'This connection is not active.'));
    }

    socket.data.edge = edge;
    socket.data.childNodeId = edge.peer_node_id;
    return next();
  });

  meshNs.on('connection', (socket) => {
    // ⚠️ `let`, because the edge is re-read per envelope below and the fresh row is what the rest of
    // the handler must use — a grant narrowed while the socket was open has to take effect on the
    // NEXT payload, not at the next reconnect.
    let edge = socket.data.edge;
    const childId = socket.data.childNodeId;
    log.log(`[mesh] node ${childId} connected on edge ${edge.id}`);
    // Optional: a replica pull loop wants to know the moment its primary is back, not at the next poll.
    if (typeof deps.onConnect === 'function') { try { deps.onConnect(edge); } catch (e) { log.warn(`[mesh] onConnect: ${e && e.message}`); } }

    /*
     * ⚠️ WHAT THIS PARENT UNDERSTANDS, STATED — never assumed by the child.
     *
     * A child that batched unilaterally would be silently ignored by an older parent: `batch` is an
     * unknown type there, so I5 applies — relay it, do not store it — and the parent would forward a
     * batch and store NOTHING, with no error anywhere. A mixed-version mesh would lose telemetry
     * invisibly, which is the worst way to lose it.
     *
     * The limits are the RECEIVER's. A sender's own defaults are a guess about somebody else's box.
     */
    socket.emit('mesh:hello', {
      supports: ['batch-v1'],
      maxBatchItems: envelope.BATCH_LIMITS.maxItems,
      maxBatchBytes: envelope.BATCH_LIMITS.maxBytes,
      // ⚠️ In preference order, and a child picks the FIRST it can produce. A peer that cannot
      // decode is worse off than one that received the payload plainly, so this is negotiated
      // rather than assumed — the same reasoning as batching itself.
      encodings: envelope.BATCH_ENCODINGS,
      nodeId: deps.thisNodeId,
    });

    socket.on('mesh:envelope', (raw, ack) => {
      /*
       * ⚠️ THE WHOLE HANDLER IS WRAPPED. A child is a remote writer on a version we do not control,
       * so a malformed payload is an expected input, not an exceptional one. An uncaught throw here
       * would land in socket.io's handler and — before #146 taught this lesson on the device side —
       * take other connections with it. One bad child must cost exactly one bad child (I6).
       */
      try {
        /*
         * ⚠️ AUTHORISATION IS RE-CHECKED HERE, NOT ONLY AT HANDSHAKE. This socket is long-lived by
         * design — a child dials its parent and stays connected — so an edge captured at connect
         * time means revoking it does nothing until the child happens to reconnect, which may be
         * days. An operator revokes precisely when they have decided a peer should stop being
         * trusted, and "it stops at the next reconnect" is not that.
         *
         * One indexed read per envelope, the same order as the write that follows it.
         */
        if (deps.reloadEdge) {
          const current = deps.reloadEdge(edge.id);
          if (!current || !pairing.edgeIsActive(current, nowSeconds())) {
            const reason = pairing.edgeInactiveReason(current, nowSeconds())
              || 'This connection is no longer authorised.';
            if (typeof ack === 'function') ack({ ok: false, reason });
            // Disconnected, not merely refused: leaving the socket open invites the child to keep
            // sending into a connection that will never accept anything again.
            socket.disconnect(true);
            return;
          }
          edge = current;
          socket.data.edge = current;
        }

        const size = typeof raw === 'string' ? raw.length : JSON.stringify(raw || {}).length;

        // ⚠️ A batch is admitted for every payload it carries, not as one message — see the note in
        // backpressure.js. Counting messages alone would make batching a way around the rate limit.
        const carried = envelope.batchClaimedCount(raw);
        const admit = backpressure.admit(childId, size, now(), carried);
        if (!admit.ok) {
          // Answered, not dropped: the child needs to know to hold and retry rather than assume
          // delivery. Silence would look identical to success from the other end.
          if (typeof ack === 'function') {
            ack({ ok: false, throttled: true, limit: admit.limit, retryAfterMs: admit.retryAfterMs });
          }
          return;
        }

        const check = envelope.validateEnvelope(raw, { thisNodeId: deps.thisNodeId });
        if (!check.ok) {
          if (typeof ack === 'function') ack({ ok: false, reason: check.reason });
          return;
        }

        /*
         * ⚠️ A CHILD MAY ATTEST ONLY TO ITS OWN SUBTREE. Reject anything claiming an origin outside
         * it — a compromised leaf must not be able to forge data about a peer it merely shares a hub
         * with. The envelope's ancestry is the child's own claim, so the check is that the SENDING
         * child appears in it: it may relay for things below itself and nothing else.
         */
        const ancestry = Array.isArray(raw.ancestry) ? raw.ancestry : [];

        /*
         * ⚠️ ATTESTATION IS ABOUT THE PATH THE PAYLOAD TOOK, and getting this subtly wrong is easy.
         *
         * A first version of the batch check read `origin === childId || ancestry.includes(childId)`
         * — reusing the envelope's shared ancestry for every item. That ancestry always contains the
         * sending child, so the second clause was TRUE for every item and the check passed for
         * anything: a forged item claiming a peer's origin was accepted on the batch's credentials.
         * The test caught it; reading the code did not.
         *
         * The real rule: a node may speak for ITSELF, or RELAY for something below it — and relaying
         * is only credible if the payload's own chain shows this child on the path. So a payload
         * whose origin is not the child must carry an ancestry of its own that includes the child.
         */
        const attests = (originId, ownAncestry) => {
          if (originId === childId) return true;
          const chain = Array.isArray(ownAncestry) ? ownAncestry : null;
          return !!chain && chain.includes(childId);
        };

        if (!attests(raw.origin_node_id, ancestry)) {
          log.warn(`[mesh] node ${childId} claimed origin ${raw.origin_node_id} outside its subtree`);
          if (typeof ack === 'function') {
            ack({ ok: false, reason: 'A node may only report data from its own subtree.' });
          }
          return;
        }

        const stamped = envelope.stampReceipt(raw, deps.thisNodeId, now());

        const items = envelope.batchItems(stamped);
        if (envelope.isBatch(stamped) && !items) {
          /*
           * ⚠️ A batch we cannot unpack is refused, never relayed. Forwarding bytes this node could
           * not read would push an unbounded decompression problem one hop further up — and the hop
           * that finally opens it is the one that pays.
           */
          if (typeof ack === 'function') {
            ack({ ok: false, reason: 'That batch could not be unpacked. Check the encoding, or ' +
                                     'send it uncompressed.' });
          }
          return;
        }
        if (items) {
          /*
           * ⚠️ THE CLAIMED COUNT IS VERIFIED. Backpressure charged for what the batch SAID it held,
           * before unpacking it — so a batch that under-declares would buy a free pass through the
           * limit that exists to stop exactly that. Refused outright rather than re-charged:
           * under-declaring is not a mistake anyone makes by accident.
           */
          if (items.length > carried) {
            log.warn(`[mesh] node ${childId} declared ${carried} items and sent ${items.length}`);
            if (typeof ack === 'function') {
              ack({ ok: false, reason: 'That batch carried more payloads than it declared.' });
            }
            return;
          }
          /*
           * ⚠️ EVERY ITEM IS VALIDATED, ATTESTED AND ANSWERED SEPARATELY (I6). All-or-nothing means
           * one malformed item from a newer child discards every good one beside it — and the child,
           * seeing a rejection, retries the identical batch forever.
           *
           * ⚠️ ATTESTATION RUNS PER ITEM, not once for the batch. A relay legitimately carries items
           * from several origins, so without this a compromised child could slip a forged item
           * claiming a peer's origin into an otherwise honest batch and have it accepted on the
           * batch's credentials.
           */
          const accepted = [];
          const rejected = [];
          let relayed = 0;

          items.forEach((item, index) => {
            const v = envelope.validateItem(item, { batchOriginNodeId: stamped.origin_node_id });
            if (!v.ok) return rejected.push({ index, reason: v.reason });
            /*
             * ⚠️ An item that names a different origin must bring its OWN chain. Falling back to the
             * batch's would be the bug above: the batch's ancestry proves the BATCH's path, not the
             * item's, and using it here accepts anything the sender cares to claim.
             */
            if (!attests(v.origin, item.ancestry)) {
              log.warn(`[mesh] node ${childId} batched an item claiming origin ${v.origin}`);
              return rejected.push({ index, reason: 'A node may only report data from its own subtree.' });
            }
            if (v.relayOnly) { relayed++; return; }
            accepted.push(envelope.itemAsEnvelope(item, stamped));
          });

          /*
           * ⚠️ Handed over as a GROUP so the caller can apply them in one transaction — per-item
           * isolation and one fsync instead of four hundred. Order is preserved: a tombstone
           * followed by an upsert for the same screen must land in that order or the screen comes
           * back deleted.
           */
          deps.onEnvelope(edge, stamped, { batch: accepted, relayOnly: false });

          if (typeof ack === 'function') {
            ack({ ok: true, batch: true, accepted: accepted.length, relayed, rejected });
          }
          return;
        }

        deps.onEnvelope(edge, stamped, { relayOnly: !!check.relayOnly });
        if (typeof ack === 'function') ack({ ok: true, relayOnly: !!check.relayOnly });
      } catch (e) {
        log.warn(`[mesh] envelope from ${childId} failed: ${e && e.message}`);
        if (typeof ack === 'function') ack({ ok: false, reason: 'Could not process that payload.' });
      }
    });

    /*
     * ⚠️ THE PARENT'S ONLY WAY TO ASK FOR ANYTHING, and it is held here so there is exactly one.
     *
     * Kept as a thin conduit: this file does not know what a device is. It hands the request to the
     * caller, which owns both the allowlist and the data, so the decision about what may be read
     * lives with the side that owns the rows rather than with the transport.
     */
    socket.on('mesh:read', (req, ack) => {
      if (typeof ack !== 'function') return;   // a read with nowhere to reply is not a read
      try {
        if (!deps.onRead) return ack({ ok: false, reason: 'This node does not answer reads.' });
        const current = deps.reloadEdge ? deps.reloadEdge(edge.id) : edge;
        if (!current || !pairing.edgeIsActive(current, nowSeconds())) {
          return ack({ ok: false, reason: 'This connection is no longer authorised.' });
        }
        Promise.resolve(deps.onRead(current, req || {}))
          .then((r) => ack(r))
          .catch((e) => ack({ ok: false, reason: 'Could not read that.', detail: e && e.message }));
      } catch (e) {
        ack({ ok: false, reason: 'Could not read that.' });
      }
    });

    socket.on('disconnect', (reason) => {
      // Not an alarm: a node going quiet is normal, and the connection view is where it shows.
      log.log(`[mesh] node ${childId} disconnected (${reason})`);
    });
  });

  /*
   * ⚠️ The PARENT side of a read: find the child's live socket and ask it. Returns a rejection
   * rather than hanging when the child is not connected — a hub whose request queues invisibly is
   * how an operator ends up staring at a spinner and concluding the product is broken.
   */
  async function readFrom(childNodeId, request, timeoutMs = 10_000) {
    for (const sock of meshNs.sockets.values()) {
      if (sock.data && sock.data.childNodeId === childNodeId) {
        return new Promise((resolve) => {
          sock.timeout(timeoutMs).emit('mesh:read', request, (err, res) => {
            if (err) return resolve({ ok: false, reason: 'That server did not answer in time.' });
            resolve(res || { ok: false, reason: 'That server returned nothing.' });
          });
        });
      }
    }
    return {
      ok: false,
      offline: true,
      // ⚠️ Says which of the two it is. "Not connected right now" and "refused" need opposite
      // responses from an operator, and a single generic failure tells them neither.
      reason: 'That server is not connected right now, so its live data cannot be read.',
    };
  }

  /*
   * ⚠️ The PARENT side of a write, and it is deliberately as thin as readFrom. This file does not
   * know what a playlist is and must not learn: it finds the child's socket and asks. Every
   * decision — is this path writable, is the grant held, does the target belong to a workspace this
   * edge may touch, has this op already been applied — is made on the CHILD, by the child, against
   * its own rows. A conduit that started making judgements would be a conduit the child had to
   * trust, and the whole point is that it does not.
   *
   * Depth 1 only, and that falls out of the implementation rather than being asserted: this scans
   * directly-connected sockets, so a write can only ever reach a node this one is actually joined
   * to. A relayed write would arrive on the relay's edge token, which would authenticate the relay
   * rather than the grantee — and nothing signs payloads yet. Keeping it to one hop means that gap
   * cannot be reached.
   */
  async function writeTo(childNodeId, request, timeoutMs = 15_000) {
    for (const sock of meshNs.sockets.values()) {
      if (sock.data && sock.data.childNodeId === childNodeId) {
        return new Promise((resolve) => {
          sock.timeout(timeoutMs).emit('mesh:write', request, (err, res) => {
            /*
             * ⚠️ A TIMEOUT IS NOT A FAILURE — it is an unknown, and saying so matters here in a way
             * it does not for a read. The write may well have been applied; the acknowledgement is
             * what went missing. The caller must retry with the SAME opId rather than re-issuing,
             * which is exactly what the child's idempotency record is for.
             */
            if (err) {
              return resolve({
                ok: false,
                indeterminate: true,
                reason: 'That server did not acknowledge in time. The change may or may not have ' +
                        'been applied — retrying the same request is safe and will tell you which.',
              });
            }
            resolve(res || { ok: false, reason: 'That server returned nothing.' });
          });
        });
      }
    }
    return {
      ok: false,
      offline: true,
      reason: 'That server is not connected right now, so nothing was changed on it.',
    };
  }

  /*
   * ⚠️ THE SAME CONDUIT AS writeTo, WITH A LONGER FUSE. A content offer makes the child fetch files
   * over a link that may be slow by nature, and the ack does not come back until it has finished —
   * so the 15s a write allows would time out on any real transfer and report indeterminate for
   * something that is merely working.
   *
   * It still decides nothing. The child evaluates what it needs, whether it may accept it, and
   * whether there is room, then pulls the bytes itself using the address IT already had.
   */
  /*
   * ⚠️ THE OWNER WITHDRAWING A COPY — the only downward verb that DELETES anything, and the
   * narrowest one here by some distance.
   *
   * It names origin content ids, and the child matches them against what THIS peer sent it. A
   * parent can ask a child to forget what it sent and can reach nothing else: not what the child
   * uploaded, not what another parent sent. And the child refuses anything a playlist still uses,
   * because a file yanked out from under a published playlist is a blank slot on a wall, decided by
   * a server nobody at that site controls.
   */
  async function contentPurgeTo(childNodeId, request, timeoutMs = 30_000) {
    for (const sock of meshNs.sockets.values()) {
      if (sock.data && sock.data.childNodeId === childNodeId) {
        return new Promise((resolve) => {
          sock.timeout(timeoutMs).emit('mesh:content-purge', request, (err, res) => {
            if (err) {
              return resolve({
                ok: false, indeterminate: true,
                reason: 'That server did not answer. Some copies may already have been removed — ' +
                        'asking again is safe.',
              });
            }
            resolve(res || { ok: false, reason: 'That server returned nothing.' });
          });
        });
      }
    }
    return { ok: false, offline: true, reason: 'That server is not connected right now.' };
  }

  async function contentOfferTo(childNodeId, request, timeoutMs = 30 * 60 * 1000) {
    for (const sock of meshNs.sockets.values()) {
      if (sock.data && sock.data.childNodeId === childNodeId) {
        return new Promise((resolve) => {
          sock.timeout(timeoutMs).emit('mesh:content-offer', request, (err, res) => {
            if (err) {
              return resolve({
                ok: false,
                indeterminate: true,
                reason: 'That server did not report back in time. Some files may have arrived — ' +
                        'sending the same content again is safe and will tell you which.',
              });
            }
            resolve(res || { ok: false, reason: 'That server returned nothing.' });
          });
        });
      }
    }
    return {
      ok: false,
      offline: true,
      reason: 'That server is not connected right now, so nothing was sent to it.',
    };
  }

  return { meshNs, backpressure, readFrom, writeTo, contentOfferTo, contentPurgeTo };
}

module.exports = setupMeshSocket;
