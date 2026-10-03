'use strict';

/*
 * The child side of an edge: dialling the parent and reporting upward.
 *
 * ⚠️ THIS MUST NEVER BE ABLE TO HARM THE NODE IT RUNS ON (invariant I1). A parent is an observer.
 * Scheduling, playback, local alerting and the local dashboard carry on identically whether this
 * connects, fails, or was never configured. Every path here either succeeds or is swallowed into the
 * connection view — nothing throws outward, and nothing blocks.
 *
 * ⚠️ THE FIRST OUTGOING SOCKET IN THIS CODEBASE. Everything else dials IN to us. That means the
 * failure modes are new: the far end may be down, wrong, slow, or someone else's machine entirely,
 * and none of that is our node's problem to escalate.
 */

const { EventEmitter } = require('events');
const envelope = require('./envelope');

/*
 * ⚠️ JITTERED BACKOFF, and the jitter is the load-bearing half (#144 precedent).
 *
 * A hub restart disconnects every child at the same instant. Without jitter they all wait the same
 * interval and retry in the same millisecond — a thundering herd that knocks the hub over again, and
 * the outage repeats on a fixed period until someone intervenes. The base doubles to a ceiling; the
 * jitter spreads the herd across it.
 */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const JITTER_RATIO = 0.5;          // up to ±50% — enough to smear a large fleet across the window

