'use strict';

/*
 * Persisting what arrives from below, and getting rid of it again.
 *
 * ⚠️ EVERY WRITE IS AN UPSERT KEYED ON (origin_node_id, …). A child that reconnects and backfills
 * will re-send state it already sent — that is normal, not a fault — and an insert-only design turns
 * an ordinary reconnect into duplicate rows that quietly double every count on the hub's dashboard.
 * Keying on the origin's own identifier also means re-parenting a node changes nothing here (I4).
 *
 * ⚠️ RETENTION IS PER EDGE, ENFORCED HERE, AND IT IS A PROMISE TO SOMEBODY ELSE. A client whose own
 * policy is 30 days can bind the parent to 30 days; holding their data longer than they hold it is a
 * real problem in a regulated environment, and it is the sort of thing that is discovered during an
 * audit rather than by us. So the prune reads the edge's own number rather than a global default.
 */

const { safeParseArray } = require('./store');

/*
 * A name off the wire, made safe to store.
 *
 * ⚠️ THIS IS ANOTHER OPERATOR'S TEXT. It is rendered on our dashboard next to real numbers, so it is
 * capped at the same 60 characters the setter enforces locally (a name is a signpost, and one that
 * can be a kilobyte is a layout attack), stripped of control characters that would let it forge line
 * structure in a log or a table, and returned as null when nothing survives — so an empty-ish name
 * falls through to COALESCE and leaves the previous one alone rather than blanking it.
 */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 60).trim();
  return clean || null;
}

/** Node self-report. */
function upsertNodeHealth(db, { edgeId, originNodeId, body, originTs, receivedAt }) {
  db.prepare(`
    INSERT INTO mesh_mirror_nodes
      (origin_node_id, via_edge_id, node_name, node_version, device_count, devices_online, origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin_node_id) DO UPDATE SET
      via_edge_id    = excluded.via_edge_id,
      node_name      = COALESCE(excluded.node_name, mesh_mirror_nodes.node_name),
      node_version   = excluded.node_version,
      device_count   = excluded.device_count,
      devices_online = excluded.devices_online,
      origin_ts      = excluded.origin_ts,
      received_at    = excluded.received_at,
      -- ⚠️ Hearing from a node CLEARS its stale mark. Without this a node that was disconnected and
      -- later re-paired would stay greyed out forever while cheerfully reporting.
      stale_since    = NULL
  `).run(originNodeId, edgeId, cleanName(body.name), body.version || null, body.device_count ?? null,
         body.devices_online ?? null, originTs ?? null, receivedAt);

  /*
   * ⚠️ AND REFRESH THE EDGE'S OWN IDEA OF WHAT THE PEER RUNS.
   *
   * `mesh_edges.peer_version` was written once, at enrollment, and never again — so it reported
   * whatever the peer happened to be running on pairing day, forever. A BrightSign that took
   * 2.0.0-alpha1 and was demonstrably serving it still showed as alpha0 on the parent, because the
   * only thing that had changed was the truth. The Servers view calls that column "version skew",
   * which makes a frozen value worse than an absent one: it is the field an operator checks to
   * confirm a fleet took an update, and it answers with the past.
   *
   * ⚠️ ONLY FOR THE EDGE'S DIRECT PEER. A node-health report legitimately RELAYS from deeper in the
   * subtree, and a grandchild's version must not be written onto the child's edge. The guard is the
   * `peer_node_id = ?` in the WHERE: for a relayed origin it matches nothing and the update is a
   * no-op, which is the correct answer rather than a special case to remember.
   */
  if (body.version) {
    db.prepare('UPDATE mesh_edges SET peer_version = ? WHERE id = ? AND peer_node_id = ?')
      .run(body.version, edgeId, originNodeId);
  }

  /*
   * ⚠️ AND THE SAME FOR THE NAME, FOR THE SAME REASON.
   *
   * peer_name was written from the introduction at enrollment and never again, so renaming a server
   * changed it everywhere except on the hubs that watch it — which is the only place anybody was
   * going to read it. Refreshed here it stays true, and the identical `peer_node_id = ?` guard keeps
   * a RELAYED grandchild's name off the direct child's edge.
   *
   * ⚠️ COALESCE ABOVE, AND A TRUTHY CHECK HERE, BECAUSE ABSENT IS NOT THE SAME AS BLANK. An older
   * child that does not send a name at all must not blank the name we already have; only a node
   * that actually says something gets to change what it is called.
   */
  const named = cleanName(body.name);
  if (named) {
    db.prepare('UPDATE mesh_edges SET peer_name = ? WHERE id = ? AND peer_node_id = ?')
      .run(named, edgeId, originNodeId);
  }
}

