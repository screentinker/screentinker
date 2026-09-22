'use strict';

/*
 * The hub API over mirrored state.
 *
 * ⚠️ THE TWO PROPERTIES THAT MATTER MOST ARE BOTH ABOUT ABSENCE:
 *
 *   1. With the flag off there are NO routes — not routes returning empty, no routes. A 404 from a
 *      route that exists still tells a prober the mesh is compiled in.
 *   2. There is no write route, because 2.0 has no downward channel (I2). That is the absence of a
 *      mechanism rather than restraint being exercised, and it is what makes "the hub cannot change
 *      what plays on your screens" a fact rather than a promise.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Database } = require('../db/sqlite-driver');
const meshRoutes = require('../routes/mesh');

const NOW = Math.floor(Date.now() / 1000);

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubapi-'));
  const db = new Database(path.join(dir, 'h.db'));
  db.exec(`
    CREATE TABLE mesh_clients (id TEXT PRIMARY KEY, name TEXT, notes TEXT,
      parent_client_id TEXT, created_at INTEGER);
    CREATE TABLE mesh_client_access (client_id TEXT, user_id TEXT, role TEXT DEFAULT 'viewer',
      granted_at INTEGER, granted_by TEXT, PRIMARY KEY (client_id, user_id));
    CREATE TABLE mesh_edges (id TEXT PRIMARY KEY, peer_node_id TEXT, direction TEXT,
      role_capabilities TEXT DEFAULT '[]', grant_categories TEXT DEFAULT '[]',
      transport_direction TEXT, retention_days INTEGER, tombstone_purge_days INTEGER,
      tls_verify INTEGER DEFAULT 1, peer_version TEXT, peer_min_version TEXT,
      token_hash TEXT, token_expires_at INTEGER, client_id TEXT,
      created_at INTEGER, last_sync_at INTEGER, revoked_at INTEGER, peer_url TEXT,
      peer_name TEXT);
    CREATE TABLE mesh_mirror_nodes (origin_node_id TEXT PRIMARY KEY, via_edge_id TEXT,
      node_version TEXT, node_name TEXT, device_count INTEGER, devices_online INTEGER,
      origin_ts INTEGER, received_at INTEGER, stale_since INTEGER);
    CREATE TABLE mesh_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      node_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, self_device_id TEXT,
      node_name TEXT, chose_name INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE mesh_mirror_devices (origin_node_id TEXT, device_id TEXT, name TEXT, status TEXT,
      last_heartbeat INTEGER, body TEXT DEFAULT '{}', origin_ts INTEGER, received_at INTEGER,
      deleted_at INTEGER, first_seen_at INTEGER, workspace_id TEXT,
      PRIMARY KEY (origin_node_id, device_id));
    CREATE TABLE mesh_mirror_workspaces (origin_node_id TEXT, workspace_id TEXT, name TEXT,
      organization_name TEXT, device_count INTEGER, origin_ts INTEGER, received_at INTEGER,
      deleted_at INTEGER, PRIMARY KEY (origin_node_id, workspace_id));
    CREATE TABLE mesh_mirror_alerts (id TEXT PRIMARY KEY, origin_node_id TEXT, alert_type TEXT,
      severity TEXT, subject_count INTEGER, subjects TEXT, opened_at INTEGER, closed_at INTEGER,
      origin_ts INTEGER, received_at INTEGER);
    CREATE TABLE alert_events (id TEXT PRIMARY KEY, rule_id TEXT, device_id TEXT, workspace_id TEXT,
      metric TEXT, severity TEXT, opened_at INTEGER, closed_at INTEGER, opened_value REAL,
      peak_value REAL, closed_value REAL, notified_at INTEGER);
  `);
  db._dir = dir;
  return db;
}
const cleanup = (db) => { try { db.close(); } catch {} fs.rmSync(db._dir, { recursive: true, force: true }); };

/** Stand the router up with a fixed user. */
async function serve(db, user) {
  const app = express();
  // The real server parses JSON globally before any router sees a request; without it here a PUT
  // with a body arrives as `undefined` and every write route answers 400 for the wrong reason.
  app.use(express.json());
  app.use('/api/mesh', meshRoutes(db, {
    requireAuth: (req, _res, next) => { req.user = user; next(); },
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const seed = (db) => {
  db.prepare("INSERT INTO mesh_clients VALUES ('acme','Acme',NULL,NULL,?)").run(NOW);
  db.prepare("INSERT INTO mesh_clients VALUES ('contoso','Contoso',NULL,NULL,?)").run(NOW);
  db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,client_id,last_sync_at,grant_categories,peer_url)
              VALUES ('e-a','node-acme','down','acme',?,'["health","identity"]','https://acme.example')`).run(NOW - 20);
  db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,client_id,last_sync_at,grant_categories)
              VALUES ('e-c','node-contoso','down','contoso',?,'["health"]')`).run(NOW - 20);
  db.prepare(`INSERT INTO mesh_mirror_devices
      (origin_node_id,device_id,name,status,last_heartbeat,body,origin_ts,received_at,first_seen_at)
      VALUES ('node-acme','d1','Acme Lobby','online',?,'{}',?,?,?)`)
    .run(NOW - 30, NOW - 30, NOW - 30, NOW - 86400);
  db.prepare(`INSERT INTO mesh_mirror_devices
      (origin_node_id,device_id,name,status,last_heartbeat,body,origin_ts,received_at,first_seen_at)
      VALUES ('node-contoso','d2','Contoso Foyer','online',?,'{}',?,?,?)`)
    .run(NOW - 30, NOW - 30, NOW - 30, NOW - 86400);
};

const tech = { id: 'u-tech', role: 'user' };
const admin = { id: 'u-admin', role: 'platform_admin' };

test('⚠️ SCOPING: a tech named on Acme sees Acme and NOT Contoso', async () => {
  /*
   * The property a client's security review actually asks about. Note this is enforced by never
   * SELECTING the other client's rows — a route that fetched everything and filtered afterwards
   * leaks the moment somebody adds a count or a total to the response, which is the classic shape
   * of this bug.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices`).then((x) => x.json());
      assert.equal(r.total, 1, 'exactly one client\'s screens');
      assert.equal(r.devices[0].originNodeId, 'node-acme');
      assert.ok(!JSON.stringify(r).includes('Contoso'),
        'no trace of the other client anywhere in the response, including counts');
    } finally {
      await close();
    }
  } finally {
    cleanup(db);
  }
});

test('⚠️ an UNFILED edge is visible to platform_admin only', async () => {
  /*
   * A node paired before anybody organised it into clients must not be readable by every technician.
   * "We hadn't got round to filing it yet" is not a defence in a security review, so the default is
   * admin-only rather than everyone.
   */
  const db = freshDb();
  try {
    db.prepare(`INSERT INTO mesh_edges (id,peer_node_id,direction,client_id,last_sync_at)
                VALUES ('e-x','node-orphan','down',NULL,?)`).run(NOW - 10);
    db.prepare(`INSERT INTO mesh_mirror_devices
        (origin_node_id,device_id,name,status,last_heartbeat,body,origin_ts,received_at,first_seen_at)
        VALUES ('node-orphan','d9','Orphan','online',?,'{}',?,?,?)`)
      .run(NOW - 10, NOW - 10, NOW - 10, NOW - 86400);

    let s = await serve(db, tech);
    let r = await fetch(`${s.base}/api/mesh/devices`).then((x) => x.json());
    assert.equal(r.total, 0, 'a tech sees nothing of an unfiled node');
    await s.close();

    s = await serve(db, admin);
    r = await fetch(`${s.base}/api/mesh/devices`).then((x) => x.json());
    assert.equal(r.total, 1, 'the instance owner does');
    await s.close();
  } finally { cleanup(db); }
});

test('⚠️ every device row carries its tri-state status and as-of age', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices`).then((x) => x.json());
      const d = r.devices[0];
      assert.equal(d.status, 'live');
      assert.ok(typeof d.asOfAgeSec === 'number', 'the age is on every row, not only stale ones');
      // ⚠️ The origin node is its OWN field. Folding it into the name ("Lobby (Acme)") breaks sort
      // and search for every row at once, and is very hard to undo once customers read it that way.
      assert.equal(d.originNodeId, 'node-acme');
      assert.equal(d.name, 'Acme Lobby', 'the name is unmodified');
      assert.equal(d.deepLink, 'https://acme.example/app#/devices/d1');  // /app, or it lands on the marketing page
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('a stale link reports the screens as stale, not down', async () => {
  // The whole point of the tri-state, over the wire this time.
  const db = freshDb();
  try {
    seed(db);
    db.prepare("UPDATE mesh_edges SET last_sync_at = ? WHERE id = 'e-a'").run(NOW - 7200);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices`).then((x) => x.json());
      assert.equal(r.devices[0].status, 'stale');
      assert.match(r.devices[0].explain, /check the connection to the site before the screen/i);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('the empty search result explains itself', async () => {
  /*
   * ⚠️ A health-only grant stores no device name, so those screens cannot be found by name. Without
   * saying so the result reads as a broken search, and the "fix" somebody reaches for is widening
   * the grant — the exact outcome the grant vocabulary exists to avoid.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices?search=nothing`).then((x) => x.json());
      assert.equal(r.total, 0);
      assert.match(r.searchNote, /health-only grant/i);
      assert.match(r.searchNote, /found by id/i);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('pagination is bounded no matter what the caller asks for', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/devices?limit=100000`).then((x) => x.json());
      assert.ok(r.limit <= 200, `limit should be capped, got ${r.limit}`);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('the node rollup hides the online count when the link is stale', async () => {
  // Zero is a measurement; "we cannot see" is not, and 0/40 tells an operator the site is dark.
  const db = freshDb();
  try {
    seed(db);
    db.prepare("UPDATE mesh_edges SET last_sync_at = ? WHERE id = 'e-a'").run(NOW - 7200);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/nodes`).then((x) => x.json());
      assert.equal(r.nodes[0].devicesOnline, null);
      assert.equal(r.nodes[0].devicesTotal, 1, 'the last known inventory is still shown');
      assert.equal(r.nodes[0].stale, true);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('⚠️ THE HUB API HAS EXACTLY ONE WRITE ROUTE, AND IT ONLY ASKS (I2)', () => {
  /*
   * ⚠️ REPLACES "there is no write route". That test asserted ABSENCE, which was the right guard
   * while there was no write channel and the wrong one to keep afterwards: deleting it to add the
   * feature would have removed the only thing watching this file. What replaces it is the property
   * that has to survive — the hub may ASK, and every decision is made on the child.
   *
   * Still asserted against the source, because the value is still about what exists rather than
   * what a caller happened to try.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mesh.js'), 'utf8');
  const mutating = [...src.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);

  /*
   * ⚠️ WIDENED ONCE, ON PURPOSE, AND THE PROPERTY IS UNCHANGED.
   *
   * This used to read `deepEqual(mutating, ['POST /write/:nodeId'])`. The property it exists to
   * protect is that the hub may ASK a child to change and never decides for it — not that this
   * file contains exactly one mutating route. Those coincided until client administration landed.
   *
   * The routes below mutate only THIS hub's own bookkeeping: which customers exist, which of this
   * hub's staff may act on them, and which client a linked server belongs to. None of them reach a
   * child, none can change a screen, and every one was needed because canWriteToNode resolves a
   * role through mesh_clients / mesh_client_access and NOTHING in the codebase could create a row
   * in either — the permission model had no way to grant permission, so the write path was
   * unreachable by every user on every install.
   *
   * It stays an explicit list rather than a pattern: a new mutating route here must still be
   * argued for, and the one that proxies to the child is still the only one that leaves this node.
   */
  const HUB_LOCAL_ADMIN = [
    /*
     * ⚠️ THE PARENT ENDING AN EDGE — the mount of lib/mesh/edge-status disenroll(by:'parent') that
     * was missing for three phases. Local: it revokes THIS node's own edge row and drops its own
     * cached media; nothing is sent to the child, which learns at its next connection when the door
     * is shut (the same way a child-side revoke is learned from below). The node holding a copy
     * must be able to stop holding it; a 365-day token expiry is not a control.
     *
     * ⚠️ /links, NOT /nodes — do not "fix" this back. mesh-servers-view's guard forbids writes to
     * /mesh/nodes on purpose: a URL that reads "write to a node" is one somebody later extends
     * into writing to a node. This route modifies this hub's LINK and nothing on the other server.
     */
    'DELETE /links/:nodeId',
    'POST /clients',                  // create a customer record
    'PUT /clients/:id/nodes/:nodeId', // file a linked server under one
    /*
     * ⚠️ Whether content this node RECEIVES is passed on to that client without being asked each
     * time. Local because the decision is this operator's: the servers below granted content-push
     * to THIS node, not to whoever is above it, so a grandparent must not be able to set it. It
     * changes only a column on this hub's own edge — what reaches the client afterwards still goes
     * through the ordinary offer, and the client still applies its own grant on arrival.
     */
    'PUT /clients/:id/nodes/:nodeId/auto-forward',
    'PUT /clients/:id/access',        // name one of THIS hub's staff on it
  ];
  /*
   * ⚠️ TWO ROUTES REACH A CHILD NOW, AND BOTH ONLY ASK.
   *
   * /write proxies one change and the child decides whether to apply it. /content offers a
   * description of some files plus a one-time ticket for each, and the child decides what it needs,
   * whether it may accept it, and whether there is room — the bytes are then PULLED by the child
   * over HTTP, so they never traverse this route at all.
   *
   * The property is unchanged and is what this list defends: a hub may ask; every decision is made
   * on the machine that owns the screens. Adding a third entry here should require the same
   * argument, which is why it stays an explicit list rather than a pattern.
   */
  /*
   * ⚠️ /content (no :nodeId) sends the SAME content to several clients in one action. It is not a
   * new power: the content belongs to this operator, every target has already granted them
   * content-push individually, and the route re-checks visibility and role PER NODE rather than
   * once for the batch — a convenience must never become a way to reach a client you could not
   * reach one at a time. Each child still fetches from this node; nothing is cached in between.
   */
  const ASKS_THE_CHILD = ['POST /write/:nodeId', 'POST /content/:nodeId', 'POST /content', 'POST /content/:nodeId/purge'];
  assert.deepEqual(mutating, [...HUB_LOCAL_ADMIN, ...ASKS_THE_CHILD],
    'the hub API grew a mutating route. Only the ones that ask a child may leave this node, the ' +
    'child decides, and the rest may touch nothing but this hub\'s own records.');

  /*
   * And the local ones must stay local: none may reach the child transport. If one ever needs to,
   * it belongs behind the write route with the child's grant checked, not here.
   */
  for (const route of HUB_LOCAL_ADMIN) {
    const name = route.split(' ')[1];
    const body = src.slice(src.indexOf(`'${name}'`));
    const end = body.indexOf('\n  router.');
    assert.ok(!/__meshWriteTo|__meshReadFrom/.test(end === -1 ? body : body.slice(0, end)),
      `${route} must not touch the mesh transport — it is hub-local bookkeeping`);
  }

  /*
   * ...and it must not do its own allowlisting. A second copy of the child's list would drift, and
   * the copy that matters is the one on the machine that owns the screens.
   *
   * Checked by IMPORT rather than by the word "WRITABLE", which appears in an unrelated comment in
   * this file — a substring match here would fail on prose and teach the next person to weaken it.
   */
  assert.ok(!/require\([^)]*write-proxy[^)]*\)/.test(src),
    'routes/mesh.js must not import the write allowlist — that list lives on the child');
  assert.ok(src.includes('__meshWriteTo'),
    'the write route must go through the socket layer to the child, never act locally');
  assert.ok(src.includes('__meshContentOfferTo'),
    'the content route must do the same — an offer that acted locally would be this hub writing ' +
    'to itself while telling an operator it had sent something to a customer');

  /*
   * ⚠️ And the bytes must not be served by anything that trusts a session. GET /pull/:token is
   * answered to a CHILD SERVER holding a ticket, not to a person holding a cookie — requireAuth on
   * it would break every transfer, and a ticket route that ALSO accepted a session would let any
   * logged-in user of this hub enumerate files by guessing tickets.
   */
  const pull = src.slice(src.indexOf("router.get('/pull/:token'"));
  assert.ok(pull.startsWith("router.get('/pull/:token', (req, res)"),
    'the pull route takes no auth middleware — the ticket IS the credential');
});

