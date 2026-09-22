'use strict';

/*
 * How a hub presents what it has mirrored: status, time, search and rollups.
 *
 * ⚠️ STATUS IS TRI-STATE, AND BINARY IS NOT A SIMPLIFICATION — IT IS A LIE.
 *
 * A hub knows two independent things: what a node last told it, and whether that node is currently
 * reachable. Collapsing them into online/offline forces a choice between two wrong answers when the
 * LINK fails: report the last known state as current (a green dot from ninety minutes ago), or report
 * everything as offline (a WAN blip on one hub link paints 400 healthy screens red and dispatches an
 * engineer). Both are worse than saying "I do not currently know, and here is when I last did".
 *
 *   live    the origin node is reachable and reported recently — this is current
 *   stale   the origin node is unreachable — this is the LAST KNOWN state, as of a timestamp
 *   down    the origin node IS reachable and says the screen is offline — this is a real fault
 *
 * ⚠️ THE DIFFERENCE BETWEEN `stale` AND `down` IS WHO IS BROKEN, and it is the single most useful
 * thing this view communicates. `down` sends someone to a screen. `stale` sends them to a network.
 */

const { freshnessOf } = require('./mirror-store');

const STATUS = Object.freeze({ LIVE: 'live', STALE: 'stale', DOWN: 'down', UNKNOWN: 'unknown' });

/**
 * @param {object} row   a mesh_mirror_devices row
 * @param {object} edge  the edge it arrived over
 */
function deviceStatus(row, edge, nowSec, staleAfterSec = 600) {
  const linkFreshness = freshnessOf(edge, nowSec, staleAfterSec);

  // ⚠️ THE LINK IS CHECKED FIRST, ALWAYS. What the row says is only meaningful if we are still in
  // touch with whoever said it — otherwise a device that went offline after the link dropped would
  // be reported as online indefinitely, and one that came back would never be seen to.
  if (linkFreshness === 'unknown') {
    return { status: STATUS.UNKNOWN, asOf: null,
             explain: 'This node has not synced yet.' };
  }
  if (linkFreshness === 'stale') {
    return {
      status: STATUS.STALE,
      asOf: row ? row.received_at : (edge ? edge.last_sync_at : null),
      explain: 'Showing the last state received. The node itself is not currently reachable, so ' +
               'this may be out of date — check the connection to the site before the screen.',
    };
  }

  if (!row) return { status: STATUS.UNKNOWN, asOf: null, explain: 'No report for this screen yet.' };

  const online = row.status === 'online';
  return {
    status: online ? STATUS.LIVE : STATUS.DOWN,
    asOf: row.received_at,
    explain: online
      ? null
      : 'The node is reachable and reports this screen as offline, so the fault is at the screen.',
  };
}

/**
 * ⚠️ EVERY REMOTE ROW CARRIES ITS AS-OF TIME, even a healthy one.
 *
 * A green dot with no timestamp is a claim about the present that may be ninety minutes old, and the
 * reader has no way to tell. Attaching the age to every row — not only the stale ones — is what makes
 * the display honest rather than merely usually-right.
 */
function withAsOf(view, nowSec) {
  return { ...view, asOfAgeSec: view.asOf == null ? null : Math.max(0, nowSec - view.asOf) };
}

/*
 * ⚠️ TIME: THE VIEW CHOOSES THE BUCKET, AND THE SCREEN SAYS WHICH.
 *
 * Two different correct answers, and picking one globally makes the other subtly wrong:
 *
 *   LIVE VIEWS use the OPERATOR's zone. "Offline since 3pm" must mean 3pm to the person reading it;
 *   they are deciding whether to phone someone now.
 *
 *   REPORTS AND HISTORY use the ORIGIN's zone. A store manager's downtime happened during THEIR
 *   business hours. Bucketing Perth's October by Kenosha days makes every uptime figure quietly
 *   wrong, with nothing on screen to explain the discrepancy — the same call already made correctly
 *   for schedules.
 *
 * Both are labelled, because an unlabelled timestamp in a multi-timezone tool is a guess.
 */
function zoneFor(context, { operatorTz, originTz }) {
  if (context === 'report' || context === 'history') return originTz || operatorTz || 'UTC';
  return operatorTz || originTz || 'UTC';
}

function timeLabel(context, zone) {
  return context === 'report' || context === 'history'
    ? `times shown in the site's local zone (${zone})`
    : `times shown in your local zone (${zone})`;
}

/**
 * Per-node rollup for the Servers list.
 *
 * ⚠️ Reports online/total AND the as-of age. "38 of 40 online" from a node last heard from at
 * breakfast is not the same sentence as the same numbers from thirty seconds ago, and a rollup that
 * omits the age invites the reader to assume the second.
 */
