'use strict';

const zlib = require('node:zlib');

/*
 * The envelope every mesh message travels in.
 *
 * ⚠️ THE ENVELOPE IS STABLE; THE BODY IS VERSIONED. These are separate contracts on purpose. A relay
 * must be able to read where a message came from and where it is going without understanding what is
 * inside it (invariant I5) — so envelope fields can never be extended casually, while payload bodies
 * evolve freely behind their own version number. Collapsing the two means a hub upgrade breaks every
 * older child at once, which is the failure mode that makes people stop upgrading.
 *
 * ⚠️ TWO CLOCKS, NEVER ONE. `origin_ts` is stamped by the node that observed the event, from its own
 * clock. `receipts[]` is appended to at each hop from that hop's clock. Nothing in the mesh may order
 * events by a single clock, because the nodes are other people's machines: a site server with a
 * two-hour skew would silently interleave its alerts into the middle of yesterday in a hub's inbox,
 * and the hub operator would have no way to see why the story does not make sense. Carrying both
 * lets skew be DETECTED and SHOWN (see `clockSkewMs`) instead of quietly corrupting history.
 *
 * ⚠️ ANCESTRY IS RECORDED AT SEND TIME AND IS NOT AN ADDRESS. It says where this message came
 * through, for loop detection and for showing an operator the path. It is never used to locate,
 * authorise, or re-parent anything — identity is position-independent (invariant I4), so a node that
 * moves in the tree keeps every id it ever had.
 */

const ENVELOPE_VERSION = 1;

/**
 * Payload contracts. Each body carries its own version so it can evolve without touching the
 * envelope. A receiver that does not know a type MUST forward it untouched rather than drop it —
 * that is I5, and it is what lets a mid-tier node relay a payload invented after it was installed.
 */
const PAYLOAD_TYPES = Object.freeze({
  'node-health': 1,
  /*
   * ⚠️ A remote server's workspaces, so its orgs appear as ORGS here rather than as one lump per
   * machine. Without it a second workspace created on a child is invisible: its screens land in the
   * same undifferentiated list as everything else on that box, and an operator has no way to tell
   * which customer they belong to.
   */
  'workspace-summary': 1,
  'device-summary': 1,
  'alert-event': 1,
  'proof-of-play': 1,
  'tombstone': 1,
  /*
   * Scale-out: "my change log has advanced to rev N for workspace W". Tiny, coalesced, and the
   * replica answers it by PULLING (mesh:read /api/mesh/changes) — the rows themselves never ride
   * an envelope, so a burst of writes is one notice and one bounded read, never a flood upward.
   */
  'change-notice': 1,
  /*
   * Scale-out C2: "deliver this to a screen attached to you" — a command (or any other
   * server-to-player message) for a player that is connected to a REPLICA, sent UP the edge by the
   * primary that owns the screen. Permitted because the replica's operator declared
   * terminates-players for the edge; the replica only delivers to a socket it holds, and only for a
   * device whose workspace is copied from the sender (I2 accounting in mesh-invariants.test.js).
   */
  'command-relay': 1,
  /*
   * ⚠️ WHAT THE CHILD HAS DECIDED THIS PARENT MAY DO — A COURTESY, NEVER AN AUTHORITY.
   *
   * The hub cannot otherwise know it has been granted anything: the grant lives on the child, is
   * enforced there, and every route on this side deliberately reports `writable: false` until told
   * otherwise. Without this the hub's operator has no way to see what they may do for a client and
   * can only try and be refused — and the refusal is deliberately identical for "no such thing" and
   * "not permitted", so it teaches them nothing either.
   *
   * ⚠️ It travels UPWARD, from the node whose screens would change, which is the only direction
   * that preserves I10. A hub that treated this as permission would be deciding its own access;
   * it is a hint for rendering, and the child re-checks its own row on every single request.
   */
  'write-offer': 1,
  /*
   * ⚠️ A CARRIER, NOT A PAYLOAD. `batch` has no body of its own — it holds items, each with its own
   * type and body_version. It is registered here so a node that understands batches recognises it;
   * a node that does NOT will treat it as unknown and relay-without-storing (I5), which is exactly
   * why a child must never send one unless the far side has said it can unpack it. See
   * docs/mesh-batching-design.md.
   */
  'batch': 1,
});

/** Bounds a sender must respect and a receiver must enforce. The receiver's are authoritative. */
const BATCH_LIMITS = Object.freeze({
  maxItems: 500,
  /*
   * ⚠️ A CEILING ON THE DECOMPRESSED SIZE, not just the compressed one. Brotli will happily turn a
   * kilobyte into gigabytes, so a bound on what arrives is no bound at all — a compressed payload
   * must be refused by how large it BECOMES. zlib enforces this for us via maxOutputLength, which
   * fails the decode rather than allocating.
   */
  maxDecodedBytes: 8 * 1024 * 1024,
  // Under socket.io's 1MB default maxHttpBufferSize with room for the envelope and framing: a batch
  // that trips the transport limit fails with an error that says nothing about batching.
  maxBytes: 512 * 1024,
});

