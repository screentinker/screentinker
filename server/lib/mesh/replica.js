'use strict';

/*
 * Scale-out, replica side (docs/scale-out-design.md §4–§5).
 *
 * A replica is a mesh PARENT whose `down` edge carries the `serves-dashboard` capability and the
 * `workspace-replication` grant. For each such edge it keeps a full-fidelity copy of the shared
 * workspaces in ITS OWN tables — the same schema, so the unchanged GET handlers serve the dashboard
 * from it — tagged by `workspaces.origin_node_id = <primary's node id>`.
 *
 * Nothing here writes to the primary. Every byte arrives by ASKING (mesh:read, the allowlisted
 * `/api/mesh/snapshot` and `/api/mesh/changes` paths) and the primary decides what to answer from
 * its own edge row. A `change-notice` envelope is only a nudge to ask sooner; a 30 s poll asks
 * anyway, because a lost notice must not mean a stale copy until the next write (silence ≠ success).
 *
 * ⚠️ THE TWO UNCALLED MODULES ARE CALLED HERE. `circuit-breaker.js` wraps every ask so a primary
 * that stopped answering is skipped rather than waited on (I6); `backfill.js` paces the initial copy
 * so a 400-screen snapshot fills the fleet page from the top in seconds rather than blocking it.
 *
 * ⚠️ ORIGIN IDS ARE PRESERVED. Copied rows keep the primary's primary keys; `origin_node_id` on the
 * workspace disambiguates tenancy, so a replica's own workspaces and its copies share pk space
 * without colliding (UUIDs) and a write for a copied row is refused by the workspace tag, never by a
 * key lookup. Two global uniques need a rule: a `users.email` already held by a LOCAL user is never
 * overwritten by a copy (the copy is skipped and logged), and device tokens are blocklisted at the
 * source so they arrive NULL.
 */

const { CircuitBreakers } = require('./circuit-breaker');
const { BackfillQueue, PRIORITY } = require('./backfill');
const replication = require('./replication');
const store = require('./store');

const nowSec = () => Math.floor(Date.now() / 1000);
const POLL_MS = 30_000;
const NOTICE_DEBOUNCE_MS = 250;
const PAGE = 500;

// The edge row arrives as stored (JSON text) from the DB, or already parsed from the socket layer.
const asList = (v) => (Array.isArray(v) ? v : store.safeParseArray(v));

function isReplicaEdge(edge) {
  const caps = asList(edge.role_capabilities);
  const grant = asList(edge.grant_categories);
  return edge.direction === 'down' && !edge.revoked_at &&
         caps.includes('serves-dashboard') && grant.includes('workspace-replication');
}

function replicaEdges(db) {
  try {
    return db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL").all()
      .filter(isReplicaEdge);
  } catch (e) { return []; }
}

/* ============================== applying rows ============================== */

function localColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch (e) { return []; }
}

/**
 * Upsert one copied row. Only columns that exist locally are written (a newer primary may send a
 * column this build lacks — it is dropped, never fatal). The workspace tag is set here and nowhere
 * else, so a workspace row can never arrive untagged.
 */
