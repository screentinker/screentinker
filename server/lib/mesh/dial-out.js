'use strict';

/*
 * Scale-out: a replica that DIALS OUT to its primary (docs/scale-out.md, "A replica behind NAT").
 *
 * The ordinary pairing has the primary dial the replica: the replica mints a code, the primary types
 * the replica's address, and from then on the primary holds the socket. That needs a route from the
 * primary to the replica — fine in a data centre, impossible for a PC in a studio behind a router.
 * The directive anticipated this ("transport direction is negotiated per edge … dial-out solves NAT
 * wherever one side is reachable", docs/mesh-directive.md) and this is that, for replicas:
 *
 *   1. On the PRIMARY, an operator mints an INVITE and chooses which workspaces it copies. The
 *      scope is the primary's decision, made at mint time, exactly like a pairing code's grant.
 *   2. On the REPLICA, an operator (or the installer, via REPLICA_JOIN_CODE) gives the primary's
 *      address and the invite, and ticks the roles THIS server takes on (keep media copies, accept
 *      screens). The replica previews the invite, runs the same enrollment checks a code redemption
 *      runs (cycles, depth, duplicate identity, version floor) from its own side, then redeems it.
 *   3. The primary stores a 'they-dial' up edge holding only the token's HASH; the replica stores a
 *      'we-dial' down edge holding the plaintext (dial_token) and keeps a socket open to the
 *      primary's /mesh-in namespace (services/mesh-dialer.js, ws/meshDialIn.js).
 *
 * ⚠️ ONLY THE TCP DIRECTION CHANGES. Over that socket the replica still asks (mesh:read, mesh:write)
 * and the primary still answers and reports (mesh:envelope) — the same handlers, the same re-check
 * of the edge per request, the same grant. Who dialled is a reachability fact and never a permission.
 */

const pairing = require('./pairing');
const capabilities = require('./capabilities');
const grants = require('./grants');
const identity = require('./node-identity');
const store = require('./store');
const { postJson } = require('../post-json');

/*
 * An invite outlives a pairing code (15 min) on purpose: it is typed into an installer on a PC that
 * may be set up days later by someone else. Still single-use, still burned in the transaction that
 * creates the edge, and revocable by simply not being redeemed — the primary lists what it minted.
 */
const INVITE_TTL_S = 7 * 86400;
const EDGE_TOKEN_TTL_S = 365 * 86400;

/** The roles a replica may take on when it joins, on top of the copy itself. */
const JOIN_EXTRA_ROLES = Object.freeze(['caches-content', 'terminates-players']);

const nowSec = () => Math.floor(Date.now() / 1000);

/** The capability set a joining replica declares: always the copy, plus what its operator ticked. */
function joinCapabilities(extra) {
  const wanted = (Array.isArray(extra) ? extra : []).map(String).filter((r) => JOIN_EXTRA_ROLES.includes(r));
  return ['serves-dashboard', ...new Set(wanted), 'consumes-telemetry'];
}

/** This node's own chain — itself plus everything above it. Same rule as routes/mesh-enroll.js. */
function ancestryOf(db) {
  const me = store.ensureNodeIdentity(db);
  const ups = db.prepare("SELECT peer_node_id FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL").all();
  return [me, ...ups.map((u) => u.peer_node_id)];
}

function normalizeBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) {
    return { ok: false, reason: 'That is not a valid address. Include the scheme (https:// or http://) and the host name.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'The address must be http or https.' };
  if (u.username || u.password) return { ok: false, reason: 'Do not put credentials in the address.' };
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * Join a primary from this (replica) node.
 *
 * @returns {Promise<{ok: true, edgeId, primaryNodeId, primaryName, capabilities, grant, workspaces, warnings: string[]}
 *                   | {ok: false, reason: string}>}
 */
async function joinPrimary(db, { primaryUrl, code, roles = [], tlsVerify = true, config, post = postJson } = {}) {
  if (!config || !config.meshAcceptEnrollment) {
    return { ok: false, reason: 'This server is not set up to be a replica. Set MESH_ACCEPT_ENROLLMENT=true and restart it.' };
  }
  const base = normalizeBaseUrl(primaryUrl || config.primaryUrl);
  if (!base.ok) return { ok: false, reason: base.reason };
  const invite = pairing.normalizeCode(code);
  if (!invite) return { ok: false, reason: 'Enter the invite code from the primary server.' };

  const me = store.ensureNodeIdentity(db);
  const version = require('../../package.json').version;
  const caps = joinCapabilities(roles);
  const mine = ancestryOf(db);

  const call = async (path, body) => {
    try {
      const r = await post(`${base.url}${path}`, body, { tlsVerify });
      // retryable: the primary was busy or down, not refusing. A 4xx is an answer and is final.
      if (!r.ok) {
        return { ok: false, reason: (r.json && r.json.error) || `The primary refused (${r.status}).`,
                 retryable: r.status >= 500 || r.status === 429 };
      }
      return { ok: true, json: r.json || {} };
    } catch (e) {
      return { ok: false, retryable: true,
               reason: `Could not reach ${base.url}: ${e && e.message}. Check the address, and that this ` +
                       'server can open a connection to it (no inbound route to this server is needed).' };
    }
  };

  // 1. Who is this, before anything is created on either side.
  const pv = await call('/api/mesh/invite/preview', { code: invite });
  if (!pv.ok) return pv;
  const primary = pv.json;
  if (!primary.nodeId) return { ok: false, reason: 'The primary did not identify itself.' };

  /*
   * 2. The enrollment checks, run from THIS side — the side whose depth, ancestry and identity they
   * protect. Reusing validateEnrollment rather than restating it is the point: a cycle or depth rule
   * fixed there is fixed here. The code itself was checked by the primary; the record passed in is
   * only what lets the shared function reach the checks that matter here.
   */
  const check = pairing.validateEnrollment({
    code: invite,
    codeRecord: { code: invite, expires_at: nowSec() + 60, burned_at: null },
    capabilities: caps,
    grant: Array.isArray(primary.grant) ? primary.grant : [],
    peer: { nodeId: primary.nodeId, version: primary.version, name: primary.nodeName, ancestry: primary.ancestry || [] },
    deps: {
      now: nowSec(),
      thisNodeId: me,
      thisAncestry: mine,
      maxDepth: config.meshMaxDepth,
      minNodeVersion: config.meshMinNodeVersion,
      flags: { acceptEnrollment: config.meshAcceptEnrollment, allowUplink: config.meshAllowUplink },
      mods: { identity, capabilities, grants },
      existingEdgeForPeer: (nodeId) => db.prepare(
        "SELECT id FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down' AND revoked_at IS NULL").get(nodeId),
      newEdgeId: '(new)',
    },
  });
  if (!check.ok) return { ok: false, reason: check.reason };
  // ⚠️ A replica invite carries the copy and nothing that writes. The primary chose it; we verify it.
  if (!check.grant.includes('workspace-replication') || check.grant.some((c) => grants.isWriteCategory(c))) {
    return { ok: false, reason: 'That invite is not a replica invite. Ask for one from "Let a replica connect to this server".' };
  }

  // 3. Redeem. The primary burns the invite and creates its edge in one transaction.
  const rd = await call('/api/mesh/invite/redeem', {
    code: invite, nodeId: me, version, nodeName: store.nodeName(db), ancestry: mine, capabilities: check.capabilities,
  });
  if (!rd.ok) return rd;
  const answer = rd.json;
  if (!answer.edgeToken || answer.primaryNodeId !== primary.nodeId) {
    return { ok: false, reason: 'The primary did not return a usable connection. Mint a new invite and try again.' };
  }

  const edgeId = require('crypto').randomUUID();
  const now = nowSec();
  db.prepare(`INSERT INTO mesh_edges
      (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction,
       tls_verify, peer_version, token_hash, token_expires_at, dial_token, created_at, peer_url, peer_name)
      VALUES (?,?,'down',?,?,'we-dial',?,?,NULL,?,?,?,?,?)
      ON CONFLICT(peer_node_id, direction) DO UPDATE SET
        role_capabilities   = excluded.role_capabilities,
        grant_categories    = excluded.grant_categories,
        transport_direction = 'we-dial',
        tls_verify          = excluded.tls_verify,
        peer_version        = excluded.peer_version,
        token_hash          = NULL,
        token_expires_at    = excluded.token_expires_at,
        dial_token          = excluded.dial_token,
        peer_url            = excluded.peer_url,
        peer_name           = excluded.peer_name,
        revoked_at          = NULL`).run(
    edgeId, primary.nodeId, JSON.stringify(check.capabilities), JSON.stringify(check.grant),
    tlsVerify ? 1 : 0, String(primary.version || ''), now + EDGE_TOKEN_TTL_S, answer.edgeToken, now,
    base.url, answer.primaryName || primary.nodeName || null);
  const row = db.prepare("SELECT id FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down'").get(primary.nodeId);

  // Writes and media fetches go to PRIMARY_URL, which is configuration, not an edge field (I9).
  const warnings = [];
  if (!config.primaryUrl) {
    warnings.push(`PRIMARY_URL is not set, so changes made here are refused and media cannot be fetched. Set PRIMARY_URL=${base.url} and restart.`);
  } else if (config.primaryUrl !== base.url) {
    warnings.push(`PRIMARY_URL is ${config.primaryUrl}, not ${base.url}. Changes and media go to PRIMARY_URL; make them the same and restart.`);
  }

  return {
    ok: true,
    edgeId: row ? row.id : edgeId,
    primaryNodeId: primary.nodeId,
    primaryName: answer.primaryName || primary.nodeName || null,
    capabilities: check.capabilities,
    grant: check.grant,
    workspaces: answer.workspaces === undefined ? null : answer.workspaces,
    warnings,
  };
}

module.exports = { joinPrimary, joinCapabilities, normalizeBaseUrl, INVITE_TTL_S, EDGE_TOKEN_TTL_S, JOIN_EXTRA_ROLES };