/**
 * Build an envelope.
 *
 * @param {object} p
 * @param {string} p.originNodeId  UUID of the node that OBSERVED this, never the sender if relayed
 * @param {string} p.type          payload type
 * @param {number} p.bodyVersion   version of the body contract
 * @param {string[]} p.ancestry    node ids this message has passed through, origin first
 * @param {number} p.originTs      epoch ms from the ORIGIN's clock
 * @param {object} p.body
 */
/**
 * Wrap many observations in one envelope.
 *
 * ⚠️ TRANSPORT METADATA BELONGS TO THE BATCH; OBSERVATION METADATA BELONGS TO THE ITEM. Receipts
 * answer "where did the delay happen", which is a property of the journey — one chain is the answer
 * and four hundred copies of it are the same answer repeated. `origin_ts` is when a thing was
 * OBSERVED, which differs per item and is what clock-skew detection reads, so it stays on the item.
 *
 * ⚠️ An item may name its OWN origin_node_id. A relay legitimately carries items from several nodes,
 * and defaulting them all to the batching node would attribute a subtree's data to the relay — which
 * would quietly re-write history the moment anything was relayed.
 */
/*
 * ⚠️ COMPRESSION LIVES ON THE BATCH BODY, NOT ON THE TRANSPORT — and that reverses what I first
 * recommended, for a reason worth writing down.
 *
 * socket.io's perMessageDeflate is a SERVER-WIDE constructor option: one engine serves every
 * namespace, so enabling it for the mesh enables it for all ~400 player sockets on /device too — a
 * path that has already had two incidents about connection behaviour. A mesh feature must not change
 * how players connect. Compressing the body reaches only the sockets this feature owns.
 *
 * ⚠️ AND IT IS A BUFFER, NOT BASE64. socket.io carries binary natively as an attachment; base64 would
 * make the payload ~33% LARGER for the privilege of being text nobody reads. Encoding is negotiated,
 * because a peer that cannot decode is worse off than one that received it plainly.
 */
const BATCH_ENCODINGS = Object.freeze(['br', 'gzip']);

function encodeItems(items, encoding) {
  const json = Buffer.from(JSON.stringify(items), 'utf8');
  if (encoding === 'br') {
    return { enc: 'br', count: items.length, data: zlib.brotliCompressSync(json, {
      // q5: the measured knee. Higher costs main-thread milliseconds for single-digit percentages.
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    }) };
  }
  if (encoding === 'gzip') {
    return { enc: 'gzip', count: items.length, data: zlib.gzipSync(json) };
  }
  return { items };
}

function decodeItems(body) {
  if (!body) return null;
  if (Array.isArray(body.items)) return body.items;
  if (!body.enc || !body.data) return null;

  const buf = Buffer.isBuffer(body.data) ? body.data : Buffer.from(body.data);
  const opts = { maxOutputLength: BATCH_LIMITS.maxDecodedBytes };
  let json;
  try {
    if (body.enc === 'br') json = zlib.brotliDecompressSync(buf, opts);
    else if (body.enc === 'gzip') json = zlib.gunzipSync(buf, opts);
    else return null;
  } catch (e) {
    // A bomb, a corrupt payload, or an encoding we do not speak — all one answer: refuse it.
    return null;
  }
  try {
    const items = JSON.parse(json.toString('utf8'));
    return Array.isArray(items) ? items : null;
  } catch (e) {
    return null;
  }
}

function createBatch({ originNodeId, ancestry, originTs, items, encoding = null }) {
  return {
    envelope_version: ENVELOPE_VERSION,
    origin_node_id: originNodeId,
    origin_ts: originTs,
    type: 'batch',
    body_version: PAYLOAD_TYPES.batch,
    ancestry: Array.isArray(ancestry) ? ancestry : [originNodeId],
    receipts: [],
    body: encodeItems((items || []).map((i) => ({
        type: i.type,
        body_version: i.body_version ?? 1,
        origin_ts: i.origin_ts,
        /*
         * Omitted when it matches the batch — repeating it 400 times is most of what batching saves.
         *
         * ⚠️ An item from a DIFFERENT origin carries its own ancestry too, and must: the receiver
         * attests each item against the path that item actually took, and the batch's own chain
         * proves the batch's journey rather than the item's. Without this a relayed item is refused,
         * which is the correct failure — it is unprovable, not merely unlabelled.
         */
        ...(i.origin_node_id && i.origin_node_id !== originNodeId
          ? { origin_node_id: i.origin_node_id, ancestry: i.ancestry } : {}),
      body: i.body,
    })), encoding),
  };
}