function upsertRow(db, table, row, originNodeId) {
  const spec = replication.TABLE_BY_NAME[table];
  if (!spec || !row) return { applied: false, reason: 'unknown table' };
  const cols = localColumns(db, table);
  if (!cols.length) return { applied: false, reason: 'table absent locally' };
  const data = {};
  for (const c of cols) if (row[c] !== undefined) data[c] = row[c];
  if (table === 'workspaces') { data.origin_node_id = originNodeId; }
  if (table === 'users') {
    // Never overwrite a LOCAL account with a copy: same email, different id means this replica's
    // operator already has an account here, and a copy carrying no password must not replace it.
    const clash = db.prepare('SELECT id, password_hash FROM users WHERE email = ? AND id <> ?').get(row.email, row.id);
    if (clash) return { applied: false, reason: `email ${row.email} belongs to a local user; copy skipped` };
    for (const c of replication.BLOCKLIST.users) if (c in data) delete data[c];
  }
  const pks = replication.pkCols(spec);
  for (const pk of pks) if (data[pk] === undefined) return { applied: false, reason: `row lacks pk ${pk}` };
  const names = Object.keys(data);
  const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ` +
              `ON CONFLICT(${pks.join(', ')}) DO UPDATE SET ` +
              names.filter((n) => !pks.includes(n)).map((n) => `${n} = excluded.${n}`).join(', ');
  db.prepare(names.filter((n) => !pks.includes(n)).length ? sql : sql.replace(/ ON CONFLICT.*$/, ' ON CONFLICT DO NOTHING'))
    .run(...names.map((n) => data[n]));
  return { applied: true };
}

function deleteRow(db, table, rowId) {
  const spec = replication.TABLE_BY_NAME[table];
  if (!spec) return;
  const key = replication.parseRowId(spec, rowId);
  const pks = replication.pkCols(spec);
  db.prepare(`DELETE FROM ${table} WHERE ${pks.map((c) => `${c} = ?`).join(' AND ')}`).run(...pks.map((c) => key[c]));
}

/**
 * Apply a batch inside one transaction with foreign keys OFF for its duration. Rows arrive in the
 * primary's commit order but a batch can reference a row that arrives later in the same batch, and
 * a copied row may reference a user who is not a member of any shared workspace and so was never
 * copied. The copy is read-only, so a dangling reference is a missing name, not corruption.
 */
function applyBatch(db, changes, originNodeId) {
  const fk = db.pragma('foreign_keys', { simple: true });
  if (fk) db.pragma('foreign_keys = OFF');
  const skipped = [];
  try {
    db.transaction(() => {
      for (const ch of changes) {
        if (ch.op === 'delete') { deleteRow(db, ch.table, ch.row_id); continue; }
        const r = upsertRow(db, ch.table, ch.row, originNodeId);
        if (!r.applied) skipped.push(`${ch.table}/${ch.row_id}: ${r.reason}`);
      }
    })();
  } finally {
    if (fk) db.pragma('foreign_keys = ON');
  }
  return { skipped };
}

/** Volatile device state rides the existing device-summary envelope; write it onto the copied row. */
function applyDeviceSummary(db, originNodeId, body) {
  if (!body || !body.id) return false;
  const cols = localColumns(db, 'devices');
  const fields = ['status', 'last_heartbeat', 'app_version', 'platform', 'client_type', 'offline_reason', 'offline_detail']
    .filter((f) => cols.includes(f) && body[f] !== undefined);
  if (!fields.length) return false;
  const r = db.prepare(
    `UPDATE devices SET ${fields.map((f) => `${f} = ?`).join(', ')}
      WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE origin_node_id = ?)`
  ).run(...fields.map((f) => body[f]), body.id, originNodeId);
  return r.changes > 0;
}

function markWorkspaces(db, wsIds, originNodeId, rev) {
  const now = nowSec();
  const stmt = db.prepare('UPDATE workspaces SET replica_rev = ?, replica_as_of = ? WHERE id = ? AND origin_node_id = ?');
  for (const id of wsIds) stmt.run(rev, now, id, originNodeId);
}

function copiedWorkspaces(db, originNodeId) {
  return db.prepare('SELECT id, replica_rev, replica_as_of FROM workspaces WHERE origin_node_id = ?').all(originNodeId);
}

/* ============================== the per-edge loop ============================== */

/**
 * @param db        writable handle
 * @param deps.readFrom  (childNodeId, {path, method}) => Promise<answer>   (ws/meshSocket.readFrom)
 */
function createReplica(db, { readFrom, logger = console, pollMs = POLL_MS, onApplied = null } = {}) {
  const breakers = new CircuitBreakers();
  const state = new Map(); // edgeId -> { origin, phase, lastAppliedRev, lastAppliedAt, lastError, snapshot }
  let timer = null;
  const pending = new Map(); // edgeId -> debounce timer
  let stopped = false;

  function stateFor(edge) {
    let s = state.get(edge.id);
    if (!s) {
      s = { origin: edge.peer_node_id, phase: 'idle', lastAppliedRev: null, lastAppliedAt: null, lastError: null, snapshot: null, busy: false };
      const ws = copiedWorkspaces(db, edge.peer_node_id);
      const revs = ws.map((w) => w.replica_rev).filter((r) => r != null);
      if (revs.length) { s.lastAppliedRev = Math.min(...revs); s.lastAppliedAt = Math.max(...ws.map((w) => w.replica_as_of || 0)) || null; }
      state.set(edge.id, s);
    }
    return s;
  }

  async function ask(edge, path) {
    const origin = edge.peer_node_id;
    if (!breakers.shouldAttempt(origin, Date.now())) return { ok: false, breaker: true, reason: 'circuit open' };
    let res;
    try { res = await readFrom(origin, { path, method: 'GET' }); } catch (e) { res = { ok: false, reason: e && e.message }; }
    if (res && res.ok) breakers.recordSuccess(origin);
    else breakers.recordFailure(origin, Date.now(), res && res.reason);
    return res || { ok: false, reason: 'no answer' };
  }

  /** Initial copy: every table, in dependency order, paced by the backfill queue. */
  async function snapshot(edge, s) {
    const head0 = await ask(edge, '/api/mesh/changes?since=0&limit=1');
    if (!head0.ok) throw new Error(head0.reason || 'primary did not answer');
    const wsIds = head0.workspaces || [];
    const head = head0.head || 0;
    const q = new BackfillQueue();
    // Current state first (what the fleet page needs), history last.
    for (const spec of replication.TABLES) {
      const p = ['activity_log', 'revisions'].includes(spec.table) ? PRIORITY.HISTORY : PRIORITY.CURRENT_STATE;
      q.add(p, spec.table);
    }
    s.snapshot = { tables: replication.TABLES.length, done: 0, rows: 0 };
    let batch;
    while ((batch = q.nextBatch())) {
      for (const table of batch.items) {
        let after = null;
        for (;;) {
          const page = await ask(edge, `/api/mesh/snapshot?table=${encodeURIComponent(table)}&limit=${PAGE}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
          if (!page.ok) throw new Error(`snapshot ${table}: ${page.reason || 'no answer'}`);
          const changes = (page.rows || []).map((row) => ({ op: 'upsert', table, row }));
          const r = applyBatch(db, changes, edge.peer_node_id);
          for (const m of r.skipped) logger.warn(`[mesh] replica ${edge.peer_node_id}: ${m}`);
          s.snapshot.rows += changes.length;
          if (page.done || !page.next) break;
          after = page.next;
          await new Promise((r) => setImmediate(r)); // yield between pages: never starve this node's own players
        }
        s.snapshot.done++;
      }
    }
    // Close the gap opened while paging, then record the position on every copied workspace.
    await incremental(edge, s, head, wsIds);
    s.snapshot = null;
  }

  async function incremental(edge, s, fromRev, wsIdsHint) {
    let since = fromRev == null ? (s.lastAppliedRev || 0) : fromRev;
    for (let guard = 0; guard < 100; guard++) {
      const res = await ask(edge, `/api/mesh/changes?since=${since}&limit=${PAGE}`);
      if (!res.ok) throw new Error(res.reason || 'primary did not answer');
      const wsIds = res.workspaces || wsIdsHint || copiedWorkspaces(db, edge.peer_node_id).map((w) => w.id);
      const r = applyBatch(db, res.rows || [], edge.peer_node_id);
      for (const m of r.skipped) logger.warn(`[mesh] replica ${edge.peer_node_id}: ${m}`);
      since = res.upto != null ? res.upto : since;
      markWorkspaces(db, wsIds, edge.peer_node_id, since);
      s.lastAppliedRev = since; s.lastAppliedAt = nowSec(); s.lastError = null;
      // Scale-out C2: screens attached HERE are served from this copy, so a change that just landed
      // must reach them now, not at their next refresh. The hook is told which workspaces moved.
      if ((res.rows || []).length && typeof onApplied === 'function') {
        try { onApplied([...new Set((res.rows || []).map((c) => c.workspace_id).filter(Boolean))]); } catch (e) { /* */ }
      }
      if (!res.more) return;
    }
  }

  async function sync(edge) {
    const s = stateFor(edge);
    if (s.busy) return;
    s.busy = true;
    try {
      const needSnapshot = s.lastAppliedRev == null || !copiedWorkspaces(db, edge.peer_node_id).length;
      s.phase = needSnapshot ? 'snapshot' : 'incremental';
      if (needSnapshot) await snapshot(edge, s); else await incremental(edge, s);
      s.phase = 'idle';
    } catch (e) {
      s.phase = 'error';
      s.lastError = (e && e.message) || String(e);
      logger.warn(`[mesh] replica: sync with ${edge.peer_node_id} failed: ${s.lastError}`);
    } finally {
      s.busy = false;
    }
  }

  function tick() {
    if (stopped) return;
    for (const edge of replicaEdges(db)) sync(edge);
  }

  /** The primary (re)connected: pull now. A fresh edge gets its snapshot at once, not at the next poll. */
  function onConnect(edge) {
    if (stopped || !isReplicaEdge(edge)) return;
    logger.log(`[mesh] replica: primary ${edge.peer_node_id} connected, syncing`);
    sync(edge);
  }

  /** ws/index calls this for every envelope on a down edge; only replica edges care. */
  function onEnvelope(edge, env) {
    if (!isReplicaEdge(edge) || !env) return false;
    if (env.type === 'change-notice') {
      const t = pending.get(edge.id);
      if (t) clearTimeout(t);
      pending.set(edge.id, setTimeout(() => { pending.delete(edge.id); sync(edge); }, NOTICE_DEBOUNCE_MS));
      return true;
    }
    if (env.type === 'device-summary') { try { applyDeviceSummary(db, edge.peer_node_id, env.body); } catch (e) { /* mirror still has it */ } }
    return false;
  }

  function status(now = nowSec()) {
    const out = [];
    for (const edge of replicaEdges(db)) {
      const s = stateFor(edge);
      const up = breakers.status(Date.now()).find((b) => b.childId === edge.peer_node_id);
      const edgeUp = !s.lastError && (!up || up.state !== 'open');
      out.push({
        node_id: edge.peer_node_id,
        phase: s.phase,
        last_applied_rev: s.lastAppliedRev,
        as_of: s.lastAppliedAt,
        // ⚠️ null when we cannot know. A replica that has not heard from its primary must not
        // report a lag of zero — that is the uptime-report rule (silence ≠ success) applied here.
        lag_s: edgeUp && s.lastAppliedAt ? Math.max(0, now - s.lastAppliedAt) : null,
        edge: edgeUp ? 'up' : 'down',
        error: s.lastError,
        snapshot: s.snapshot,
        workspaces: copiedWorkspaces(db, edge.peer_node_id).length,
      });
    }
    return out;
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, pollMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  }

  return { start, stop, tick, sync, onConnect, onEnvelope, status, breakers, _state: state };
}

module.exports = {
  createReplica, isReplicaEdge, replicaEdges, upsertRow, deleteRow, applyBatch, applyDeviceSummary,
  copiedWorkspaces, POLL_MS,
};
