'use strict';

/*
 * Enrollment: the flow that actually connects two servers.
 *
 * Phase 1 built pairing, validation, transport and storage as modules and tested them thoroughly —
 * but nothing ever called them from an HTTP surface, and nothing constructed an Uplink. The pieces
 * all worked and there was no way for an operator to reach any of them, which is not "complete".
 *
 * ⚠️ THE GRANT IS CHOSEN AT MINT TIME, BY THE SIDE GIVING THE DATA. The hub operator, already
 * authenticated here, decides what a code will grant before it is handed over. Letting the redeeming
 * node ask for its own grant would make enrollment a self-service permission escalation: whoever
 * holds a code could request everything, and the only thing standing between a client's content
 * library and a stranger would be a five-minute expiry.
 *
 * ⚠️ REDEMPTION IS THE ONE UNAUTHENTICATED ROUTE, and the code IS the credential. That is deliberate
 * and it is why the code is CSPRNG, single-use, short-lived, and burned inside the same transaction
 * that creates the edge. A child enrolling has no account on the parent and never will — it is a
 * machine, not a user.
 */

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const pairing = require('../lib/mesh/pairing');
const capabilities = require('../lib/mesh/capabilities');
const grants = require('../lib/mesh/grants');
const identity = require('../lib/mesh/node-identity');
const store = require('../lib/mesh/store');
const edgeStatus = require('../lib/mesh/edge-status');

const nowSec = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID();

/**
 * Who may create an uplink.
 *
 * ⚠️ NOT INSTANCE-OWNER-ONLY ANY MORE, deliberately. A workspace owner should be able to put THEIR
 * workspace under an MSP's hub without the instance owner brokering every relationship — that is the
 * ordinary case in a multi-tenant install, and requiring an escalation for it means it gets done by
 * sharing an admin login instead, which is worse.
 *
 * The blast radius is bounded by the scope check below: whatever they pair, only workspaces they
 * administer travel up, and "all workspaces" stays the instance owner's alone.
 *
 * ⚠️ THE RESIDUAL RISK IS OUTBOUND, NOT INBOUND. Creating an uplink makes this server dial an
 * address the user typed, so a workspace admin can now cause outbound connections from inside the
 * network. normalizeParentUrl() constrains the scheme and rejects embedded credentials, but it does
 * not and cannot restrict the host — an operator's own hub is frequently on a private address, so a
 * blocklist would break the main use case. Worth an allowlist if this is ever exposed to
 * lower-trust roles.
 */
function requireCanShareSomething(db) {
  return (req, res, next) => {
    if (!req.user) return res.status(403).json({ error: 'Not permitted.' });
    if (req.user.role === 'platform_admin') return next();
    let count = 0;
    try {
      count = db.prepare(`SELECT COUNT(*) AS c FROM workspace_members
                           WHERE user_id = ? AND role IN ('owner','admin')`).get(req.user.id).c;
    } catch (e) { count = 0; }
    if (!count) {
      return res.status(403).json({
        error: 'You do not administer any workspace on this server, so there is nothing you could ' +
               'share with another one.',
      });
    }
    return next();
  };
}

/** Minting a code — accepting an observer — stays an instance-level act. */
function requireInstanceOwner(req, res, next) {
  if (!req.user || req.user.role !== 'platform_admin') {
    return res.status(403).json({
      error: 'Connecting this server to another one is an instance-owner action.',
    });
  }
  return next();
}

/**
 * ⚠️ The URL an operator types is normalised and constrained here, not trusted. It becomes an
 * outbound dial target from inside their network, so an unvalidated value is a request-forgery
 * primitive pointed at whatever the server can reach.
 */
function normalizeParentUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) {
    return { ok: false, reason: 'That is not a valid URL. Include the scheme, e.g. https://hub.example.com' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'A mesh address must be http or https.' };
  }
  if (u.username || u.password) {
    // Credentials in the URL would end up in the edge row and in logs.
    return { ok: false, reason: 'Do not put credentials in the address.' };
  }
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * POST some JSON to the other node.
 *
 * ⚠️ node:https RATHER THAN fetch(), for one reason: the per-edge TLS opt-out has to apply to THIS
 * request too. global fetch() offers no way to relax certificate checking without an undici
 * dispatcher, so enrolling into a self-signed on-prem hub failed at the very first call — while the
 * schema, the UI and the socket all promised the opt-out was available. An option that exists
 * everywhere except the one call that has to happen first is not an option.
 *
 * ⚠️ tlsVerify defaults to TRUE and the caller must ask to turn it off. Nothing here infers it from
 * the failure — retrying insecurely after a certificate error is how an opt-out becomes the default.
 */