const isBatch = (env) => !!env && env.type === 'batch';
const batchItems = (env) => (isBatch(env) ? decodeItems(env.body) : null);

/*
 * How many payloads a batch CLAIMS to carry, readable without decompressing it.
 *
 * ⚠️ Backpressure has to charge for a batch before it is unpacked, or a compressed payload buys a
 * free pass through the limit that exists to stop exactly that. The claim is then verified against
 * the real count after decoding — a batch that under-declared is refused outright rather than
 * corrected, because under-declaring is not a mistake anyone makes by accident.
 */
const batchClaimedCount = (env) => {
  if (!isBatch(env) || !env.body) return 1;
  if (Array.isArray(env.body.items)) return Math.max(1, env.body.items.length);
  return Math.max(1, Number(env.body.count) || 1);
};

/**
 * Validate ONE item of a batch, in isolation.
 *
 * ⚠️ IN ISOLATION IS THE POINT. I6 says one bad payload costs exactly one bad payload; validating a
 * batch as a unit means a single malformed item from a newer child discards every good one beside
 * it — and the child, seeing a rejection, retries the identical batch forever.
 *
 * Returns the same shape as validateEnvelope so the caller treats batched and unbatched payloads
 * with one code path.
 */
function validateItem(item, { batchOriginNodeId } = {}) {
  if (!item || typeof item !== 'object') {
    return { ok: false, reason: 'Batch item is not an object.' };
  }
  const origin = item.origin_node_id || batchOriginNodeId;
  if (typeof origin !== 'string' || !origin) {
    return { ok: false, reason: 'Batch item has no origin node id.' };
  }
  if (typeof item.origin_ts !== 'number') {
    return { ok: false, reason: 'Batch item has no origin timestamp.' };
  }
  if (item.type === 'batch') {
    /*
     * ⚠️ NO NESTING. A batch inside a batch buys nothing and turns every bound — item count, byte
     * size, the per-item loop — into a recursive problem, which is how a size limit stops being one.
     */
    return { ok: false, reason: 'A batch may not contain a batch.' };
  }

  const known = Object.prototype.hasOwnProperty.call(PAYLOAD_TYPES, item.type);
  if (!known) {
    return { ok: true, relayOnly: true, origin,
             reason: `Unknown payload type "${item.type}" — relay only.` };
  }
  if (item.body_version > PAYLOAD_TYPES[item.type]) {
    return { ok: true, relayOnly: true, origin,
             reason: `Payload "${item.type}" version ${item.body_version} is newer than this node ` +
                     `understands (${PAYLOAD_TYPES[item.type]}) — relay only.` };
  }
  return { ok: true, relayOnly: false, origin };
}

/** An item, expressed as the envelope the storage layer already knows how to handle. */
function itemAsEnvelope(item, batch) {
  return {
    envelope_version: batch.envelope_version,
    origin_node_id: item.origin_node_id || batch.origin_node_id,
    origin_ts: item.origin_ts,
    type: item.type,
    body_version: item.body_version,
    /*
     * ⚠️ THE ITEM'S OWN CHAIN WINS, and discarding it was the same mistake twice over.
     *
     * The validator that runs a few lines earlier says it outright: the batch's ancestry proves the
     * BATCH's path, not the item's. This function then handed every item the batch's chain anyway —
     * so a relayed payload that arrived carrying A<-B<-C was stored as though it had come straight
     * from B, and everything downstream that reasons about distance saw one hop where there were
     * two. A relay was indistinguishable from a direct link at exactly the layer that decides how
     * far away something is.
     *
     * Falls back to the batch for ordinary items, which is correct: an item that did not bring its
     * own chain travelled the batch's, and omitting it is what makes batching cheap.
     */
    ancestry: Array.isArray(item.ancestry) && item.ancestry.length ? item.ancestry : batch.ancestry,
    receipts: batch.receipts,
    body: item.body,
  };
}

function createEnvelope({ originNodeId, type, bodyVersion, ancestry, originTs, body }) {
  return {
    envelope_version: ENVELOPE_VERSION,
    origin_node_id: originNodeId,
    type,
    body_version: bodyVersion,
    ancestry: Array.isArray(ancestry) ? [...ancestry] : [originNodeId],
    origin_ts: originTs,
    receipts: [],
    body,
  };
}

/**
 * Stamp a message as received by this node.
 *
 * ⚠️ APPEND, NEVER OVERWRITE. Each hop's clock is evidence. Replacing the previous hop's receipt
 * destroys the only record of where a delay or a skew was introduced, which is exactly what someone
 * is trying to find out when they look at this.
 */
