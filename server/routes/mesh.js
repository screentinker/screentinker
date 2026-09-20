'use strict';

/*
 * The hub's read-only API over mirrored state: Servers, remote screens, alerts, uptime.
 *
 * ⚠️ READ-ONLY, AND STRUCTURALLY SO. There is no route here that writes to a child, because 2.0 has
 * no downward channel to write over (I2). That is not a restraint being exercised — it is the absence
 * of a mechanism, and it is what makes "the hub cannot change what plays on your screens" a fact
 * rather than a promise.
 *
 * ⚠️ EVERY DEVICE ROW GOES THROUGH deviceStatus(), never straight from the table. The stored `status`
 * column is what a node last SAID; it becomes meaningful only when combined with whether that node is
 * still reachable. Serving the raw column is how a dashboard ends up showing a green dot from ninety
 * minutes ago.
 */

const express = require('express');
const hubView = require('../lib/mesh/hub-view');
const clientRoles = require('../lib/mesh/client-roles');
const clientTree = require('../lib/mesh/client-tree');
const meshUptime = require('../lib/mesh/uptime-report');
const alertRollup = require('../lib/mesh/alert-rollup');
const { openIncidents } = require('../services/threshold-alerts');
const { resolveSessionUser } = require('../middleware/auth');

const nowSec = () => Math.floor(Date.now() / 1000);

const contentOffer = require('../lib/mesh/content-offer');
const { digestFileSync } = require('../lib/content-digest');
const path = require('path');
const fs = require('fs');
const config = require('../config');

/*
 * Has this exact file (same path, size and mtime) already been shown to match this digest?
 *
 * ⚠️ Keyed on mtime AND size, so any write invalidates the answer — the cache can only ever save a
 * re-read of bytes that demonstrably have not changed. Bounded, because an unbounded map keyed on
 * filenames is a slow leak on a node serving a large library.
 */
const digestChecks = new Map();
const DIGEST_CACHE_MAX = 500;

function verifiedRecently(abs, stat, expected) {
  const key = `${abs}:${stat.size}:${stat.mtimeMs}`;
  const seen = digestChecks.get(key);
  if (seen !== undefined) return seen === expected;

  const actual = digestFileSync(abs);
  if (digestChecks.size >= DIGEST_CACHE_MAX) {
    // Oldest first: Map preserves insertion order, and this is a cache rather than an index.
    digestChecks.delete(digestChecks.keys().next().value);
  }
  digestChecks.set(key, actual);
  return actual === expected;
}

