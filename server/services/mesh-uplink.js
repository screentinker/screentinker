'use strict';

/*
 * The thing that actually reports upward: opens an Uplink per `up` edge and feeds it projections.
 *
 * ⚠️ EVERY PAYLOAD GOES THROUGH lib/mesh/mirror.js FIRST. Nothing reads a device row and sends it.
 * The grant is enforced by CONSTRUCTING what is allowed rather than by removing what is not — the
 * moment a new telemetry column lands, a delete-based filter silently starts shipping it upward and
 * nobody finds out until a client asks why their hub knows something it was never granted.
 *
 * ⚠️ THIS SERVICE MUST NEVER BE ABLE TO HARM ITS OWN NODE (I1). It is a reporter to an observer.
 * Every path is wrapped, the timer is unref'd, and a parent that is down, wrong, slow or hostile
 * changes nothing about scheduling, playback or the local dashboard.
 */

const { Uplink } = require('../lib/mesh/uplink');
const nodeData = require('../lib/mesh/node-data');
const {
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead, deviceDetail,
} = nodeData;
const { createReadRunner } = require('../lib/mesh/read-runner');
const nodeWrite = require('../lib/mesh/node-write');
const contentReceive = require('../lib/mesh/content-receive');
const relay = require('../lib/mesh/relay');
const autoForward = require('../lib/mesh/auto-forward');
const contentFiles = require('../lib/content-files');
const meshAudit = require('../lib/mesh/audit');
const { createLocalApply } = require('../lib/mesh/local-apply');
const envelope = require('../lib/mesh/envelope');
const mirror = require('../lib/mesh/mirror');
const store = require('../lib/mesh/store');
const replication = require('../lib/mesh/replication');

/*
 * How often a child reports. ⚠️ Not per heartbeat. A 400-screen node whose panels beat every 30s
 * would push 800 envelopes a minute at a hub that wants a picture, not a firehose — and the hub's
 * own backpressure would then throttle it, so the extra traffic buys nothing but load on both ends.
 */
const REPORT_INTERVAL_MS = 60_000;

const nowSec = () => Math.floor(Date.now() / 1000);

function activeUpEdges(db) {
  try {
    return db.prepare(
      "SELECT * FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL AND up_token IS NOT NULL")
      .all();
  } catch (e) {
    return [];
  }
}

/*
 * ⚠️ THE WORKSPACE SCOPE IS ENFORCED IN THE QUERY, not filtered afterwards.
 *
 * A shared list that is applied after the rows are fetched leaks the moment somebody adds a count,
 * a total or a "devices online" to a payload — the classic shape of this bug, and the same one the
 * hub's client scoping avoids by resolving visibility before it selects. Here the SQL simply cannot
 * return a workspace this edge was not granted.
 *
 * `null` means every workspace INCLUDING ones created later, which only the instance owner can
 * choose. A named list is fixed: a workspace added tomorrow is not silently swept in.
 */


/*
 * The synthetic principal that OWNS content received from a parent. Deliberately the same user the
 * write executor mints tokens for: a row created by "the mesh" should read that way in the library,
 * not as whichever human happened to enrol the link months ago.
 */
function meshPrincipalId(db) {
  const existing = db.prepare("SELECT id FROM users WHERE email = 'mesh@localhost.invalid'").get();
  if (existing) return existing.id;
  const id = require('crypto').randomUUID();
  db.prepare(`INSERT INTO users (id, email, name, password_hash, role)
              VALUES (?, 'mesh@localhost.invalid', 'Another server (mesh)', NULL, 'user')`).run(id);
  return id;
}

