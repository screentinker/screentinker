'use strict';

/*
 * Scale-out C2 — the REPLICA side of "players on a replica" (docs/scale-out-design.md §6).
 *
 * A replica that declared `terminates-players` on an edge accepts player sockets for the
 * workspaces it copies from that edge's primary. Everything here is about the three things a
 * replica cannot do alone and how it does them anyway:
 *
 *   AUTH   — the replica holds no device_token (blocklisted; never copied). It asks the primary
 *            ONCE per socket: mesh:read GET /api/mesh/verify-device?device_id=&token_hash=, and
 *            caches yes/no for the socket's life. While the primary is unreachable, a device with a
 *            PRIOR verified session on this replica (mesh_player_verdicts, keyed by token hash)
 *            reconnects on that cached verdict; a device this replica has never verified waits.
 *   WRITES — every player event becomes a `player-event` mesh:write to the primary, applied there
 *            by the same function the primary's own socket handler calls. The outbox
 *            (mesh_player_events) is durable and ORDERED per edge; proof-of-play is never thinned
 *            and never dropped; heartbeat-shaped kinds coalesce last-wins by (device, kind).
 *   READS  — assignments, playlist payloads and media URLs come from this node's mirror. This
 *            module does not touch them: ws/deviceSocket.js builds the payload from local rows
 *            exactly as it does for a local screen.
 *
 * ⚠️ I9. Nothing in this file ever tells a player to go somewhere else. A replica that cannot
 * reach its primary makes the player WAIT (device:throttled with a retry), and a replica that does
 * not terminate players says so (read_replica) — it names the primary as information for the
 * setup screen, never as a redirect. test_no_automatic_player_failover_to_primary holds this.
 */

const crypto = require('node:crypto');
const store = require('./store');

const VERIFY_PATH = '/api/mesh/verify-device';
/** How long a player waits before asking again while the primary is unreachable. */
const PRIMARY_WAIT_MS = 15_000;
/*
 * ⚠️ HOW LONG A CACHED VERDICT IS GOOD FOR WITHOUT THE PRIMARY. A verdict is overwritten by every
 * verify the primary answers (a rotated or revoked token answers "no" and the row is dropped), so
 * while the primary is reachable it is never older than the last register. While the primary is
 * UNREACHABLE it is the only thing standing between a stolen old token and a socket, and that
 * window is bounded here: a verdict older than this is not honoured, and the screen waits.
 */
const VERDICT_TTL_S = 7 * 24 * 3600;
/*
 * ⚠️ THE OUTBOX IS BOUNDED, PER EDGE. Ordered, never-thinned proof-of-play is the point — but a
 * replica that queued for a month would fill its disk before the primary came back, and take the
 * mirror (and every attached screen) down with it. Rows older than the age cap are expired; past
 * the row cap new events are refused (counted in status()). Heartbeat-shaped kinds coalesce to one
 * row per device, and debug logs are never queued, so what accumulates is plays — at one 8 s loop
 * a second-long outage the caps below hold roughly a fortnight of a 100-screen site.
 */
const OUTBOX_MAX_ROWS_PER_EDGE = 500_000;
const OUTBOX_MAX_AGE_S = 14 * 24 * 3600;
/** A buffered event is stamped at SEND time; this is how long the primary may take to apply it. */
const OP_TTL_MS = 10 * 60 * 1000;
const DRAIN_BATCH = 50;
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/*
 * Which kinds coalesce (last wins per device) and which are ordered, durable, never dropped.
 * Proof-of-play lives in 'play-event'. 'log' is a live debug stream the primary never persists
 * either, so it is sent when the link is up and dropped when it is not — the one deliberate drop.
 */
const COALESCE_KINDS = new Set(['heartbeat', 'playback-state', 'info', 'ota-status', 'trigger-status', 'screenshot']);
const EPHEMERAL_KINDS = new Set(['log']);

const asList = (v) => (Array.isArray(v) ? v : store.safeParseArray(v));

function terminatesPlayers(edge) {
  const caps = asList(edge.role_capabilities);
  const grant = asList(edge.grant_categories);
  return edge.direction === 'down' && !edge.revoked_at &&
         caps.includes('terminates-players') && caps.includes('serves-dashboard') &&
         grant.includes('workspace-replication');
}

/** The edge to the primary that owns `originNodeId`, if this node terminates players for it. */
function terminatingEdgeFor(db, originNodeId) {
  if (!originNodeId) return null;
  try {
    return db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL AND peer_node_id = ?")
      .all(originNodeId).find(terminatesPlayers) || null;
  } catch (e) { return null; }
}

function terminatingEdges(db) {
  try {
    return db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL").all().filter(terminatesPlayers);
  } catch (e) { return []; }
}