function postJson(urlStr, body, { tlsVerify = true, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    const payload = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      rejectUnauthorized: tlsVerify,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(text); } catch (e) { json = {}; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json });
      });
    });
    // Bounded: an enrollment that hangs must not hold an operator's request open until a proxy
    // times out and shows them a page with no explanation on it.
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = function meshEnrollRoutes(db, { requireAuth, config, onUplinkChanged }) {
  const router = express.Router();

  const thisNode = () => store.ensureNodeIdentity(db);

  /*
   * This node's own chain: itself, plus everything above it. ⚠️ Used for BOTH the cycle check and
   * the depth check, because it is the half that cannot be lied about by the party enrolling.
   */
  function thisAncestry() {
    const me = thisNode();
    const ups = db.prepare(
      "SELECT peer_node_id FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL").all();
    return [me, ...ups.map((u) => u.peer_node_id)];
  }

  /* ======================= hub side: hand out a code ======================= */

  if (config.meshAcceptEnrollment) {
    router.post('/pair/code', requireAuth, requireInstanceOwner, (req, res) => {
      const caps = capabilities.validateCapabilities(req.body && req.body.capabilities, {
        acceptEnrollment: config.meshAcceptEnrollment,
        allowUplink: config.meshAllowUplink,
      });
      if (!caps.ok) return res.status(400).json({ error: caps.reason });

      const g = grants.validateGrant(req.body && req.body.grant);
      if (!g.ok) return res.status(400).json({ error: g.reason });

      const code = pairing.mintPairingCode();
      const expires = nowSec() + Math.floor(pairing.PAIRING_CODE_TTL_MS / 1000);
      db.prepare(`INSERT INTO mesh_pairing_codes
          (id, code, role_capabilities, grant_categories, client_id, retention_days,
           created_by, created_at, expires_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
        /*
         * ⚠️ STORED NORMALISED, SHOWN PRETTY. mintPairingCode() returns a display form with a
         * hyphen for someone to read aloud, and normalizeCode() strips everything that is not
         * alphanumeric so an operator can retype it any way they like. Storing the display form
         * meant the lookup — which normalises — never matched, and every redemption answered
         * "that code is not valid" about a code that had been minted seconds earlier.
         */
        uid(), pairing.normalizeCode(code),
        JSON.stringify(caps.capabilities), JSON.stringify(g.categories),
        (req.body && req.body.clientId) || null,
        Number(req.body && req.body.retentionDays) || null,
        req.user.id, nowSec(), expires);

      res.json({
        code,
        expiresAt: expires,
        nodeId: thisNode(),
        nodeName: store.nodeName(db),
        grant: g.categories,
        capabilities: caps.capabilities,
        // ⚠️ Spelled out in the response so the operator reads what they are about to hand over
        // BEFORE they paste it into a chat window. A code is a bearer credential.
        grantDescription: grants.describeGrant(g.categories),
      });
    });

    /*
     * Redeem. ⚠️ NO requireAuth — the code is the credential, see the header.
     */
    router.post('/pair/redeem', (req, res) => {
      const body = req.body || {};
      const code = pairing.normalizeCode(body.code);
      const codeRecord = db.prepare('SELECT * FROM mesh_pairing_codes WHERE code = ?').get(code);

      const peer = {
        nodeId: body.nodeId,
        version: body.version,
        // ⚠️ A NAME, capped and sanitised. It is attacker-influenced text from another machine that
        // will be rendered in this server's UI and used to label a relationship, so it is treated
        // like any other remote string: bounded, and never trusted to be unique.
        name: String(body.nodeName || '').trim().slice(0, 60) || null,
        ancestry: Array.isArray(body.ancestry) ? body.ancestry : [],
      };

      const check = pairing.validateEnrollment({
        code,
        codeRecord: codeRecord
          ? { ...codeRecord, expires_at: codeRecord.expires_at, burned_at: codeRecord.burned_at }
          : null,
        capabilities: codeRecord ? JSON.parse(codeRecord.role_capabilities || '[]') : [],
        grant: codeRecord ? JSON.parse(codeRecord.grant_categories || '[]') : [],
        peer,
        deps: {
          now: nowSec(),
          thisNodeId: thisNode(),
          thisAncestry: thisAncestry(),
          maxDepth: config.meshMaxDepth,
          minNodeVersion: config.meshMinNodeVersion,
          flags: { acceptEnrollment: config.meshAcceptEnrollment, allowUplink: config.meshAllowUplink },
          mods: { identity, capabilities, grants },
          existingEdgeForPeer: (nodeId) => db.prepare(
            "SELECT id FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down' AND revoked_at IS NULL")
            .get(nodeId),
          newEdgeId: '(new)',
        },
      });
      if (!check.ok) {
        // 400, not 403: this is a statement about the request, and the refusal text is written to be
        // shown to the operator on the other end verbatim.
        return res.status(400).json({ error: check.reason });
      }

      const { token, tokenHash } = pairing.mintEdgeToken();
      const peerUrl = normalizeParentUrl(body.peerUrl || '');
      const edgeId = uid();

      /*
       * ⚠️ THE CODE IS BURNED IN THE SAME TRANSACTION THAT CREATES THE EDGE. Separately, two nodes
       * redeeming the same code in the same instant both pass the burned check and both get an edge
       * — single-use enforced everywhere except under the concurrency it exists to prevent.
       */
      const commit = db.transaction(() => {
        const burn = db.prepare(
          'UPDATE mesh_pairing_codes SET burned_at = ?, burned_by_node = ? WHERE id = ? AND burned_at IS NULL')
          .run(nowSec(), peer.nodeId, codeRecord.id);
        if (burn.changes !== 1) throw new Error('code-already-burned');

        db.prepare(`INSERT INTO mesh_edges
            (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction,
             retention_days, tls_verify, peer_version, token_hash, token_expires_at, client_id,
             created_at, peer_url, peer_name)
            VALUES (?,?,'down',?,?,'they-dial',?,1,?,?,?,?,?,?,?)`).run(
          edgeId, peer.nodeId,
          JSON.stringify(check.capabilities), JSON.stringify(check.grant),
          codeRecord.retention_days || null, String(peer.version || ''),
          tokenHash, nowSec() + 365 * 86400, codeRecord.client_id || null,
          nowSec(), peerUrl.ok ? peerUrl.url : null, peer.name);
      });

      try {
        commit();
      } catch (e) {
        if (e && e.message === 'code-already-burned') {
          return res.status(400).json({ error: 'That pairing code has already been used.' });
        }
        if (e && /UNIQUE/.test(e.message || '')) {
          return res.status(400).json({
            error: 'This node is already connected here. Revoke the existing connection first.',
          });
        }
        throw e;
      }

      res.json({
        ok: true,
        edgeId,
        // So the child can show WHO it is now reporting to, by name.
        parentName: store.nodeName(db),
        // The one and only time the plaintext token leaves this node.
        edgeToken: token,
        parentNodeId: thisNode(),
        grant: check.grant,
        capabilities: check.capabilities,
        depth: check.resultingDepth,
      });
    });
  }

  /* ======================= child side: report upward ======================= */

  /*
   * ⚠️ CONSENT FROM BELOW IS READABLE WHATEVER THE FLAGS SAY. A node that has a parent must be able
   * to show its operator that it does, exactly what the parent can see, and how to sever it — even
   * if MESH_ALLOW_UPLINK was turned off afterwards. An MSP link the client cannot see or cut is a
   * contract dispute waiting to happen, and hiding it behind the flag that CREATES it would mean the
   * one configuration where it is invisible is the one where somebody turned the flag off to hide it.
   */
  /*
   * What this server can do in the mesh, so the UI can offer only what will work.
   *
   * ⚠️ ASKED, NOT ASSUMED. There is no client-side copy of the flags and there must not be: they
   * live in the environment, and a bundled duplicate drifts the moment somebody changes one — then
   * the UI offers an action that 404s, which is worse than not offering it.
   */
  /**
   * The workspaces this user could offer to a parent.
   *
   * ⚠️ SCOPED TO WHAT THEY ADMINISTER, except for the instance owner. A workspace member pairing a
   * server must not be able to hand a stranger a workspace they merely have login for — that is a
   * privilege escalation wearing the clothes of a convenience, and it is invisible afterwards
   * because the resulting edge looks exactly like a legitimate one.
   */
  /*
   * ============================== NOC: THIS node's graph, nothing further ==============================
   *
   * One poll, O(edges), built from what this node ALREADY holds: its mesh_edges rows, the mirror
   * counts it was sent, its own scale_out status block (routes/status.js — the same numbers, not a
   * second computation) and a few in-memory counters that tick when data actually moves. It reads
   * no row from another node, dials nothing, starts nothing: opening the NOC must not start a
   * snapshot, a cache fill or a mesh read (test_noc_poll_moves_no_data). It is instance-owner only,
   * and exists only where the enrollment router is mounted — a stock install has no route (I7/I8).
   *
   * "Screens" are COUNTS per node (grouped queries, never a per-device scan on the poll); a
   * per-device list is a separate, explicit call the dashboard already has.
   */
  router.get('/noc', requireAuth, requireInstanceOwner, (req, res) => {
    const now = nowSec();
    const me = thisNode();
    const so = (() => { try { return require('./status').scaleOutStatus() || null; } catch (e) { return null; } })();
    const parse = (v) => store.safeParseArray(v);
    const edges = db.prepare("SELECT * FROM mesh_edges WHERE revoked_at IS NULL OR revoked_at > ?").all(now - 24 * 3600);
    const rolesOfCaps = (caps) => caps.filter((c) => ['serves-dashboard', 'terminates-players', 'caches-content', 'relays-for-subtree', 'redistributes-content'].includes(c));
    // Mirror counts per origin, ONE grouped query for every child at once.
    const mirror = new Map();
    try {
      for (const r of db.prepare(`SELECT origin_node_id, COUNT(*) AS total,
                                   SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
                                   SUM(CASE WHEN last_heartbeat IS NULL OR last_heartbeat < ? THEN 1 ELSE 0 END) AS stale
                                   FROM mesh_mirror_devices WHERE deleted_at IS NULL GROUP BY origin_node_id`).all(now - 600)) mirror.set(r.origin_node_id, r);
    } catch (e) { /* no mirror on a leaf */ }
    // Copied-workspace device counts per origin (a replica's own copy), ONE grouped query.
    const copied = new Map();
    try {
      for (const r of db.prepare(`SELECT w.origin_node_id, COUNT(d.id) AS total,
                                   SUM(CASE WHEN d.status = 'online' THEN 1 ELSE 0 END) AS online,
                                   SUM(CASE WHEN d.attached_node_id = ? THEN 1 ELSE 0 END) AS attached_here
                                   FROM devices d JOIN workspaces w ON w.id = d.workspace_id
                                   WHERE w.origin_node_id IS NOT NULL GROUP BY w.origin_node_id`).all(me)) copied.set(r.origin_node_id, r);
    } catch (e) { /* */ }
    let own = { total: 0, online: 0, attached_elsewhere: 0 };
    try {
      own = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
                        SUM(CASE WHEN attached_node_id IS NOT NULL THEN 1 ELSE 0 END) AS attached_elsewhere
                        FROM devices d WHERE ${require('../lib/replica-proxy').LOCAL_ROWS_SQL('d')}`).get();
    } catch (e) { /* */ }

    const nodes = [];
    const links = [];
    const selfRoles = new Set();
    for (const e of edges) {
      const caps = parse(e.role_capabilities);
      const grant = parse(e.grant_categories);
      const peer = { id: e.peer_node_id, name: e.peer_name || null, edgeId: e.id, revoked: !!e.revoked_at, lastSyncAt: e.last_sync_at || null };
      if (e.direction === 'up') {
        // A parent: what it is to us is the role set it declared; we are its child.
        const rep = so && so.replicas ? so.replicas.find((r) => r.node_id === e.peer_node_id) : null;
        const upl = (global.__meshUplinks && typeof global.__meshUplinks.status === 'function' ? global.__meshUplinks.status() : []).find((l) => l.edgeId === e.id) || null;
        if (grant.includes('workspace-replication')) selfRoles.add('primary');
        nodes.push({ ...peer, kind: 'parent', roles: rolesOfCaps(caps), grant, writeGrant: parse(e.write_grant),
          screens: null });
        links.push({
          from: me, to: e.peer_node_id, edgeId: e.id, direction: 'up',
          state: e.revoked_at ? 'revoked' : (upl ? (upl.connected ? 'connected' : 'down') : 'unknown'),
          lastError: upl ? upl.lastError || null : null,
          headRev: so ? so.head_rev : null, ackedRev: rep ? rep.acked_rev : null,
          // Movement counters: change when data moved over this link.
          movement: { head_rev: so ? so.head_rev : null, acked_rev: rep ? rep.acked_rev : null, last_sync_at: e.last_sync_at || null,
                      relayed: require('../lib/mesh/command-relay').relayedCount(e.peer_node_id), buffered: upl ? upl.buffered : null },
        });
      } else {
        const r = so && so.replica_of ? so.replica_of.find((x) => x.node_id === e.peer_node_id) : null;
        if (caps.includes('serves-dashboard')) selfRoles.add('replica');
        if (caps.includes('relays-for-subtree')) selfRoles.add('relay');
        if (caps.includes('consumes-telemetry') || caps.includes('consumes-proof-of-play')) selfRoles.add('hub');
        const m = mirror.get(e.peer_node_id) || null;
        const c = copied.get(e.peer_node_id) || null;
        const pt = require('../lib/mesh/player-termination');
        nodes.push({ ...peer, kind: 'child', roles: rolesOfCaps(caps).length ? ['is served by this node'] : [], grant, capabilitiesHere: rolesOfCaps(caps),
          // Screens: what we hold about that node's screens (mirror), or our copy's rows. Counts only.
          screens: c ? { total: c.total, online: c.online, attachedHere: c.attached_here, stale: Math.max(0, c.total - c.online) }
                     : (m ? { total: m.total, online: m.online, stale: m.stale, attachedHere: 0 }
                          : { total: 0, online: 0, stale: 0, attachedHere: 0 }) });
        const state = e.revoked_at ? 'revoked' : (r ? (r.edge === 'up' ? ((r.lag_s != null && r.lag_s > 60) ? 'lagging' : 'connected') : 'down')
                                                    : (require('../lib/mesh/mirror-store').freshnessOf(e, now) === 'fresh' ? 'connected' : 'down'));
        links.push({
          from: e.peer_node_id, to: me, edgeId: e.id, direction: 'down', state,
          lag_s: r ? r.lag_s : null, phase: r ? r.phase : null, lastAppliedRev: r ? r.last_applied_rev : null, error: r ? r.error : null,
          players: r && r.players ? r.players : null, cache: r && r.cache ? r.cache : null,
          movement: { last_applied_rev: r ? r.last_applied_rev : null, last_sync_at: e.last_sync_at || null,
                      players_sent: r && r.players ? r.players.sent : null, cache_stored: r && r.cache ? r.cache.stored : null,
                      relays_delivered: pt.relaysDelivered(e.id) },
        });
      }
    }
    // Nodes reached through a child: learned from the paths their reports took, counts only.
    let indirect = [];
    try {
      indirect = db.prepare('SELECT node_id, hops, via_edge_id, last_seen_at FROM mesh_node_paths ORDER BY hops, node_id').all()
        .map((r) => { const via = edges.find((e) => e.id === r.via_edge_id); const m = mirror.get(r.node_id) || null;
          return { id: r.node_id, kind: 'indirect', hops: r.hops, via: via ? via.peer_node_id : null, lastSeenAt: r.last_seen_at,
                   name: (db.prepare('SELECT node_name FROM mesh_mirror_nodes WHERE origin_node_id = ?').get(r.node_id) || {}).node_name || null,
                   screens: m ? { total: m.total, online: m.online, stale: m.stale, attachedHere: 0 } : null }; });
    } catch (e) { indirect = []; }
    /*
     * ?node=<id>: the SELECTED node's screens and last alerts — asked once per selection by the
     * dashboard, never on the 3 s poll (the poll test holds that the interval call carries no
     * node). Bounded: 50 rows, stale first, plus how many more; the normal Displays list is where
     * the rest lives. Sources, in order: this node's own rows (LOCAL_ROWS_SQL); a copied
     * workspace's rows (a replica of that node); the mirror rows that node reported (a plain hub).
     */
    let selected = null;
    const want = typeof req.query.node === 'string' ? req.query.node : null;
    if (want) {
      const LIMIT = 50;
      const age = (t) => (t ? Math.max(0, now - t) : null);
      let rows = [], total = 0, alerts = [];
      try {
        if (want === me) {
          const local = require('../lib/replica-proxy').LOCAL_ROWS_SQL('d');
          total = db.prepare(`SELECT COUNT(*) AS n FROM devices d WHERE ${local}`).get().n;
          rows = db.prepare(`SELECT d.id, d.name, d.status, d.last_heartbeat, d.attached_node_id, p.name AS playlist
                               FROM devices d LEFT JOIN device_resolved_playlist r ON r.device_id = d.id LEFT JOIN playlists p ON p.id = r.playlist_id
                              WHERE ${local} ORDER BY (d.status = 'online') ASC, COALESCE(d.last_heartbeat, 0) ASC LIMIT ?`).all(LIMIT);
          alerts = db.prepare(`SELECT a.id, a.metric, a.severity, a.opened_at, a.closed_at, d.name AS device
                                 FROM alert_events a LEFT JOIN devices d ON d.id = a.device_id
                                WHERE a.workspace_id IN (SELECT id FROM workspaces WHERE origin_node_id IS NULL)
                                ORDER BY a.opened_at DESC LIMIT 5`).all();
        } else if (copied.has(want)) {
          total = copied.get(want).total;
          rows = db.prepare(`SELECT d.id, d.name, d.status, d.last_heartbeat, d.attached_node_id, p.name AS playlist
                               FROM devices d JOIN workspaces w ON w.id = d.workspace_id
                               LEFT JOIN device_resolved_playlist r ON r.device_id = d.id LEFT JOIN playlists p ON p.id = r.playlist_id
                              WHERE w.origin_node_id = ? ORDER BY (d.status = 'online') ASC, COALESCE(d.last_heartbeat, 0) ASC LIMIT ?`).all(want, LIMIT);
          alerts = db.prepare(`SELECT a.id, a.metric, a.severity, a.opened_at, a.closed_at, d.name AS device
                                 FROM alert_events a LEFT JOIN devices d ON d.id = a.device_id
                                WHERE a.workspace_id IN (SELECT id FROM workspaces WHERE origin_node_id = ?)
                                ORDER BY a.opened_at DESC LIMIT 5`).all(want);
        } else {
          total = (mirror.get(want) || { total: 0 }).total;
          rows = db.prepare(`SELECT device_id AS id, name, status, last_heartbeat, NULL AS attached_node_id, NULL AS playlist
                               FROM mesh_mirror_devices WHERE origin_node_id = ? AND deleted_at IS NULL
                              ORDER BY (status = 'online') ASC, COALESCE(last_heartbeat, 0) ASC LIMIT ?`).all(want, LIMIT);
          alerts = db.prepare(`SELECT id, alert_type AS metric, severity, opened_at, closed_at, subject_count AS device
                                 FROM mesh_mirror_alerts WHERE origin_node_id = ? ORDER BY opened_at DESC LIMIT 5`).all(want);
        }
      } catch (e) { rows = []; alerts = []; }
      selected = {
        id: want, asOf: now,
        screens: rows.map((d) => ({
          id: d.id, name: d.name || d.id.slice(0, 8), status: d.status || 'unknown', seen_s: age(d.last_heartbeat),
          // Where the screen's socket is: here, on the node that owns it, or on another replica.
          attached: d.attached_node_id ? (d.attached_node_id === me ? 'here' : d.attached_node_id) : (want === me ? 'here' : 'primary'),
          playlist: d.playlist || null,
        })),
        more: Math.max(0, (total || 0) - rows.length),
        alerts: alerts.map((a) => ({ id: a.id, metric: a.metric, severity: a.severity, opened_at: a.opened_at, closed_at: a.closed_at, device: a.device == null ? null : String(a.device) })),
      };
    }

    res.json({
      asOf: now,
      self: { id: me, name: store.nodeName(db), roles: [...selfRoles], screens: { total: own.total || 0, online: own.online || 0, attachedElsewhere: own.attached_elsewhere || 0 } },
      nodes, links, indirect, selected,
      depthCap: config.meshMaxDepth,
    });
  });

  router.get('/shareable-workspaces', requireAuth, (req, res) => {
    const isOwner = req.user && req.user.role === 'platform_admin';
    try {
      const rows = isOwner
        ? db.prepare(`SELECT w.id, w.name, o.name AS organization_name
                        FROM workspaces w LEFT JOIN organizations o ON o.id = w.organization_id`).all()
        : db.prepare(`SELECT w.id, w.name, o.name AS organization_name
                        FROM workspaces w
                        LEFT JOIN organizations o ON o.id = w.organization_id
                        JOIN workspace_members m ON m.workspace_id = w.id
                       WHERE m.user_id = ? AND m.role IN ('owner','admin')`).all(req.user.id);
      res.json({
        workspaces: rows,
        // ⚠️ Only the instance owner may say "all", including workspaces created LATER. Everyone
        // else names a fixed set, so a future workspace is never silently included.
        canShareAll: isOwner,
      });
    } catch (e) {
      res.json({ workspaces: [], canShareAll: isOwner });
    }
  });

  router.get('/capabilities', requireAuth, (req, res) => {
    const rows = db.prepare("SELECT * FROM mesh_edges WHERE direction = 'up'").all();
    res.json({
      nodeId: thisNode(),
      nodeName: store.nodeName(db),
      /*
       * WARNSIGN So the UI can say "defaulted from the hostname" instead of presenting a guess as a
       * decision. An operator who has never named this box should be told that, not shown a filled
       * field that looks deliberate - especially here, where the name is about to be handed to
       * another organisation and shown on their dashboard.
       */
      nodeNameIsDefault: !store.nameWasChosen(db),
      canMint: !!config.meshAcceptEnrollment,
      canEnroll: !!config.meshAllowUplink,
      uplinks: rows.map((e) => ({
        edgeId: e.id,
        parentNodeId: e.peer_node_id,
        parentName: e.peer_name || null,
        parentUrl: e.peer_url,
        sharing: store.safeParseArray(e.grant_categories),
        // ⚠️ null means every workspace, including ones created later. Spelled out rather than
        // rendered as an empty list, which would read as "nothing is shared".
        sharedWorkspaces: e.shared_workspaces ? store.safeParseArray(e.shared_workspaces) : null,
        lastSyncAt: e.last_sync_at ? e.last_sync_at * 1000 : null,
        revoked: !!e.revoked_at,

        /*
         * ⚠️ THE WRITE GRANT TRAVELS WITH THE REST, or the operator cannot see it.
         *
         * consentView() computes every one of these carefully — and was served ONLY by GET /uplink,
         * which nothing calls. The Connect tab reads this route, whose projection had no write
         * fields at all, so a customer who linked read-only last month saw a screen identical to
         * the one they saw before write existed: no grant, no budget, no revoke, no affordance to
         * discover any of it. The route to grant write access existed and had no caller either.
         *
         * Spread from the same function rather than re-derived here, because a second computation
         * of "can this parent control my screens" is a second chance to answer it wrongly.
         */
        ...(() => {
          const view = edgeStatus.consentView(
            { ...e, grant_categories: store.safeParseArray(e.grant_categories) }, Date.now(),
          ) || {};
          return {
            parentCanControlThisNode: !!view.parentCanControlThisNode,
            writeGrant: view.writeGrant || [],
            writeGrantExplained: view.writeGrantExplained || [],
            writeWorkspaces: view.writeWorkspaces || [],
            writeBytesBudget: view.writeBytesBudget ?? null,
            writeBytesUsed: view.writeBytesUsed ?? 0,
            writeBytesRemaining: view.writeBytesRemaining ?? 0,
            shareUpward: !!view.shareUpward,
          };
        })(),
      })),
      /*
       * The catalogue the consent UI renders its checkboxes from — names, plain-language
       * consequences and which ones cost disk. Sent with the state so the two cannot disagree
       * about what a category means.
       */
      writeCategories: grants.WRITE_CATEGORIES,
    });
  });

  /*
   * NAMING THIS SERVER.
   *
   * ⚠️ THE HALF THAT WAS NEVER BUILT. mesh_node.node_name, store.nodeName(), store.setNodeName()
   * and the `nodeName` field in the pairing handshake all shipped together and read as a finished
   * feature. setNodeName had no callers anywhere in the tree, so the name was permanently whatever
   * os.hostname() returned the first time the getter ran: peers displayed it, and nobody could
   * change it. The same shape as the single-device command route - a definition with no way in.
   *
   * ⚠️ IT LIVES HERE, NOT IN THE HUB ROUTER, AND THAT IS THE WHOLE POINT.
   *
   * routes/mesh.js mounts only where MESH_ACCEPT_ENROLLMENT is set - on a hub. But a name matters
   * MOST on a leaf: a site server's name is what its MSP's dashboard displays, so the operator with
   * the strongest reason to set it is the one the hub router does not exist for. Putting it there
   * would have shipped a rename button that appears only for people who already have one.
   *
   * This router mounts wherever a node participates in a mesh at all - either flag, or an existing
   * up-edge - which is exactly the set of installs where the name is visible to somebody else. An
   * install that never touched the mesh has no route and no button, which is I1 working correctly.
   *
   * requireInstanceOwner for the same reason minting a code needs it: this name is displayed by
   * every peer, so it is an instance-level act, not a per-workspace preference.
   */
  router.put('/identity', requireAuth, requireInstanceOwner, (req, res) => {
    const raw = String((req.body && req.body.name) || '');
    /*
     * ⚠️ REFUSED, NOT SILENTLY ABSORBED. setNodeName returns false for a blank name and leaves
     * the old one standing; answering 200 to that would tell the operator a rename happened while
     * every peer in the mesh still shows the old name - and they would have no reason to check.
     */
    if (!raw.trim()) return res.status(400).json({ error: 'A server needs a name.' });
    if (!store.setNodeName(db, raw)) {
      return res.status(500).json({ error: 'Could not save the name.' });
    }
    /*
     * ⚠️ NO BROADCAST, AND THAT IS NOT A GAP. The name rides the next self-report to every peer
     * watching this node (mirror-store.upsertNodeHealth refreshes both the mirror row and the edge),
     * so it converges over exactly the path the data already takes. A bespoke rename push would be a
     * second delivery mechanism to keep correct forever, and it would be the only one able to reach
     * a node this one is not otherwise reporting to - which is a reach it should not have.
     */
    res.json({ ok: true, name: store.nodeName(db) });
  });

  router.get('/uplink', requireAuth, (req, res) => {
    const rows = db.prepare("SELECT * FROM mesh_edges WHERE direction = 'up'").all();
    res.json({
      nodeId: thisNode(),
      canEnroll: !!config.meshAllowUplink,
      uplinks: rows.map((e) => ({
        ...edgeStatus.consentView({ ...e, grant_categories: store.safeParseArray(e.grant_categories) },
                                  Date.now()),
        edgeId: e.id,
        parentNodeId: e.peer_node_id,
        parentUrl: e.peer_url,
        revoked: !!e.revoked_at,
      })),
    });
  });

  if (config.meshAllowUplink) {
    router.post('/uplink', requireAuth, requireCanShareSomething(db), async (req, res) => {
      const parsed = normalizeParentUrl(req.body && req.body.parentUrl);
      if (!parsed.ok) return res.status(400).json({ error: parsed.reason });
      const code = pairing.normalizeCode(req.body && req.body.code);
      if (!code) return res.status(400).json({ error: 'Enter the pairing code from the other server.' });

      const me = thisNode();
      const version = require('../package.json').version;
      const tlsVerify = req.body.tlsVerify !== false;

      /*
       * ⚠️ THE SCOPE IS VALIDATED HERE, AGAINST WHAT THIS USER ADMINISTERS. Sending a list from the
       * browser is a request, not a decision — a non-owner naming a workspace they do not administer
       * must be refused rather than trimmed, because silently narrowing means the operator believes
       * they shared something they did not, and finds out when a report is empty.
       */
      const isOwner = req.user.role === 'platform_admin';
      const shareAll = req.body.shareAllWorkspaces === true;
      if (shareAll && !isOwner) {
        return res.status(403).json({
          error: 'Only the instance owner can share every workspace on this server. Choose the ' +
                 'workspaces you administer instead.',
        });
      }
      let sharedWorkspaces = null;   // ⚠️ null means ALL — see the column comment.
      if (!shareAll) {
        const asked = Array.isArray(req.body.workspaceIds) ? req.body.workspaceIds.map(String) : [];
        if (!asked.length) {
          return res.status(400).json({
            error: 'Choose at least one workspace to share, or share all of them.',
          });
        }
        let allowed = [];
        try {
          allowed = isOwner
            ? db.prepare('SELECT id FROM workspaces').all().map((w) => w.id)
            : db.prepare(`SELECT w.id FROM workspaces w
                            JOIN workspace_members m ON m.workspace_id = w.id
                           WHERE m.user_id = ? AND m.role IN ('owner','admin')`)
                .all(req.user.id).map((w) => w.id);
        } catch (e) { allowed = []; }
        const refused = asked.filter((id) => !allowed.includes(id));
        if (refused.length) {
          return res.status(403).json({
            error: `You do not administer ${refused.length} of the workspaces you selected, so they ` +
                   `cannot be shared. Ask their owner to pair, or select only your own.`,
          });
        }
        sharedWorkspaces = asked;
      }

      let answer;
      try {
        const r = await postJson(`${parsed.url}/api/mesh/pair/redeem`, {
          code, nodeId: me, version,
          nodeName: store.nodeName(db),
          ancestry: thisAncestry(),
          // So the parent can deep-link back to objects here. Optional: a node behind NAT simply
          // has no useful address to give, and the hub renders a dash rather than a broken link.
          peerUrl: req.body.selfUrl || null,
        }, { tlsVerify });
        answer = r.json || {};
        if (!r.ok) return res.status(400).json({ error: answer.error || `The other server refused (${r.status}).` });
      } catch (e) {
        return res.status(400).json({
          error: `Could not reach ${parsed.url}: ${e && e.message}. Check the address is reachable ` +
                 `from this server, and that the other side has MESH_ACCEPT_ENROLLMENT set.`,
        });
      }

      if (!answer || !answer.edgeToken) {
        return res.status(400).json({ error: 'The other server did not return a token.' });
      }

      /*
       * ⚠️ STRIP ANY WRITE CATEGORY THE PEER SENT. This row is the parent's own answer, and it is
       * about to become the permission this node enforces against itself. For reads that is
       * defensible — every read category is read-only by construction. A write category arriving
       * this way would be the parent granting itself the ability to change our screens, which we
       * would then enforce faithfully. So the wire cannot put one here, ever: write lives in
       * write_grant, set only by an operator on this node.
       *
       * Silent stripping would be its own failure ("never accept-and-silently-degrade"), so the
       * response says plainly that it was refused and how a write grant is actually obtained.
       */
      const offered = Array.isArray(answer.grant) ? answer.grant : [];
      const readOnlyGrant = offered.filter((c) => !grants.isWriteCategory(c));
      const refusedWrites = offered.filter((c) => grants.isWriteCategory(c));

      db.prepare(`INSERT INTO mesh_edges
          (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction,
           tls_verify, peer_version, up_token, client_id, created_at, peer_url, peer_name,
           shared_workspaces)
          VALUES (?,?,'up',?,?,'we-dial',?,?,?,NULL,?,?,?,?)
          ON CONFLICT(peer_node_id, direction) DO UPDATE SET
            peer_name         = excluded.peer_name,
            shared_workspaces = excluded.shared_workspaces,
            grant_categories = excluded.grant_categories,
            up_token         = excluded.up_token,
            peer_url         = excluded.peer_url,
            tls_verify       = excluded.tls_verify,
            revoked_at       = NULL`).run(
        /*
         * ⚠️ write_grant and write_scope are absent from BOTH the column list and the DO UPDATE
         * clause, on purpose. Re-pairing therefore cannot widen — or narrow — a write grant, and an
         * operator who re-pairs to fix a stale token does not silently hand over more than they did
         * the first time. Only the consent route touches those two columns.
         */
        uid(), answer.parentNodeId,
        JSON.stringify(answer.capabilities || []), JSON.stringify(readOnlyGrant),
        tlsVerify ? 1 : 0, null, answer.edgeToken, nowSec(), parsed.url, answer.parentName || null,
        sharedWorkspaces ? JSON.stringify(sharedWorkspaces) : null);

      if (typeof onUplinkChanged === 'function') onUplinkChanged();
      res.json({
        ok: true,
        parentNodeId: answer.parentNodeId,
        grant: readOnlyGrant,
        // Shown back to the operator: what they just agreed to share, in words.
        grantDescription: grants.describeGrant(readOnlyGrant),
        // Nothing on this node can write until its operator says so, separately and explicitly.
        writeGrant: [],
        ...(refusedWrites.length ? {
          refusedWrites,
          refusedWritesReason:
            `This server refused ${refusedWrites.join(', ')}: a write permission is chosen here, by ` +
            'you, not by the server asking for it. The connection was made read-only. You can grant ' +
            'write access afterwards from this page if you decide to.',
        } : {}),
      });
    });
  }

  /*
   * Sever, from below. ⚠️ NOT gated on meshAllowUplink — see the note on GET above. Turning the flag
   * off must never be able to strand a node in a link it cannot cut.
   */
  /*
   * ⚠️ Severing is deliberately available to anyone who could have created one. A link you can make
   * but cannot cut is the shape of the problem consent-from-below exists to prevent.
   */
  /*
   * ─── WRITE CONSENT, and the only route that may set it ────────────────────────────────────────
   *
   * ⚠️ THE ENTIRE POINT OF THIS ROUTE IS WHERE IT LIVES. It is on the node whose screens would
   * change, authenticated as an operator of that node, and it takes nothing from any peer message.
   * `grant_categories` is authored by the parent when it mints a pairing code; if writes were
   * carried there, a parent would be writing its own permission into this database — and this node
   * would then enforce it faithfully, which is worse than not enforcing it at all, because the
   * consent view would look correct while being a lie.
   *
   * PUT sets the whole grant, rather than adding to it, so revocation and narrowing are the same
   * operation as granting: send the categories you want to hold now. Sending `[]` revokes write
   * while leaving the connection — and the reporting it carries — completely intact. Severing the
   * edge must never be the only way to stop writes, or an operator under pressure has to choose
   * between being written to and being monitored at all.
   *
   * SCOPE IS REQUIRED. A write grant with no workspaces is refused rather than stored as "all":
   * the column means nothing when empty, deliberately the opposite of shared_workspaces, because a
   * permission that becomes total by being unset is how this goes wrong quietly.
   */
  router.put('/uplink/:id/write-grant', requireAuth, requireCanShareSomething(db), (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE id = ? AND direction = 'up'").get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'No such connection.' });
    if (edge.revoked_at) return res.status(409).json({ error: 'This connection has been severed.' });

    const categories = req.body && req.body.categories;
    const check = grants.validateWriteConsent(Array.isArray(categories) ? categories : []);
    if (!check.ok) return res.status(400).json({ error: check.reason, rejected: check.rejected });

    // Revoking: no scope needed, and the scope is cleared with it so a later re-grant cannot
    // silently inherit workspaces the operator picked months ago for a different arrangement.
    if (check.categories.length === 0) {
      db.prepare(`UPDATE mesh_edges SET write_grant = NULL, write_scope = NULL,
                  write_bytes_budget = NULL WHERE id = ?`).run(edge.id);
      if (typeof onUplinkChanged === 'function') onUplinkChanged();
      return res.json({
        ok: true, categories: [], workspaces: [],
        note: 'Write access revoked. This server keeps reporting upward exactly as before; anything ' +
              'already pushed here stays until you remove it.',
      });
    }

    const wanted = Array.isArray(req.body.workspaces) ? req.body.workspaces : [];
    if (!wanted.length) {
      return res.status(400).json({
        error: 'Choose which workspaces this server may write to. A write grant with no workspaces ' +
               'is not granted — it is refused.',
      });
    }
    /*
     * ⚠️ AGAINST THE CALLER'S OWN WORKSPACES, NOT EVERY WORKSPACE ON THE SERVER.
     *
     * This read `SELECT id FROM workspaces` — the whole box — while the route is gated only by
     * "administers at least one workspace". So any workspace admin could hand a hub write access
     * to someone ELSE's workspace on a shared server: strictly more power than POST /uplink, which
     * grants only visibility and correctly checks owner/admin membership per workspace. The route
     * giving away more had the weaker check.
     *
     * Same query as the enrolment path, and the instance owner keeps the wider set for the same
     * reason they do there.
     */
    const isOwner = req.user && req.user.role === 'platform_admin';
    let mineRows = [];
    try {
      mineRows = isOwner
        ? db.prepare('SELECT id FROM workspaces').all()
        : db.prepare(`SELECT w.id FROM workspaces w
                        JOIN workspace_members m ON m.workspace_id = w.id
                       WHERE m.user_id = ? AND m.role IN ('owner','admin')`).all(req.user.id);
    } catch (e) { mineRows = []; }
    const mine = new Set(mineRows.map((w) => w.id));
    const foreign = wanted.filter((w) => !mine.has(w));
    if (foreign.length) {
      return res.status(400).json({
        // Deliberately does not distinguish "does not exist here" from "not yours" — the same
        // reasoning as the write door's single refusal string.
        error: `${foreign.length === 1 ? 'That workspace is' : 'Those workspaces are'} not yours ` +
               'to grant on this server.', rejected: foreign,
      });
    }

    /*
     * ⚠️ A BYTE BUDGET IS REQUIRED FOR content-push, and refused when absent — the same rule as
     * scope, for the same reason.
     *
     * Scope answers "whose screens"; this answers "how much of my disk". An operator is only ever
     * asked the first question, so the second gets answered by default unless it is asked out loud
     * — and the default is "all of it". A full disk on a signage server is a cross-tenant outage,
     * and it is the customer's disk, not the hub's.
     */
    let budget = null;
    if (check.categories.includes('content-push')) {
      budget = Number(req.body.bytes_budget);
      if (!Number.isFinite(budget) || budget <= 0) {
        return res.status(400).json({
          error: 'Set how much space this server may use for content it sends you. Sending content ' +
                 'means storing it here, and a limit with no number is not a limit.',
        });
      }
      const used = Number(edge.write_bytes_used) || 0;
      if (budget < used) {
        return res.status(400).json({
          error: `That is less than the ${grants.describeBytes(used)} already stored from this ` +
                 'connection. Remove some of it first, or set a larger limit — lowering the number ' +
                 'does not delete anything on its own.',
        });
      }
    }

    db.prepare(`UPDATE mesh_edges SET write_grant = ?, write_scope = ?, write_bytes_budget = ?
                WHERE id = ?`)
      .run(JSON.stringify(check.categories), JSON.stringify([...new Set(wanted)]), budget, edge.id);
    if (typeof onUplinkChanged === 'function') onUplinkChanged();
    res.json({
      ok: true,
      categories: check.categories,
      workspaces: [...new Set(wanted)],
      bytesBudget: budget,
      // The consequence text belongs to whoever is giving something up, which is this operator —
      // with the byte figure spelled out, because "up to the limit you set" is only meaningful if
      // the number is shown next to it.
      consequences: [
        ...grants.describeGrant(check.categories),
        ...(budget ? [`It may use up to ${grants.describeBytes(budget)} of storage on this server.`] : []),
      ],
      note: 'You can narrow or revoke this at any time without disconnecting.',
    });
  });

  /*
   * ⚠️ WHAT THIS OTHER SERVER HAS ACTUALLY DONE HERE — the question a customer asks first and could
   * not ask at all.
   *
   * mesh_write_ops looks like it should answer it and cannot: it is an idempotency ledger, with no
   * path, no method, no actor, and nothing that reads it. So an operator could grant write access
   * and then have no way to find out what was done with it — on the very page where they granted it.
   *
   * ⚠️ REFUSALS ARE INCLUDED, and they are the more useful half. After narrowing a grant, the thing
   * an operator wants to see is what has been TRIED and stopped; a list of successes describes the
   * relationship as it was permitted rather than as it was attempted.
   *
   * Scoped to this edge's peer by matching the audit line's own description of it, because
   * activity_log has no column for "which peer" — the alternative was a schema change to answer a
   * question the text already answers. Bounded and read-only.
   */
  /*
   * ⚠️ MAY THIS PARENT PASS WHAT WE SEND IT FURTHER UP?
   *
   * A separate decision from every other one on this page, and it has to be, because it is the only
   * one that concerns a server this operator has no relationship with. Sharing with an MSP is a
   * choice about the MSP; sharing with whoever the MSP reports to is a choice about a stranger, and
   * collapsing them would mean agreeing to the second by making the first.
   *
   * Nothing infers it and nothing else sets it: absent means no, so every link made before relaying
   * existed stays one hop until somebody says otherwise. Revocable the same way — set it false and
   * the parent stops including this node's screens in its own reports on the next tick.
   */
  router.put('/uplink/:id/share-upward', requireAuth, requireCanShareSomething(db), (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE id = ? AND direction = 'up'").get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'No such connection.' });
    const allow = req.body && req.body.allow === true;
    db.prepare('UPDATE mesh_edges SET share_upward = ? WHERE id = ?').run(allow ? 1 : 0, edge.id);
    if (typeof onUplinkChanged === 'function') onUplinkChanged();
    res.json({
      ok: true,
      shareUpward: allow,
      note: allow
        ? 'That server may now include your screens in the reports it sends to its own parent. ' +
          'They will see what you already share here, attributed to this server.'
        : 'That server will stop including your screens in its own reports. Anything it has ' +
          'already passed on stays with whoever received it until they purge it.',
    });
  });

  router.get('/uplink/:id/activity', requireAuth, requireCanShareSomething(db), (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE id = ? AND direction = 'up'").get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'No such connection.' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const peerId = String(edge.peer_node_id || '').slice(0, 8);
    const rows = db.prepare(`
      SELECT id, action, details, created_at, workspace_id, was_acting_as
        FROM activity_log
       WHERE action IN ('mesh:write', 'mesh:content-push')
         AND details LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`).all(`%${peerId}%`, limit);

    res.json({
      peerNodeId: edge.peer_node_id,
      peerName: edge.peer_name || null,
      entries: rows.map((r) => ({
        id: r.id,
        at: r.created_at ? r.created_at * 1000 : null,
        kind: r.action === 'mesh:content-push' ? 'content' : 'change',
        // The full sentence as it was recorded, including whether it applied or was refused and
        // who that server said asked for it.
        what: r.details || '',
        applied: /— applied/.test(r.details || ''),
        workspaceId: r.workspace_id || null,
      })),
      /*
       * ⚠️ Says out loud what this list is NOT. Changes made by this server's own operators are in
       * the ordinary activity view; a customer reading a short list here should not conclude the
       * hub has been quiet if they were looking for something else entirely.
       */
      note: 'Only changes requested by that server appear here. Anything done on this server by ' +
            'your own team is in the main activity log.',
    });
  });

  /*
   * ⚠️ WHAT THIS SERVER IS STORING FOR ANOTHER ONE — and which of it nothing plays any more.
   *
   * Deleting hub-pushed content already works and is already the RIGHT shape: the rows live in the
   * customer's own workspace, their own operator can remove them through their own library, and the
   * purge refunds the storage allowance. A hub can stop referencing a file; it can never delete
   * bytes here. Remote-triggered unlink is the highest-blast-radius verb this design could have
   * grown, and it deliberately did not grow it.
   *
   * What was missing is the only thing that made that useless: nothing showed which content came
   * from a hub, how much room it takes, or which of it is now unreferenced. The consent panel said
   * "18 GB of 20 GB used" and gave the operator no way to find out what the 18 GB was — so the
   * budget could only ever go up in practice, however correct the refund was.
   *
   * "Unused" means no playlist item and no published snapshot mentions it. Both, because a snapshot
   * outlives the items it was built from — offering to remove something a screen is still playing
   * from its published copy is exactly the mistake this list exists to prevent.
   */
  router.get('/uplink/:id/content', requireAuth, requireCanShareSomething(db), (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE id = ? AND direction = 'up'").get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'No such connection.' });

    const rows = db.prepare(`
      SELECT p.origin_content_id, p.bytes, p.last_seen_at,
             c.id AS local_id, c.filename, c.file_size, c.workspace_id, c.filepath
        FROM mesh_content_provenance p
        JOIN content c ON c.id = p.local_content_id
       WHERE p.origin_node_id = ?
       ORDER BY c.file_size DESC
       LIMIT 500`).all(edge.peer_node_id);

    const referenced = (contentId) => {
      const item = db.prepare('SELECT 1 FROM playlist_items WHERE content_id = ? LIMIT 1').get(contentId);
      if (item) return true;
      const snap = db.prepare(
        "SELECT 1 FROM playlists WHERE published_snapshot LIKE ? LIMIT 1").get(`%${contentId}%`);
      return !!snap;
    };

    const items = rows.map((r) => ({
      localId: r.local_id,
      filename: r.filename,
      bytes: r.file_size || r.bytes || 0,
      workspaceId: r.workspace_id,
      receivedAt: r.last_seen_at ? r.last_seen_at * 1000 : null,
      inUse: referenced(r.local_id),
    }));

    res.json({
      peerNodeId: edge.peer_node_id,
      peerName: edge.peer_name || null,
      items,
      totalBytes: items.reduce((n, i) => n + i.bytes, 0),
      unusedBytes: items.filter((i) => !i.inUse).reduce((n, i) => n + i.bytes, 0),
      /*
       * ⚠️ Says where deletion happens, because the obvious assumption is that it happens here.
       * It does not, and that is the design: this page reports, the library removes.
       */
      note: 'Remove anything you no longer want from your own content library — the space it was ' +
            'using is returned to this connection\'s allowance. That server cannot delete files here.',
    });
  });

  router.delete('/uplink/:id', requireAuth, requireCanShareSomething(db), (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE id = ? AND direction = 'up'").get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'No such connection.' });
    /*
     * ⚠️ THE WRITE GRANT GOES WITH IT. Severing used to null only the token, leaving write_grant,
     * write_scope and write_bytes_budget on the row — and the enrolment upsert sets revoked_at =
     * NULL on conflict, so re-pairing the same peer silently RESTORED write access to workspaces
     * the operator had chosen months earlier, while the response cheerfully reported
     * `writeGrant: []` and "the connection was made read-only".
     *
     * The partial-revoke path already clears all three and says why: so a later re-grant cannot
     * inherit an old choice. Severing is the stronger act and had the weaker cleanup. The note in
     * the enrolment path claiming re-pairing cannot widen a grant was true only for an edge that
     * had never been revoked; against a revoked one, un-revoking IS the widening.
     *
     * write_bytes_used is deliberately left alone — it is a record of what is still stored here,
     * not a permission, and zeroing it would lose track of bytes that are still on the disk.
     */
    db.prepare(`UPDATE mesh_edges SET revoked_at = ?, up_token = NULL,
                write_grant = NULL, write_scope = NULL, write_bytes_budget = NULL
                WHERE id = ?`).run(nowSec(), edge.id);
    if (typeof onUplinkChanged === 'function') onUplinkChanged();
    res.json({
      ok: true,
      // ⚠️ Says plainly what severing does and does NOT do. The parent keeps what it already
      // received; pretending otherwise would be the more comfortable answer and the false one.
      note: 'This server has stopped reporting upward, and any write access it had is revoked. ' +
            'Data already sent is still held by the other server until it purges it — ask them to ' +
            'purge if that matters.',
    });
  });

  return router;
};
