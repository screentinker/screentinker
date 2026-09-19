'use strict';

/*
 * What this node knows about itself, projected for one edge.
 *
 * ⚠️ EXTRACTED SO A WORKER THREAD CAN LOAD IT WITHOUT LOADING THE UPLINK SERVICE. The reporting
 * loop and the read path shared these functions, and requiring the service from a worker would drag
 * in the socket client and the timers with it — a thread whose whole job is a SQLite query would
 * have started a second reporter. Keeping the data functions in their own module makes the worker's
 * dependency list exactly what it needs, and removes the circular require the alternative created.
 *
 * ⚠️ EVERY PROJECTION IS BUILT BY ADDING WHAT THE GRANT ALLOWS, never by removing what it does not.
 * A delete-based filter silently starts shipping each column added afterwards, and nobody finds out
 * until a client asks why their hub knows something they never shared.
 */

const readProxy = require('./read-proxy');
const mirror = require('./mirror');
const store = require('./store');

const nowSec = () => Math.floor(Date.now() / 1000);

function scopeClause(edge, alias) {
  const ids = edge.shared_workspaces ? store.safeParseArray(edge.shared_workspaces) : null;
  if (!ids || !ids.length) return { sql: '', params: [] };
  return {
    sql: ` WHERE ${alias} IN (${ids.map(() => '?').join(',')})`,
    params: ids,
  };
}

