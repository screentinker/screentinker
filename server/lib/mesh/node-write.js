'use strict';

const writeProxy = require('./write-proxy');
const meshAudit = require('./audit');

/*
 * Applying a write a parent asked for — on the child, by the child, or not at all.
 *
 * ⚠️ THE ORDER OF CHECKS IS THE DESIGN. Allowlist, then resolve the target locally, then grant, then
 * idempotency, then apply. Every one of those happens on the node that owns the screens, using that
 * node's own rows. Nothing the parent sent is trusted for anything except *what it is asking for*.
 *
 * ⚠️ THE TARGET'S WORKSPACE IS RESOLVED HERE, NEVER SENT. This is the difference between a scoped
 * grant and a decorative one: if the parent named the workspace it was writing to, a compromised or
 * merely buggy parent would name a different one and the check would pass. So the child looks up
 * what the object actually belongs to and compares that against what its operator granted.
 */

const MAX_SKEW_MS = 10 * 60 * 1000;

function parseList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []; }
  catch (e) { return []; }
}

/**
 * Which workspace does the object this path targets belong to?
 *
 * ⚠️ Returns null when the target does not exist, and the caller must refuse — not fall back to a
 * default, not treat it as "no workspace, therefore unscoped". An unknown target with an unscoped
 * write is how a grant for one customer becomes a write against another.
 */
function resolveTargetWorkspace(db, path) {
  const seg = String(path || '').split('?')[0].split('/');
  // /api/playlists -> a creation, so the target workspace comes from the request body instead and
  // the caller supplies it; every other rule addresses an existing object.
  if (seg.length === 3) return { kind: 'collection', workspaceId: null };

  /*
   * ⚠️ EVERY TARGET'S WORKSPACE IS READ FROM THIS NODE'S OWN ROWS, whatever kind it is. The table
   * differs; the rule does not — the parent names an object, and this node alone decides which
   * workspace that object belongs to. A resolver that took the workspace from the request would
   * let a parent choose its own permission, which is the defect the whole design exists to close.
   */
  const kind = seg[2];
  const targetId = seg[3];
  if (!targetId) return null;

  const TABLES = {
    playlists: 'playlists',
    devices: 'devices',
    'device-groups': 'device_groups',
  };
  const table = TABLES[kind];
  if (!table) return null;

  const row = db.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(targetId);
  if (!row) return null;
  /*
   * ⚠️ A row with no workspace is refused rather than treated as unowned-and-therefore-fair-game.
   * For content, NULL means "platform template, shared with everyone" — a deliberate global. For a
   * device or a group it means the row predates tenancy or was written wrong, and the safe reading
   * of "I do not know whose this is" is never "yours".
   */
  if (!row.workspace_id) return null;
  return { kind, workspaceId: row.workspace_id, id: targetId };
}

/**
 * @returns {{ok:true, outcome:object, replayed?:boolean} | {ok:false, reason:string}}
 */
/*
 * ⚠️ ASYNC, AND IT MUST STAY ASYNC. The executor re-enters this server's own HTTP API
 * (lib/mesh/local-apply.js), so `apply()` returns a promise. A synchronous version of this function
 * recorded that promise as a successful outcome BEFORE the request had been sent, acked ok:true to
 * the hub, and — because the outcome was written to mesh_write_ops — replayed that invented success
 * on every retry, so the write could never recover.
 *
 * It was green, because the test stubbed `apply` synchronously. The lesson is the one this codebase
 * keeps relearning: a stub that is simpler than the real collaborator tests the stub.
 */
/*
 * `ok` is a tri-state in mesh_write_ops: 1 applied, 0 refused, -1 claimed and still running.
 * -1 rather than a separate column so the primary key alone serialises duplicates.
 */
const IN_FLIGHT = -1;

/*
 * ⚠️ ONE AUDIT WRITE PER REQUEST, WRAPPED AROUND THE WHOLE DECISION.
 *
 * applyWrite returns from a dozen places — a bad deadline, no grant, an unwritable path, a target
 * that does not resolve, a stale intent, a replay, a refusal from the local API. Auditing at each
 * one means auditing at eleven of them and forgetting the twelfth, and the forgotten one is always
 * the interesting refusal. So the real function is wrapped and its single return value is what gets
 * recorded.
 *
 * ⚠️ A REPLAY IS NOT AUDITED AGAIN. The uplink re-queues on ack timeout, so the same intent arrives
 * repeatedly as a matter of course; recording each arrival would turn one operator action into a
 * page of identical lines and bury the events that matter.
 */
