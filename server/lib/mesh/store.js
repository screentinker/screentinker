'use strict';

/*
 * The database side of the mesh: this node's identity, and the edges it holds.
 *
 * ⚠️ EVERY FUNCTION HERE IS A NO-OP UNLESS THE MESH TABLES EXIST AND A FLAG IS ON. This module is
 * required at boot, so it must be safe on an install that has never heard of the mesh — that is the
 * "invisible by default" guarantee (I1), and it is easy to break by assuming a table.
 */

const os = require('os');
const { newNodeId } = require('./node-identity');

/**
 * This server's own friendly name, as declared to peers when pairing.
 *
 * ⚠️ Defaults to the host name rather than to the node id. An operator pairing two servers is
 * looking at a screen that has to distinguish them, and "screentinker-hq" does that while
 * "bd5f5179-49dd-…" does not — the id is what the machines use, and it is not what anybody calls
 * the box. Stored once so a later hostname change cannot silently rename an existing relationship.
 */
function nodeName(db) {
  try {
    const row = db.prepare('SELECT node_name FROM mesh_node WHERE singleton = 1').get();
    if (row && row.node_name) return row.node_name;
    const fallback = (os.hostname() || 'ScreenTinker').split('.')[0];
    db.prepare('UPDATE mesh_node SET node_name = ? WHERE singleton = 1').run(fallback);
    return fallback;
  } catch (e) {
    return null;
  }
}

function setNodeName(db, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return false;
  try {
    /*
     * ⚠️ ENSURE THE ROW FIRST. This is an UPDATE, and an UPDATE that matches nothing succeeds: on a
     * node whose identity had not been materialised yet the setter stored nothing, changed nothing,
     * and reported true — so the route answered 200 and the operator was told a rename happened
     * that had not. ensureNodeIdentity is idempotent and is already the one way a node gets an id,
     * and a name without an identity to hang it on is not a thing that should exist.
     */
    ensureNodeIdentity(db);
    // ⚠️ chose_name IN THE SAME STATEMENT. Recorded separately it can be missed by a second caller,
    // and a name an operator picked would keep being described to them as a hostname default.
    const r = db.prepare('UPDATE mesh_node SET node_name = ?, chose_name = 1 WHERE singleton = 1')
      .run(clean);
    /*
     * ⚠️ UNREACHABLE WHILE THE ensureNodeIdentity ABOVE STANDS, and kept deliberately anyway.
     *
     * Said plainly because a mutation test proved it: flipping this to `return true` does not fail
     * the suite, since the row is guaranteed by then. It is not tested behaviour and should not be
     * read as any — what actually covers this failure is the ensure, and removing THAT does fail.
     * The check stays because the two lines are a pair: if a later edit makes the row conditional
     * again, this is what turns a silent no-op back into an honest false.
     */
    return r.changes === 1;
  } catch (e) {
    return false;
  }
}

/*
 * Whether an operator actually picked this name, as opposed to inheriting the hostname.
 *
 * ⚠️ A STORED FLAG RATHER THAN COMPARING THE NAME TO os.hostname(). That comparison is wrong in both
 * directions: a box renamed at the OS level after pairing would start reporting a chosen name as a
 * default, and an operator who deliberately types the hostname would be told they never decided.
 */
function nameWasChosen(db) {
  try {
    return !!db.prepare('SELECT chose_name FROM mesh_node WHERE singleton = 1').get()?.chose_name;
  } catch (e) {
    return false;
  }
}

/**
 * This node's own id, created on first call and stable forever after.
 *
 * ⚠️ GENERATED LOCALLY, REGISTERED NOWHERE (I7). No licence check, no activation, no registry to be
 * down. An air-gapped install is first-class and cannot be if identity needs the internet.
 *
 * ⚠️ Created LAZILY rather than at boot, so an install with the mesh switched off never writes a row
 * it has no use for. A node that is never paired should be byte-identical to one on 1.9.x.
 */
