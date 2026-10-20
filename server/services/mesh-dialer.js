'use strict';

/*
 * The REPLICA side of a dial-out edge (lib/mesh/dial-out.js): keep one socket open to each primary
 * this server joined, from here, so the primary never needs a route to us.
 *
 * Once a socket connects it is handed to ws/meshSocket.js (attachDialed) and handled exactly like a
 * socket a primary opened to us: the replica pull loop reads through it, writes go through it, and
 * the primary's reports arrive on it. This file only owns the dialling — when, where, and how often
 * to try again.
 *
 * ⚠️ MUST NEVER HARM THE NODE IT RUNS ON (I1). Every path is wrapped, every timer unref'd, and a
 * primary that is down, wrong or refusing changes nothing but this link's status line.
 *
 * ⚠️ A FRESH SOCKET PER ATTEMPT (forceNew), never socket.connect() again on the old one: attachDialed
 * registers the mesh handlers on the socket it is given, and re-attaching the same object after a
 * reconnect would register every handler twice.
 */

const { backoffFor } = require('../lib/mesh/uplink');
const store = require('../lib/mesh/store');
const pairing = require('../lib/mesh/pairing');

const SWEEP_MS = 60_000;
const nowSec = () => Math.floor(Date.now() / 1000);

function dialEdges(db) {
  try {
    return db.prepare(`SELECT * FROM mesh_edges WHERE direction = 'down' AND transport_direction = 'we-dial'
                          AND revoked_at IS NULL AND dial_token IS NOT NULL AND peer_url IS NOT NULL`).all();
  } catch (e) { return []; }
}

function startMeshDialer(db, { attachDialed, connect, logger = console, rand = Math.random } = {}) {
  const io = connect || require('socket.io-client').io;
  const me = store.ensureNodeIdentity(db);
  const links = new Map();   // edgeId -> { socket, attempt, timer, connected, lastError, peerNodeId, peerUrl }

  function stopLink(edgeId) {
    const l = links.get(edgeId);
    if (!l) return;
    l.stopped = true;
    if (l.timer) clearTimeout(l.timer);
    try { if (l.socket) l.socket.disconnect(); } catch (e) { /* best effort */ }
    links.delete(edgeId);
  }

  function liveEdge(edgeId) {
    const e = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
    return e && e.transport_direction === 'we-dial' && e.dial_token && pairing.edgeIsActive(e, nowSec()) ? e : null;
  }

  function scheduleRetry(l) {
    if (l.stopped) return;
    l.connected = false;
    l.attempt += 1;
    const delay = backoffFor(l.attempt, rand);
    if (l.timer) clearTimeout(l.timer);
    l.timer = setTimeout(() => dial(l), delay);
    if (l.timer.unref) l.timer.unref();
    logger.warn(`[mesh] dial-out to ${l.peerNodeId} failed (attempt ${l.attempt}): ${l.lastError || 'unknown'} — ` +
                `retrying in ${Math.round(delay / 1000)}s`);
  }

  function dial(l) {
    if (l.stopped) return;
    const edge = liveEdge(l.edgeId);
    if (!edge) { stopLink(l.edgeId); return; }
    try { if (l.socket) { l.socket.removeAllListeners(); l.socket.disconnect(); } } catch (e) { /* */ }
    let socket;
    try {
      socket = io(`${String(edge.peer_url).replace(/\/+$/, '')}/mesh-in`, {
        auth: { edgeToken: edge.dial_token, nodeId: me },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        timeout: 10_000,
        rejectUnauthorized: edge.tls_verify !== 0,
      });
    } catch (e) {
      l.lastError = e && e.message;
      scheduleRetry(l);
      return;
    }
    l.socket = socket;
    socket.on('connect', () => {
      if (socket !== l.socket) return;
      l.connected = true;
      l.attempt = 0;
      l.lastError = null;
      const fresh = store.reloadEdge(db, l.edgeId);
      if (!fresh) { stopLink(l.edgeId); return; }
      try { attachDialed(socket, fresh); } catch (e) {
        logger.warn(`[mesh] dial-out attach failed: ${(e && e.stack) || e}`);
      }
    });
    socket.on('connect_error', (err) => {
      if (socket !== l.socket) return;
      // ⚠️ Kept verbatim: "no longer authorised" and "connection refused" need different fixes.
      l.lastError = (err && err.message) || 'connection failed';
      scheduleRetry(l);
    });
    socket.on('disconnect', (reason) => {
      if (socket !== l.socket || l.stopped) return;
      l.lastError = reason || 'disconnected';
      scheduleRetry(l);
    });
  }

  /** Start links for new edges, stop links for edges that went (revoked, expired, re-paired). */
  function refresh() {
    const edges = dialEdges(db);
    const ids = new Set(edges.map((e) => e.id));
    for (const id of [...links.keys()]) if (!ids.has(id)) stopLink(id);
    for (const e of edges) {
      if (links.has(e.id)) continue;
      const l = { edgeId: e.id, peerNodeId: e.peer_node_id, peerUrl: e.peer_url, socket: null, attempt: 0,
                  timer: null, connected: false, lastError: null, stopped: false };
      links.set(e.id, l);
      logger.log(`[mesh] dialling out to ${e.peer_node_id} at ${e.peer_url}`);
      dial(l);
    }
  }

  refresh();
  const sweep = setInterval(() => { try { refresh(); } catch (e) { /* next sweep */ } }, SWEEP_MS);
  if (sweep.unref) sweep.unref();

  return {
    refresh,
    status: () => [...links.values()].map((l) => ({
      edgeId: l.edgeId, node_id: l.peerNodeId, url: l.peerUrl, connected: !!(l.socket && l.socket.connected),
      last_error: l.lastError, attempt: l.attempt,
    })),
    stop() {
      clearInterval(sweep);
      for (const id of [...links.keys()]) stopLink(id);
    },
  };
}

/*
 * The installer's path: REPLICA_JOIN_CODE (+ PRIMARY_URL) in the environment joins once at boot, so a
 * studio PC pairs itself without anyone opening its dashboard. Skipped as soon as an edge to that
 * primary exists, so the code left in the env file afterwards is inert (and single-use anyway).
 */
async function autoJoin(db, config, { logger = console, onJoined } = {}) {
  if (!config.replicaJoinCode || !config.meshAcceptEnrollment) return { skipped: true };
  if (!config.primaryUrl) {
    logger.warn('[mesh] REPLICA_JOIN_CODE is set but PRIMARY_URL is not; cannot join. Set both and restart.');
    return { skipped: true };
  }
  const existing = db.prepare(`SELECT id FROM mesh_edges WHERE direction = 'down' AND transport_direction = 'we-dial'
                                  AND revoked_at IS NULL AND peer_url = ?`).get(config.primaryUrl);
  if (existing) return { skipped: true, already: true };
  const r = await require('../lib/mesh/dial-out').joinPrimary(db, {
    primaryUrl: config.primaryUrl, code: config.replicaJoinCode, roles: config.replicaJoinRoles,
    tlsVerify: config.replicaJoinTlsVerify !== false, config,
  });
  if (!r.ok) {
    logger.warn(`[mesh] could not join ${config.primaryUrl} with REPLICA_JOIN_CODE: ${r.reason}`);
    return r;
  }
  logger.log(`[mesh] joined ${r.primaryName || r.primaryNodeId} as a replica (${r.capabilities.join(', ')})`);
  for (const w of r.warnings || []) logger.warn(`[mesh] ${w}`);
  if (typeof onJoined === 'function') onJoined(r);
  return r;
}

module.exports = { startMeshDialer, autoJoin, dialEdges };