function startMeshUplinks(db, { config, connect, logger = console } = {}) {
  if (!config || !config.meshAllowUplink) return { stop() {}, links: new Map(), refresh() {} };

  const io = connect || require('socket.io-client').io;
  const links = new Map();
  let timer = null;

  const me = store.ensureNodeIdentity(db);
  if (!me) {
    logger.warn('[mesh] MESH_ALLOW_UPLINK is set but this node has no identity — not reporting upward.');
    return { stop() {}, links, refresh() {} };
  }

  /*
   * ⚠️ Reads go to a worker where one exists, and inline where one does not — the same answer
   * either way. better-sqlite3 is synchronous, so an inline read is served on the event loop that
   * answers every player's heartbeat: a parent's convenience paid for out of the child's own
   * responsiveness, which is what I1 forbids.
   */
  // One executor for the whole service: it mints a short-lived, workspace-bound token per
  // write and re-enters this server's own HTTP API, so a mesh write passes exactly the
  // guards a local one does.
  const applyLocally = createLocalApply(db, config);

  const reads = createReadRunner({
    dbPath: (config && config.dbPath) || require('../config').dbPath,
    db,
    nodeData,
    logger,
    preferWorker: process.env.ST_MESH_READ_WORKER !== '0',
  });

  function send(edge, link) {
    const grant = store.safeParseArray(edge.grant_categories);
    const mk = (type, body) => envelope.createEnvelope({
      originNodeId: me, type, bodyVersion: 1,
      ancestry: [me], originTs: Date.now(), body,
    });

    /*
     * ⚠️ ALERTS ARE NOT BATCHED, and that is a product decision rather than an oversight. An alert is
     * the one payload where latency IS the point; batching it behind four hundred device summaries
     * adds up to a full cycle of delay to the message an operator is waiting for. "Fewer bytes" and
     * "better product" are not the same goal, and where they disagree this one wins.
     */
    for (const a of openAlerts(db, grant, edge)) link.send(mk('alert-event', a));

    /*
     * Everything else travels together. Node health leads and workspaces precede devices, because a
     * device arriving before its workspace flickers into "unfiled" and back out again on the very
     * first sync — order is preserved inside a batch, so this ordering still means something.
     */
    /*
     * ⚠️ WHAT WE HAVE DECIDED THIS PARENT MAY DO, SENT UPWARD SO IT CAN RENDER THE RIGHT CONTROLS.
     *
     * The grant lives here and is enforced here, on this node's own row, re-read live per request.
     * The parent has no copy and must never infer one — so without this it cannot tell an operator
     * whether they may push to this client, and can only let them try and be refused. The refusal
     * is deliberately identical for "no such thing" and "not permitted", so it teaches nothing.
     *
     * Sent every tick alongside the rest rather than only on change: a report that only fires on
     * change is a report that is wrong for ever after one dropped connection, and this is cheap —
     * four short fields.
     *
     * ⚠️ The BUDGET is included and the USED figure with it, so the hub can warn before a push
     * fails rather than after. Neither is authority: the child re-checks both when the bytes
     * actually arrive.
     */
    const writeGrant = store.safeParseArray(edge.write_grant);
    const writeScope = store.safeParseArray(edge.write_scope);
    /*
     * ⚠️ A RELAYED SCREEN CARRIES ITS OWN ORIGIN, NOT OURS — and getting this wrong is the worst
     * available bug in a multi-tier mesh.
     *
     * mk() stamps every envelope with THIS node as the origin, which is correct for our own
     * devices and a lie about somebody else's. Sent that way, the node above files a customer's
     * screens under the relay: an MSP looking at their top hub sees one company's estate labelled
     * as another's, and every count, report and alert above that point is attributed to the wrong
     * party. Measured in the lab before this existed — A showed C's screen as belonging to B.
     *
     * The ancestry carries the path with it, which is also what lets the node above know the shape
     * of what is beneath it rather than just its immediate neighbours.
     */
    const mkFor = (originNodeId, type, body) => envelope.createEnvelope({
      originNodeId, type, bodyVersion: 1,
      ancestry: originNodeId === me ? [me] : [originNodeId, me],
      originTs: Date.now(), body,
    });

    const bulk = [
      mk('node-health', nodeHealth(db, me)),
      mk('write-offer', {
        categories: writeGrant,
        workspaces: writeScope,
        bytesBudget: typeof edge.write_bytes_budget === 'number' ? edge.write_bytes_budget : null,
        bytesUsed: Number(edge.write_bytes_used) || 0,
        /*
         * ⚠️ WHETHER THIS PARENT MAY PASS WHAT WE SEND IT FURTHER UP. Travels here because this is
         * already the message where a child tells a parent what it has consented to — a second
         * envelope type for one boolean would be a second thing to keep in step.
         *
         * The parent cannot infer this and must never assume it: a node two hops above has no
         * relationship with this one, and "my MSP may see my screens" is not the same agreement as
         * "and so may whoever my MSP reports to".
         */
        shareUpward: Number(edge.share_upward) === 1,
      }),
    ];
    for (const w of workspaceProjections(db, grant, edge)) bulk.push(mk('workspace-summary', w));
    /*
     * Nodes below us that agreed to be passed on. Sent before their devices for the same reason
     * workspaces precede devices: a screen arriving before the server it belongs to flickers into
     * "unknown origin" and back out again on the very first sync.
     */
    for (const n of nodeData.relayedNodeProjections(db)) {
      bulk.push(mkFor(n.origin_node_id, 'node-health', n));
    }
    /*
     * ⚠️ Workspaces before the devices that belong to them — the same ordering rule as our own, and
     * for the same reason: a screen arriving before its workspace flickers into "unfiled" and back
     * out again on the first sync. Without these at all, a relayed screen upstream carried a
     * workspace id that node had never heard of and could not be filed under any customer.
     */
    for (const w of nodeData.relayedWorkspaceProjections(db)) {
      bulk.push(mkFor(w.origin_node_id, 'workspace-summary', w));
    }

    for (const d of deviceProjections(db, grant, edge)) {
      // Ours keep our origin; a relayed one keeps the origin it arrived with.
      bulk.push(mkFor(d.origin_node_id || me, 'device-summary', d));
    }
    link.sendMany(bulk, { nodeId: me, ancestry: [me] });
  }

  /* ======================= scale-out: change log, notices, acks ======================= */

  function recordAck(edge, req) {
    try {
      const path = String((req && req.path) || '');
      if (!path.startsWith('/api/mesh/changes')) return;
      const since = Number(new URL(path, 'http://127.0.0.1').searchParams.get('since'));
      if (!Number.isFinite(since) || since < 0) return;
      db.prepare('UPDATE mesh_edges SET acked_rev = MAX(COALESCE(acked_rev, 0), ?) WHERE id = ?').run(since, edge.id);
    } catch (e) { /* an ack is advisory; never fail a read over it */ }
  }

  /*
   * ⚠️ TRIGGERS FOLLOW THE GRANT, and are re-evaluated on every refresh: revoke the last
   * workspace-replication edge and the triggers go with it in the same call, so a node that stopped
   * being a primary stops paying for a change log the moment its operator says so.
   */
  function syncTriggers() {
    try {
      const r = replication.ensureTriggers(db);
      if (r.action === 'created' || r.action === 'dropped') {
        logger.log(`[mesh] change-log triggers ${r.action} (${r.count}) — workspace-replication ${r.action === 'created' ? 'granted' : 'no longer granted'}`);
      }
    } catch (e) {
      logger.warn(`[mesh] could not maintain change-log triggers: ${e && e.message}`);
    }
  }

  /*
   * Notices are a poll of MAX(rev), once a second, sent only when it moved. Cheap (an indexed max),
   * naturally debounced (a bulk publish is one notice), and it needs no hook in any write path.
   * The replica answers by pulling; nothing here ever pushes a row.
   */
  let lastNoticedRev = 0;
  let noticeTimer = null;
  function noticeTick() {
    let head;
    try { head = replication.headRev(db); } catch (e) { return; }
    if (head <= lastNoticedRev) return;
    lastNoticedRev = head;
    for (const [edgeId, link] of links) {
      const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
      if (!edge || edge.revoked_at) continue;
      if (!store.safeParseArray(edge.grant_categories).includes('workspace-replication')) continue;
      try {
        link.send(envelope.createEnvelope({
          originNodeId: me, type: 'change-notice', bodyVersion: 1,
          ancestry: [me], originTs: Date.now(), body: { rev: head },
        }));
      } catch (e) { /* the 30 s poll on the replica covers a lost notice */ }
    }
  }
  function startNotices() {
    if (noticeTimer) return;
    noticeTimer = setInterval(noticeTick, 1000);
    if (noticeTimer.unref) noticeTimer.unref();
  }

  let pruneCounter = 0;

  function tick() {
    // Every ~10 minutes: drop change-log rows every replica has acknowledged (7-day floor).
    if (++pruneCounter % 10 === 0) { try { replication.pruneLog(db); } catch (e) { /* best effort */ } }
    for (const [edgeId, link] of links) {
      const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
      /*
       * ⚠️ Re-read every tick, so a revoke or a narrowed grant takes effect on the NEXT report
       * rather than at the next restart. The same reasoning as the parent re-reading its edge per
       * envelope: a permission change that waits for a process lifecycle is not a permission change.
       */
      if (!edge || edge.revoked_at) {
        try { link.stop(); } catch (e) { /* best effort */ }
        links.delete(edgeId);
        continue;
      }
      try { send(edge, link); } catch (e) {
        logger.warn(`[mesh] could not build a report for ${edge.peer_node_id}: ${e && e.message}`);
      }
    }
  }

  function refresh() {
    syncTriggers();
    /*
     * ⚠️ AN EXISTING LINK IS TOLD AT ONCE, not at the next tick.
     *
     * This only ever created links for NEW edges, so a change to an existing one — granting write
     * access, widening a workspace scope, raising a storage budget — reached the parent whenever
     * the 60-second report next happened to fire. For up to a minute the hub's UI still said
     * read-only, the Send button stayed hidden, and the operator who had just granted it reasonably
     * concluded it had not worked and tried again.
     *
     * The grant itself was always live — it is re-read per request — so this was never a
     * permissions gap. It was the parent being told late about a decision already in force, which
     * is its own kind of wrong: consent that takes a minute to become visible looks broken.
     */
    for (const edge of activeUpEdges(db)) {
      const existing = links.get(edge.id);
      if (existing) {
        try { send(edge, existing); } catch (e) {
          logger.warn(`[mesh] could not re-report to ${edge.peer_node_id}: ${e && e.message}`);
        }
        continue;
      }
      try {
        const link = new Uplink({
          parentUrl: edge.peer_url,
          edgeToken: edge.up_token,
          nodeId: me,
          connect: io,
          tlsVerify: edge.tls_verify !== 0,
          logger,
          // ⚠️ Re-read per request, so narrowing a grant or a workspace scope takes effect on the
          // NEXT read rather than at the next restart.
          onRead: (req) => {
            /*
             * ⚠️ The EDGE is re-read on this thread, then handed to the runner. Authorisation is
             * decided here from live state; the worker only computes an answer for an edge it was
             * given. A worker that fetched its own edge row could serve a revoked one from a
             * connection opened before the revoke.
             */
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            /*
             * Scale-out: a replica asking for changes after rev N has, by construction, applied
             * everything up to N — so the ask IS the acknowledgement. Recorded here, on the thread
             * that holds the writable handle (the worker answering the read is readonly by design),
             * and it is what lets the change log be pruned behind the slowest replica.
             */
            recordAck(fresh, req);
            return reads.run(fresh, req);
          },

          /*
           * ⚠️ Same live re-read as onRead, and it matters MORE here. For a read, a stale edge means
           * a hub sees something it should no longer see. For a write it means a hub CHANGES
           * something after its operator revoked the right to — so the grant is read inside the
           * request, from the row, every time. Nothing is cached at handshake, because revocation
           * that only takes effect at the next restart is not revocation.
           */
          onWrite: (req) => {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            /*
             * ⚠️ Runs on THIS thread with the writable handle, unlike reads.
             *
             * The read path deliberately opens its own read-only connection on a worker, so "the
             * read path cannot write" is a property of the file descriptor rather than of the code
             * above it. A write cannot have that, so it gives up that guarantee — which is exactly
             * why the allowlist in write-proxy.js is narrow and why nothing that touches bytes is
             * on it. It also means a parent's convenience is paid out of this node's event loop,
             * the one answering every player's heartbeat: keep the surface small.
             */
            return nodeWrite.applyWrite(db, fresh, req, { apply: applyLocally });
          },

          /*
           * ⚠️ CONTENT COMES IN OVER HTTP, NOT OVER THIS SOCKET. The envelope caps a batch at
           * 512 KB against a 500 MB upload limit, so the socket carries the OFFER — a description
           * and a ticket per file — and the child then pulls the bytes itself from the address it
           * already had. That keeps a 400 MB video off the control plane entirely.
           *
           * The edge is re-read here for the same reason as onWrite: a grant revoked a moment ago
           * must bite the very next request, not at the next restart.
           */
          /*
           * ⚠️ THE OWNER WITHDRAWING WHAT THEY SENT. Scoped by the edge to what THIS peer
           * originated, and refused for anything a playlist here still uses — see lib/mesh/relay.js
           * for why that refusal is not negotiable.
           */
          onContentPurge: (req) => {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            const result = relay.applyPurge(db, fresh, req && req.oids, {
              /*
               * ⚠️ BOTH, and the snapshot half is the one that matters. A published snapshot
               * outlives the playlist items it was built from, so checking items alone would call a
               * file unused while a screen is still playing it from its published copy.
               */
              isReferenced: (contentId) => {
                const item = db.prepare('SELECT 1 FROM playlist_items WHERE content_id = ? LIMIT 1').get(contentId);
                if (item) return true;
                return !!db.prepare("SELECT 1 FROM playlists WHERE published_snapshot LIKE ? LIMIT 1")
                  .get(`%${contentId}%`);
              },
              removeLocal: (row) => contentFiles.removeUnreferencedContent(row.local_content_id),
            });
            meshAudit.recordPeerAction(db, fresh, {
              action: 'mesh:content-push',
              ok: !!result.ok,
              reason: result.reason,
              actor: req && req.actor,
              path: result.ok ? `withdrew ${result.removed.length} file(s), kept ${result.kept.length} still in use` : null,
            });
            return result;
          },

          onContentOffer: (req) => {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            return contentReceive.receiveContentOffer(db, fresh, req, {
              contentDir: config.contentDir,
              userId: meshPrincipalId(db),
            }).then(async (result) => {
              /*
               * ⚠️ AFTER the bytes are safely committed, and never as part of committing them. A
               * forward that failed must not make a successful receipt look like a failure — this
               * node HAS the content either way, and the client below can be sent it later.
               */
              try {
                const offerTo = global.__meshContentOfferTo;
                if (offerTo && result && result.ok && (result.stored || []).length) {
                  const fwd = await autoForward.forwardReceived(db, result.stored, fresh, {
                    contentDir: config.contentDir,
                    offerTo,
                    /*
                     * Which of that client's workspaces to put it in. Only answerable when they have
                     * told us about exactly one; with several, guessing would drop a campaign into
                     * the wrong customer's screens, so it is skipped and reported instead.
                     */
                    workspaceFor: (e) => {
                      try {
                        const rows = db.prepare(
                          `SELECT workspace_id FROM mesh_mirror_workspaces
                            WHERE origin_node_id = ? AND deleted_at IS NULL`).all(e.peer_node_id);
                        return rows.length === 1 ? rows[0].workspace_id : null;
                      } catch (x) { return null; }
                    },
                  });
                  if (fwd.forwarded.length || fwd.skipped.length) {
                    logger.log(`[mesh] passed content on to ${fwd.forwarded.length} client(s)` +
                               `${fwd.skipped.length ? `, skipped ${fwd.skipped.length}` : ''}`);
                  }
                }
              } catch (e) {
                logger.warn(`[mesh] could not pass content on: ${e && e.message}`);
              }
              return result;
            });
          },
        }).start();
        /*
         * ⚠️ REPORT AS SOON AS THE SOCKET COMES UP, not at the next tick. Otherwise a node that was
         * just enrolled shows nothing on the hub for up to a minute — the operator's very first
         * look at the thing they just connected is an empty page, which reads as "it did not work"
         * and gets retried. Also covers every reconnect, so a link that drops catches up at once
         * instead of waiting out the interval.
         */
        /*
         * ⚠️ A failing uplink SAYS SO in the log. The Uplink keeps lastError for the connection view,
         * but nothing printed it — so a link that could not connect looked identical to one that was
         * connected and idle, and the only symptom was a hub showing a node with no data. Rate is
         * not a concern: the backoff is jittered and caps at a minute.
         */
        link.on('retry-scheduled', ({ attempt, delayMs, reason }) => {
          logger.warn(`[mesh] uplink to ${edge.peer_node_id} failed (attempt ${attempt}): ` +
                      `${reason || 'unknown'} — retrying in ${Math.round(delayMs / 1000)}s`);
        });
        link.on('connected', () => {
          try {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (fresh && !fresh.revoked_at) send(fresh, link);
          } catch (e) {
            logger.warn(`[mesh] first report to ${edge.peer_node_id} failed: ${e && e.message}`);
          }
        });
        links.set(edge.id, link);
        logger.log(`[mesh] reporting upward to ${edge.peer_node_id} at ${edge.peer_url}`);
      } catch (e) {
        /*
         * A bad row must not stop the others, and must not stop the node (I6).
         *
         * ⚠️ But it must not be QUIET either. A ReferenceError in the constructor is a programming
         * fault, not a malformed edge, and this handler once turned exactly that into one warn line
         * per edge while the entire mesh sat inert — no telemetry, no reads, no writes, and a suite
         * of 2,300 tests still green. Isolation is right; hiding the difference between "this row is
         * bad" and "this build is broken" is not. The stack goes in the log, and the message says
         * what is actually not happening.
         */
        logger.warn(`[mesh] NOT reporting to ${edge.peer_node_id} — its uplink could not start: ` +
                    `${(e && e.stack) || e}`);
      }
    }
    // Anything revoked while we were not looking.
    for (const [edgeId, link] of links) {
      const still = db.prepare(
        "SELECT 1 FROM mesh_edges WHERE id = ? AND revoked_at IS NULL AND direction = 'up'").get(edgeId);
      if (!still) { try { link.stop(); } catch (e) { /* best effort */ } links.delete(edgeId); }
    }
  }

  refresh();
  tick();
  timer = setInterval(tick, REPORT_INTERVAL_MS);
  startNotices();
  // ⚠️ Never hold the process open for an observer relationship.
  if (timer.unref) timer.unref();

  return {
    links,
    refresh,
    status: () => [...links.entries()].map(([id, l]) => ({ edgeId: id, ...l.status() })),
    readMode: () => reads.mode,
    stop() {
      if (timer) clearInterval(timer);
      if (noticeTimer) clearInterval(noticeTimer);
      reads.stop();
      for (const l of links.values()) { try { l.stop(); } catch (e) { /* best effort */ } }
      links.clear();
    },
  };
}

module.exports = {
  startMeshUplinks, REPORT_INTERVAL_MS,
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead, deviceDetail,
};