async function applyWrite(db, edge, req, deps = {}) {
  const outcome = await applyWriteInner(db, edge, req, deps);
  if (!outcome || !outcome.replayed) {
    meshAudit.recordPeerAction(db, edge, {
      action: 'mesh:write',
      path: (req && req.path) || null,
      method: (req && req.method) || null,
      ok: !!(outcome && outcome.ok),
      reason: outcome && outcome.reason,
      actor: req && req.actor,
      workspaceId: outcome && outcome.workspaceId,
    });
  }
  return outcome;
}

async function applyWriteInner(db, edge, req, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const method = req && req.method;
  /*
   * ⚠️ NORMALISED ONCE, HERE, AND NOTHING BELOW EVER SEES THE RAW STRING AGAIN.
   *
   * The allowlist, the target lookup and the outgoing request must all be talking about the same
   * path. When they were not, a backslash in an item id matched an allowlisted playlist rule and
   * arrived at the server as DELETE /api/devices/<id> — see write-proxy.normalizeTarget.
   */
  const norm = writeProxy.normalizeTarget(req && req.path);
  const path = norm ? norm.full : null;
  if (!path) return { ok: false, reason: writeProxy.REFUSED };

  /*
   * ⚠️ A DEADLINE, CHECKED BEFORE ANYTHING ELSE. Revocation is "stop future writes", and without a
   * deadline a write that left the parent before a revocation can arrive long after it and still
   * apply. The parent sets it on its own clock; both clocks travel in the envelope already, so a
   * peer whose skew is absurd is refused rather than trusted to have meant well.
   */
  /*
   * ⚠️ A DEADLINE IS REQUIRED, NOT OFFERED. This block only ran `if (typeof req.notAfter ===
   * 'number')` — so a peer that simply omitted the field got no deadline at all, and one that
   * omitted `sentAt` with it disarmed the skew check too, since the skew was computed against
   * `req.sentAt || now` and therefore always zero. A guard a caller can switch off by leaving a
   * field out is not a guard; it constrains only the honest.
   *
   * What it protects: revocation means "stop future writes", and without a deadline a write that
   * left the parent before a revocation can arrive long afterwards and still apply. The live edge
   * re-read is what actually stops a revoked peer — this bounds the window for one already in
   * flight, which the re-read cannot see.
   *
   * Refusing outright is safe here because our own hub has always sent both fields (routes/mesh.js
   * stamps sentAt and notAfter on every write), and mesh write has never shipped in a build that
   * did not. A peer sending neither is hand-rolled, and a hand-rolled peer asking to change
   * somebody's screens with no expiry on the request is exactly the caller to turn away.
   */
  if (req && typeof req.notAfter !== 'number') {
    return { ok: false, reason: 'A write must carry an expiry, so that revoking access cannot be ' +
                                'outrun by a request already in flight.' };
  }
  if (req && typeof req.sentAt !== 'number') {
    return { ok: false, reason: 'A write must say when it was sent, so its expiry can be checked ' +
                                'against a clock rather than taken on trust.' };
  }

  if (req && typeof req.notAfter === 'number') {
    if (Math.abs((req.sentAt || now) - now) > MAX_SKEW_MS) {
      return { ok: false, reason: "This server and yours disagree about the time by more than ten " +
                                  'minutes, so a deadline on the request cannot be trusted. Fix the ' +
                                  'clock skew and try again.' };
    }
    if (req.notAfter < now) {
      return { ok: false, reason: 'That request expired before it arrived, so it was not applied.' };
    }
  }

  const writeGrant = parseList(edge && edge.write_grant);
  const writeScope = parseList(edge && edge.write_scope);

  // Cheap refusal first: an edge with no write grant at all should never reach a target lookup,
  // because even the EXISTENCE of an object is something this connection may not learn this way.
  if (!writeGrant.length) {
    return { ok: false, reason: 'This connection may not change anything on this server. Write ' +
                                "access is granted by this server's operator." };
  }

  // Scale-out C2: a player event or a provisioning request from a replica — its own path, its own
  // grant, the same idempotency record. See applyPlayerOp for the checks.
  if (req && PLAYER_OP_TYPES.includes(req.type)) {
    return applyPlayerOp(db, edge, req, { writeGrant, writeScope, now, deps });
  }
  if (!writeProxy.isWritable(path, method)) {
    return { ok: false, reason: writeProxy.REFUSED };
  }

  const target = resolveTargetWorkspace(db, path);
  if (!target) {
    // ⚠️ The IDENTICAL string a denial uses — see write-proxy.REFUSED. A parent must not be able
    // to tell "no such playlist" from "not yours", or the write door becomes an oracle for what
    // exists on someone else's server.
    return { ok: false, reason: writeProxy.REFUSED };
  }

  const workspaceId = target.kind === 'collection'
    ? (req.body && req.body.workspace_id) || null
    : target.workspaceId;

  const auth = writeProxy.authorizeWrite(edge, path, method, writeGrant, writeScope, workspaceId, req.body);
  if (!auth.ok) return auth;

  /*
   * ⚠️ A NODE CAN BE ONE OF ITS OWN SCREENS, AND NOTHING MAY EVER POINT A PARENT AT THAT ONE.
   *
   * mesh_node.self_device_id exists because a single box is often both the server and the panel
   * hanging on the wall in reception. Every other guard here reasons about workspaces, and that one
   * device is inside a workspace like any other — so a perfectly valid content-push grant covering
   * the workspace also covers the host itself, and a parent could retarget the screen belonging to
   * the machine running the server.
   *
   * The column had ZERO readers anywhere in the tree before this: it was added for the rollup
   * double-count in #288 and never wired to anything, so the trap was open on every install that
   * had ever set it.
   *
   * Refused with the standard string — a parent has no business learning which device the host is.
   */
  const selfDeviceId = (() => {
    try {
      const row = db.prepare('SELECT self_device_id FROM mesh_node LIMIT 1').get();
      return (row && row.self_device_id) || null;
    } catch (e) {
      return null;   // no mesh_node row yet: nothing to protect
    }
  })();
  if (selfDeviceId && req.body && typeof req.body === 'object') {
    const named = [req.body.device_id, ...(Array.isArray(req.body.device_ids) ? req.body.device_ids : [])];
    if (named.some((d) => d && String(d) === String(selfDeviceId))) {
      return { ok: false, reason: writeProxy.REFUSED };
    }
  }

  /*
   * ⚠️ IDEMPOTENCY, and it returns the RECORDED OUTCOME rather than re-applying. The uplink
   * re-queues on ack timeout, so a link that drops mid-write will send the same intent again as a
   * matter of course. Without this, "the network hiccuped" and "the operator asked twice" are
   * indistinguishable, and the second one adds a duplicate item to somebody's playlist.
   */
  const opId = req && req.opId;
  if (!opId) {
    return { ok: false, reason: 'A write must carry an operation id, so that retrying it is safe.' };
  }
  const readRecorded = () => {
    const seen = db.prepare('SELECT ok, outcome FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?')
      .get(edge.id, opId);
    if (!seen) return null;
    let outcome = null;
    try { outcome = seen.outcome ? JSON.parse(seen.outcome) : null; } catch (e) { outcome = null; }
    if (seen.ok === IN_FLIGHT) {
      /*
       * ⚠️ A DUPLICATE THAT ARRIVED WHILE THE FIRST IS STILL RUNNING. Answering "already refused"
       * would be a lie and answering "applied" would be a guess; indeterminate is the truth, and it
       * is the one answer the caller already knows how to handle — retry with the SAME op id.
       */
      return { ok: false, reason: 'That change is already being applied. Retry with the same ' +
                                  'operation id to learn how it finished.', indeterminate: true };
    }
    return seen.ok
      ? { ok: true, outcome, replayed: true }
      : { ok: false, reason: 'That write was already refused.', replayed: true };
  };

  const already = readRecorded();
  if (already) return already;

  /*
   * ⚠️ ORDERING. A stale intent for the same target must not win by arriving last. Dropped rather
   * than applied, and reported as such — silently ignoring it would look identical to success.
   */
  const targetKey = `${target.kind}:${target.id || (workspaceId || '')}`;
  if (typeof req.intentSeq === 'number') {
    const last = db.prepare(
      `SELECT MAX(intent_seq) AS m FROM mesh_write_ops
        WHERE edge_id = ? AND target = ? AND ok = 1`).get(edge.id, targetKey);
    if (last && typeof last.m === 'number' && req.intentSeq <= last.m) {
      return { ok: false, reason: 'A newer change to that item has already been applied, so this ' +
                                  'older one was not.' };
    }
  }

  const apply = typeof deps.apply === 'function' ? deps.apply : null;
  if (!apply) {
    return { ok: false, reason: 'This server cannot apply writes right now.' };
  }

  /*
   * ⚠️ THE PARENT'S CONTENT IDS ARE NOT THIS NODE'S CONTENT IDS.
   *
   * A hub adding an item to a child's playlist sends the content id from ITS OWN library. That id
   * does not exist here — ids are generated independently on every node — so the child's playlist
   * route looked it up, found nothing, and answered 404. Nothing anywhere translated between the
   * two, so this failed even for content that HAD been transferred: the bytes arrived, a local row
   * was created with a fresh local id, and the hub went on naming its own.
   *
   * mesh_content_provenance is exactly this mapping — (origin_node_id, origin_content_id) →
   * local_content_id — and it was written on receipt and read nowhere.
   *
   * ⚠️ The origin is the EDGE's peer, never anything in the body. A parent that could name the
   * origin node could address another parent's provenance rows and attach that node's content to a
   * playlist here.
   *
   * An id that maps to nothing AND is not already a local row means the bytes were never sent. That
   * is refused with a reason the operator can act on, rather than the generic refusal: it is not a
   * permission problem, and telling somebody "not permitted" when the answer is "send the file
   * first" costs them an afternoon.
   */
  if (req.body && typeof req.body === 'object' && typeof req.body.content_id === 'string') {
    const wanted = req.body.content_id;
    const localRow = db.prepare('SELECT id FROM content WHERE id = ?').get(wanted);
    if (!localRow) {
      const mapped = db.prepare(`SELECT local_content_id FROM mesh_content_provenance
                                  WHERE origin_node_id = ? AND origin_content_id = ?`)
        .get(edge.peer_node_id, wanted);
      if (!mapped) {
        return {
          ok: false,
          reason: 'That content has not been sent to this server yet, so it cannot be added to a ' +
                  'playlist here. Send the file first, then add the item.',
        };
      }
      req = { ...req, body: { ...req.body, content_id: mapped.local_content_id } };
    }
  }

  /*
   * ⚠️ CLAIM THE OPERATION *BEFORE* APPLYING IT, OR THE RETRY THE DESIGN MANDATES DOUBLE-APPLIES.
   *
   * The record used to be written after apply() returned, with nothing in between — so two
   * requests carrying the same op id both found no row and both applied. That is not a theoretical
   * race: writeTo times out an ack at 15s, POST /items re-probes video duration with a 15s ffprobe
   * timeout, and the route answers 504 telling the operator to retry with the SAME id. A slow probe
   * therefore produces exactly the duplicate playlist item this table exists to prevent.
   *
   * The primary key on (edge_id, op_id) does the work: the INSERT is the lock. A second arrival
   * conflicts and reads the claim instead of racing past it.
   */
  try {
    db.prepare(`INSERT INTO mesh_write_ops (edge_id, op_id, target, intent_seq, ok, outcome, applied_at)
                VALUES (?,?,?,?,?,NULL,?)`)
      .run(edge.id, opId, targetKey,
           typeof req.intentSeq === 'number' ? req.intentSeq : null,
           IN_FLIGHT, Math.floor(now / 1000));
  } catch (e) {
    // Lost the race, or a replay slipped in between the read above and here. Either way the other
    // arrival owns the outcome; report whatever it recorded.
    return readRecorded() || { ok: false, reason: writeProxy.REFUSED };
  }

  const finish = (okFlag, outcome) => {
    db.prepare('UPDATE mesh_write_ops SET ok = ?, outcome = ?, applied_at = ? WHERE edge_id = ? AND op_id = ?')
      .run(okFlag, JSON.stringify(outcome ?? null), Math.floor(now / 1000), edge.id, opId);
  };

  let result;
  try {
    // ⚠️ auth.path, not `path`: the executor sends precisely the string that was authorised.
    result = await apply({ path: auth.path, method, body: req.body, workspaceId, rule: auth.rule, edge });
  } catch (e) {
    /*
     * ⚠️ A REFUSAL AND A FAILURE ARE NOT THE SAME OUTCOME, AND RECORDING BOTH AS `ok=0` MADE THE
     * MANDATED RETRY IMPOSSIBLE.
     *
     * Everything used to be written as a permanent refusal, so a restart mid-write, a momentary
     * 503, or a dropped loopback connection was remembered for ever — and the route reports a
     * recorded refusal as 403, whose text tells the operator that no retry will help. Four lines
     * above it, the 504 branch instructs them to retry with the same op id. The only escape was a
     * fresh op id, which is precisely what the design forbids.
     *
     * A 4xx from this node's own API is deterministic: it saw the request and said no, and it will
     * say no again. Anything else — 5xx, a transport error, no status at all — is not an answer,
     * so the claim is released and the caller may genuinely try again.
     *
     * ⚠️ The honest cost: a connection error that dropped AFTER the write landed will re-apply on
     * retry. That risk is real and is accepted deliberately, because the alternative on the table
     * was a write that can never be retried at all — and the local routes are transactional, so
     * the ambiguous window is a dropped response rather than a partial change.
     */
    const status = e && e.status;
    const deterministic = typeof status === 'number' && status >= 400 && status < 500;
    if (deterministic) {
      finish(0, { error: String((e && e.message) || e), status });
      return { ok: false, reason: 'That change could not be applied.' };
    }
    db.prepare('DELETE FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?').run(edge.id, opId);
    return {
      ok: false,
      indeterminate: true,
      reason: 'This server could not complete that change just now. Retry with the same operation id.',
    };
  }

  finish(1, result || null);
  return { ok: true, outcome: result || null, workspaceId };
}