function stampReceipt(env, nodeId, nowMs) {
  const receipts = Array.isArray(env.receipts) ? env.receipts : [];
  return { ...env, receipts: [...receipts, { node_id: nodeId, received_ts: nowMs }] };
}

/**
 * Apparent clock skew between the origin and the first node that received it, in ms.
 *
 * Positive means the origin's clock is AHEAD of the receiver's. Returns null when there is no receipt
 * to compare against. This is deliberately the FIRST receipt: later hops accumulate real transit
 * time, so comparing against them measures the network rather than the clock.
 *
 * Network transit is included in this figure and cannot be separated from skew without a round trip.
 * That is acceptable because the number exists to answer "is this node's clock roughly sane", where
 * the interesting values are minutes and hours, not the milliseconds transit contributes.
 */
function clockSkewMs(env) {
  if (!env || !Array.isArray(env.receipts) || env.receipts.length === 0) return null;
  if (typeof env.origin_ts !== 'number') return null;
  const first = env.receipts[0];
  if (!first || typeof first.received_ts !== 'number') return null;
  return env.origin_ts - first.received_ts;
}

/** Skew worth telling an operator about. A minute is noise; ten is a story that will not add up. */
const SKEW_WARN_MS = 10 * 60 * 1000;

function skewIsNotable(env) {
  const skew = clockSkewMs(env);
  return skew !== null && Math.abs(skew) >= SKEW_WARN_MS;
}

/**
 * Would forwarding this message create a loop?
 *
 * ⚠️ A REACHABILITY CHECK ON RECORDED ANCESTRY, not a path-prefix comparison (invariant I3). Prefix
 * matching assumes a tree; the mesh is a DAG, because multi-parent is a real requirement — an MSP's
 * hub and the client's own hub may both observe the same server. Under multi-parent a legitimate
 * message routinely arrives with an ancestry that is not a prefix of anything local, and a prefix
 * check would refuse it.
 */
function wouldLoop(env, thisNodeId) {
  return Array.isArray(env?.ancestry) && env.ancestry.includes(thisNodeId);
}

/**
 * Validate an inbound envelope.
 *
 * ⚠️ AN UNKNOWN PAYLOAD TYPE IS NOT AN ERROR. It is the relay case (I5) and it must survive. This
 * returns `relayOnly` for it: the node may forward it and must not try to store or interpret it.
 * Refusing unknown types would mean every node in a path had to be upgraded before any new payload
 * could travel — which is precisely the coupling the envelope/body split exists to prevent.
 */
function validateEnvelope(env, { thisNodeId } = {}) {
  if (!env || typeof env !== 'object') {
    return { ok: false, reason: 'Message is not an envelope.' };
  }
  if (env.envelope_version !== ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: `Envelope version ${env.envelope_version} is not supported by this node ` +
              `(it speaks version ${ENVELOPE_VERSION}). The sending node is likely newer; ` +
              `upgrade this one.`,
    };
  }
  if (typeof env.origin_node_id !== 'string' || !env.origin_node_id) {
    return { ok: false, reason: 'Envelope has no origin node id.' };
  }
  if (typeof env.origin_ts !== 'number') {
    return { ok: false, reason: 'Envelope has no origin timestamp.' };
  }
  if (thisNodeId && wouldLoop(env, thisNodeId)) {
    return {
      ok: false,
      reason: `Refusing a message that has already passed through this node ` +
              `(${thisNodeId}) — that would be a routing loop.`,
    };
  }

  const known = Object.prototype.hasOwnProperty.call(PAYLOAD_TYPES, env.type);
  if (!known) {
    // I5: forward it, do not understand it, do not drop it.
    return { ok: true, relayOnly: true, reason: `Unknown payload type "${env.type}" — relay only.` };
  }
  if (env.body_version > PAYLOAD_TYPES[env.type]) {
    // A newer body of a type we know: still relayable, still not storable.
    return {
      ok: true,
      relayOnly: true,
      reason: `Payload "${env.type}" version ${env.body_version} is newer than this node ` +
              `understands (${PAYLOAD_TYPES[env.type]}) — relay only.`,
    };
  }

  return { ok: true, relayOnly: false };
}

module.exports = {
  ENVELOPE_VERSION,
  PAYLOAD_TYPES,
  BATCH_LIMITS,
  BATCH_ENCODINGS,
  createBatch,
  isBatch,
  batchItems,
  batchClaimedCount,
  encodeItems,
  decodeItems,
  validateItem,
  itemAsEnvelope,
  SKEW_WARN_MS,
  createEnvelope,
  stampReceipt,
  clockSkewMs,
  skewIsNotable,
  wouldLoop,
  validateEnvelope,
};