/** The copied workspace a local device row belongs to, or null when the device is this node's own. */
function copiedOriginOf(db, deviceId) {
  try {
    const row = db.prepare(`SELECT w.origin_node_id FROM devices d JOIN workspaces w ON w.id = d.workspace_id
                             WHERE d.id = ? AND w.origin_node_id IS NOT NULL`).get(deviceId);
    return row ? row.origin_node_id : null;
  } catch (e) { return null; }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/* ------------------------------ verdicts ------------------------------ */

function rememberVerdict(db, edge, deviceId, hash) {
  db.prepare(`INSERT INTO mesh_player_verdicts (device_id, edge_id, token_hash, verified_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(device_id) DO UPDATE SET edge_id = excluded.edge_id, token_hash = excluded.token_hash, verified_at = excluded.verified_at`)
    .run(deviceId, edge.id, hash, Math.floor(Date.now() / 1000));
}

function cachedVerdict(db, deviceId, hash, now = Math.floor(Date.now() / 1000)) {
  const row = db.prepare('SELECT edge_id, token_hash, verified_at FROM mesh_player_verdicts WHERE device_id = ?').get(deviceId);
  if (!row) return null;
  if (now - row.verified_at > VERDICT_TTL_S) return null;   // too old to trust without the primary
  try {
    if (!crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) return null;
  } catch (e) { return null; }
  return row;
}

function forgetVerdict(db, deviceId) {
  try { db.prepare('DELETE FROM mesh_player_verdicts WHERE device_id = ?').run(deviceId); } catch (e) { /* */ }
}

/**
 * Ask the primary whether this device + token is one of its own.
 * @returns {{verified:true, workspace_id, paired, name} | {verified:false} | {unreachable:true}}
 */
async function verifyWithPrimary(readFrom, edge, deviceId, hash) {
  let res;
  try {
    res = await readFrom(edge.peer_node_id, {
      path: `${VERIFY_PATH}?device_id=${encodeURIComponent(deviceId)}&token_hash=${hash}`,
      method: 'GET',
    });
  } catch (e) { res = { ok: false, offline: true, reason: e && e.message }; }
  if (!res || !res.ok) {
    // "not connected" and "refused" are different answers (the grant may be missing on the
    // primary); only the first one is something waiting can fix.
    if (res && res.offline) return { unreachable: true, reason: res.reason };
    return { verified: false, reason: (res && res.reason) || 'refused' };
  }
  if (!res.verified) return { verified: false };
  return { verified: true, workspace_id: res.workspace_id || null, paired: !!res.paired, name: res.name || null };
}

/* ------------------------------ outbox ------------------------------ */

const opId = () => crypto.randomUUID();

/**
 * Put one player event on the durable outbox for its primary. Returns the row id, or null when
 * the kind is ephemeral and the caller should send it live or not at all.
 */
const refusedByEdge = new Map();   // edgeId -> count of events refused at the row cap (this process)

function enqueue(db, edge, deviceId, kind, payload) {
  if (EPHEMERAL_KINDS.has(kind)) return null;
  const key = COALESCE_KINDS.has(kind) ? `${edge.id}|${deviceId}|${kind}` : null;
  // A coalescing kind replaces its own row, so it never grows the queue; only new rows are capped.
  if (!key && pendingCount(db, edge.id) >= OUTBOX_MAX_ROWS_PER_EDGE) {
    refusedByEdge.set(edge.id, (refusedByEdge.get(edge.id) || 0) + 1);
    throw new Error(`outbox for ${edge.peer_node_id} is at its cap (${OUTBOX_MAX_ROWS_PER_EDGE} rows); ${kind} refused`);
  }
  const body = JSON.stringify(payload == null ? {} : payload);
  if (key) {
    // Last wins, but the row keeps its place in the order it first took — a coalesced heartbeat
    // never jumps ahead of a play-event that was queued before it.
    const r = db.prepare(`INSERT INTO mesh_player_events (edge_id, device_id, kind, op_id, coalesce_key, payload)
                          VALUES (?, ?, ?, ?, ?, ?)
                          ON CONFLICT(coalesce_key) WHERE coalesce_key IS NOT NULL DO UPDATE SET payload = excluded.payload, op_id = excluded.op_id, attempts = 0, last_error = NULL`)
      .run(edge.id, deviceId, kind, opId(), key, body);
    return r.lastInsertRowid;
  }
  return db.prepare('INSERT INTO mesh_player_events (edge_id, device_id, kind, op_id, payload) VALUES (?, ?, ?, ?, ?)')
    .run(edge.id, deviceId, kind, opId(), body).lastInsertRowid;
}

function pendingCount(db, edgeId) {
  try {
    return edgeId
      ? db.prepare('SELECT COUNT(*) AS n FROM mesh_player_events WHERE edge_id = ?').get(edgeId).n
      : db.prepare('SELECT COUNT(*) AS n FROM mesh_player_events').get().n;
  } catch (e) { return 0; }
}

/**
 * The drain loop: one in-flight write per edge, strictly in row order, retried with backoff and
 * the SAME op id so the primary's idempotency record answers a duplicate. Replies the primary
 * collected while applying (a play-offline ack, say) are handed to `onReply(deviceId, event,
 * payload)` so the local socket hears them.
 */
function createOutbox(db, { writeTo, onReply, logger = console } = {}) {
  const inFlight = new Set();            // edgeId
  const backoffUntil = new Map();        // edgeId -> ms
  let stopped = false;
  let timer = null;

  async function drainEdge(edge) {
    if (stopped || inFlight.has(edge.id)) return;
    if ((backoffUntil.get(edge.id) || 0) > Date.now()) return;
    inFlight.add(edge.id);
    try {
      const rows = db.prepare('SELECT * FROM mesh_player_events WHERE edge_id = ? ORDER BY id ASC LIMIT ?').all(edge.id, DRAIN_BATCH);
      for (const row of rows) {
        if (stopped) return;
        const sentAt = Date.now();
        let payload = {};
        try { payload = JSON.parse(row.payload); } catch (e) { payload = {}; }
        const res = await writeTo(edge.peer_node_id, {
          type: 'player-event', opId: row.op_id, deviceId: row.device_id, kind: row.kind, payload,
          sentAt, notAfter: sentAt + OP_TTL_MS,
        });
        if (res && res.ok) {
          db.prepare('DELETE FROM mesh_player_events WHERE id = ?').run(row.id);
          backoffUntil.delete(edge.id);
          const replies = res.outcome && Array.isArray(res.outcome.replies) ? res.outcome.replies : [];
          for (const r of replies) { try { onReply && onReply(row.device_id, r.event, r.payload); } catch (e) { /* */ } }
          continue;
        }
        if (res && res.indeterminate) {
          // Applied or not — unknown. Same op id next time; the primary answers from its record.
          bump(row, 'no acknowledgement');
          break;
        }
        if (res && res.offline) { bump(row, 'primary unreachable'); break; }
        /*
         * A definite refusal. The grant may have been withdrawn on the primary, or the device may
         * no longer be one it will accept through this edge. The event stays (nothing here decides
         * to drop evidence), the backoff grows, and the reason is visible in status().
         */
        bump(row, (res && res.reason) || 'refused');
        break;
      }
    } catch (e) {
      logger.warn(`[mesh] player outbox for ${edge.peer_node_id}: ${e && e.message}`);
      backoffUntil.set(edge.id, Date.now() + RETRY_BACKOFF_MS[1]);
    } finally {
      inFlight.delete(edge.id);
    }
  }

  function bump(row, error) {
    const attempts = (row.attempts || 0) + 1;
    db.prepare('UPDATE mesh_player_events SET attempts = ?, last_error = ? WHERE id = ?').run(attempts, String(error).slice(0, 200), row.id);
    backoffUntil.set(row.edge_id, Date.now() + RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]);
  }

  /** An ephemeral kind: one attempt, now, never queued — a lost debug line is not evidence. */
  function sendLive(edge, deviceId, kind, payload) {
    const sentAt = Date.now();
    writeTo(edge.peer_node_id, { type: 'player-event', opId: opId(), deviceId, kind, payload: payload || {}, sentAt, notAfter: sentAt + OP_TTL_MS })
      .catch(() => { /* dropped */ });
  }
  /** Drop what is too old to be worth the disk; counted so status() can say so. */
  const expiredByEdge = new Map();
  function expire(edge, now = Math.floor(Date.now() / 1000)) {
    const r = db.prepare('DELETE FROM mesh_player_events WHERE edge_id = ? AND created_at < ?').run(edge.id, now - OUTBOX_MAX_AGE_S);
    if (r.changes) expiredByEdge.set(edge.id, (expiredByEdge.get(edge.id) || 0) + r.changes);
    return r.changes;
  }
  function kick(edge) { drainEdge(edge); }
  /** The primary (re)connected: forget the backoff and drain now. */
  function resume(edge) { backoffUntil.delete(edge.id); return drainEdge(edge); }
  let ticks = 0;
  function tick() {
    if (stopped) return;
    const edges = terminatingEdges(db);
    if (++ticks % 600 === 0) for (const e of edges) { try { expire(e); } catch (err) { /* */ } }   // every ~10 min
    for (const e of edges) drainEdge(e);
  }
  function start() { if (timer) return; timer = setInterval(tick, 1000); if (timer.unref) timer.unref(); }
  function stop() { stopped = true; if (timer) clearInterval(timer); }
  function status() {
    return terminatingEdges(db).map((e) => {
      const oldest = db.prepare('SELECT created_at, last_error, attempts FROM mesh_player_events WHERE edge_id = ? ORDER BY id ASC LIMIT 1').get(e.id);
      return { node_id: e.peer_node_id, pending: pendingCount(db, e.id),
               oldest_age_s: oldest ? Math.max(0, Math.floor(Date.now() / 1000) - oldest.created_at) : 0,
               last_error: oldest ? oldest.last_error : null, attempts: oldest ? oldest.attempts : 0,
               refused_at_cap: refusedByEdge.get(e.id) || 0, expired: expiredByEdge.get(e.id) || 0,
               cap_rows: OUTBOX_MAX_ROWS_PER_EDGE, cap_age_s: OUTBOX_MAX_AGE_S };
    });
  }
  return { kick, resume, tick, start, stop, status, drainEdge, sendLive, expire };
}