/*
 * ============================================================================================
 * Scale-out C2 — player ops (docs/scale-out-design.md §6).
 *
 * `player-event`: a screen connected to a REPLICA reported something (heartbeat, a play, an
 * offline), and the replica forwards it here, to the node that owns the screen. Applied by the very
 * function the local socket handler calls (ws/deviceSocket.js EVENT_APPLIERS), so a screen behind a
 * replica is indistinguishable in this database from one connected directly.
 *
 * `player-provision`: a NEW screen paired to a replica; only this node can mint its token. The row
 * is created here exactly as the local pairing path creates it, and the outcome carries the token
 * ONCE for the replica to hand to the screen.
 *
 * ⚠️ THE I2 ACCOUNTING. Both are writes arriving at the data owner over the wire, and both are
 * permitted ONLY because THIS node's operator set `player-events` on this edge — the write grant is
 * read from this node's own row, the device's workspace is resolved from this node's own rows and
 * must be inside the grant's scope, and a provisioning request is accepted only for an edge that
 * holds that grant with a non-empty scope. The op types are a REVIEWED LIST (mesh-invariants
 * asserts it), like the downward socket verbs are.
 * ============================================================================================
 */
const PLAYER_OP_TYPES = Object.freeze(['player-event', 'player-provision']);

function applyPlayerOp(db, edge, req, { writeGrant, writeScope, now }) {
  const opId = req && req.opId;
  if (!opId) return { ok: false, reason: 'A write must carry an operation id, so that retrying it is safe.' };
  if (!writeGrant.includes('player-events') || !writeScope.length) {
    return { ok: false, reason: 'This connection may not report screens to this server. The player-events ' +
                                "grant is set by this server's operator." };
  }
  const deviceSocket = require('../../ws/deviceSocket');

  // Idempotency, same record as every other write. Replays answer from the record.
  const seen = db.prepare('SELECT ok, outcome FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?').get(edge.id, opId);
  if (seen) {
    let outcome = null;
    try { outcome = seen.outcome ? JSON.parse(seen.outcome) : null; } catch (e) { outcome = null; }
    if (seen.ok === IN_FLIGHT) return { ok: false, reason: 'That change is already being applied. Retry with the same operation id to learn how it finished.', indeterminate: true };
    return seen.ok ? { ok: true, outcome, replayed: true } : { ok: false, reason: 'That write was already refused.', replayed: true };
  }

  let targetKey, workspaceId = null, run;
  if (req.type === 'player-provision') {
    const p = req.payload || {};
    const code = typeof p.pairing_code === 'string' ? p.pairing_code.trim().slice(0, 32) : '';
    if (!code) return { ok: false, reason: 'A pairing code is required.' };
    targetKey = `provision:${code}`;
    run = () => deviceSocket.provisionViaReplica({
      pairing_code: code, device_info: p.device_info && typeof p.device_info === 'object' ? p.device_info : null,
      fingerprint: typeof p.fingerprint === 'string' ? p.fingerprint : null,
      hw_fingerprint: typeof p.hw_fingerprint === 'string' ? p.hw_fingerprint : null,
      ip: typeof p.ip === 'string' ? p.ip.slice(0, 45) : null, nodeId: edge.peer_node_id,
    });
  } else {
    const deviceId = typeof req.deviceId === 'string' ? req.deviceId : null;
    const kind = typeof req.kind === 'string' ? req.kind : null;
    if (!deviceId || !kind) return { ok: false, reason: writeProxy.REFUSED };
    if (!deviceSocket.PLAYER_EVENT_KINDS.includes(kind)) return { ok: false, reason: writeProxy.REFUSED };
    /*
     * ⚠️ The device's workspace is THIS node's answer, never the replica's claim. A device that
     * belongs to a workspace outside the grant's scope is refused with the same string as one
     * that does not exist. An unclaimed screen (no workspace yet) is accepted only if THIS replica
     * provisioned it — attached_node_id says so — because its future workspace is one of the
     * scoped ones by construction (the operator claims it there).
     */
    const row = db.prepare('SELECT workspace_id, attached_node_id FROM devices WHERE id = ?').get(deviceId);
    if (!row) return { ok: false, reason: writeProxy.REFUSED };
    if (row.workspace_id) {
      if (!writeScope.includes(row.workspace_id)) return { ok: false, reason: writeProxy.REFUSED };
      workspaceId = row.workspace_id;
    } else if (row.attached_node_id !== edge.peer_node_id) {
      return { ok: false, reason: writeProxy.REFUSED };
    }
    targetKey = `player:${deviceId}`;
    const payload = req.payload && typeof req.payload === 'object' ? { ...req.payload, device_id: deviceId } : { device_id: deviceId };
    run = () => {
      const replies = [];
      const ctx = {
        reply: (event, p) => { replies.push({ event, payload: p }); },
        session: { strandedSweepDone: false },
        ip: typeof payload.ip === 'string' ? payload.ip : null,
        source: 'replica', nodeId: edge.peer_node_id, closingSocketId: `mesh:${edge.peer_node_id}`,
      };
      // Every event from a replica keeps the attachment current; 'online' writes it itself.
      if (kind !== 'online' && kind !== 'offline') {
        db.prepare('UPDATE devices SET attached_node_id = ? WHERE id = ? AND (attached_node_id IS NULL OR attached_node_id != ?)').run(edge.peer_node_id, deviceId, edge.peer_node_id);
      }
      const r = deviceSocket.applyPlayerEvent(kind, deviceId, payload, ctx);
      if (!r.ok) throw Object.assign(new Error(r.reason), { status: 400 });
      return { replies };
    };
  }

  try {
    db.prepare(`INSERT INTO mesh_write_ops (edge_id, op_id, target, intent_seq, ok, outcome, applied_at) VALUES (?,?,?,?,?,NULL,?)`)
      .run(edge.id, opId, targetKey, null, IN_FLIGHT, Math.floor(now / 1000));
  } catch (e) {
    return { ok: false, reason: 'That change is already being applied. Retry with the same operation id to learn how it finished.', indeterminate: true };
  }
  const finish = (okFlag, outcome) => {
    db.prepare('UPDATE mesh_write_ops SET ok = ?, outcome = ?, applied_at = ? WHERE edge_id = ? AND op_id = ?')
      .run(okFlag, JSON.stringify(outcome ?? null), Math.floor(now / 1000), edge.id, opId);
  };
  let result;
  try {
    result = run();
  } catch (e) {
    const status = e && e.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      finish(0, { error: String((e && e.message) || e), status });
      return { ok: false, reason: 'That change could not be applied.' };
    }
    db.prepare('DELETE FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?').run(edge.id, opId);
    return { ok: false, indeterminate: true, reason: 'This server could not complete that change just now. Retry with the same operation id.' };
  }
  finish(1, result || null);
  return { ok: true, outcome: result || null, workspaceId };
}

module.exports = { applyWrite, resolveTargetWorkspace, PLAYER_OP_TYPES };