/**
 * Device summary.
 *
 * ⚠️ The hot columns are written from the body when present and left NULL when not. A health-only
 * grant sends no name, so `name` is NULL and that device is un-searchable by name — a documented
 * consequence of the grant, and the empty state has to say so or it reads as a broken search.
 */
function upsertWorkspace(db, { originNodeId, body, originTs, receivedAt }) {
  if (!body || !body.id) return false;
  db.prepare(`
    INSERT INTO mesh_mirror_workspaces
      (origin_node_id, workspace_id, name, organization_name, device_count, origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin_node_id, workspace_id) DO UPDATE SET
      name              = excluded.name,
      organization_name = excluded.organization_name,
      device_count      = excluded.device_count,
      origin_ts         = excluded.origin_ts,
      received_at       = excluded.received_at,
      -- A workspace that reports again is not deleted, whatever a stale tombstone said.
      deleted_at        = NULL
  `).run(originNodeId, body.id, body.name ?? null, body.organization_name ?? null,
         body.device_count ?? null, originTs ?? null, receivedAt);
  return true;
}

function upsertDevice(db, { originNodeId, body, originTs, receivedAt, edgeId }) {
  if (!body || !body.id) return false;
  db.prepare(`
    INSERT INTO mesh_mirror_devices
      (origin_node_id, device_id, name, status, last_heartbeat, body, origin_ts, received_at,
       first_seen_at, workspace_id, edge_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin_node_id, device_id) DO UPDATE SET
      name           = excluded.name,
      workspace_id   = excluded.workspace_id,
      status         = excluded.status,
      last_heartbeat = excluded.last_heartbeat,
      body           = excluded.body,
      origin_ts      = excluded.origin_ts,
      received_at    = excluded.received_at,
      edge_id        = excluded.edge_id,
      -- A device that reports again is not deleted, whatever a stale tombstone said.
      deleted_at     = NULL
      -- ⚠️ first_seen_at is deliberately ABSENT from this SET list, which is what makes it mean
      -- "first", and it is not re-stamped when a tombstoned screen comes back: identity is stable
      -- (I4), so a screen that returns is the same screen and its history still belongs to it.
      -- Rows written before the column existed keep NULL and fall back to received_at in the report,
      -- rather than being back-stamped to now — which would read as "installed today" and quietly
      -- drop the whole existing fleet out of the first report anybody ran.
  `).run(originNodeId, body.id, body.name ?? null, body.status ?? null,
         body.last_heartbeat ?? null, JSON.stringify(body), originTs ?? null, receivedAt,
         receivedAt, body.workspace_id ?? null, edgeId ?? null);
  return true;
}

function upsertAlert(db, { originNodeId, body, originTs, receivedAt }) {
  if (!body || !body.id) return false;
  db.prepare(`
    INSERT INTO mesh_mirror_alerts
      (id, origin_node_id, alert_type, severity, subject_count, subjects, opened_at, closed_at,
       origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      severity      = excluded.severity,
      subject_count = excluded.subject_count,
      subjects      = excluded.subjects,
      -- An alert closing is the update that matters most; everything else about it is immutable.
      closed_at     = excluded.closed_at,
      received_at   = excluded.received_at
  `).run(body.id, originNodeId, body.type, body.severity ?? null, body.subject_count ?? null,
         body.subjects ? JSON.stringify(body.subjects) : null,
         body.opened_at ?? null, body.closed_at ?? null, originTs ?? null, receivedAt);
  return true;
}