module.exports = function meshRoutes(db, { requireAuth }) {
  const router = express.Router();

  /*
   * ⚠️ CLIENT SCOPING IS APPLIED ON THE WAY IN, NOT FILTERED ON THE WAY OUT. A route that fetched
   * everything and removed the rows the caller may not see would leak the moment somebody added a
   * count, an aggregate or a "total" to the response — the classic shape of this bug. Resolving the
   * visible set first means the query itself cannot return anything else.
   */
  function visibleClientIds(user) {
    const clients = db.prepare('SELECT id, parent_client_id FROM mesh_clients').all();
    const parentOf = new Map(clients.map((c) => [c.id, c.parent_client_id]));
    const getParentId = (id) => parentOf.get(id) || null;
    const getAccessRow = (clientId, userId) => db.prepare(
      'SELECT role FROM mesh_client_access WHERE client_id = ? AND user_id = ?').get(clientId, userId);

    const allowed = new Set();
    for (const c of clients) {
      const { role } = clientTree.resolveAccess(c.id, user, getParentId, getAccessRow, clientRoles);
      if (role && clientRoles.roleAllows(role, 'view-mirrored-data')) allowed.add(c.id);
    }
    return allowed;
  }

  /**
   * May this user perform a WRITE action on the client that owns this node?
   *
   * ⚠️ TWO CONDITIONS, AND THE SECOND ONE IS THE POINT. The role must permit the action, AND the
   * access must be `direct` — a row naming this user on THIS client. Read access inherits down the
   * client tree deliberately; write must not, or dragging a client under "West Region" hands the
   * ability to change a hospital's screens to everyone holding that region, in one drag, with
   * nobody named. resolveAccess already reports provenance, so this is one extra comparison.
   *
   * ⚠️ This is a hub-side PRE-FILTER, not the enforcement. The child re-checks its own grant on
   * every request and owes this hub nothing (I10). A hub that skipped this check would only be rude
   * to its own staff; the child would still refuse.
   */
  function canWriteToNode(user, nodeId, action) {
    const row = db.prepare('SELECT client_id FROM mesh_edges WHERE peer_node_id = ? AND direction = ?')
      .get(nodeId, 'down');
    if (!row || !row.client_id) return false;

    const clients = db.prepare('SELECT id, parent_client_id FROM mesh_clients').all();
    const parentOf = new Map(clients.map((c) => [c.id, c.parent_client_id]));
    const getParentId = (id) => parentOf.get(id) || null;
    const getAccessRow = (clientId, userId) => db.prepare(
      'SELECT role FROM mesh_client_access WHERE client_id = ? AND user_id = ?').get(clientId, userId);

    const { role, source } = clientTree.resolveAccess(
      row.client_id, user, getParentId, getAccessRow, clientRoles);
    if (!role || !clientRoles.roleAllows(role, action)) return false;
    if (clientRoles.requiresDirectAccess(action) && source !== 'direct') return false;
    return true;
  }

  /**
   * Every client beneath this one.
   *
   * ⚠️ Depth-bounded by a seen-set rather than trusting the tree to be acyclic. client-tree.js
   * cycle-checks on write, but a walk that assumes its input is well-formed is one bad row away from
   * hanging the request thread — and a hung report endpoint is indistinguishable from a slow one.
   */
  function descendantClientIds(rootId) {
    const rows = db.prepare('SELECT id, parent_client_id FROM mesh_clients').all();
    const children = new Map();
    for (const r of rows) {
      if (!r.parent_client_id) continue;
      if (!children.has(r.parent_client_id)) children.set(r.parent_client_id, []);
      children.get(r.parent_client_id).push(r.id);
    }
    const out = [];
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      for (const kid of children.get(queue.shift()) || []) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        out.push(kid);
        queue.push(kid);
      }
    }
    return out;
  }

  function visibleNodeIds(user) {
    const allowed = visibleClientIds(user);
    const edges = db.prepare(
      "SELECT peer_node_id, client_id FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL"
    ).all();

    /*
     * ⚠️ An edge with NO client is visible to platform_admin only. Defaulting it to "everyone" would
     * mean a node paired before anybody organised it into clients is silently readable by every
     * technician — and "we hadn't got round to filing it yet" is not a defence in a security review.
     */
    const direct = edges
      .filter((e) => (e.client_id ? allowed.has(e.client_id) : user && user.role === 'platform_admin'))
      .map((e) => e.peer_node_id);

    /*
     * ⚠️ NODES BELOW A VISIBLE ONE ARE VISIBLE TOO — otherwise a relayed screen is stored correctly
     * and then filtered out of every view, which reads as the relay not working at all.
     *
     * A relayed row's ORIGIN is a node this hub has no edge to, so visibility cannot be resolved
     * from the origin. It is resolved from the EDGE the row arrived on: if you may see the node
     * that relayed it, you may see what it relayed, because that is the same client's estate one
     * level further down.
     *
     * ⚠️ It does NOT widen who may see anything. The relayed row only exists because the node at
     * the bottom consented to its data travelling a second hop, and it is filed under the same
     * client as the node that carried it — so a technician sees exactly the clients they were named
     * on, in more depth, and never a client they were not.
     */
    const visibleEdgeIds = new Set(
      db.prepare("SELECT id, client_id FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL")
        .all()
        .filter((e) => (e.client_id ? allowed.has(e.client_id) : user && user.role === 'platform_admin'))
        .map((e) => e.id),
    );
    /*
     * ⚠️ FROM THE ROUTE MAP, NOT FROM DEVICE ROWS.
     *
     * This first derived relayed nodes from mesh_mirror_devices, which tied a server's VISIBILITY to
     * it having screens. A site that had connected but had nothing plugged in yet was therefore
     * invisible — its workspace arrived and could not be shown, and acting on it answered "no such
     * server" about a row on the topology page, because the topology reads the route map while this
     * read the devices.
     *
     * mesh_node_paths is the right source: it is written for ANY relayed payload — node health, a
     * workspace, a screen — so a server appears as soon as it is genuinely reachable through
     * something visible, which is the same moment the topology admits it exists.
     */
    let relayed = [];
    try {
      relayed = db.prepare('SELECT node_id, via_edge_id FROM mesh_node_paths').all()
        .filter((r) => visibleEdgeIds.has(r.via_edge_id))
        .map((r) => r.node_id);
    } catch (e) { relayed = []; }

    return [...new Set([...direct, ...relayed])];
  }

  const edgeFor = (nodeId) => db.prepare(
    "SELECT * FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down'").get(nodeId);

  /** GET /api/mesh/nodes — the Servers list. */
  router.get('/nodes', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ nodes: [], total: 0 });

    const marks = ids.map(() => '?').join(',');
    const nodes = db.prepare(
      `SELECT * FROM mesh_mirror_nodes WHERE origin_node_id IN (${marks})`).all(...ids);
    const devices = db.prepare(
      `SELECT origin_node_id, status FROM mesh_mirror_devices
        WHERE origin_node_id IN (${marks}) AND deleted_at IS NULL`).all(...ids);

    const byNode = new Map();
    for (const d of devices) {
      if (!byNode.has(d.origin_node_id)) byNode.set(d.origin_node_id, []);
      byNode.get(d.origin_node_id).push(d);
    }

    /*
     * ⚠️ Counted, not hardcoded. This was `openAlerts: 0` — the rollup has always had the field and
     * has always reported none, so a site with nine open alerts rendered a clean card. A placeholder
     * that renders as a REASSURING value is worse than a missing one, because nothing on screen
     * invites anybody to check.
     */
    const alertCounts = new Map(db.prepare(
      `SELECT origin_node_id, COUNT(*) AS c FROM mesh_mirror_alerts
        WHERE origin_node_id IN (${marks}) AND closed_at IS NULL
        GROUP BY origin_node_id`).all(...ids).map((r) => [r.origin_node_id, r.c]));

    const out = ids.map((id) => hubView.nodeRollup({
      node: nodes.find((n) => n.origin_node_id === id) || null,
      edge: edgeFor(id),
      devices: byNode.get(id) || [],
      openAlerts: alertCounts.get(id) || 0,
    }, now));

    res.json({ nodes: out, total: out.length, asOf: now });
  });

  /**
   * GET /api/mesh/orgs — connected servers presented as ORGS this operator can select.
   *
   * ⚠️ THE MODEL SHIFT THAT MAKES THE REST OF THE UI WORK. Earlier the position was that remote
   * workspaces must never enter the workspace switcher, because the switcher assumes a local
   * WRITABLE workspace and every write surface would grow a disabled state — "a UI full of dead
   * controls teaches people the product is broken."
   *
   * That objection is answered by making the controls not dead: a write against a remote org is
   * relayed to the server that owns it, over the link that already exists. Once writes work,
   * selecting a remote org is exactly like selecting a local one, and keeping it out of the
   * switcher becomes the arbitrary choice. Until the downward channel lands (I2) the selection is
   * READ-ONLY and the UI says so — which is a caveat on one banner rather than a disabled state on
   * every button.
   *
   * Named after the CLIENT where one exists, because "Acme Retail" is what an operator calls that
   * site; a node UUID is what the machine calls itself and nobody else ever does.
   */
  router.get('/orgs', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ orgs: [] });

    const marks = ids.map(() => '?').join(',');
    const mirrorStore = require('../lib/mesh/mirror-store');

    /*
     * ⚠️ ONE ORG PER REMOTE WORKSPACE, falling back to one per server.
     *
     * A connected server may hold several customers. Presenting it as a single org was wrong in the
     * exact way that matters to an MSP: every screen from that box landed in one undifferentiated
     * list, so the hub could not tell one client's estate from another's — which is the entire job.
     *
     * The fallback is not a degraded mode to apologise for. A health-only grant deliberately carries
     * no names, and a child on an older build sends no workspaces at all; both then read as one org
     * for that server, which is the honest summary of what we actually know rather than a guess at
     * structure we were not told.
     */
    const workspaces = db.prepare(
      `SELECT * FROM mesh_mirror_workspaces
        WHERE origin_node_id IN (${marks}) AND deleted_at IS NULL`).all(...ids);

    const deviceCounts = db.prepare(
      `SELECT origin_node_id, workspace_id,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online
         FROM mesh_mirror_devices
        WHERE origin_node_id IN (${marks}) AND deleted_at IS NULL
        GROUP BY origin_node_id, workspace_id`).all(...ids);

    const countFor = (nodeId, wsId) => deviceCounts.find(
      (c) => c.origin_node_id === nodeId && (wsId ? c.workspace_id === wsId : true)) || { total: 0, online: 0 };
    const nodeTotals = new Map();
    for (const c of deviceCounts) {
      const t = nodeTotals.get(c.origin_node_id) || { total: 0, online: 0 };
      t.total += c.total; t.online += (c.online || 0);
      nodeTotals.set(c.origin_node_id, t);
    }

    const orgs = [];
    for (const id of ids) {
      const edge = edgeFor(id);
      const client = edge && edge.client_id
        ? db.prepare('SELECT name FROM mesh_clients WHERE id = ?').get(edge.client_id) : null;
      const fresh = mirrorStore.freshnessOf(edge, now);
      const serverName = (edge && edge.peer_name) || null;
      const mine = workspaces.filter((w) => w.origin_node_id === id);

      const base = {
        nodeId: id,
        clientId: edge ? edge.client_id : null,
        /*
         * ⚠️ The SERVER's own name, separate from the client it is filed under and from the
         * workspace. The switcher used to sub-title every remote org "another server", which is true
         * of all of them and so distinguishes none.
         */
        serverName,
        stale: fresh === 'stale',
        /*
        * ⚠️ WHAT THE CHILD SAYS WE MAY DO — AND ONLY EVER FOR RENDERING.
        *
        * This was a hardcoded `false` with a comment saying it must stay so until the child tells us
        * otherwise, and nothing was ever built for the child to tell us. So a hub operator could not
        * see, per client, whether they may push content or how much storage is left; they could only
        * try and be refused, by a refusal deliberately identical for "no such thing" and "not
        * permitted". The child now announces its grant upward (mesh:write-offer) and this reads it.
        *
        * Advisory in the strongest sense: the child re-checks its own row on every request and owes
        * this hub nothing. A `true` here means "offer the operator the button", never "the write
        * will succeed" — and a stale or absent offer degrades to read-only, which is the safe way
        * for this to be wrong.
        */
      ...(() => {
        let offer = null;
        try { offer = edge && edge.peer_write_offer ? JSON.parse(edge.peer_write_offer) : null; } catch (x) { offer = null; }
        const cats = (offer && Array.isArray(offer.categories)) ? offer.categories : [];
        const spaces = (offer && Array.isArray(offer.workspaces)) ? offer.workspaces : [];
        return {
          writable: cats.length > 0 && spaces.length > 0,
          writeOffer: offer ? {
            categories: cats,
            workspaces: spaces,
            bytesBudget: offer.bytesBudget ?? null,
            bytesUsed: offer.bytesUsed ?? 0,
            bytesRemaining: typeof offer.bytesBudget === 'number'
              ? Math.max(0, offer.bytesBudget - (offer.bytesUsed || 0)) : 0,
          } : null,
        };
      })(),
      };

      if (!mine.length) {
        const t = nodeTotals.get(id) || { total: 0, online: 0 };
        orgs.push({
          ...base,
          workspaceId: null,
          name: (client && client.name) || serverName || `Server ${String(id).slice(0, 8)}`,
          deviceCount: t.total,
          // ⚠️ null when the link is stale, never 0 — "0 online" is a claim that the site is dark.
          devicesOnline: fresh === 'stale' ? null : t.online,
          // So the UI can say WHY a server shows as one org instead of several.
          grouping: 'server',
        });
        continue;
      }

      for (const w of mine) {
        const c = countFor(id, w.workspace_id);
        orgs.push({
          ...base,
          workspaceId: w.workspace_id,
          name: w.name || `Unnamed workspace ${String(w.workspace_id).slice(0, 6)}`,
          organizationName: w.organization_name || null,
          deviceCount: c.total,
          devicesOnline: fresh === 'stale' ? null : (c.online || 0),
          grouping: 'workspace',
        });
      }
    }

    res.json({ orgs });
  });

  /** GET /api/mesh/devices — the aggregated cross-node screens view. */
  router.get('/devices', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ devices: [], total: 0, limit: 0, offset: 0 });

    const q = hubView.deviceQuery({
      search: req.query.search || null,
      nodeIds: ids,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    const rows = db.prepare(q.sql).all(...q.params);
    const total = db.prepare(q.countSql).get(...q.countParams).c;
    const edges = new Map(ids.map((id) => [id, edgeFor(id)]));
    /*
     * ⚠️ A RELAYED SCREEN HAS NO DIRECT EDGE, and reading freshness from a missing one made it
     * STALE — a live screen two hops down displayed as unreachable, which is worse than not showing
     * it at all: an operator would go and investigate a site that is working.
     *
     * Its liveness belongs to the link it actually arrives over, which is the edge to the node that
     * relayed it. If that link is healthy the reports are current; if it drops, everything beneath
     * it goes stale together, which is exactly the truth.
     */
    const edgeById = new Map(
      db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down'").all().map((e) => [e.id, e]),
    );

    const devices = rows.map((r) => {
      const edge = edges.get(r.origin_node_id) || edgeById.get(r.edge_id);
      const view = hubView.withAsOf(hubView.deviceStatus(r, edge, now), now);
      let body = {};
      try { body = JSON.parse(r.body || '{}'); } catch (e) { body = {}; }
      return {
        deviceId: r.device_id,
        // ⚠️ The origin node is its OWN field, never concatenated into the name. Folding it in
        // ("Lobby (Acme)") breaks sort and search for every row at once, and it is the sort of thing
        // that is very hard to undo once a customer has learned to read it.
        originNodeId: r.origin_node_id,
        /*
         * ⚠️ WHICH SERVER IT CAME THROUGH, when that is not the same as where it lives. Without it
         * a three-tier estate is a flat list and an operator cannot tell which of their servers to
         * ask about a screen — the first question anybody has about a row they cannot reach.
         */
        ...(edge && edge.peer_node_id !== r.origin_node_id
          ? { relayedVia: edge.peer_node_id, relayedViaName: edge.peer_name || null } : {}),
        name: r.name,
        ...view,
        body,
        deepLink: hubView.deepLink(edge, 'device', r.device_id),
      };
    });

    res.json({
      devices, total, limit: q.limit, offset: Number(req.query.offset) || 0,
      asOf: now,
      /*
       * ⚠️ The empty state has to EXPLAIN ITSELF. A health-only grant stores no device name, so those
       * screens are un-searchable by name — a documented consequence of the grant. Without this the
       * result reads as a broken search, and the "fix" somebody reaches for is widening the grant.
       */
      searchNote: req.query.search
        ? 'Screens shared under a health-only grant have no name here and can only be found by id.'
        : null,
    });
  });

  /** GET /api/mesh/alerts — the cross-node inbox. */
  router.get('/alerts', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    if (!ids.length) return res.json({ alerts: [], total: 0 });

    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM mesh_mirror_alerts
        WHERE origin_node_id IN (${marks}) AND closed_at IS NULL
        ORDER BY opened_at DESC LIMIT 200`).all(...ids);

    const mirrorStore = require('../lib/mesh/mirror-store');
    const alerts = rows.map((a) => {
      const edge = edgeFor(a.origin_node_id);
      return {
        ...a,
        subjects: a.subjects ? JSON.parse(a.subjects) : null,
        /*
         * ⚠️ An alert from a node we cannot currently reach is LAST KNOWN, like every other row on
         * this hub. Without the flag the inbox is the one screen in the product that still implies
         * live truth — and it is the screen people act on fastest.
         */
        stale: mirrorStore.freshnessOf(edge, now) === 'stale',
        deepLink: hubView.deepLink(edge, 'alert', a.id),
      };
    });

    /*
     * ⚠️ ROLLED UP, AND MOST IMPORTANTLY FOR THE CASE WHERE THIS HUB IS THE BROKEN THING. When most
     * children go quiet at once the honest reading is "suspect the observer", not "40 sites are
     * down" — the latter dispatches engineers to premises that are fine. alert-rollup.js has encoded
     * this since Phase 2 but had no caller until now, so the inbox would have shown the forty.
     */
    const rolled = alertRollup.rollup(
      rows.map((a) => ({
        node_id: a.origin_node_id,
        type: a.alert_type,
        // ⚠️ MILLISECONDS. alert-rollup's correlation window is a ms constant, while every timestamp
        // stored on this hub is unix SECONDS. Passing seconds against a ms `now` makes every alert
        // look ancient, so nothing ever correlates and the rollup silently degrades to no rollup at
        // all — working code, no error, and the self-suspicion case never fires.
        opened_at: a.opened_at * 1000,
        severity: a.severity,
        subject_count: a.subject_count,
      })),
      { now: now * 1000, totalChildren: ids.length },
    ).filter((r) => r.rolled);

    res.json({
      alerts,
      total: alerts.length,
      asOf: now,
      // Only the grouped conditions; a single site's alert stays a single site's alert, named, rather
      // than being buried in a summary that reads as a statistic.
      rollups: rolled,
      // Local incidents live in the same inbox — a hub is a node too, and its own problems are not
      // somebody else's category.
      local: openIncidents(db),
    });
  });

  /**
   * GET /api/mesh/uptime?clientId=… — the per-client report.
   *
   * ⚠️ Bucketed in the ORIGIN's timezone, and the response says so. A store manager's downtime
   * happened during THEIR business hours; bucketing Perth's October by Kenosha days makes every
   * figure quietly wrong with nothing on screen to explain the discrepancy.
   *
   * ⚠️ SCOPED PER CLIENT, and an earlier version was NOT — it checked that the caller could see at
   * least one node and then reported over every alert_events row on this server, which handed a
   * technician scoped to one client the whole local fleet's incident history. Exactly the
   * fetch-everything-then-hope shape this file's header warns about, except nothing filtered it at
   * all. The client is now resolved and authorised before any row is read.
   */
  function buildReport(req, clientId) {
    const to = Number(req.query.to) || nowSec();
    const from = Number(req.query.from) || (to - 30 * 86400);
    const client = db.prepare('SELECT id, name FROM mesh_clients WHERE id = ?').get(clientId);
    if (!client) return { error: 404, reason: 'No such client.' };
    if (!visibleClientIds(req.user).has(client.id)) {
      // 404, not 403: "you may not see this" confirms it exists, and client names are commercially
      // sensitive in exactly the multi-tenant deployments this feature is for.
      return { error: 404, reason: 'No such client.' };
    }

    const report = meshUptime.clientUptime(db, {
      clientId: client.id,
      clientName: client.name,
      from,
      to,
      descendantsOf: (id) => descendantClientIds(id),
      nowSec: nowSec(),
    });
    const zone = hubView.zoneFor('report', {
      operatorTz: req.query.tz || null,
      originTz: req.query.originTz || null,
    });
    return { report: { ...report, timezone: zone, timezoneLabel: hubView.timeLabel('report', zone) } };
  }

  router.get('/uptime', requireAuth, (req, res) => {
    if (!req.query.clientId) {
      /*
       * ⚠️ NO IMPLICIT "EVERYTHING" REPORT. A report headed with no client name, mixing several
       * customers' screens into one percentage, is worse than useless: it is the document somebody
       * forwards to one of those customers. Asking for the client is one extra parameter and removes
       * the possibility.
       */
      return res.json({
        report: null,
        clients: [...visibleClientIds(req.user)].map((id) =>
          db.prepare('SELECT id, name FROM mesh_clients WHERE id = ?').get(id)).filter(Boolean),
        reason: 'Choose a client to report on.',
      });
    }
    const out = buildReport(req, String(req.query.clientId));
    if (out.error) return res.status(out.error).json({ report: null, reason: out.reason });
    res.json(out.report);
  });

  /** GET /api/mesh/uptime.csv?clientId=… — the same report, as the artifact. */
  router.get('/uptime.csv', requireAuth, (req, res) => {
    const out = buildReport(req, String(req.query.clientId || ''));
    if (out.error) return res.status(out.error).json({ reason: out.reason });

    /*
     * ⚠️ The filename is built from a WHITELIST, never from the client name directly. A name is
     * attacker-influenced text arriving from another server, and dropping it into Content-Disposition
     * is a header-injection primitive — the same reasoning as lib/brand-filename.js.
     */
    const stem = String(out.report.clientName || out.report.clientId || 'client')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'client';
    const day = new Date(out.report.to * 1000).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="uptime-${stem}-${day}.csv"`);
    res.send(meshUptime.toCsv(out.report));
  });

  /**
   * GET /api/mesh/read/:nodeId?path=/api/devices — a child's own live data, read through.
   *
   * ⚠️ THE PARENT MAY ASK, AND CANNOT TELL. The path is passed to the child, which owns the
   * allowlist and refuses anything outside it — the decision belongs to the side holding the rows,
   * not the side that wants them. This route deliberately does no allowlisting of its own beyond
   * refusing an obviously absent path: duplicating the list here would create two copies to keep in
   * step, and the copy that matters is the child's.
   *
   * ⚠️ SCOPED BEFORE IT ASKS. A caller may only read through to a node they can already see, so the
   * proxy cannot become a way around the client scoping that governs everything else here.
   */
  /**
   * POST /api/mesh/write/:nodeId — ask a child to change something.
   *
   * ⚠️ ASK. Everything that decides whether it happens lives on the child: its own allowlist, a
   * write grant its own operator set, and the target's workspace resolved from its own rows. This
   * route does no allowlisting of its own for the same reason the read route does not — a second
   * copy of the list would drift, and the copy that matters is the one on the machine that owns the
   * screens.
   *
   * ⚠️ THE opId IS MINTED HERE AND MUST SURVIVE A RETRY. If the child answers `indeterminate` the
   * caller should send the SAME body again: the child recorded the first outcome and will return it
   * rather than applying twice. Minting a fresh id on retry would defeat that entirely, which is
   * why it is generated per request body and echoed back in the response.
   */
  /*
   * ⚠️ CLIENTS, AND WHO MAY ACT ON THEM. WITHOUT THESE ROUTES THE WRITE PATH CANNOT BE REACHED.
   *
   * canWriteToNode resolves a role through mesh_clients / mesh_client_access, and nothing in the
   * codebase ever created a row in either table — no route, no migration, no enrolment path. So
   * the check could never pass, for anybody, on any install: the transport, the opId machinery and
   * the whole 403/504/503 triad were unreachable behind a permission model with no way to grant
   * permission. A capability that cannot be granted is a capability that does not exist.
   *
   * Deliberately platform-staff only. Deciding which of YOUR technicians may change a customer's
   * screens is an instance-owner decision, not a per-client one — a manager who could name
   * themselves publisher would defeat the direct-access rule that keeps write from inheriting down
   * the client tree.
   */
  function requirePlatformStaff(req, res, next) {
    if (!req.user || (req.user.role !== 'platform_admin' && req.user.role !== 'platform_operator')) {
      return res.status(403).json({ error: "Only this platform's staff can manage client access." });
    }
    return next();
  }

  /*
   * ⚠️ THE PARENT CAN END IT TOO. Revocation used to exist only on the child
   * (DELETE /api/mesh/uplink/:id): the node HOLDING a copy had no way to stop holding it short of
   * waiting a year for the pairing token to expire — and "the node that holds someone's data can
   * end that at will" is the consent-from-below rule read from the other side. lib/mesh/edge-status
   * has had `disenroll(edge, { by: 'parent' })` since Phase 2; nothing mounted it. This does.
   *
   * What it does, in this order, on THIS node: marks the edge revoked (the one state both sides
   * already use; nothing is sent downward — the child learns at its next connection, which the
   * live socket drop forces now), so the replica loop stops pulling and `terminates-players` /
   * `caches-content` end with it (both key on an active edge); then removes every media file cached
   * for that edge. Copied rows are KEPT and simply no longer updated — the same retain-and-mark-
   * stale default the child-side revoke has, for the same reason (a report must not rewrite itself
   * because somebody clicked disconnect). Screens already attached keep playing; a new register
   * answers read_replica.
   */
  router.delete('/links/:nodeId', requireAuth, requirePlatformStaff, (req, res) => {
    const edge = db.prepare("SELECT * FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down'").get(req.params.nodeId);
    const edgeStatus = require('../lib/mesh/edge-status');
    const now = Math.floor(Date.now() / 1000);
    const d = edgeStatus.disenroll(edge, { by: 'parent', now, reason: (req.body && req.body.reason) || null });
    if (!d.ok) return res.status(edge ? 409 : 404).json({ error: d.reason });
    db.prepare('UPDATE mesh_edges SET revoked_at = ?, token_hash = NULL WHERE id = ?').run(now, edge.id);
    // The child's live socket, if any: dropped now, so its next connection is refused at the door.
    try { if (global.__meshDropChild) global.__meshDropChild(edge.peer_node_id); } catch (e) { /* the next envelope is refused anyway */ }
    let filesDropped = 0;
    try { filesDropped = require('../lib/mesh/content-cache').sweep(db, require('../config')); } catch (e) { /* no cache on this node */ }
    let copied = 0;
    try { copied = db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE origin_node_id = ?').get(edge.peer_node_id).n; } catch (e) { /* */ }
    res.json({
      ok: true,
      summary: d.summary,
      filesDropped,
      copiedWorkspacesRetained: copied,
      note: copied
        ? 'The copied workspaces stay, read-only and no longer updated; screens already attached keep ' +
          'playing what they have, and no new screen will be accepted for them here.'
        : undefined,
    });
  });

  router.get('/clients', requireAuth, (req, res) => {
    const visible = visibleClientIds(req.user);
    const rows = db.prepare(`SELECT id, name, parent_client_id, created_at FROM mesh_clients
                              ORDER BY name COLLATE NOCASE`).all()
      .filter((c) => visible.has(c.id));
    const access = db.prepare(`SELECT client_id, user_id, role FROM mesh_client_access`).all();
    const users = db.prepare('SELECT id, email, name FROM users').all();
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json(rows.map((c) => ({
      ...c,
      nodes: db.prepare('SELECT peer_node_id FROM mesh_edges WHERE client_id = ? AND direction = ?')
        .all(c.id, 'down').map((e) => e.peer_node_id),
      access: access.filter((a) => a.client_id === c.id).map((a) => ({
        user_id: a.user_id, role: a.role,
        email: (byId.get(a.user_id) || {}).email || null,
        name: (byId.get(a.user_id) || {}).name || null,
      })),
    })));
  });

  router.post('/clients', requireAuth, requirePlatformStaff, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'A client needs a name.' });
    const parent = (req.body && req.body.parent_client_id) || null;
    if (parent && !db.prepare('SELECT 1 FROM mesh_clients WHERE id = ?').get(parent)) {
      return res.status(400).json({ error: 'That parent client does not exist.' });
    }
    const id = require('crypto').randomUUID();
    db.prepare(`INSERT INTO mesh_clients (id, name, parent_client_id, created_at)
                VALUES (?,?,?,strftime('%s','now'))`).run(id, name, parent);
    res.status(201).json({ id, name, parent_client_id: parent });
  });

  /*
   * Assign a linked server to a client. Until a node has a client it is visible to platform staff
   * and writable by nobody — which is the right default: an unassigned customer is one nobody has
   * been made responsible for yet.
   */
  /*
   * ⚠️ ADDRESSED UNDER /clients, NOT /nodes, AND THE URL IS THE POINT.
   *
   * This writes mesh_edges.client_id — which customer a linked server is FILED under, this hub's
   * own bookkeeping. It has nothing to do with the node's mirrored data, and a guard asserting that
   * everything under /mesh/nodes is read-only caught the first spelling of this route. It was right
   * to: a URL that reads like "write to a node" is one somebody later extends into writing to a
   * node. The resource being modified is the client's list of servers, so that is where it lives.
   *
   * `unassigned` as the client id unfiles a server. An unfiled server is writable by nobody, which
   * is the correct default — a customer nobody has been made responsible for yet.
   */
  router.put('/clients/:id/nodes/:nodeId', requireAuth, requirePlatformStaff, (req, res) => {
    const edge = db.prepare('SELECT id FROM mesh_edges WHERE peer_node_id = ? AND direction = ?')
      .get(req.params.nodeId, 'down');
    if (!edge) return res.status(404).json({ error: 'No such server.' });
    const clientId = req.params.id === 'unassigned' ? null : req.params.id;
    if (clientId && !db.prepare('SELECT 1 FROM mesh_clients WHERE id = ?').get(clientId)) {
      return res.status(404).json({ error: 'No such client.' });
    }
    db.prepare('UPDATE mesh_edges SET client_id = ? WHERE id = ?').run(clientId, edge.id);
    res.json({ ok: true, node_id: req.params.nodeId, client_id: clientId });
  });

  /*
   * ⚠️ PASS CONTENT ON TO THIS CLIENT AUTOMATICALLY — set here, by the operator who holds the
   * relationship with them, and settable nowhere else.
   *
   * A grandparent cannot switch this on: the servers below granted content-push to THIS node, not
   * to whoever is above it, and letting an instruction from above decide what lands on them would
   * be acting on a grant nobody gave. What arrives from above is an offer this node may choose to
   * repeat.
   *
   * It also cannot widen what travels. Content carries the owner's decision about whether it may be
   * passed on at all, and forwarding respects that whatever this says.
   */
  router.put('/clients/:id/nodes/:nodeId/auto-forward', requireAuth, requirePlatformStaff, (req, res) => {
    const edge = db.prepare("SELECT id FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down'")
      .get(req.params.nodeId);
    if (!edge) return res.status(404).json({ error: 'No such server.' });
    const on = !!(req.body && req.body.enabled);
    db.prepare('UPDATE mesh_edges SET auto_forward = ? WHERE id = ?').run(on ? 1 : 0, edge.id);
    res.json({
      ok: true,
      autoForward: on,
      note: on
        ? 'Content sent to this server that its owner allowed to be passed on will now be offered ' +
          'to that client automatically. They still apply their own permissions on arrival.'
        : 'This client will only receive content you send them explicitly.',
    });
  });

  router.put('/clients/:id/access', requireAuth, requirePlatformStaff, (req, res) => {
    if (!db.prepare('SELECT 1 FROM mesh_clients WHERE id = ?').get(req.params.id)) {
      return res.status(404).json({ error: 'No such client.' });
    }
    const userId = (req.body && req.body.user_id) || null;
    const role = (req.body && req.body.role) || null;
    if (!userId || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
      return res.status(400).json({ error: 'That user does not exist.' });
    }
    /*
     * An empty role REMOVES the access rather than storing a blank one — the same shape as
     * revoking a write grant with an empty category list, so "take it away" is expressible
     * without severing anything else.
     */
    if (!role) {
      db.prepare('DELETE FROM mesh_client_access WHERE client_id = ? AND user_id = ?')
        .run(req.params.id, userId);
      return res.json({ ok: true, removed: true });
    }
    if (!clientRoles.isKnownRole(role)) {
      return res.status(400).json({ error: `Unknown role. Known roles: ${clientRoles.ROLE_NAMES.join(', ')}.` });
    }
    db.prepare(`INSERT INTO mesh_client_access (client_id, user_id, role, granted_at)
                VALUES (?,?,?,strftime('%s','now'))
                ON CONFLICT(client_id, user_id) DO UPDATE SET role = excluded.role`)
      .run(req.params.id, userId, role);
    res.json({ ok: true, client_id: req.params.id, user_id: userId, role });
  });

  /*
   * ⚠️ "NO SUCH SERVER" IS THE RIGHT ANSWER TO A STRANGER AND THE WRONG ONE TO YOUR OWN OPERATOR.
   *
   * Acting on a node requires a DIRECT link: writes, content and commands all reach a child over
   * the socket it dialled in on, and there is deliberately no forwarding — the servers below a
   * relay granted THAT relay, not whoever sits above it, so passing an instruction through would
   * let a grandparent act on a grant it was never given.
   *
   * But relayed telemetry means a node two hops down now APPEARS on the topology and in the fleet
   * list. An operator clicks it and, before this, was told "No such server" about a row they were
   * looking at. The refusal was correct and the message was a lie.
   *
   * So the two cases are separated: a node nobody may see stays "no such server", because whether
   * it exists is not something an unauthorised caller learns. A node you CAN see but cannot reach
   * directly says so, and names the server that does have the link — which is the next thing that
   * person needs to know.
   */
  function directEdgeOrExplain(user, nodeId) {
    const ids = visibleNodeIds(user);
    if (!ids.includes(nodeId)) return { ok: false, status: 404, error: 'No such server.' };

    const direct = db.prepare(
      "SELECT * FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down' AND revoked_at IS NULL")
      .get(nodeId);
    if (direct) return { ok: true, edge: direct };

    let via = null;
    try {
      const path = db.prepare('SELECT via_edge_id, hops FROM mesh_node_paths WHERE node_id = ?').get(nodeId);
      if (path) via = db.prepare('SELECT peer_node_id, peer_name FROM mesh_edges WHERE id = ?').get(path.via_edge_id);
    } catch (e) { via = null; }

    return {
      ok: false,
      status: 409,
      error: via
        ? `That server reports through ${via.peer_name || `server ${String(via.peer_node_id).slice(0, 8)}`}, ` +
          'not to this one, so changes cannot be sent to it from here. Ask that server to make the ' +
          'change, or connect to it directly.'
        : 'That server does not report to this one directly, so changes cannot be sent to it from here.',
      reachableFrom: via ? via.peer_node_id : null,
    };
  }

  router.post('/write/:nodeId', requireAuth, async (req, res) => {
    const reach = directEdgeOrExplain(req.user, req.params.nodeId);
    if (!reach.ok) return res.status(reach.status).json(reach);
    /*
     * ⚠️ Seeing a client is not permission to change their screens. Before this check any `viewer`
     * who could reach the node could reach this route — the read proxy gates on visibility alone,
     * which is right for reads and wrong here.
     */
    if (!canWriteToNode(req.user, req.params.nodeId, 'push-content')) {
      return res.status(403).json({
        error: 'You can see this server, but you are not named as a publisher on it. Write access ' +
               'has to be granted on the client directly — it is deliberately not inherited from a ' +
               'parent client.',
      });
    }
    const writeTo = global.__meshWriteTo;
    if (!writeTo) {
      return res.status(503).json({ error: 'This server is not accepting connections from others.' });
    }
    const path = String((req.body && req.body.path) || '');
    const method = String((req.body && req.body.method) || '').toUpperCase();
    if (!path || !method) {
      return res.status(400).json({ error: 'A write needs a path and a method.' });
    }

    const opId = String((req.body && req.body.opId) || require('crypto').randomUUID());
    /*
     * ⚠️ WHO ASKED, SENT AS A CLAIM AND NOTHING MORE.
     *
     * The child cannot verify this and must never act on it — its own grant is the only thing that
     * decides anything. It travels because "your MSP changed this playlist" is far less useful to
     * a customer working out what happened than "Priya at your MSP changed it", and the child
     * records it labelled as unverified. Name and email only: no id, because an id from another
     * server means nothing on the child and would invite somebody to try joining on it.
     */
    const actor = req.user ? { name: req.user.name || null, email: req.user.email || null } : null;

    const answer = await writeTo(req.params.nodeId, {
      actor,
      path,
      method,
      body: req.body && req.body.body,
      opId,
      sentAt: Date.now(),
      /*
       * A deadline, so a request that sat in a reconnect buffer cannot outrun a revocation. Short
       * on purpose: an operator who waited two minutes has already retried.
       */
      notAfter: Date.now() + 120_000,
      ...(typeof (req.body && req.body.intentSeq) === 'number' ? { intentSeq: req.body.intentSeq } : {}),
    });

    if (!answer || !answer.ok) {
      /*
       * ⚠️ Three outcomes, and they need three different responses from an operator: 503 the child
       * is not connected and nothing happened; 504 it did not acknowledge and the change may or may
       * not have landed — retry with this opId to find out; 403 it refused, and no retry will help.
       * Collapsing them into one error is how somebody retries a write that already applied.
       */
      if (answer && answer.offline) return res.status(503).json({ error: answer.reason, opId });
      if (answer && answer.indeterminate) {
        return res.status(504).json({ error: answer.reason, opId, retryWithSameOpId: true });
      }
      return res.status(403).json({ error: (answer && answer.reason) || 'That server refused.', opId });
    }
    res.json({ ok: true, opId, replayed: !!answer.replayed, result: answer.outcome });
  });

  /*
   * ⚠️ SEND CONTENT TO A CHILD — the SECOND route here that reaches another node, and like the
   * first it only ASKS. It builds a description of some files and a one-time ticket for each, hands
   * both to the child, and the child decides what it needs, whether it may accept it, and whether
   * there is room. Nothing about the child's disk is judged here (I10).
   *
   * The bytes never touch this route. The envelope caps a batch at 512 KB against a 500 MB upload
   * limit, so the socket carries the offer and the child pulls the files over HTTP from the address
   * it already had — which also means one slow transfer cannot block the control plane.
   */
  router.post('/content/:nodeId', requireAuth, async (req, res) => {
    const reach = directEdgeOrExplain(req.user, req.params.nodeId);
    if (!reach.ok) return res.status(reach.status).json(reach);
    if (!canWriteToNode(req.user, req.params.nodeId, 'push-content')) {
      return res.status(403).json({
        error: 'You do not have permission to send content to this client. Ask an administrator ' +
               'to name you on it.',
      });
    }

    const offerTo = global.__meshContentOfferTo;
    if (!offerTo) {
      return res.status(503).json({ error: 'This server is not accepting connections from others.' });
    }

    const edge = reach.edge;

    const workspaceId = req.body && req.body.workspace_id;
    if (!workspaceId) {
      return res.status(400).json({
        error: 'Name the workspace on their server that this content is for.',
      });
    }

    /*
     * ⚠️ `relayable` is THIS operator's consent that the files may be passed on by the receiving
     * server to servers below it. Their content, their call — and it is opt-in per push rather
     * than a property of the link, because "you may send me things" and "you may hand what I sent
     * you to someone else" are different agreements.
     */
    const built = contentOffer.buildOffer(db, edge, (req.body && req.body.content_ids) || [],
                                          { contentDir: config.contentDir,
                                            relayable: !!(req.body && req.body.relayable) });
    if (!built.ok) return res.status(400).json({ error: built.reason, skipped: built.skipped });

    const answer = await offerTo(req.params.nodeId, {
      manifest: built.manifest, tickets: built.tickets, workspaceId,
      // Same claim, same caveat as the write path — see POST /write/:nodeId.
      actor: req.user ? { name: req.user.name || null, email: req.user.email || null } : null,
    });

    if (!answer || !answer.ok) {
      /*
       * Same three outcomes as a write, and they mean the same three things to an operator: 503
       * nothing was sent, 504 some of it may have arrived and re-sending is safe, 403 the customer
       * refused. A partial success arrives here too — the child reports per item, and that detail
       * is passed through rather than flattened, because "3 of 9 files failed" is the only version
       * of this an operator can act on.
       */
      if (answer && answer.offline) return res.status(503).json({ error: answer.reason });
      if (answer && answer.indeterminate) return res.status(504).json({ error: answer.reason, resendIsSafe: true });
      return res.status(403).json({
        error: (answer && answer.reason) || 'That server refused the content.',
        failed: (answer && answer.failed) || [],
        stored: (answer && answer.stored) || [],
      });
    }
    res.json({ ok: true, ...answer, skippedHere: built.skipped });
  });

  /*
   * ⚠️ SEND THE SAME CONTENT TO SEVERAL CLIENTS AT ONCE.
   *
   * The real shape of this job: an MSP has one campaign and forty sites, and doing that one node at
   * a time is forty trips through a UI plus keeping track of which ones took it. Nothing about it
   * needs new permission — the content belongs to this operator, and every client on the list has
   * already granted them content-push individually. This is a loop over a decision each customer
   * already made, not a new power.
   *
   * ⚠️ IT IS NOT A RELAY, and the distinction is worth keeping straight. Each child still fetches
   * from THIS node; nothing is cached in between, no third party holds anybody's bytes, and each
   * child's own grant is checked on arrival exactly as it is for a single push. The relay tier —
   * where an intermediate node stores and serves a subtree — is a different feature with an
   * unresolved consent question, and is documented in docs/mesh-relay-design.md rather than built.
   *
   * ⚠️ Bounded concurrency, not one big Promise.all. A push holds its acknowledgement open until
   * the child has finished fetching, so forty at once is forty long-lived sockets and forty
   * simultaneous transfers out of one uplink — which is how a hub saturates its own connection and
   * makes every one of them slower. Four at a time keeps the link usable and the wall-clock sane.
   */
  router.post('/content', requireAuth, async (req, res) => {
    const wanted = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
    if (!wanted.length) return res.status(400).json({ error: 'Choose which servers to send to.' });
    if (wanted.length > 100) {
      return res.status(400).json({ error: `That is ${wanted.length} servers; 100 at a time.` });
    }
    const contentIds = (req.body && req.body.content_ids) || [];
    if (!contentIds.length) return res.status(400).json({ error: 'Choose some content to send.' });

    const offerTo = global.__meshContentOfferTo;
    if (!offerTo) {
      return res.status(503).json({ error: 'This server is not accepting connections from others.' });
    }

    const visible = visibleNodeIds(req.user);
    const actor = req.user ? { name: req.user.name || null, email: req.user.email || null } : null;

    /*
     * ⚠️ EVERY TARGET IS AUTHORISED INDIVIDUALLY. A batch is a convenience for the operator and
     * must never become a way to reach a client they could not reach one at a time — so visibility
     * and the publisher role are re-checked per node, not once for the request.
     */
    const results = [];
    const queue = wanted.slice();
    const runOne = async (t) => {
      const nodeId = t && t.node_id;
      const workspaceId = t && t.workspace_id;
      const label = { nodeId, workspaceId };
      if (!nodeId || !workspaceId) return { ...label, ok: false, reason: 'Missing server or workspace.' };
      // ⚠️ Same reachability answer as the single send, per target — a batch across forty sites is
      // exactly where an operator meets a relayed node and needs to be told why it was skipped.
      const reach = directEdgeOrExplain(req.user, nodeId);
      if (!reach.ok) return { ...label, ok: false, reason: reach.error };
      if (!canWriteToNode(req.user, nodeId, 'push-content')) {
        return { ...label, ok: false, reason: 'You may not send content to that client.' };
      }
      const edge = reach.edge;

      /*
       * ⚠️ A FRESH OFFER PER TARGET, tickets included. A ticket names one file on one EDGE, so
       * reusing one batch's tickets across children would hand every child a credential minted for
       * a different relationship — and make revoking one edge stop transfers on another.
       */
      const built = contentOffer.buildOffer(db, edge, contentIds,
        { contentDir: config.contentDir, relayable: !!(req.body && req.body.relayable) });
      if (!built.ok) return { ...label, ok: false, reason: built.reason };

      const answer = await offerTo(nodeId, {
        manifest: built.manifest, tickets: built.tickets, workspaceId, actor,
      });
      return {
        ...label,
        ok: !!(answer && answer.ok),
        reason: answer && answer.reason,
        stored: (answer && answer.stored ? answer.stored.length : 0),
        alreadyHeld: (answer && answer.alreadyHeld ? answer.alreadyHeld.length : 0),
      };
    };

    const CONCURRENCY = 4;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try { results.push(await runOne(next)); }
        catch (e) { results.push({ nodeId: next && next.node_id, ok: false, reason: (e && e.message) || 'failed' }); }
      }
    }));

    /*
     * ⚠️ 200 with per-target results, even when some failed. A batch across forty sites will have a
     * few offline, and collapsing that into one status code loses the only thing the operator needs
     * — WHICH ones, so they can send to those again later without re-sending to the thirty-seven
     * that took it.
     */
    res.json({
      ok: results.every((r) => r.ok),
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  });

  /*
   * ⚠️ WITHDRAW CONTENT THIS SERVER SENT. The only route here that removes anything anywhere, and
   * it can only reach what this node itself sent to that client — the child matches every id
   * against its own record of what came from us.
   *
   * A child refuses anything one of its playlists still uses, and reports which. That is not a
   * failure to work around: a file pulled out from under a published playlist is a blank slot on a
   * wall, and the decision to accept that belongs to whoever is standing in front of it.
   */
  router.post('/content/:nodeId/purge', requireAuth, async (req, res) => {
    const reach = directEdgeOrExplain(req.user, req.params.nodeId);
    if (!reach.ok) return res.status(reach.status).json(reach);
    if (!canWriteToNode(req.user, req.params.nodeId, 'push-content')) {
      return res.status(403).json({ error: 'You do not have permission to change content on this client.' });
    }
    const purgeTo = global.__meshContentPurgeTo;
    if (!purgeTo) return res.status(503).json({ error: 'This server is not accepting connections from others.' });

    const oids = (req.body && req.body.content_ids) || [];
    if (!Array.isArray(oids) || !oids.length) {
      return res.status(400).json({ error: 'Choose what to withdraw.' });
    }

    const answer = await purgeTo(req.params.nodeId, {
      oids,
      actor: req.user ? { name: req.user.name || null, email: req.user.email || null } : null,
    });
    if (!answer || !answer.ok) {
      if (answer && answer.offline) return res.status(503).json({ error: answer.reason });
      if (answer && answer.indeterminate) return res.status(504).json({ error: answer.reason, resendIsSafe: true });
      return res.status(403).json({ error: (answer && answer.reason) || 'That server refused.' });
    }
    res.json({ ok: true, ...answer });
  });

  /*
   * ⚠️ WHERE THE BYTES ACTUALLY COME FROM, and the only unauthenticated-by-JWT route in this file.
   *
   * The caller is a CHILD SERVER, not a person — it holds a ticket rather than a session, so
   * requireAuth would be exactly wrong. The ticket is the credential: it is hashed at rest, names
   * ONE file on ONE edge, expires in hours, and is checked against a LIVE read of the edge so a
   * link severed a moment ago stops serving immediately.
   *
   * ⚠️ Range is honoured because the far side depends on it. These transfers run over the worst
   * links this product sees — a shop on 4G, a coach with a rooftop modem — and a 400 MB file that
   * restarts from zero on every drop never completes at all.
   *
   * ⚠️ NOT single-use, deliberately: a resumable download makes several requests against the same
   * ticket by design, so single-use would break precisely the transfers this exists for.
   */
  router.get('/pull/:token', (req, res) => {
    const redeemed = contentOffer.redeemTicket(db, req.params.token);
    // One answer for "no such ticket", "expired" and "the link is gone" — a caller learns nothing
    // from the difference, and there is nothing useful it could do with it.
    if (!redeemed.ok) return res.status(404).json({ error: redeemed.reason });

    const abs = path.join(config.contentDir, path.basename(redeemed.ticket.filepath));
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'That file is no longer here.' });

    /*
     * ⚠️ CHECKED BEFORE IT IS SERVED — but the size on every request and the digest only when the
     * file has actually changed.
     *
     * The receiving node verifies size, digest and type on arrival, so a wrong file cannot be
     * accepted whatever this does; that is the guarantee, and it stays. What this adds is catching
     * it HERE, where the operator who can fix it will see it, instead of as a mystery failure at a
     * customer site. A file replaced or truncated under a live ticket is a real thing — a restore, a
     * botched sync, a disk error — and the ticket names the bytes it was minted for.
     *
     * ⚠️ Re-hashing per request was the obvious version and it is wrong: a 500 MB asset pulled by
     * forty sites would be forty full reads of a file nobody touched, on the box those sites are
     * also fetching from. The digest is verified once per (size, mtime) and the result remembered,
     * so a changed file is caught and an unchanged one costs a statSync.
     */
    let stat;
    try { stat = fs.statSync(abs); } catch (e) {
      return res.status(404).json({ error: 'That file is no longer here.' });
    }
    if (typeof redeemed.ticket.size === 'number' && stat.size !== redeemed.ticket.size) {
      console.warn(`[mesh] refusing to serve ${redeemed.ticket.filepath}: ${stat.size} bytes, ` +
                   `ticket says ${redeemed.ticket.size}`);
      return res.status(409).json({ error: 'That file has changed since it was offered.' });
    }
    if (redeemed.ticket.digest && !verifiedRecently(abs, stat, redeemed.ticket.digest)) {
      console.warn(`[mesh] refusing to serve ${redeemed.ticket.filepath}: digest does not match the ticket`);
      return res.status(409).json({ error: 'That file has changed since it was offered.' });
    }

    /*
     * ⚠️ The response is forced to an opaque type and marked nosniff. It is a byte stream for a
     * machine; nothing about it should ever be interpreted by a browser that happens to open the
     * URL, and the same rule the upload routes follow applies here.
     */
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    // A validator so the far side can use If-Range and refuse to stitch two different files.
    if (redeemed.ticket.digest) res.setHeader('ETag', `"${redeemed.ticket.digest}"`);

    db.prepare('UPDATE mesh_pull_tickets SET used_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(redeemed.ticket.id);

    // res.sendFile handles Range, If-Range, 206 and 416 correctly; re-implementing that by hand is
    // how off-by-one errors get into a byte stream.
    return res.sendFile(abs, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  });

  router.get('/read/:nodeId', requireAuth, async (req, res) => {
    /*
     * ⚠️ Reads do not traverse a relay either — readFrom finds a directly-connected socket or
     * nothing. Before this, asking a two-hop server for live data answered "not connected right
     * now", which reads as a temporary fault and invites retrying something that can never work.
     * A node nobody may see still gets the flat 404: whether it exists is not something an
     * unauthorised caller learns.
     */
    const reach = directEdgeOrExplain(req.user, req.params.nodeId);
    if (!reach.ok) return res.status(reach.status).json(reach);
    const readFrom = global.__meshReadFrom;
    if (!readFrom) {
      return res.status(503).json({ error: 'This server is not accepting connections from others.' });
    }
    const answer = await readFrom(req.params.nodeId, {
      path: String(req.query.path || ''),
      method: 'GET',
    });
    if (!answer || !answer.ok) {
      /*
       * ⚠️ 503 when the child is merely offline, 403 when it refused. They read the same to a naive
       * client and mean opposite things: one is "try again shortly", the other is "this will never
       * work until somebody changes a grant".
       */
      return res.status(answer && answer.offline ? 503 : 403)
        .json({ error: (answer && answer.reason) || 'That server did not answer.' });
    }
    res.json(answer);
  });

  /**
   * GET /api/mesh/screenshot/:nodeId/:deviceId — a remote screen's picture, proxied as an image.
   *
   * ⚠️ ITS OWN ROUTE BECAUSE IT RETURNS BYTES, NOT JSON. /mesh/read wraps everything in an envelope,
   * which is right for data and useless for an <img src>: a browser needs the image with a content
   * type, not a JSON object containing one. Squeezing it through the JSON route would have meant
   * base64 in a response body and a data: URL on the page — larger, slower, and uncacheable.
   *
   * Scoped before it asks, like every other route here, and the CHILD still applies the
   * display-capture grant: this endpoint cannot be a way around it.
   */
  /*
   * ⚠️ AUTHENTICATED BY HEADER **OR** QUERY, because the caller is an <img> tag.
   *
   * requireAuth reads the Authorization header, and a browser loading an image cannot send one — so
   * this route answered 401 to the only client that will ever call it, and the page rendered a
   * broken image with no error anybody would see. The proxy itself was working the whole time; the
   * door it was behind only opened for callers that could not knock.
   *
   * The local screenshot route already solved this the same way, with the same resolver, for the
   * same reason. Matching it means one definition of "this token is a usable session" rather than a
   * second, subtly different one.
   */
  router.get('/screenshot/:nodeId/:deviceId', (req, res, next) => {
    if (req.headers.authorization) return requireAuth(req, res, next);
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const session = resolveSessionUser(token, { sourceIp: req.ip || null });
      req.user = session.user;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }, async (req, res) => {
    const ids = visibleNodeIds(req.user);
    if (!ids.includes(req.params.nodeId)) return res.status(404).json({ error: 'No such server.' });
    const readFrom = global.__meshReadFrom;
    if (!readFrom) return res.status(503).json({ error: 'Not accepting connections from others.' });

    const answer = await readFrom(req.params.nodeId, {
      path: `/api/devices/${encodeURIComponent(req.params.deviceId)}/screenshot`,
      method: 'GET',
    });
    if (!answer || !answer.ok || !answer.image) {
      /*
       * ⚠️ 404 for "no screenshot", 503 for "cannot reach that server". They look the same to a
       * browser rendering a broken image, and mean opposite things to whoever has to fix it.
       */
      return res.status(answer && answer.offline ? 503 : 404)
        .json({ error: (answer && answer.reason) || 'No screenshot available.' });
    }

    const buf = Buffer.isBuffer(answer.image) ? answer.image : Buffer.from(answer.image);
    res.set('Content-Type', answer.mime || 'image/jpeg');
    // Last-known by definition: the child captured it whenever it captured it, not on this request.
    res.set('Cache-Control', 'no-cache');
    if (answer.capturedAt) res.set('X-Captured-At', String(answer.capturedAt));
    res.send(buf);
  });

  /** GET /api/mesh/topology — the graph, for the topology view. */
  router.get('/topology', requireAuth, (req, res) => {
    const now = nowSec();
    const ids = visibleNodeIds(req.user);
    const edges = ids.map((id) => {
      const e = edgeFor(id);
      const node = db.prepare('SELECT * FROM mesh_mirror_nodes WHERE origin_node_id = ?').get(id);
      return {
        edgeId: e ? e.id : null,
        peerNodeId: id,
        clientId: e ? e.client_id : null,
        grant: e ? JSON.parse(e.grant_categories || '[]') : [],
        transportDirection: e ? e.transport_direction : null,
        tlsVerify: e ? !!e.tls_verify : null,
        peerVersion: node ? node.node_version : null,
        // What to print on the box in the diagram. Same precedence as the fleet rollup.
        peerName: (node && node.node_name) || (e && e.peer_name) || null,
        lastSyncAt: e ? e.last_sync_at : null,
        // Surfaced per edge so an operator can see WHICH link is the problem rather than being told
        // the mesh is unwell.
        freshness: require('../lib/mesh/mirror-store').freshnessOf(e, now),
      };
    });
    /*
     * ⚠️ NODES BEYOND THE FIRST HOP, so the shape of the estate is visible rather than just this
     * node's own neighbours.
     *
     * Without it a three-tier mesh looked identical to a two-tier one: a single row saying "we are
     * paired with B", and no way to tell whether B is a site with screens or a relay with a dozen
     * sites behind it. The number an operator asks for is how many servers a screen's data crosses
     * to reach them, and that number was nowhere on the page.
     *
     * Learned from attested ancestry (mirror-store.recordNodePath) rather than declared, and scoped
     * the same way everything else here is: a path is shown only if the edge it arrived over is one
     * this user may see.
     */
    let indirect = [];
    try {
      const visibleEdges = new Set(
        db.prepare("SELECT id, client_id FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL")
          .all()
          .filter((e) => (e.client_id ? visibleClientIds(req.user).has(e.client_id)
                                      : req.user && req.user.role === 'platform_admin'))
          .map((e) => e.id),
      );
      indirect = db.prepare('SELECT * FROM mesh_node_paths ORDER BY hops, node_id').all()
        .filter((r) => visibleEdges.has(r.via_edge_id))
        .map((r) => {
          let path = [];
          try { path = JSON.parse(r.path); } catch (e) { path = []; }
          const via = db.prepare('SELECT peer_node_id, peer_name FROM mesh_edges WHERE id = ?').get(r.via_edge_id);
          const seen = db.prepare('SELECT node_name FROM mesh_mirror_nodes WHERE origin_node_id = ?')
            .get(r.node_id);
          return {
            nodeId: r.node_id,
            /*
             * ⚠️ ONLY FROM THE MIRROR, never from mesh_node_paths. A path is ancestry — a list of
             * ids attested by the nodes that relayed it — and a name is not a fact about a path.
             * Reading it here keeps the naming and the routing on separate rails, so no amount of
             * creative naming downstream can change where anything is delivered.
             */
            name: (seen && seen.node_name) || null,
            hops: r.hops,
            // Ordered nearest-first, so it reads the way an operator traces it: us -> B -> C.
            path: [...path].reverse(),
            viaNodeId: via ? via.peer_node_id : null,
            viaName: via ? via.peer_name : null,
            lastSeenAt: r.last_seen_at,
          };
        });
    } catch (e) { indirect = []; }

    res.json({ edges, indirect, asOf: now, depthCap: require('../config').meshMaxDepth });
  });

  return router;
};