/* ------------------------------ socket-side glue ------------------------------ */

let outbox = null;
let readFromRef = null;

/** ws/index wires the mesh conduits in once the namespace exists. */
function attach({ db, readFrom, writeTo, onReply, logger = console }) {
  readFromRef = readFrom;
  outbox = createOutbox(db, { writeTo, onReply, logger });
  outbox.start();
  return outbox;
}
function detach() { if (outbox) outbox.stop(); outbox = null; readFromRef = null; }
function getOutbox() { return outbox; }

/**
 * Forward one event from a replica-attached player to its primary. `localSideEffects(kind, ...)`
 * lets the caller keep the mirror's volatile columns and its own dashboard current — the same
 * columns device-summary writes — so the replica's fleet page does not wait for the round trip.
 */
function forwardEvent(db, edge, deviceId, kind, data, ctx, localSideEffects) {
  try { if (typeof localSideEffects === 'function') localSideEffects(kind, deviceId, data, ctx); } catch (e) { /* mirror is best effort */ }
  if (!outbox) return;
  if (EPHEMERAL_KINDS.has(kind)) {
    // Sent live or not at all; never queued.
    outbox.sendLive && outbox.sendLive(edge, deviceId, kind, data);
    return;
  }
  // Stamped on receipt: the primary records a play at the time it happened here, however long it
  // waited in the outbox (proof-of-play is never thinned; it must not be re-dated either).
  const stamped = { ...(data || {}), ts: Date.now() };
  try { enqueue(db, edge, deviceId, kind, stamped); } catch (e) { console.warn(`[replica] could not queue ${kind} for ${deviceId}: ${e && e.message}`); return; }
  outbox.kick(edge);
}