/** Devices as this node knows them, already narrowed to the grant AND to the shared workspaces. */
function deviceProjections(db, grantCategories, edge) {
  /*
   * ⚠️ Only columns that exist. The first version of this query named `hardware_model` and joined
   * device_telemetry on `created_at`; neither exists — telemetry is timestamped `reported_at`, and
   * the hardware fields in mirror.js's category map come from families that report them, not from a
   * `devices` column. SQLite errors on an unknown column, so the whole report failed and the hub
   * showed a connected node with zero screens — which looks exactly like a working link with an
   * empty fleet.
   *
   * projectDevice() skips anything undefined, so a field this node cannot answer is simply absent
   * rather than sent as null — the grant decides what MAY travel, the row decides what exists.
   */
  const scope = edge ? scopeClause(edge, 'd.workspace_id') : { sql: '', params: [] };
  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, d.last_heartbeat, d.app_version, d.platform, d.client_type,
           d.workspace_id, d.playlist_id, d.layout_id,
           t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
           t.ram_free_mb, t.ram_total_mb, t.cpu_usage, t.wifi_rssi, t.uptime_seconds
      FROM devices d
      LEFT JOIN (
        SELECT device_id, MAX(reported_at) AS reported_at FROM device_telemetry GROUP BY device_id
      ) latest ON latest.device_id = d.id
      LEFT JOIN device_telemetry t
             ON t.device_id = latest.device_id AND t.reported_at = latest.reported_at
    ${scope.sql}
  `).all(...scope.params);
  /*
   * ⚠️ COMPUTED, not selected — `capabilities` is not a column. It is derived from the platform and
   * what the panel declared, by the same function the local API uses, so a hub sees exactly the
   * list the child would show its own operator rather than a second opinion.
   */
  const playerCapabilities = require('../player-capabilities');
  const own = rows.map((r) => mirror.projectDevice(
    { ...r, capabilities: playerCapabilities.capabilitiesFor(r) }, grantCategories));

  return own.concat(relayedDeviceProjections(db, grantCategories));
}

/*
 * ⚠️ SCREENS BELONGING TO NODES BELOW THIS ONE — the upward half of relaying.
 *
 * (Worded to avoid the literal token a relay ADDRESS would use: the I9 guard greps lib/mesh for
 * hostname shapes, and a sentence ending in that word reads the same to a regex as a compiled-in
 * relay host. The guard is right to be blunt — this is prose bending around it, not the reverse.)
 *
 * Everything else about the mesh moved one hop. A node reported its OWN devices, and anything it
 * mirrored from below stopped there — so in a three-tier estate the top hub saw the middle node's
 * workspaces and not a single screen, and the middle node was a wall rather than a relaying tier. Content
 * learned to travel two hops before telemetry did, which is the wrong way round: the whole reason
 * an MSP wants a middle tier is to see everything beneath it.
 *
 * ⚠️ ONLY FOR CHILDREN THAT AGREED, and that agreement is the child's alone. A node two hops up has
 * no relationship with the site at the bottom: "my MSP may see my screens" is not the same
 * agreement as "and so may whoever my MSP reports to". The child sets share_upward on its own
 * uplink, announces it, and this reads what was announced (peer_shares_upward) rather than
 * assuming. Absent means no, so every relationship formed before relaying existed stays one hop.
 *
 * ⚠️ THE ORIGIN IS PRESERVED. A relayed screen is reported with the node it actually belongs to,
 * never as this node's own — a hub that could not tell whose screen it was looking at would file a
 * customer's estate under the wrong company, which is the worst available bug here.
 */
/*
 * ⚠️ THE NODES THEMSELVES, not only their screens — otherwise a site with nothing plugged in yet is
 * invisible however clearly it consented.
 *
 * The shape was learned only from relayed payloads, so a customer's brand-new server appeared
 * nowhere upstream until somebody hung a screen on it. That is the wrong dependency: whether a
 * relationship exists and whether it currently has hardware are different questions, and an
 * operator setting up a site wants to see the site appear before the screens do.
 *
 * Node health is the payload the child already sends about ITSELF every cycle, so relaying it
 * carries both the node's existence and the ancestry that proves the route.
 */
function relayedNodeProjections(db) {
  try {
    return db.prepare(`
      SELECT m.origin_node_id, m.node_name, m.node_version, m.device_count, m.devices_online, m.origin_ts
        FROM mesh_mirror_nodes m
        JOIN mesh_edges e ON e.peer_node_id = m.origin_node_id
                         AND e.direction = 'down' AND e.revoked_at IS NULL
       WHERE e.peer_shares_upward = 1`).all().map((r) => ({
      node_id: r.origin_node_id,
      // Carried onward so a grandparent sees "Kenosha North", not eight hex characters. A relay
      // repeats the child's own word for itself; it does not get to substitute its own.
      name: r.node_name || null,
      version: r.node_version || null,
      device_count: r.device_count ?? null,
      devices_online: r.devices_online ?? null,
      origin_node_id: r.origin_node_id,
    }));
  } catch (e) {
    return [];
  }
}

/*
 * ⚠️ AND THE WORKSPACES THOSE SCREENS BELONG TO. Relaying devices without them left a screen
 * arriving upstream carrying a workspace_id the receiving node had never heard of — so it could not
 * be filed under a customer, did not appear in the switcher, and showed as belonging to nothing.
 * A screen is only meaningful as somebody's screen.
 */
function relayedWorkspaceProjections(db) {
  try {
    return db.prepare(`
      SELECT w.origin_node_id, w.workspace_id, w.name, w.organization_name, w.device_count
        FROM mesh_mirror_workspaces w
        JOIN mesh_edges e ON e.peer_node_id = w.origin_node_id
                         AND e.direction = 'down' AND e.revoked_at IS NULL
       WHERE e.peer_shares_upward = 1
         AND w.deleted_at IS NULL`).all().map((r) => ({
      id: r.workspace_id,
      name: r.name || null,
      organization_name: r.organization_name || null,
      device_count: r.device_count ?? null,
      origin_node_id: r.origin_node_id,
    }));
  } catch (e) {
    return [];
  }
}

function relayedDeviceProjections(db, grantCategories) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT m.*, e.peer_node_id AS via_node_id
        FROM mesh_mirror_devices m
        JOIN mesh_edges e ON e.peer_node_id = m.origin_node_id
                         AND e.direction = 'down' AND e.revoked_at IS NULL
       WHERE e.peer_shares_upward = 1
         AND m.deleted_at IS NULL`).all();
  } catch (e) {
    // A node with no mirror tables relays nothing; that is not an error worth failing a report over.
    return [];
  }

  return rows.map((r) => {
    /*
     * ⚠️ THE FIELDS LIVE IN `body`, not in columns. A mirror row promotes only what the hub queries
     * on — name, status, heartbeat, workspace — and keeps the rest as the JSON the child sent.
     * Projecting the ROW would have relayed four fields and dropped everything else, which reads as
     * a screen that reports almost nothing rather than as a bug.
     *
     * Re-projected against THIS edge's grant rather than passed through: the child below may have
     * shared more with us than we are permitted to share upward, and the narrower of the two must
     * win. A relay is not a hole in whatever grant sits above it.
     */
    let body = {};
    try { body = r.body ? JSON.parse(r.body) : {}; } catch (e) { body = {}; }
    const projected = mirror.projectDevice(
      { ...body, name: r.name, status: r.status, last_heartbeat: r.last_heartbeat,
        workspace_id: r.workspace_id }, grantCategories);
    return {
      ...projected,
      id: r.device_id,
      /*
       * Carried explicitly so the node above can attribute it. Without these two fields a relayed
       * screen is indistinguishable from one of this node's own, which is precisely the confusion
       * that makes a multi-tier view worse than no view.
       */
      origin_node_id: r.origin_node_id,
      relayed_via: r.via_node_id,
    };
  });
}