test('the uptime report is bucketed in the ORIGIN zone and says so', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(
        `${base}/api/mesh/uptime?clientId=acme&tz=America/Chicago&originTz=Australia/Perth`)
        .then((x) => x.json());
      assert.equal(r.timezone, 'Australia/Perth', 'a report follows the site, not the reader');
      assert.match(r.timezoneLabel, /site's local zone/i);
    } finally { await close(); }
  } finally { cleanup(db); }
});

/* ===================== Phase 3 completion: inbox, topology, per-client report ===================== */

test('⚠️ THE UPTIME REPORT IS SCOPED — it once reported on every client', async () => {
  /*
   * The bug this replaces: /uptime checked that the caller could see at least ONE node and then
   * called uptimeReport() over every alert_events row on the server. A technician named on Acme got
   * Contoso's incident history — the fetch-everything-then-hope shape this file's header warns
   * about, except nothing filtered it at all. Now the client is resolved and authorised first.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const mine = await fetch(`${base}/api/mesh/uptime?clientId=acme`).then((x) => x.json());
      assert.equal(mine.clientId, 'acme');

      const res = await fetch(`${base}/api/mesh/uptime?clientId=contoso`);
      assert.equal(res.status, 404, 'another client\'s report is not reachable');
      const body = await res.json();
      // ⚠️ 404, not 403: "you may not see this" confirms it EXISTS, and client names are
      // commercially sensitive in exactly the multi-tenant deployments this feature is for.
      assert.ok(!JSON.stringify(body).includes('Contoso'), 'and does not name it in the refusal');
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('⚠️ there is no implicit ALL-CLIENTS report', async () => {
  /*
   * A report headed with no client name, mixing several customers' screens into one percentage, is
   * the document somebody forwards to one of those customers. Asking which client is one parameter.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/uptime`).then((x) => x.json());
      assert.equal(r.report, null, 'no numbers without a named client');
      assert.deepEqual(r.clients.map((c) => c.id), ['acme'], 'only the clients this user may see');
      assert.match(r.reason, /Choose a client/);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('the CSV export is attachment-dispositioned with a sanitised filename', async () => {
  const db = freshDb();
  try {
    seed(db);
    // ⚠️ A client NAME is attacker-influenced text arriving from another server. Dropping it into
    // Content-Disposition unescaped is a header-injection primitive.
    db.prepare("UPDATE mesh_clients SET name = ? WHERE id = 'acme'")
      .run('Acme"; drop\r\nX-Evil: 1');
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const res = await fetch(`${base}/api/mesh/uptime.csv?clientId=acme`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      const cd = res.headers.get('content-disposition');
      assert.match(cd, /^attachment; filename="uptime-[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.csv"$/,
        `filename must be whitelist-built, got ${cd}`);
      assert.ok(!/[\r\n]/.test(cd), 'and can carry no header injection');
      const text = await res.text();
      assert.match(text, /Uptime %/);
      assert.match(text, /Coverage %/);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('a CSV export for an invisible client is refused, not empty', async () => {
  // An empty CSV reads as "that client has no screens", which is a leak of a different kind.
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const res = await fetch(`${base}/api/mesh/uptime.csv?clientId=contoso`);
      assert.equal(res.status, 404);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('⚠️ the node rollup COUNTS open alerts — it used to hardcode zero', async () => {
  /*
   * `openAlerts: 0` shipped from Phase 3: the field existed, the card rendered, and a site with nine
   * open alerts looked clean. A placeholder that renders as a REASSURING value is worse than a
   * missing one, because nothing on screen invites anybody to check it.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    for (const id of ['a1', 'a2']) {
      db.prepare(`INSERT INTO mesh_mirror_alerts
        (id,origin_node_id,alert_type,severity,subject_count,subjects,opened_at,closed_at,received_at)
        VALUES (?,'node-acme','device_offline','warn',1,'["d1"]',?,NULL,?)`).run(id, NOW - 60, NOW);
    }
    db.prepare(`INSERT INTO mesh_mirror_alerts
      (id,origin_node_id,alert_type,severity,subject_count,subjects,opened_at,closed_at,received_at)
      VALUES ('closed','node-acme','device_offline','warn',1,'["d1"]',?,?,?)`)
      .run(NOW - 600, NOW - 300, NOW);

    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/nodes`).then((x) => x.json());
      assert.equal(r.nodes[0].openAlerts, 2, 'open only, and actually counted');
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('⚠️ the inbox rolls up, and correlation is not silently defeated by unit mismatch', async () => {
  /*
   * alert-rollup's correlation window is a MILLISECOND constant while every timestamp on this hub is
   * unix SECONDS. Passing seconds against a ms `now` makes every alert look ancient, nothing ever
   * correlates, and the rollup degrades to no rollup at all — working code, no error, and the
   * self-suspicion case silently never fires.
   */
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    db.prepare("INSERT INTO mesh_client_access VALUES ('contoso','u-tech','viewer',?,NULL)").run(NOW);
    for (const [id, node] of [['a1', 'node-acme'], ['a2', 'node-contoso']]) {
      db.prepare(`INSERT INTO mesh_mirror_alerts
        (id,origin_node_id,alert_type,severity,subject_count,subjects,opened_at,closed_at,received_at)
        VALUES (?,?,'device_offline','warn',4,'["d1"]',?,NULL,?)`).run(id, node, NOW - 30, NOW);
    }
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/alerts`).then((x) => x.json());
      assert.equal(r.alerts.length, 2, 'the individual alerts are still there');
      assert.equal(r.rollups.length, 1, 'and they correlate into one condition');
      assert.equal(r.rollups[0].nodeCount, 2);
      // Both of two children affected is over the 0.66 ratio: suspect the observer, not the sites.
      assert.equal(r.rollups[0].suspectSelf, true,
        'everything going quiet at once should blame this hub, not dispatch two engineers');
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('an alert from an unreachable node is marked last-known', async () => {
  // The inbox is the screen people act on fastest; it must not be the one place implying live truth.
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    db.prepare("UPDATE mesh_edges SET last_sync_at = ? WHERE id = 'e-a'").run(NOW - 7200);
    db.prepare(`INSERT INTO mesh_mirror_alerts
      (id,origin_node_id,alert_type,severity,subject_count,subjects,opened_at,closed_at,received_at)
      VALUES ('a1','node-acme','device_offline','warn',1,'["d1"]',?,NULL,?)`).run(NOW - 7300, NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/alerts`).then((x) => x.json());
      assert.equal(r.alerts[0].stale, true);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('topology reports per-edge health and the depth cap', async () => {
  const db = freshDb();
  try {
    seed(db);
    db.prepare("INSERT INTO mesh_client_access VALUES ('acme','u-tech','viewer',?,NULL)").run(NOW);
    const { base, close } = await serve(db, tech);
    try {
      const r = await fetch(`${base}/api/mesh/topology`).then((x) => x.json());
      assert.equal(r.edges.length, 1, 'and only the caller\'s edges');
      assert.equal(r.edges[0].freshness, 'live');
      assert.deepEqual(r.edges[0].grant, ['health', 'identity']);
      // Stated, because "why can't I add a server under that one" is otherwise unanswerable from
      // the UI — and it is still 2 until real hardware says otherwise.
      assert.equal(r.depthCap, 2);
    } finally { await close(); }
  } finally { cleanup(db); }
});

test('⚠️ the screenshot proxy accepts a QUERY token, because an <img> cannot send a header', async () => {
  /*
   * The proxy worked and the page still showed a broken image: requireAuth reads the Authorization
   * header, and a browser loading an image cannot send one — so the route answered 401 to the only
   * client that will ever call it. Every test passed because every test used a header.
   *
   * The local screenshot route solved this the same way with the same resolver; matching it keeps
   * ONE definition of "this token is a usable session" rather than a second, subtly different one.
   */
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../routes/mesh.js'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/screenshot/"));
  const body = route.slice(0, 1400);
  assert.match(body, /req\.headers\.authorization/, 'a header still works');
  assert.match(body, /req\.query\.token/, 'and a query token, for the <img> case');
  assert.match(body, /resolveSessionUser/, 'resolved by the shared resolver, not a local copy');
  assert.doesNotMatch(body, /jwt\.verify/, 'never a second, hand-rolled verification');
});