/**
 * Deliver a command-relay that arrived UP the edge from a primary: the device must be attached
 * HERE, and must belong to a workspace copied from THAT primary (or be an unclaimed row this
 * replica provisioned through it) — a primary can reach the screens it owns and nothing else.
 */
function deliverRelay(db, deviceNs, edge, body) {
  if (!body || !body.device_id || typeof body.event !== 'string') return { ok: false, reason: 'malformed' };
  if (!terminatesPlayers(edge)) return { ok: false, reason: 'edge does not terminate players' };
  const origin = copiedOriginOf(db, body.device_id);
  const verdict = db.prepare('SELECT edge_id FROM mesh_player_verdicts WHERE device_id = ?').get(body.device_id);
  const ours = (origin && origin === edge.peer_node_id) || (verdict && verdict.edge_id === edge.id);
  if (!ours) return { ok: false, reason: 'not a device of that primary' };
  if (!/^device:[a-z0-9-]+$/.test(body.event)) return { ok: false, reason: 'not a player event' };
  const room = deviceNs.adapter.rooms.get(body.device_id);
  if (!room || room.size === 0) return { ok: false, reason: 'not attached here' };
  deviceNs.to(body.device_id).emit(body.event, body.payload == null ? {} : body.payload);
  return { ok: true };
}

module.exports = {
  VERIFY_PATH, PRIMARY_WAIT_MS, VERDICT_TTL_S, OUTBOX_MAX_ROWS_PER_EDGE, OUTBOX_MAX_AGE_S, COALESCE_KINDS, EPHEMERAL_KINDS,
  terminatesPlayers, terminatingEdgeFor, terminatingEdges, copiedOriginOf, tokenHash,
  rememberVerdict, cachedVerdict, forgetVerdict, verifyWithPrimary,
  enqueue, pendingCount, createOutbox,
  attach, detach, getOutbox, forwardEvent, deliverRelay,
  get readFrom() { return readFromRef; },
};