function insertPlayLog(db, { originNodeId, body, originTs, receivedAt }) {
  if (!body || !body.id) return false;
  // ⚠️ INSERT OR IGNORE, not upsert: a play event is an immutable historical fact. A re-send during
  // backfill must be a no-op, and anything that "updates" a past play is corrupting evidence.
  db.prepare(`
    INSERT OR IGNORE INTO mesh_mirror_play_logs
      (id, origin_node_id, device_id, content_ref, played_at, duration_ms, origin_ts, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body.id, originNodeId, body.device_id ?? null, body.content_ref ?? null,
         body.played_at ?? null, body.duration_ms ?? null, originTs ?? null, receivedAt);
  return true;
}

/** Route a validated envelope to the right table. */
/*
 * What a child says this hub may do to it. Stored on the EDGE rather than in a mirror table,
 * because it describes the relationship rather than the child's data — and because the one
 * question it answers ("may I offer this operator a Save button?") is asked per edge.
 *
 * ⚠️ Recorded verbatim and trusted for NOTHING except rendering. The child enforces its own grant
 * on every request, re-read live from its own row; a hub that used this to decide anything would be
 * a hub granting itself permission. Shape-checked so a malformed or hostile offer cannot make the
 * hub's UI claim more than the child would honour — and an unparseable one clears the offer rather
 * than leaving a stale, more permissive answer standing.
 */
function recordWriteOffer(db, edge, ctx) {
  const b = ctx.body || {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []);
  const offer = {
    categories: list(b.categories),
    workspaces: list(b.workspaces),
    bytesBudget: Number.isFinite(b.bytesBudget) ? b.bytesBudget : null,
    bytesUsed: Number.isFinite(b.bytesUsed) ? b.bytesUsed : 0,
    at: ctx.receivedAt,
  };
  const empty = !offer.categories.length || !offer.workspaces.length;
  /*
   * ⚠️ Recorded SEPARATELY from the write offer, and not cleared with it. A child may consent to
   * its data travelling further up while granting no write at all — the two are unrelated
   * decisions, and folding them together would silently revoke one by changing the other.
   */
  const sharesUpward = b.shareUpward === true ? 1 : 0;
  db.prepare('UPDATE mesh_edges SET peer_write_offer = ?, peer_shares_upward = ? WHERE id = ?')
    .run(empty ? null : JSON.stringify(offer), sharesUpward, edge.id);
  return true;
}

/*
 * ⚠️ WHERE THIS PAYLOAD CAME FROM, IN HOPS — learned rather than declared.
 *
 * A node cannot tell this hub where it sits in the tree; that would be describing a relationship it
 * is not a party to, and it would be trusting a claim nobody can check. But a payload that has
 * genuinely travelled through a relay carries the path it took, and the receiver already refuses
 * any item whose ancestry does not include the node that handed it over. So the shape is proven by
 * arrival: if this row is here and attested, that route exists.
 *
 * Recorded per node rather than per payload — the question is "how far away is this server", and
 * the answer changes only when the topology does.
 */
function recordNodePath(db, edge, env, receivedAt) {
  const chain = Array.isArray(env && env.ancestry) ? env.ancestry.filter((x) => typeof x === 'string') : [];
  const origin = env && env.origin_node_id;
  if (!origin || origin === edge.peer_node_id) return;      // direct: the edge already says it
  if (!chain.includes(edge.peer_node_id)) return;           // unattested: not ours to record

  /*
   * Hops counted from THIS node: the chain is [origin, …, neighbour], so its length is exactly the
   * number of links back to here. A screen on a directly-paired server is 1; one behind a relay is 2.
   */
  const hops = chain.length;
  try {
    db.prepare(`INSERT INTO mesh_node_paths (node_id, via_edge_id, path, hops, first_seen_at, last_seen_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(node_id) DO UPDATE SET
                  via_edge_id  = excluded.via_edge_id,
                  path         = excluded.path,
                  hops         = excluded.hops,
                  last_seen_at = excluded.last_seen_at`)
      .run(origin, edge.id, JSON.stringify(chain), hops, receivedAt, receivedAt);
  } catch (e) { /* a node with no paths table simply learns no shape */ }
}

function storeEnvelope(db, edge, env, now) {
  const receivedAt = now || Math.floor(Date.now() / 1000);
  recordNodePath(db, edge, env, receivedAt);
  const ctx = { edgeId: edge.id, originNodeId: env.origin_node_id, body: env.body || {},
                originTs: env.origin_ts ? Math.floor(env.origin_ts / 1000) : null, receivedAt };
  switch (env.type) {
    case 'node-health':    upsertNodeHealth(db, ctx); return 'node-health';
    case 'workspace-summary': return upsertWorkspace(db, ctx) ? 'workspace-summary' : null;
    case 'device-summary': return upsertDevice(db, ctx) ? 'device-summary' : null;
    case 'alert-event':    return upsertAlert(db, ctx) ? 'alert-event' : null;
    case 'proof-of-play':  return insertPlayLog(db, ctx) ? 'proof-of-play' : null;
    case 'tombstone':      return markDeleted(db, ctx) ? 'tombstone' : null;
    case 'write-offer':    return recordWriteOffer(db, edge, ctx) ? 'write-offer' : null;
    default:
      // ⚠️ Unknown types are NOT stored. They are relayable (I5) and that is a transport concern —
      // inventing a table for a payload this node cannot interpret would be storing bytes nobody can
      // ever read, and it is how a mirror becomes a landfill.
      return null;
  }
}

/**
 * A device deleted on the child.
 *
 * ⚠️ MARKED, NOT DELETED. Removing the row would rewrite last month's uptime report, and a report
 * that changes retroactively cannot be cited in an invoice dispute. The purge horizon is per edge.
 */
function markDeleted(db, { originNodeId, body, receivedAt }) {
  if (!body || !body.object_id) return false;
  db.prepare(`
    UPDATE mesh_mirror_devices SET deleted_at = ?
     WHERE origin_node_id = ? AND device_id = ?
  `).run(body.deleted_at || receivedAt, originNodeId, body.object_id);
  return true;
}

/** Mark everything from a node as stale, without deleting any of it (disenrollment). */
function markNodeStale(db, originNodeId, now) {
  db.prepare('UPDATE mesh_mirror_nodes SET stale_since = ? WHERE origin_node_id = ?')
    .run(now || Math.floor(Date.now() / 1000), originNodeId);
}

/**
 * Prune one edge's mirrored data to its own retention.
 *
 * ⚠️ CURRENT STATE IS NEVER PRUNED BY AGE. `mesh_mirror_devices` and `mesh_mirror_nodes` hold the
 * LATEST state, so a device that has not changed in six months would be deleted by an age sweep and
 * the screen would vanish from the hub while still hanging on a wall. Only HISTORY — alerts and play
 * logs — ages out. Current state leaves only when its tombstone's purge horizon passes.
 */
function pruneEdge(db, edge, now) {
  const nowSec = now || Math.floor(Date.now() / 1000);
  const out = { alerts: 0, playLogs: 0, tombstoned: 0 };

  if (edge.retention_days > 0) {
    const cutoff = nowSec - edge.retention_days * 86400;
    // Closed alerts only: an alert that is still open is current state however old it is.
    out.alerts = db.prepare(`
      DELETE FROM mesh_mirror_alerts
       WHERE origin_node_id = ? AND closed_at IS NOT NULL AND closed_at < ?
    `).run(edge.peer_node_id, cutoff).changes;

    out.playLogs = db.prepare(`
      DELETE FROM mesh_mirror_play_logs WHERE origin_node_id = ? AND played_at < ?
    `).run(edge.peer_node_id, cutoff).changes;
  }

  if (edge.tombstone_purge_days > 0) {
    const tombCutoff = nowSec - edge.tombstone_purge_days * 86400;
    out.tombstoned = db.prepare(`
      DELETE FROM mesh_mirror_devices
       WHERE origin_node_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?
    `).run(edge.peer_node_id, tombCutoff).changes;
  }

  return out;
}

/** Everything a hub holds from one node — used by purge-on-request after disenrollment. */
function purgeNode(db, originNodeId) {
  const out = {};
  const tx = db.transaction(() => {
    out.devices  = db.prepare('DELETE FROM mesh_mirror_devices WHERE origin_node_id = ?').run(originNodeId).changes;
    out.alerts   = db.prepare('DELETE FROM mesh_mirror_alerts WHERE origin_node_id = ?').run(originNodeId).changes;
    out.playLogs = db.prepare('DELETE FROM mesh_mirror_play_logs WHERE origin_node_id = ?').run(originNodeId).changes;
    out.node     = db.prepare('DELETE FROM mesh_mirror_nodes WHERE origin_node_id = ?').run(originNodeId).changes;
  });
  tx();
  return out;
}

/**
 * ⚠️ FRESHNESS IS JUDGED BY THE EDGE, NOT BY THE ROW'S AGE.
 *
 * A device row an hour old is perfectly current if its node reports hourly and is reachable, and
 * badly out of date if the node dropped ten minutes ago. Reading the row's own timestamp gives the
 * wrong answer in both directions — this is the data behind Phase 3's tri-state, where a WAN blip on
 * one hub link must never paint 400 healthy screens red.
 *
 * @returns {'live'|'stale'|'unknown'}
 */
function freshnessOf(edge, nowSec, staleAfterSec = 600) {
  if (!edge || edge.revoked_at) return 'stale';
  if (!edge.last_sync_at) return 'unknown';   // never synced is not the same as gone quiet
  return (nowSec - edge.last_sync_at) > staleAfterSec ? 'stale' : 'live';
}

function readDevice(db, originNodeId, deviceId) {
  const row = db.prepare(`
    SELECT * FROM mesh_mirror_devices WHERE origin_node_id = ? AND device_id = ?
  `).get(originNodeId, deviceId);
  if (!row) return null;
  let body = {};
  try { body = JSON.parse(row.body || '{}'); } catch (e) { body = {}; }
  return { ...row, body };
}

module.exports = {
  recordNodePath,
  upsertNodeHealth, upsertDevice, upsertAlert, insertPlayLog, storeEnvelope,
  markDeleted, markNodeStale, pruneEdge, purgeNode, freshnessOf, readDevice, safeParseArray,
};