function ensureNodeIdentity(db) {
  try {
    const row = db.prepare('SELECT node_id FROM mesh_node WHERE singleton = 1').get();
    if (row && row.node_id) return row.node_id;

    const id = newNodeId();
    // INSERT OR IGNORE, not INSERT: two workers booting together would otherwise race, and the
    // CHECK(singleton = 1) means the loser throws rather than being harmlessly redundant.
    db.prepare('INSERT OR IGNORE INTO mesh_node (singleton, node_id, created_at) VALUES (1, ?, ?)')
      .run(id, Math.floor(Date.now() / 1000));
    const after = db.prepare('SELECT node_id FROM mesh_node WHERE singleton = 1').get();
    return after ? after.node_id : id;
  } catch (e) {
    // No table yet (an install that has never migrated) — the mesh simply does not exist here.
    return null;
  }
}

/**
 * Find an edge by the hash of the token a caller presented.
 *
 * ⚠️ Takes the HASH, never the token. The plaintext has no reason to reach this layer, and a
 * signature that accepted one would invite it being logged by a future caller.
 */
function findEdgeByTokenHash(db, tokenHash) {
  if (!tokenHash) return null;
  try {
    const row = db.prepare(`
      SELECT id, peer_node_id, direction, role_capabilities, grant_categories,
             transport_direction, retention_days, tombstone_purge_days, tls_verify,
             peer_version, client_id, created_at, last_sync_at, revoked_at,
             -- ⚠️ token_expires_at MUST be selected, and its absence here was a silent auth bug.
             -- edgeIsActive() gates on it being a number, so a row loaded without the column reads
             -- undefined, the gate skips, and an expired edge token authenticated forever. The unit
             -- tests passed because they build edge objects by hand with the field present; only
             -- the real query omitted it. Anything gated on a field must load that field.
             token_expires_at
        FROM mesh_edges
       WHERE token_hash = ? AND direction = 'down'
    `).get(tokenHash);
    if (!row) return null;
    return {
      ...row,
      // Stored as JSON text; callers expect arrays and must not each re-parse.
      role_capabilities: safeParseArray(row.role_capabilities),
      grant_categories: safeParseArray(row.grant_categories),
    };
  } catch (e) {
    return null;
  }
}

/**
 * Re-read one edge by id, for revalidating a connection that is already open.
 *
 * ⚠️ AUTHORISATION HAS TO BE RE-CHECKED, NOT SNAPSHOTTED AT HANDSHAKE. A mesh socket is long-lived by
 * design — a child dials its parent and stays — so an edge captured at connect time means revocation
 * and token expiry do nothing until the child happens to reconnect, which may be days. "Revoke"
 * that leaves the data flowing is not a revoke, and it is the control an operator reaches for
 * precisely when they have decided a peer should no longer be trusted.
 */
function reloadEdge(db, edgeId) {
  if (!edgeId) return null;
  try {
    const row = db.prepare(`
      SELECT id, peer_node_id, direction, role_capabilities, grant_categories,
             transport_direction, retention_days, tombstone_purge_days, tls_verify,
             peer_version, client_id, created_at, last_sync_at, revoked_at, token_expires_at,
             peer_name
        FROM mesh_edges WHERE id = ?
    `).get(edgeId);
    if (!row) return null;
    return {
      ...row,
      role_capabilities: safeParseArray(row.role_capabilities),
      grant_categories: safeParseArray(row.grant_categories),
    };
  } catch (e) {
    return null;
  }
}

function safeParseArray(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    // ⚠️ A corrupt grant reads as NO grant, never as every grant. Failing closed is the only safe
    // direction when the field decides what leaves this node.
    return [];
  }
}

/** Note that an edge just heard from its peer — what the connection view calls "last synced". */
function touchEdge(db, edgeId, atSeconds) {
  try {
    db.prepare('UPDATE mesh_edges SET last_sync_at = ? WHERE id = ?')
      .run(atSeconds || Math.floor(Date.now() / 1000), edgeId);
    return true;
  } catch (e) {
    return false;
  }
}

/** Every active downward edge, for a parent's own topology view. */
function listChildEdges(db) {
  try {
    return db.prepare(`
      SELECT id, peer_node_id, grant_categories, client_id, last_sync_at, created_at
        FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL
    `).all().map((r) => ({ ...r, grant_categories: safeParseArray(r.grant_categories) }));
  } catch (e) {
    return [];
  }
}

module.exports = {
  ensureNodeIdentity, nodeName, setNodeName, nameWasChosen,
  findEdgeByTokenHash, reloadEdge, touchEdge, listChildEdges, safeParseArray,
};