/**
 * This server's workspaces, so a parent can present them as separate orgs.
 *
 * ⚠️ WITHOUT THIS, A SECOND WORKSPACE IS INVISIBLE UPSTREAM. One connected server would read as one
 * org however many customers it actually holds, and every screen would land in the same
 * undifferentiated list — which is wrong in the specific way that matters to an MSP, because the
 * whole point of the hub is telling one client's estate from another's.
 *
 * Grant-gated on `identity` like every other name: a health-only edge learns that screens exist and
 * how they are coping, and learns nothing about how the client organises them.
 */
function workspaceProjections(db, grantCategories, edge) {
  if (!mirror.fieldsAllowedFor(grantCategories).includes('name')) return [];
  try {
    const scope = edge ? scopeClause(edge, 'w.id') : { sql: '', params: [] };
    return db.prepare(`
      SELECT w.id, w.name, o.name AS organization_name,
             (SELECT COUNT(*) FROM devices d WHERE d.workspace_id = w.id) AS device_count
        FROM workspaces w
        LEFT JOIN organizations o ON o.id = w.organization_id
      ${scope.sql}
    `).all(...scope.params);
  } catch (e) {
    // An older schema, or a build without workspaces: the parent simply groups by server instead.
    return [];
  }
}

/**
 * One screen, in the shape the device page actually expects.
 *
 * ⚠️ THE SUMMARY SHAPE WAS NOT ENOUGH, and the symptom was silent. The local /api/devices/:id
 * returns a composite — telemetry[], assignments[], playlist_status, statusLog, screenshot — and
 * returning only the flat summary made the Playlist tab read "No content assigned" and Device Info
 * render blank. Both are legitimate states for a real screen, so nothing looked broken; the page
 * simply lied quietly. A proxy that returns a DIFFERENT shape from the endpoint it stands in for is
 * not a proxy.
 *
 * ⚠️ EACH PIECE IS GATED ON THE GRANT THAT COVERS IT, so the composite cannot become the way around
 * the grant that the individual fields respect. And the local response's `owner_email`,
 * `owner_name` and `_workspaceRole` are deliberately NOT carried: those name the client's own
 * staff, which is nobody else's business and is not something any grant here asks for.
 */