function nodeRollup({ node, edge, devices, openAlerts }, nowSec) {
  const link = freshnessOf(edge, nowSec);
  const total = devices.length;
  const online = devices.filter((d) => d.status === 'online').length;

  return {
    nodeId: node ? node.origin_node_id : (edge ? edge.peer_node_id : null),
    /*
     * ⚠️ MIRROR FIRST, EDGE SECOND. Both carry the name for a DIRECT peer and both are kept fresh,
     * but only the mirror row has one for a node reached through a relay, and only the edge has one
     * for a peer that has enrolled and not yet reported. Neither alone covers the view.
     */
    name: (node && node.node_name) || (edge && edge.peer_name) || null,
    version: node ? node.node_version : null,
    linkFreshness: link,
    devicesTotal: total,
    devicesOnline: link === 'stale' ? null : online,   // ⚠️ null, not 0 — we do not know
    devicesOnlineAsOf: node ? node.received_at : null,
    openAlerts: openAlerts || 0,
    // Surfaced per node so a version spread across a fleet is visible without opening each one.
    stale: link === 'stale',
  };
}

/**
 * ⚠️ SERVER-SIDE PAGINATION AND SEARCH FROM THE START. Fine at 40 devices, fatal at 10,000 — and the
 * hub is the one place where the whole fleet lands in one table. Building the "load everything and
 * filter in the browser" version first means rewriting it under a customer who already has the data.
 *
 * Returns a bounded SQL fragment rather than executing, so the caller controls the connection and the
 * query can be reviewed in one place.
 */
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

function deviceQuery({ search = null, nodeIds = null, status = null,
                       limit = DEFAULT_PAGE, offset = 0 } = {}) {
  const where = [];
  const params = [];

  // Deleted devices are tombstoned, not removed — they must not appear in a live list.
  where.push('d.deleted_at IS NULL');

  if (search) {
    /*
     * ⚠️ Matches name OR id. A health-only grant stores a NULL name, so those devices are findable
     * ONLY by id — which is a documented consequence of the grant and why the empty state has to
     * explain itself rather than just saying "no results".
     */
    where.push('(d.name LIKE ? OR d.device_id LIKE ?)');
    const like = `%${String(search).replace(/[%_]/g, '\\$&')}%`;
    params.push(like, like);
  }
  if (Array.isArray(nodeIds) && nodeIds.length) {
    where.push(`d.origin_node_id IN (${nodeIds.map(() => '?').join(',')})`);
    params.push(...nodeIds);
  }
  if (status) {
    where.push('d.status = ?');
    params.push(status);
  }

  /*
   * ⚠️ Nonsense gets ONE answer: the default. An earlier version clamped 0 to the default and -5 to
   * 1, which is two behaviours for the same class of bad input and means a caller with an off-by-one
   * gets a single row back and concludes the fleet is empty. Anything not a positive number is
   * treated as "unspecified"; only a real number is capped.
   */
  const asked = Number(limit);
  const capped = Number.isFinite(asked) && asked > 0
    ? Math.min(asked, MAX_PAGE)
    : DEFAULT_PAGE;
  return {
    sql: `SELECT d.* FROM mesh_mirror_devices d
           WHERE ${where.join(' AND ')}
           ORDER BY d.name IS NULL, d.name, d.device_id
           LIMIT ? OFFSET ?`,
    countSql: `SELECT COUNT(*) AS c FROM mesh_mirror_devices d WHERE ${where.join(' AND ')}`,
    params: [...params, capped, Math.max(0, Number(offset) || 0)],
    countParams: params,
    limit: capped,
  };
}

/**
 * A deep link back to the object on the node that owns it.
 *
 * ⚠️ THIS IS WHAT LETS THE HUB STAY READ-ONLY AND STILL BE USEFUL. Without it, every remote row is a
 * dead end and the only way to act is to widen the hub's permissions — which is how a read-only
 * observer becomes a control plane by accident.
 *
 * Returns null when the node's address is unknown rather than guessing one (I9: no invented hosts).
 */
function deepLink(edge, kind, id) {
  if (!edge || !edge.peer_url) return null;
  const base = String(edge.peer_url).replace(/\/+$/, '');
  // ⚠️ /app, not /: the dashboard lives at /app and `/` is the marketing page, which ignores the
  // hash. A deep link without it drops the operator on that node's front door.
  const path = kind === 'device' ? `/app#/devices/${encodeURIComponent(id)}`
             : kind === 'alert' ? '/app#/activity'
             : '/';
  return `${base}${path}`;
}

module.exports = {
  STATUS, deviceStatus, withAsOf, zoneFor, timeLabel, nodeRollup,
  deviceQuery, deepLink, MAX_PAGE, DEFAULT_PAGE,
};