function backoffFor(attempt, rand = Math.random) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
  const jitter = base * JITTER_RATIO * (rand() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

/*
 * ⚠️ THE BUFFER IS BOUNDED, AND DROPS THE OLDEST.
 *
 * A node whose parent is away for a week must not consume its own memory reporting to nobody — that
 * would turn an observer's outage into the observed node's outage, which is exactly what I1 forbids.
 * Oldest-first because current state is worth more than history: after a long gap, "what is happening
 * now" is the thing an operator needs, and the middle of last Tuesday is the part they can lose.
 */
const DEFAULT_BUFFER_MAX = 5_000;

class Uplink extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.parentUrl      operator-supplied. ⚠️ There is NO default and no fallback (I9).
   * @param {string} opts.edgeToken
   * @param {string} opts.nodeId
   * @param {(url: string, options: object) => object} opts.connect  socket.io-client's `io`
   * @param {boolean} [opts.tlsVerify=true]
   */
  constructor({ parentUrl, edgeToken, nodeId, connect, tlsVerify = true,
                bufferMax = DEFAULT_BUFFER_MAX, rand = Math.random, logger = console,
                onRead = null, onWrite = null, onContentOffer = null, onContentPurge = null }) {
    super();
    if (!parentUrl) throw new Error('An uplink needs a parent URL. There is no default address.');
    if (!edgeToken) throw new Error('An uplink needs an edge token.');
    if (typeof connect !== 'function') throw new Error('An uplink needs a socket.io client factory.');

    this.parentUrl = parentUrl;
    this.edgeToken = edgeToken;
    this.nodeId = nodeId;
    this.connect = connect;
    this.tlsVerify = tlsVerify;
    this.bufferMax = bufferMax;
    this.rand = rand;
    this.log = logger;
    // Optional: with no handler the child simply refuses every read, which is the correct default
    // for a node that has not opted into being readable.
    this.onRead = onRead;
    // Same default and same reason: with no handler the child refuses every write, which is correct
    // for a node whose operator has not granted one.
    this.onWrite = onWrite;
    /*
     * ⚠️ DESTRUCTURED ABOVE, and that is not a formality. The last handler added here was assigned
     * from `opts.onContentOffer`-style scope that did not exist, which threw a ReferenceError in the
     * CONSTRUCTOR — on every uplink, on every node. services/mesh-uplink.js catches per edge, so
     * the entire mesh would have gone inert behind one warn line. I made the same mistake again
     * writing this one; the test that merely CONSTRUCTS an Uplink caught it both times.
     */
    this.onContentOffer = onContentOffer;
    this.onContentPurge = onContentPurge;

    this.socket = null;
    this.connected = false;
    this.attempt = 0;
    this.buffer = [];
    this.dropped = 0;
    this.rejected = 0;
    this.lastRejection = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.throttledUntil = 0;

    /*
     * ⚠️ NULL UNTIL THE PARENT SAYS OTHERWISE, and batching stays off until it does. A child that
     * batched unilaterally would be silently ignored by an older parent — `batch` is an unknown type
     * there, so it gets relayed and not stored, and the telemetry vanishes with no error on either
     * side. Assuming a capability is how a mixed-version mesh loses data quietly.
     */
    this.parentCapabilities = null;
  }

  start() {
    /*
     * ⚠️ socket.io's own reconnection is turned OFF in favour of ours. Its built-in backoff is
     * per-socket and has no idea about the herd; ours is jittered and reports its state into the
     * connection view, which is what the child's dashboard has to show. Two competing reconnect
     * loops would also fight, producing a connection that flaps rather than settles.
     */
    /*
     * ⚠️ THE NAMESPACE IS PART OF THE ADDRESS. The parent listens on `/mesh`, deliberately separate
     * from `/device`; dialling the base URL lands on the DEFAULT namespace instead, where no mesh
     * handler exists. socket.io does not error on that — it connects happily and every message
     * vanishes, which is how this first presented: a working socket that delivered nothing.
     *
     * The operator supplies a plain base URL, so the namespace is appended here rather than being
     * something they have to know about.
     */
    const nsUrl = `${String(this.parentUrl).replace(/\/+$/, '')}/mesh`;
    this.socket = this.connect(nsUrl, {
      auth: { edgeToken: this.edgeToken, nodeId: this.nodeId },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
      // Per-edge opt-out for self-signed certs on-prem. On by default and visible in the UI, never
      // buried — an operator who turned this off should be able to see that they did.
      rejectUnauthorized: this.tlsVerify,
    });

    /*
     * ⚠️ THE PARENT MAY ASK; IT MAY NOT TELL. This is the only inbound handler on the child, and the
     * decision about what it will answer is made by the owner of the data (services/mesh-uplink.js
     * via lib/mesh/read-proxy.js), not here. Keeping the transport ignorant of the policy is what
     * stops a future "just add this one endpoint" from quietly widening it.
     */
    this.socket.on('mesh:read', (req, ack) => {
      if (typeof ack !== 'function') return;
      if (!this.onRead) return ack({ ok: false, reason: 'This node does not answer reads.' });
      try {
        Promise.resolve(this.onRead(req || {}))
          .then((r) => ack(r))
          .catch(() => ack({ ok: false, reason: 'Could not read that.' }));
      } catch (e) {
        ack({ ok: false, reason: 'Could not read that.' });
      }
    });

    /*
     * ⚠️ THE SECOND — AND ONLY OTHER — INBOUND HANDLER. Same shape as mesh:read above and for the
     * same reason: this file stays ignorant of the policy. It does not know what a playlist is,
     * whether the parent holds a grant, or which workspace anything belongs to. It hands the
     * request to the owner of the data (services/mesh-uplink.js -> lib/mesh/node-write.js) and
     * returns whatever that decides.
     *
     * The default when no handler is wired is a REFUSAL, not silence — a node that has not been
     * configured to accept writes must say so, because "no response" and "applied" are
     * indistinguishable to a parent holding a timeout.
     */
    this.socket.on('mesh:write', (req, ack) => {
      if (typeof ack !== 'function') return;
      if (!this.onWrite) {
        return ack({ ok: false, reason: 'This server does not accept changes from another server.' });
      }
      try {
        Promise.resolve(this.onWrite(req || {}))
          .then((r) => ack(r))
          .catch(() => ack({ ok: false, reason: 'That change could not be applied.' }));
      } catch (e) {
        ack({ ok: false, reason: 'That change could not be applied.' });
      }
    });

    /*
     * ⚠️ THE THIRD INBOUND HANDLER, and the same shape as the other two on purpose: this file does
     * not know what content is, what a digest proves, or how much disk is left. It hands the offer
     * to the owner of the disk and returns whatever that decides.
     *
     * The default with no handler wired is a REFUSAL rather than silence, for the same reason as
     * mesh:write — "no response" and "stored it" are indistinguishable to a parent holding a
     * timeout, and here the parent would go on to add those files to a playlist.
     */
    this.socket.on('mesh:content-offer', (req, ack) => {
      if (typeof ack !== 'function') return;
      if (!this.onContentOffer) {
        return ack({ ok: false, reason: 'This server does not accept content from another server.' });
      }
      try {
        Promise.resolve(this.onContentOffer(req || {}))
          .then((r) => ack(r))
          .catch((e) => ack({ ok: false, reason: 'That content could not be stored.' }));
      } catch (e) {
        ack({ ok: false, reason: 'That content could not be stored.' });
      }
    });

    /*
     * ⚠️ THE FOURTH AND LAST INBOUND HANDLER, and the only one that removes anything. Same shape as
     * the others: this file does not know what content is or what "still in use" means. It hands
     * the request to the owner of the disk and returns whatever that decides.
     */
    this.socket.on('mesh:content-purge', (req, ack) => {
      if (typeof ack !== 'function') return;
      if (!this.onContentPurge) {
        return ack({ ok: false, reason: 'This server does not accept content changes from another server.' });
      }
      try {
        Promise.resolve(this.onContentPurge(req || {}))
          .then((r) => ack(r))
          .catch(() => ack({ ok: false, reason: 'That could not be applied.' }));
      } catch (e) {
        ack({ ok: false, reason: 'That could not be applied.' });
      }
    });

    /*
     * The parent announces what it can unpack, and its limits are authoritative: a sender's own
     * defaults are a guess about somebody else's box.
     */
    this.socket.on('mesh:hello', (hello) => {
      this.parentCapabilities = hello && typeof hello === 'object' ? hello : null;
      this.emit('parent-hello', this.parentCapabilities);
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this.attempt = 0;
      this.lastError = null;
      this.emit('connected');
      this._flush();
    });

    this.socket.on('connect_error', (err) => {
      // ⚠️ The message is KEPT, not just counted. "connection refused" and "no longer authorised" need
      // completely different actions from an operator, and a bare failure count tells them neither.
      this.lastError = (err && err.message) || 'connection failed';
      this._scheduleRetry();
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      /*
       * ⚠️ FORGOTTEN ON DISCONNECT. The next connection may be to a different parent, or to the same
       * one downgraded — and a stale "it supports batching" would send batches into a node that
       * relays them without storing. Re-announced on every connect, so forgetting costs one round
       * trip and remembering could cost a customer's telemetry.
       */
      this.parentCapabilities = null;
      this.emit('disconnected', reason);
      this._scheduleRetry();
    });
    return this;
  }

  _scheduleRetry() {
    this.connected = false;
    this.attempt += 1;
    const delay = backoffFor(this.attempt, this.rand);
    this.emit('retry-scheduled', { attempt: this.attempt, delayMs: delay, reason: this.lastError });
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try { this.socket.connect(); } catch (e) { this.lastError = e && e.message; this._scheduleRetry(); }
    }, delay);
    // Never hold the process open for an observer.
    if (this._timer.unref) this._timer.unref();
  }

  /** Does the far side understand batches, and how big may they be? */
  batchLimits() {
    const caps = this.parentCapabilities;
    if (!caps || !Array.isArray(caps.supports) || !caps.supports.includes('batch-v1')) return null;
    /*
     * ⚠️ The FIRST encoding both sides can do, in the parent's preference order — and null if there
     * is no overlap, which sends the batch plainly rather than in a format the far side cannot open.
     */
    const theirs = Array.isArray(caps.encodings) ? caps.encodings : [];
    const encoding = theirs.find((e) => envelope.BATCH_ENCODINGS.includes(e)) || null;
    return {
      maxItems: Math.max(1, Math.min(caps.maxBatchItems || envelope.BATCH_LIMITS.maxItems,
                                     envelope.BATCH_LIMITS.maxItems)),
      maxBytes: Math.max(1024, Math.min(caps.maxBatchBytes || envelope.BATCH_LIMITS.maxBytes,
                                        envelope.BATCH_LIMITS.maxBytes)),
      encoding,
    };
  }

  /**
   * Send many observations, batched if the parent can unpack them and singly if not.
   *
   * ⚠️ THE FALLBACK IS THE CURRENT BEHAVIOUR, unchanged. A node talking to an older parent keeps
   * working exactly as it does today rather than degrading in some new way — which is what makes
   * this deployable into a running mesh instead of a coordinated upgrade.
   */
  sendMany(envelopes, { nodeId, ancestry } = {}) {
    const list = (envelopes || []).filter(Boolean);
    if (!list.length) return true;

    const limits = this.batchLimits();
    if (!limits) {
      let ok = true;
      for (const env of list) ok = this.send(env) && ok;
      return ok;
    }

    let ok = true;
    let chunk = [];
    let bytes = 0;

    const flush = () => {
      if (!chunk.length) return;
      ok = this.send(envelope.createBatch({
        originNodeId: nodeId || this.nodeId,
        ancestry: ancestry || [nodeId || this.nodeId],
        originTs: Date.now(),
        items: chunk,
        encoding: limits.encoding,
      })) && ok;
      chunk = [];
      bytes = 0;
    };

    for (const env of list) {
      /*
       * ⚠️ Measured per item and flushed BEFORE the item that would breach the bound, not after.
       * Overshooting by one item is how a batch trips socket.io's maxHttpBufferSize and fails with
       * an error that says nothing about batching.
       */
      const size = JSON.stringify(env).length;
      if (chunk.length >= limits.maxItems || (bytes + size) > limits.maxBytes) flush();
      chunk.push({
        type: env.type,
        body_version: env.body_version,
        origin_ts: env.origin_ts,
        origin_node_id: env.origin_node_id,
        /*
         * ⚠️ THE ITEM'S OWN CHAIN, AND LEAVING IT OUT MADE RELAYING IMPOSSIBLE.
         *
         * This copied a fixed set of fields and ancestry was not one of them, so createBatch — which
         * carries per-item ancestry precisely so a relayed item can be attested, and says so in its
         * own comment — never received the field to carry. Every item arrived with an origin and no
         * path, and the receiver refused it with "a node may only report data from its own subtree".
         *
         * Which was the CORRECT refusal: an item claiming an origin it cannot prove a path to is
         * exactly what that check exists to stop. The bug was that an honest relay could not prove
         * it either, because the proof was dropped one layer below the code written to send it.
         *
         * Costs nothing for the ordinary case: createBatch omits both fields when the item's origin
         * matches the batch's, which is every item a node reports about itself.
         */
        ancestry: env.ancestry,
        body: env.body,
      });
      bytes += size;
    }
    flush();
    return ok;
  }

  /** Queue an envelope for the parent. Returns false only if THIS call had to drop something. */
  send(env) {
    if (this.connected && Date.now() >= this.throttledUntil) {
      this._emit(env);
      return true;
    }
    /*
     * ⚠️ Reports what happened to THIS envelope. It used to `return this.dropped === 0`, a running
     * total — so one drop at any point in the process's life latched the return value to false
     * forever, and a caller logging or counting on it would report loss on every subsequent send
     * that had in fact been buffered fine.
     */
    let droppedHere = false;
    if (this.buffer.length >= this.bufferMax) {
      this.buffer.shift();
      this.dropped += 1;
      droppedHere = true;
    }
    this.buffer.push(env);
    return !droppedHere;
  }

  /**
   * Put an envelope back after a failed or throttled send.
   *
   * ⚠️ BOUNDED, like send(). The re-buffer path used to push directly, so a parent that accepted
   * connections but timed out every emit would grow the buffer past its own limit — the exact
   * condition the limit exists for (I1: an observer's outage must not become the observed node's
   * outage). Newest is dropped here rather than oldest: this envelope has already failed once, and
   * the older ones in the queue are closer to being delivered.
   */
  _requeue(env) {
    if (this.buffer.length >= this.bufferMax) {
      this.dropped += 1;
      return;
    }
    this.buffer.push(env);
  }

  _emit(env) {
    try {
      this.socket.timeout(15_000).emit('mesh:envelope', env, (err, res) => {
        if (err) { this._requeue(env); return; }
        /*
         * ⚠️ A PARTIALLY-ACCEPTED BATCH IS NOT RETRIED. The parent answers per item; a rejection is
         * a statement ABOUT THE PAYLOAD, and re-sending an identical item cannot change it — a child
         * that retried would loop on the same malformed row forever while the good ones behind it
         * waited. Recorded so it is visible rather than silent.
         */
        if (res && res.batch && Array.isArray(res.rejected) && res.rejected.length) {
          this.rejected += res.rejected.length;
          this.lastRejection = res.rejected[0] && res.rejected[0].reason;
          this.log.warn(`[mesh] parent rejected ${res.rejected.length} of a batch: ` +
                        `${this.lastRejection}`);
        }
        if (res && res.throttled) {
          /*
           * ⚠️ Respect the parent's backpressure rather than hammering. The parent already told us
           * how long to wait; ignoring it turns a throttle into a fight, and the child that ignores
           * it hardest wins the most bandwidth — the opposite of what the limit is for.
           */
          this.throttledUntil = Date.now() + (res.retryAfterMs || 1000);
          this._requeue(env);
          return;
        }
        if (res && res.ok) this.lastSyncAt = Date.now();
      });
    } catch (e) {
      this._requeue(env);
    }
  }

  _flush() {
    // Oldest first, so the parent sees the gap in the order it happened.
    const pending = this.buffer.splice(0, this.buffer.length);
    for (const env of pending) {
      if (!this.connected) { this._requeue(env); break; }
      this._emit(env);
    }
  }

  /** What the child's own dashboard renders about this link. */
  status() {
    return {
      parentUrl: this.parentUrl,
      connected: this.connected,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      retryAttempt: this.attempt,
      buffered: this.buffer.length,
      droppedOldest: this.dropped,
      // Surfaced in the connection view: "the parent refused 40 payloads" is a different
      // conversation from "we could not connect", and they must not read the same.
      rejectedByParent: this.rejected,
      lastRejection: this.lastRejection,
      batching: !!this.batchLimits(),
      tlsVerify: this.tlsVerify,
    };
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    try { if (this.socket) this.socket.close(); } catch (e) { /* closing is best-effort */ }
    this.connected = false;
  }
}

module.exports = { Uplink, backoffFor, BACKOFF_BASE_MS, BACKOFF_MAX_MS, DEFAULT_BUFFER_MAX };