function deviceDetail(db, grants, deviceId, summary) {
  const has = (g) => grants.includes(g);
  const out = { ...summary };
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  out.telemetry = has('health') ? safe(() => db.prepare(
    `SELECT battery_level, battery_charging, storage_free_mb, storage_total_mb, ram_free_mb,
            ram_total_mb, cpu_usage, wifi_rssi, uptime_seconds, local_ip, local_ip6,
            attached_display, video_mode, temperature_c, reported_at
       FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 20`)
    .all(deviceId), []) : [];

  /*
   * ⚠️ The screenshot needs `display-capture`, which is its own grant for a reason: an image of a
   * screen may contain whatever was behind it. Without the grant there is no path, not an empty
   * one — the page then renders its ordinary "no screenshot" state rather than a broken image.
   */
  out.screenshot = has('display-capture') ? safe(() => db.prepare(
    'SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1')
    .get(deviceId) || null, null) : null;

  const row = safe(() => db.prepare('SELECT playlist_id, layout_id FROM devices WHERE id = ?')
    .get(deviceId), null);

  out.assignments = [];
  out.playlist_status = null;
  out.playlist_has_published = false;
  out.active_layout_zones = [];
  if (has('content-metadata') && row && row.playlist_id) {
    out.assignments = safe(() => db.prepare(`
      SELECT pi.id, pi.content_id, pi.widget_id, pi.child_playlist_id, pi.zone_id, pi.sort_order,
             pi.duration_sec, pi.muted, pi.created_at, pi.updated_at,
             COALESCE(c.filename, w.name, cp.name) AS filename, c.mime_type,
             c.duration_sec AS content_duration,
             w.name AS widget_name, w.widget_type, cp.name AS child_playlist_name
        FROM playlist_items pi
        LEFT JOIN content c ON pi.content_id = c.id
        LEFT JOIN widgets w ON pi.widget_id = w.id
        LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
       WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`).all(row.playlist_id), []);
    const pl = safe(() => db.prepare(
      'SELECT status, published_snapshot FROM playlists WHERE id = ?').get(row.playlist_id), null);
    if (pl) {
      out.playlist_status = pl.status;
      out.playlist_has_published = pl.published_snapshot !== null;
    }
    /*
     * ⚠️ `filepath` and `thumbnail_path` are omitted on purpose. They are paths on the CHILD's
     * disk; a parent can neither fetch them nor do anything useful with them, and shipping them
     * would leak the client's storage layout for no benefit at all.
     */
  }

  // Diagnostics: why something went wrong is its own grant, separate from whether it is alive.
  out.statusLog = has('diagnostics') ? safe(() => db.prepare(
    `SELECT status, reason, detail, timestamp FROM device_status_log
      WHERE device_id = ? AND timestamp > ? ORDER BY timestamp ASC`)
    .all(deviceId, Math.floor(Date.now() / 1000) - 86400), []) : [];
  out.deviceEvents = has('diagnostics') ? safe(() => db.prepare(
    `SELECT * FROM device_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(deviceId), []) : [];

  return out;
}

function nodeHealth(db, nodeId) {
  const counts = db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online FROM devices")
    .get();
  return mirror.projectNodeHealth({
    node_id: nodeId,
    // What this box calls itself. Sent on EVERY report, not just at enrollment, so a rename
    // reaches everyone who is listening instead of only everyone who pairs after it.
    name: store.nodeName(db),
    /*
     * ⚠️ '../../' — this file moved from services/ to lib/mesh/ and the relative path did not move
     * with it. The throw was caught by the reporting loop's own try/catch and logged as "could not
     * build a report", so the child would have gone silent while looking healthy: connected, no
     * error surfaced to the operator, and no data arriving. A measurement script found it, not a
     * test, because every test injects its own version rather than reading package.json.
     */
    version: require('../../package.json').version,
    device_count: counts.total || 0,
    devices_online: counts.online || 0,
    reported_at: nowSec(),
  });
}

function openAlerts(db, grantCategories, edge) {
  try {
    /*
     * ⚠️ Alerts are scoped too. An incident names a device, so an unscoped alert feed would tell a
     * parent about screens in a workspace that was deliberately withheld — leaking by description
     * what the workspace scope refused by row.
     */
    const ids = edge && edge.shared_workspaces ? store.safeParseArray(edge.shared_workspaces) : null;
    const scoped = ids && ids.length;
    const rows = db.prepare(
      'SELECT a.id, a.metric, a.severity, a.device_id, a.opened_at, a.closed_at FROM alert_events a ' +
      (scoped ? `LEFT JOIN devices d ON d.id = a.device_id
                  WHERE a.closed_at IS NULL AND d.workspace_id IN (${ids.map(() => '?').join(',')}) `
              : 'WHERE a.closed_at IS NULL ') +
      'ORDER BY a.opened_at DESC LIMIT 200').all(...(scoped ? ids : []));
    return rows
      .map((a) => mirror.projectAlert({
        id: a.id, type: a.metric, severity: a.severity,
        opened_at: a.opened_at, closed_at: a.closed_at,
        subject_count: 1, subjects: a.device_id ? [a.device_id] : [],
      }, grantCategories))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Answer a parent's read.
 *
 * ⚠️ THE ALLOWLIST, THE GRANT AND THE WORKSPACE SCOPE ARE ALL APPLIED HERE, on the child, in that
 * order — because this is the side that owns the rows. A parent asking for something it may not have
 * is refused by the party with the standing to refuse, which is the difference between a permission
 * and a request for good manners.
 *
 * It returns the SAME shape the child's own API returns, so the parent can render its ordinary
 * screens rather than a reduced summary of them. That is the whole point: an operator looking at a
 * customer's estate should see what the customer sees, minus the ability to change it.
 */

/*
 * ⚠️ A MESSAGE, NOT A PAYLOAD. error_data is whatever the player serialised — it can contain a
 * widget's response body, a signed URL, or text an operator typed into a slide. Sending it upward
 * because it is "diagnostics" would hand a third party the contents of a customer's screen under a
 * grant that says "why something went wrong".
 */
function summariseError(raw) {
  if (!raw) return null;
  let msg = null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    msg = parsed && (parsed.message || parsed.error || parsed.name);
  } catch (e) {
    msg = typeof raw === 'string' ? raw : null;
  }
  if (typeof msg !== 'string') return null;
  return msg.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || null;
}

/*
 * Origin and path, never the query. "Which widget is failing" is the useful half; the query string
 * is where tokens and identifiers live, and it is not needed to answer that question.
 */
/** The query string of a proxied read, as URLSearchParams (empty when there is none). */
function queryOf(url) {
  try { return new URL(String(url || ''), 'http://127.0.0.1').searchParams; } catch (e) { return new URLSearchParams(); }
}

function stripQuery(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url, 'http://127.0.0.1');
    return `${u.origin === 'http://127.0.0.1' ? '' : u.origin}${u.pathname}`.slice(0, 200) || null;
  } catch (e) {
    return url.split('?')[0].slice(0, 200);
  }
}

function answerRead(db, edge, req) {
  const grants = store.safeParseArray(edge.grant_categories);
  const check = readProxy.authorize(edge, req && req.path, req && req.method, grants);
  if (!check.ok) return { ok: false, reason: check.reason };

  const shared = edge.shared_workspaces ? store.safeParseArray(edge.shared_workspaces) : null;

  const path = String(req.path || '').split('?')[0];
  const seg = path.split('/');
  const inScope = (wsId) => !shared || !shared.length || wsId == null || shared.includes(wsId);

  /*
   * ⚠️ COMPUTED ONCE PER REQUEST. Every branch below needs the visible device set — the collection
   * to return it, the single-object reads to check the id is one this edge may see at all — and
   * each call was re-running a devices×telemetry join over the whole fleet. Three passes to answer
   * one question about one screen.
   *
   * ⚠️ AND THIS RUNS ON THE MAIN THREAD. better-sqlite3 is synchronous by design, and there is no
   * worker behind the mesh: a read from a parent is served on the same event loop that answers
   * every player's heartbeat. On a 400-screen node that is the difference between a proxy that is
   * free and one an operator feels on their own screens — which is exactly the harm I1 exists to
   * prevent, arriving from the opposite direction to the one it was written for.
   */
  const visible = deviceProjections(db, grants, edge);

  if (path === '/api/devices') {
    /*
     * ⚠️ Built from the same projection the mirror uses, so a field cannot travel over the proxy
     * that would not travel over the mirror. Two paths to the same data with two different filters
     * is how one of them ends up more generous than anybody intended.
     */
    return { ok: true, rows: readProxy.scopeRows(visible, shared), asOf: nowSec() };
  }

  if (seg.length === 4 && seg[2] === 'devices') {
    /*
     * ⚠️ THE SCOPE IS CHECKED ON THE ROW, NOT ON THE REQUEST. A single-object read cannot be
     * filtered by the list comprehension that protects the collection, so it needs its own check —
     * and a parent guessing device ids from another workspace is exactly the shape of attack a
     * per-collection filter misses.
     */
    const one = visible.find((d) => d.id === seg[3]);
    if (!one) return { ok: false, reason: 'No such screen on this server.' };
    return { ok: true, row: deviceDetail(db, grants, seg[3], one), asOf: nowSec() };
  }

  if (seg.length === 5 && seg[2] === 'devices' && seg[4] === 'screenshot') {
    /*
     * ⚠️ THE BYTES, NOT THE ROW. The composite device read already returns a `screenshot` record
     * when the grant allows — but that record names a file on THIS machine's disk, which a parent
     * can neither open nor do anything with. Returning it and calling the job done is how a remote
     * device page ends up with an empty picture frame and no error: the field was present, the
     * image was not.
     */
    const owns = visible.some((d) => d.id === seg[3]);
    if (!owns) return { ok: false, reason: 'No such screen on this server.' };
    try {
      const fs = require('fs');
      const path = require('path');
      const cfg = require('../../config');
      const row = db.prepare(
        'SELECT filepath, captured_at FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1')
        .get(seg[3]);
      if (!row) return { ok: false, reason: 'No screenshot has been captured for that screen.' };

      /*
       * ⚠️ Resolved through basename against the configured directory, exactly as the local route
       * does. The stored path is data this process wrote, but a proxy is a new way to reach it, and
       * a path-traversal that was unreachable locally must not become reachable remotely.
       */
      const safe = path.resolve(cfg.screenshotsDir, path.basename(row.filepath));
      if (!safe.startsWith(path.resolve(cfg.screenshotsDir))) {
        return { ok: false, reason: 'Invalid screenshot path.' };
      }
      if (!fs.existsSync(safe)) return { ok: false, reason: 'That screenshot is no longer on disk.' };

      const stat = fs.statSync(safe);
      // Bounded: a screen capture is a few hundred KB, and anything far larger is not one.
      if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: 'That screenshot is too large to send.' };

      return {
        ok: true,
        image: fs.readFileSync(safe),        // socket.io carries binary natively — no base64 tax
        mime: 'image/jpeg',
        capturedAt: row.captured_at,
        asOf: nowSec(),
      };
    } catch (e) {
      return { ok: false, reason: 'Could not read that screenshot.' };
    }
  }

  if (seg.length === 5 && seg[2] === 'devices' && seg[4] === 'telemetry') {
    const owns = visible.some((d) => d.id === seg[3]);
    if (!owns) return { ok: false, reason: 'No such screen on this server.' };
    try {
      const rows = db.prepare(
        `SELECT battery_level, battery_charging, storage_free_mb, storage_total_mb, ram_free_mb,
                ram_total_mb, cpu_usage, wifi_rssi, uptime_seconds, local_ip, local_ip6,
                attached_display, video_mode, temperature_c, reported_at
           FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 50`).all(seg[3]);
      return { ok: true, rows, asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  /*
   * ⚠️ WHY A SCREEN IS MISBEHAVING — the question support actually needs answered, and the one an
   * MSP could not ask about a customer's site. They could see a screen was unhealthy and had no way
   * to find out why, which is the difference between fixing it from a desk and driving to it.
   *
   * ⚠️ THE ERROR PAYLOAD IS NOT SENT WHOLESALE. `error_data` and `context` are captured by the
   * player and can carry anything the page had — a URL with a token in it, a widget's fetched
   * content, an operator's own text. What travels is the fingerprint (which groups repeats), the
   * message, the URL's ORIGIN AND PATH without its query, and the timestamp. That is enough to say
   * "this screen is failing to load that widget, forty times an hour" and not enough to hand over
   * whatever happened to be in a query string.
   */
  if (seg.length === 5 && seg[2] === 'devices' && seg[4] === 'debug') {
    const owns = visible.some((d) => d.id === seg[3]);
    if (!owns) return { ok: false, reason: 'No such screen on this server.' };
    try {
      const rows = db.prepare(
        `SELECT error_fingerprint, error_data, url, created_at
           FROM player_debug_logs WHERE device_id = ? ORDER BY created_at DESC LIMIT 50`).all(seg[3]);
      return {
        ok: true,
        rows: rows.map((r) => ({
          fingerprint: r.error_fingerprint || null,
          message: summariseError(r.error_data),
          where: stripQuery(r.url),
          at: r.created_at,
        })),
        asOf: nowSec(),
      };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (seg.length === 5 && seg[2] === 'assignments' && seg[3] === 'device') {
    const owns = visible.some((d) => d.id === seg[4]);
    if (!owns) return { ok: false, reason: 'No such screen on this server.' };
    try {
      const rows = db.prepare(
        `SELECT a.*, p.name AS playlist_name
           FROM assignments a LEFT JOIN playlists p ON p.id = a.playlist_id
          WHERE a.device_id = ?`).all(seg[4]);
      return { ok: true, rows, asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (path === '/api/groups') {
    try {
      const rows = db.prepare('SELECT id, name, workspace_id FROM device_groups').all();
      return { ok: true, rows: readProxy.scopeRows(rows, shared), asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  /*
   * Scale-out (docs/scale-out-design.md §4): the two reads a replica's copy is built from. The
   * workspace set is THIS edge's shared list, decided here — a replica names no workspace and is
   * answered for exactly what was granted. "Share all" (an empty list, owner-only) means every
   * workspace this node owns; a workspace that is itself a copy (origin_node_id set) is never
   * re-shared, so a replica of a replica cannot be assembled by accident.
   */
  if (path === '/api/mesh/snapshot' || path === '/api/mesh/changes') {
    const replication = require('./replication');
    const q = queryOf(req.path);
    const wsIds = shared && shared.length
      ? shared
      : db.prepare('SELECT id FROM workspaces WHERE origin_node_id IS NULL').all().map((w) => w.id);
    if (path === '/api/mesh/changes') {
      const r = replication.changesSince(db, wsIds, Number(q.get('since')) || 0, Number(q.get('limit')) || 500);
      return { ok: true, ...r, workspaces: wsIds, asOf: nowSec() };
    }
    const r = replication.snapshotPage(db, String(q.get('table') || ''), wsIds, q.get('after'), Number(q.get('limit')) || 500);
    return r.ok ? { ...r, asOf: nowSec() } : r;
  }

  if (path === '/api/playlists') {
    try {
      const rows = db.prepare(
        'SELECT id, name, workspace_id, created_at, updated_at FROM playlists').all();
      return { ok: true, rows: readProxy.scopeRows(rows, shared), asOf: nowSec() };
    } catch (e) { return { ok: true, rows: [], asOf: nowSec() }; }
  }

  if (seg.length === 4 && seg[2] === 'playlists') {
    try {
      const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(seg[3]);
      if (!row || !inScope(row.workspace_id)) {
        return { ok: false, reason: 'No such playlist on this server.' };
      }
      /*
       * ⚠️ Three column names here were wrong and none of them existed: `i.position` (it is
       * `sort_order`), `c.name` and `c.type` (they are `filename` and `mime_type`). SQLite reports
       * `c.name` first, so fixing only the one we knew about changed nothing — every playlist
       * detail read on every node failed, and the catch below rendered it as HTTP 403, whose own
       * comment says it means "this will never work until somebody changes a grant". No grant
       * would ever have helped.
       *
       * Also enumerated rather than `i.*`: a SELECT * here means any column later added to
       * playlist_items crosses the wire with no review, which is the opposite of the
       * add-what-the-grant-allows discipline every other projection in this file follows.
       */
      const items = db.prepare(
        `SELECT i.id, i.content_id, i.widget_id, i.child_playlist_id, i.zone_id, i.sort_order,
                i.duration_sec, i.muted,
                COALESCE(c.filename, w.name, cp.name) AS content_name, c.mime_type AS content_type,
                w.widget_type, cp.name AS child_playlist_name
           FROM playlist_items i
           LEFT JOIN content c ON c.id = i.content_id
           LEFT JOIN widgets w ON w.id = i.widget_id
           LEFT JOIN playlists cp ON cp.id = i.child_playlist_id
          WHERE i.playlist_id = ? ORDER BY i.sort_order ASC`).all(seg[3]);
      return { ok: true, row: { ...row, items }, asOf: nowSec() };
    } catch (e) { return { ok: false, reason: 'Could not read that playlist.' }; }
  }

  return { ok: false, reason: 'That is not something this connection may read.' };
}

module.exports = {
  scopeClause, deviceProjections, relayedDeviceProjections, relayedNodeProjections,
  relayedWorkspaceProjections,
  workspaceProjections, deviceDetail,
  nodeHealth, openAlerts, answerRead,
};
