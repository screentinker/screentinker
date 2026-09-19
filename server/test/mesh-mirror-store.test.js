'use strict';

/*
 * What a parent keeps about the nodes below it, and how it gets rid of it.
 *
 * ⚠️ THE PROPERTIES THAT ARE EASY TO GET WRONG AND HARD TO NOTICE:
 *
 *   - a reconnecting child re-sends state; if that duplicates rows, every count on the hub silently
 *     doubles and nobody suspects the storage layer
 *   - pruning by age is right for history and catastrophic for current state — a screen that has not
 *     changed in six months would vanish from the hub while still hanging on a wall
 *   - deleting on disenrollment rewrites last month's report, so the report cannot be cited
 *   - freshness read from the ROW rather than the EDGE is wrong in both directions
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const ms = require('../lib/mesh/mirror-store');

const NOW = 1_700_000_000;   // seconds

/** A throwaway database with just the mirror tables, built from the same DDL shape as the schema. */
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  const db = new Database(path.join(dir, 'm.db'));
  db.exec(`
    -- ⚠️ REAL COLUMNS, because upsertNodeHealth now writes peer_version back onto the edge.
    -- The guard test below includes this table for the same reason it includes the others.
    CREATE TABLE mesh_edges (
      id TEXT PRIMARY KEY, peer_node_id TEXT NOT NULL, direction TEXT NOT NULL,
      role_capabilities TEXT NOT NULL DEFAULT '[]', grant_categories TEXT NOT NULL DEFAULT '[]',
      transport_direction TEXT NOT NULL, retention_days INTEGER, tombstone_purge_days INTEGER,
      tls_verify INTEGER NOT NULL DEFAULT 1, peer_version TEXT, peer_min_version TEXT,
      token_hash TEXT, token_expires_at INTEGER, client_id TEXT, created_at INTEGER,
      last_sync_at INTEGER, revoked_at INTEGER, peer_url TEXT, up_token TEXT, peer_name TEXT,
      shared_workspaces TEXT,
      -- Phase 5 write consent. ⚠️ Set ONLY by the child's own operator; the wire may never write
      -- these, which is why they are absent from the enrollment INSERT and its ON CONFLICT clause.
      write_grant TEXT,
      write_scope TEXT,
      -- How much disk this edge may consume, and how much it has. ⚠️ NULL is NOTHING, never
      -- unlimited — the same rule as write_scope, and for the same reason.
      write_bytes_budget INTEGER,
      write_bytes_used INTEGER NOT NULL DEFAULT 0,
      -- What a child announced this hub may do to it. Advisory — see mirror-store.recordWriteOffer.
      peer_write_offer TEXT,
      -- Whether the peer agreed its data may travel a second hop, and whether we agreed ours may.
      share_upward INTEGER NOT NULL DEFAULT 0,
      peer_shares_upward INTEGER NOT NULL DEFAULT 0,
      -- Whether this operator passes received content on to that client without being asked.
      auto_forward INTEGER NOT NULL DEFAULT 0,
      -- Scale-out: the change-log position a replica has acknowledged.
      acked_rev INTEGER);
    CREATE TABLE mesh_mirror_nodes (
      origin_node_id TEXT PRIMARY KEY, via_edge_id TEXT NOT NULL, node_version TEXT,
      -- What the node calls itself. Kept alongside node_version because it has the same lifecycle:
      -- declared by the origin, refreshed on every report, never authored by the receiver.
      node_name TEXT,
      device_count INTEGER, devices_online INTEGER, origin_ts INTEGER,
      received_at INTEGER NOT NULL, stale_since INTEGER);
    CREATE TABLE mesh_mirror_devices (
      origin_node_id TEXT NOT NULL, device_id TEXT NOT NULL, name TEXT, status TEXT,
      last_heartbeat INTEGER, body TEXT NOT NULL DEFAULT '{}', origin_ts INTEGER,
      received_at INTEGER NOT NULL, deleted_at INTEGER, first_seen_at INTEGER,
      workspace_id TEXT,
      -- Which edge the row arrived on. Relayed rows originate at a node this hub has no edge to,
      -- so visibility is resolved from the edge rather than the origin.
      edge_id TEXT,
      PRIMARY KEY (origin_node_id, device_id));
    CREATE TABLE mesh_mirror_workspaces (
      origin_node_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT,
      organization_name TEXT, device_count INTEGER, origin_ts INTEGER,
      received_at INTEGER NOT NULL, deleted_at INTEGER,
      PRIMARY KEY (origin_node_id, workspace_id));
    CREATE TABLE mesh_mirror_alerts (
      id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, alert_type TEXT NOT NULL, severity TEXT,
      subject_count INTEGER, subjects TEXT, opened_at INTEGER, closed_at INTEGER,
      origin_ts INTEGER, received_at INTEGER NOT NULL);
    CREATE TABLE mesh_mirror_play_logs (
      id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, device_id TEXT, content_ref TEXT,
      played_at INTEGER, duration_ms INTEGER, origin_ts INTEGER, received_at INTEGER NOT NULL);
  `);
  db._dir = dir;
  return db;
}
const cleanup = (db) => { try { db.close(); } catch {} fs.rmSync(db._dir, { recursive: true, force: true }); };

const env = (type, body, over = {}) => ({
  type, body, origin_node_id: 'node-a', origin_ts: NOW * 1000, ...over,
});
const edge = (over = {}) => ({ id: 'e1', peer_node_id: 'node-a', retention_days: 30,
                               tombstone_purge_days: 30, last_sync_at: NOW, revoked_at: null, ...over });

// ===== idempotence =====

test('THE RECONNECT CASE: re-sent state updates rather than duplicating', () => {
  /*
   * ⚠️ A child that reconnects and backfills WILL re-send what it already sent. An insert-only design
   * turns an ordinary reconnect into duplicate rows, and every count on the hub's dashboard silently
   * doubles — with nothing pointing at the storage layer as the cause.
   */
  const db = freshDb();
  try {
    for (let i = 0; i < 3; i++) {
      ms.storeEnvelope(db, edge(), env('device-summary',
        { id: 'dev-1', name: 'Lobby', status: 'online' }), NOW + i);
    }
    const rows = db.prepare('SELECT * FROM mesh_mirror_devices').all();
    assert.equal(rows.length, 1, 'one device, however many times it reports');
    assert.equal(rows[0].received_at, NOW + 2, 'and it holds the latest');
  } finally { cleanup(db); }
});

test('a play log re-sent during backfill is a no-op, never an update', () => {
  // ⚠️ A play event is an immutable historical fact. Anything that "updates" a past play is
  // corrupting evidence somebody may be invoicing against.
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('proof-of-play',
      { id: 'p1', device_id: 'dev-1', played_at: NOW, duration_ms: 5000 }), NOW);
    ms.storeEnvelope(db, edge(), env('proof-of-play',
      { id: 'p1', device_id: 'dev-1', played_at: NOW, duration_ms: 999999 }), NOW + 60);

    const rows = db.prepare('SELECT * FROM mesh_mirror_play_logs').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].duration_ms, 5000, 'the original fact stands');
  } finally { cleanup(db); }
});

test('hearing from a node clears its stale mark', () => {
  // Otherwise a node that was disconnected and later re-paired stays greyed out while reporting.
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('node-health', { version: '2.0.0', device_count: 4 }), NOW);
    ms.markNodeStale(db, 'node-a', NOW + 10);
    assert.ok(db.prepare('SELECT stale_since FROM mesh_mirror_nodes').get().stale_since);

    ms.storeEnvelope(db, edge(), env('node-health', { version: '2.0.0', device_count: 4 }), NOW + 20);
    assert.equal(db.prepare('SELECT stale_since FROM mesh_mirror_nodes').get().stale_since, null);
  } finally { cleanup(db); }
});

// ===== grant-shaped storage =====

test('a health-only device stores a NULL name, which is what makes it un-searchable', () => {
  /*
   * A documented consequence of the grant, not a bug — and the empty state has to say so, or someone
   * "fixes" the missing search result by widening the grant.
   */
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('device-summary', { id: 'dev-1', status: 'online' }), NOW);
    const row = db.prepare('SELECT name, status FROM mesh_mirror_devices').get();
    assert.equal(row.name, null);
    assert.equal(row.status, 'online', 'while what WAS granted is queryable');
  } finally { cleanup(db); }
});

test('an unknown payload type is not stored at all', () => {
  // ⚠️ Relayable is a TRANSPORT property (I5). Inventing a table for a payload this node cannot
  // interpret would be storing bytes nobody can ever read — how a mirror becomes a landfill.
  const db = freshDb();
  try {
    assert.equal(ms.storeEnvelope(db, edge(), env('invented-in-2027', { x: 1 }), NOW), null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mesh_mirror_devices').get().c, 0);
  } finally { cleanup(db); }
});

// ===== retention =====

test('⚠️ pruning by age NEVER touches current state', () => {
  /*
   * THE DANGEROUS ONE. mesh_mirror_devices holds the LATEST state, so an age sweep would delete a
   * screen that simply has not changed in six months — and it would vanish from the hub while still
   * hanging on a wall. Only history ages out.
   */
  const db = freshDb();
  try {
    const old = NOW - 400 * 86400;
    ms.storeEnvelope(db, edge(), env('device-summary', { id: 'dev-1', name: 'Old Faithful' }), old);
    ms.storeEnvelope(db, edge(), env('alert-event',
      { id: 'a-old', type: 'offline', opened_at: old, closed_at: old + 60 }), old);
    ms.storeEnvelope(db, edge(), env('proof-of-play', { id: 'p-old', played_at: old }), old);

    const pruned = ms.pruneEdge(db, edge({ retention_days: 30 }), NOW);
    assert.equal(pruned.alerts, 1, 'a closed alert ages out');
    assert.equal(pruned.playLogs, 1, 'and so does history');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mesh_mirror_devices').get().c, 1,
      'but the screen stays — it is current state, not history');
  } finally { cleanup(db); }
});

test('an OPEN alert is current state and survives retention however old', () => {
  const db = freshDb();
  try {
    const old = NOW - 400 * 86400;
    ms.storeEnvelope(db, edge(), env('alert-event',
      { id: 'a-open', type: 'offline', opened_at: old, closed_at: null }), old);
    ms.pruneEdge(db, edge({ retention_days: 30 }), NOW);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mesh_mirror_alerts').get().c, 1,
      'a problem that is still happening is not history');
  } finally { cleanup(db); }
});

test('retention is PER EDGE, so a client can bind the parent to their own policy', () => {
  /*
   * ⚠️ Holding a client's data longer than they hold it is a real problem in a regulated environment,
   * and it is discovered during an audit rather than by us.
   */
  const db = freshDb();
  try {
    const age = NOW - 60 * 86400;
    ms.storeEnvelope(db, edge(), env('proof-of-play', { id: 'p1', played_at: age }), age);
    // 90-day edge keeps it...
    assert.equal(ms.pruneEdge(db, edge({ retention_days: 90 }), NOW).playLogs, 0);
    // ...a 30-day edge does not.
    assert.equal(ms.pruneEdge(db, edge({ retention_days: 30 }), NOW).playLogs, 1);
  } finally { cleanup(db); }
});

test('retention of 0 or unset prunes nothing rather than everything', () => {
  // ⚠️ The failure direction matters: an unset retention silently deleting a client's history would
  // be discovered far too late. Absent means "keep", never "purge".
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('proof-of-play', { id: 'p1', played_at: NOW - 999 * 86400 }), NOW);
    assert.equal(ms.pruneEdge(db, edge({ retention_days: 0 }), NOW).playLogs, 0);
    assert.equal(ms.pruneEdge(db, edge({ retention_days: undefined }), NOW).playLogs, 0);
  } finally { cleanup(db); }
});

// ===== deletion =====

test('a device deleted on the child is MARKED, not removed', () => {
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('device-summary', { id: 'dev-1', name: 'Gone' }), NOW);
    ms.storeEnvelope(db, edge(), env('tombstone', { object_id: 'dev-1', deleted_at: NOW }), NOW);

    const row = ms.readDevice(db, 'node-a', 'dev-1');
    assert.ok(row, 'the row survives — last month\'s report must not change retroactively');
    assert.equal(row.deleted_at, NOW);

    // Purge is a separate horizon, and also per edge.
    assert.equal(ms.pruneEdge(db, edge({ tombstone_purge_days: 30 }), NOW + 31 * 86400).tombstoned, 1);
  } finally { cleanup(db); }
});

test('a device that reports again is no longer deleted', () => {
  // A tombstone followed by a live report is a device that came back, not a contradiction.
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('device-summary', { id: 'dev-1' }), NOW);
    ms.storeEnvelope(db, edge(), env('tombstone', { object_id: 'dev-1', deleted_at: NOW }), NOW);
    ms.storeEnvelope(db, edge(), env('device-summary', { id: 'dev-1', status: 'online' }), NOW + 10);
    assert.equal(ms.readDevice(db, 'node-a', 'dev-1').deleted_at, null);
  } finally { cleanup(db); }
});

test('purge on request removes everything from one node, and only that node', () => {
  const db = freshDb();
  try {
    ms.storeEnvelope(db, edge(), env('device-summary', { id: 'd1' }), NOW);
    ms.storeEnvelope(db, edge(), env('proof-of-play', { id: 'p1', played_at: NOW }), NOW);
    ms.storeEnvelope(db, edge({ peer_node_id: 'node-b' }),
      env('device-summary', { id: 'd2' }, { origin_node_id: 'node-b' }), NOW);

    const out = ms.purgeNode(db, 'node-a');
    assert.equal(out.devices, 1);
    assert.equal(out.playLogs, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mesh_mirror_devices').get().c, 1,
      'the other client is untouched');
  } finally { cleanup(db); }
});

// ===== freshness =====

test('⚠️ freshness comes from the EDGE, not the row age', () => {
  /*
   * A device row an hour old is perfectly current if its node reports hourly and is reachable, and
   * badly out of date if the node dropped ten minutes ago. This is the data behind Phase 3's
   * tri-state, where a WAN blip on one hub link must never paint 400 healthy screens red.
   */
  assert.equal(ms.freshnessOf(edge({ last_sync_at: NOW - 10 }), NOW), 'live');
  assert.equal(ms.freshnessOf(edge({ last_sync_at: NOW - 3600 }), NOW), 'stale');
  assert.equal(ms.freshnessOf(edge({ revoked_at: NOW }), NOW), 'stale');
  // ⚠️ Never synced is NOT stale — it is a link that has not started, and calling it unhealthy sends
  // someone debugging something that is merely new.
  assert.equal(ms.freshnessOf(edge({ last_sync_at: null }), NOW), 'unknown');
});

test('⚠️ the fixture schema matches the REAL one', () => {
  /*
   * The DDL above is hand-written, and a fixture that drifts from the real schema is a test that
   * proves nothing about production. This project has already been bitten by exactly that: the
   * admin-users fixture lacked `email_verified`, so a bug in that column had no coverage in either
   * direction until the fix broke four tests.
   *
   * Boots the real migrations in a child process (config.js resolves DATA_DIR once at load) and
   * compares column sets.
   */
  const { execFileSync } = require('node:child_process');
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-schema-'));
  try {
    const probe = `
      require('./db/database.js');
      const { Database } = require('./db/sqlite-driver');
      const db = new Database(require('path').join(process.env.DATA_DIR, 'db', 'remote_display.db'));
      const out = {};
      for (const t of ['mesh_mirror_nodes','mesh_mirror_devices','mesh_mirror_alerts','mesh_mirror_play_logs','mesh_edges']) {
        out[t] = db.prepare("select name from pragma_table_info('" + t + "')").all().map(r => r.name).sort();
      }
      db.close();
      console.log('SCHEMA=' + JSON.stringify(out));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test' },
    });
    const line = out.split('\n').find((l) => l.startsWith('SCHEMA='));
    assert.ok(line, `probe produced no result:\n${out.slice(-400)}`);
    const real = JSON.parse(line.slice('SCHEMA='.length));

    const fixture = freshDb();
    try {
      for (const [table, realCols] of Object.entries(real)) {
        assert.ok(realCols.length > 0, `${table} is missing from the real schema entirely`);
        const fixtureCols = fixture.prepare(
          `select name from pragma_table_info('${table}')`).all().map((r) => r.name).sort();
        assert.deepEqual(fixtureCols, realCols,
          `${table}: the test fixture and the real schema have drifted`);
      }
    } finally { cleanup(fixture); }
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

test('⚠️ first_seen_at is set ONCE and never re-stamped', () => {
  /*
   * received_at cannot answer "when did this hub first see this screen" — the row is upserted, so it
   * is always the latest report. Without a separate first-seen, the uptime report has to assume every
   * screen existed for the whole window, which scores a screen installed on the 20th as broken for
   * the first 19 days of the month.
   *
   * And it must survive a tombstone: identity is stable (I4), so a screen that comes back is the same
   * screen and its history still belongs to it. Re-stamping would read as "installed today" and drop
   * it out of every report covering the period it was actually running.
   */
  const db = freshDb();
  try {
    const send = (at) => ms.storeEnvelope(
      db, edge(), env('device-summary', { id: 'dev-1', name: 'Lobby', status: 'online' }), at);

    send(NOW);
    const first = db.prepare('SELECT first_seen_at FROM mesh_mirror_devices').get().first_seen_at;
    assert.equal(first, NOW, 'stamped on first sight');

    send(NOW + 5000);
    db.prepare('UPDATE mesh_mirror_devices SET deleted_at = ?').run(NOW + 6000);
    send(NOW + 7000);

    const row = db.prepare('SELECT * FROM mesh_mirror_devices').get();
    assert.equal(row.first_seen_at, first, 'unchanged by later reports, or by coming back');
    assert.equal(row.deleted_at, null, 'while the tombstone still clears');
    assert.equal(row.received_at, NOW + 7000, 'and received_at still tracks the latest');
  } finally { cleanup(db); }
});

/*
 * ⚠️ peer_version WAS WRITTEN ONCE, AT ENROLLMENT, AND NEVER AGAIN.
 *
 * mesh-enroll.js sets it on INSERT; meshSocket.js never touched it. So the column reported whatever
 * the peer happened to be running on pairing day, permanently. Found on real hardware: a BrightSign
 * took 2.0.0-alpha1, ran it, and reported it up the link — while the parent still showed alpha0.
 *
 * That is worse than an absent value, because the Servers view labels this column "version skew".
 * It is the field an operator reads to confirm a fleet took an update, and it answered with the past.
 */
test('a health report from the edge\'s own peer refreshes peer_version', () => {
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_version)
                VALUES ('e1','child-1','down','they-dial','2.0.0-alpha0')`).run();
    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1',
      body: { version: '2.0.0-alpha1', device_count: 1, devices_online: 1 },
      originTs: NOW, receivedAt: NOW,
    });
    assert.equal(db.prepare("SELECT peer_version v FROM mesh_edges WHERE id='e1'").get().v, '2.0.0-alpha1');
  }
});

test('⚠️ a RELAYED report from deeper in the subtree does NOT overwrite the edge', () => {
  // A node-health payload legitimately arrives via a child on behalf of a GRANDCHILD. Writing that
  // onto the edge would report the grandchild's version as the child's — the parent would then show
  // a version nobody on that link is running, and the deeper the tree the more wrong it gets.
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_version)
                VALUES ('e1','child-1','down','they-dial','2.0.0-alpha1')`).run();
    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'grandchild-9',      // relayed THROUGH child-1, not FROM it
      body: { version: '1.9.39', device_count: 4, devices_online: 2 },
      originTs: NOW, receivedAt: NOW,
    });
    assert.equal(db.prepare("SELECT peer_version v FROM mesh_edges WHERE id='e1'").get().v, '2.0.0-alpha1',
      'the grandchild version leaked onto the child edge');
    // ...while the grandchild's own mirrored row is still recorded, which is the point of relaying.
    assert.equal(db.prepare("SELECT node_version v FROM mesh_mirror_nodes WHERE origin_node_id='grandchild-9'").get().v,
      '1.9.39');
  }
});

// ===== the name a node calls itself =====

/*
 * ⚠️ THE DEFECT: THE NAME COULD TRAVEL, AND COULD NOT CHANGE.
 *
 * mesh_node.node_name, store.setNodeName() and the `nodeName` field in the pairing handshake all
 * shipped together and looked complete. Nothing in the entire tree ever called the setter, and
 * mesh_edges.peer_name was written from the introduction at enrollment - once, and never again. So
 * every server in a mesh was permanently whatever its hostname happened to be on pairing day, and
 * an operator who renamed a box renamed it for nobody but themselves.
 *
 * That is the same defect peer_version had, immediately above, so it is fixed and covered the
 * same way: the name rides the periodic self-report.
 */
test('a rename reaches the parent, on the mirror row AND the edge', () => {
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_name)
                VALUES ('e1','child-1','down','they-dial','oldhost')`).run();

    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1',
      body: { name: 'Kenosha North', version: '2.0.0', device_count: 1, devices_online: 1 },
      originTs: NOW, receivedAt: NOW,
    });
    assert.equal(db.prepare("SELECT node_name n FROM mesh_mirror_nodes WHERE origin_node_id='child-1'").get().n,
      'Kenosha North');
    assert.equal(db.prepare("SELECT peer_name n FROM mesh_edges WHERE id='e1'").get().n, 'Kenosha North',
      'THE ORIGINAL BUG: the edge is what the Servers view reads, and it kept the pairing-day name');

    // ...and again, because a rename is not a one-time event either.
    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1',
      body: { name: 'Kenosha South', version: '2.0.0', device_count: 1, devices_online: 1 },
      originTs: NOW + 60, receivedAt: NOW + 60,
    });
    assert.equal(db.prepare("SELECT peer_name n FROM mesh_edges WHERE id='e1'").get().n, 'Kenosha South');
  }
});

test('⚠️ a report carrying no name leaves the last known one alone', () => {
  /*
   * Absent is not blank. A child on an older build sends node-health with no name field at all;
   * reading that as "" would erase a good name on the first report from an un-upgraded peer - data
   * loss produced entirely by the reader, and it would look like the child had done it.
   */
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_name)
                VALUES ('e1','child-1','down','they-dial','Kenosha North')`).run();
    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1',
      body: { name: 'Kenosha North', version: '2.0.0' }, originTs: NOW, receivedAt: NOW,
    });

    for (const body of [{ version: '2.0.0' }, { name: '', version: '2.0.0' },
                        { name: '   ', version: '2.0.0' }, { name: null, version: '2.0.0' },
                        { name: 42, version: '2.0.0' }]) {
      ms.upsertNodeHealth(db, {
        edgeId: 'e1', originNodeId: 'child-1', body, originTs: NOW + 60, receivedAt: NOW + 60,
      });
      const why = `a report of ${JSON.stringify(body)} must leave the name alone`;
      assert.equal(db.prepare("SELECT node_name n FROM mesh_mirror_nodes WHERE origin_node_id='child-1'").get().n,
        'Kenosha North', why);
      assert.equal(db.prepare("SELECT peer_name n FROM mesh_edges WHERE id='e1'").get().n, 'Kenosha North', why);
    }
  }
});

test('⚠️ a RELAYED report does NOT rename the child it arrived through', () => {
  // Exactly the guard peer_version needs, for exactly the same reason: a node-health payload
  // legitimately arrives via a child on behalf of a GRANDCHILD, and stamping that name onto the
  // edge would label the child with something behind it. The Servers view would then disagree with
  // the topology view, and only one of them would be wrong.
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_name)
                VALUES ('e1','child-1','down','they-dial','Direct Child')`).run();
    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'grandchild-9',      // relayed THROUGH child-1, not FROM it
      body: { name: 'Deep Site', version: '1.9.39' }, originTs: NOW, receivedAt: NOW,
    });
    assert.equal(db.prepare("SELECT peer_name n FROM mesh_edges WHERE id='e1'").get().n, 'Direct Child',
      "the grandchild's name leaked onto the child edge");
    // ...while the grandchild is still recorded under its own id, which is the point of relaying.
    assert.equal(
      db.prepare("SELECT node_name n FROM mesh_mirror_nodes WHERE origin_node_id='grandchild-9'").get().n,
      'Deep Site');
  }
});

test('⚠️ a name off the wire is bounded and stripped before it is stored', () => {
  /*
   * This text comes from a machine we do not run and is rendered on our dashboard beside real
   * numbers. Escaping at the renderer handles markup; it does nothing about a name that is a
   * kilobyte long (a layout attack on every page it appears in) or one carrying control characters
   * (which forge line structure in a log or a table). Bounded on the way in, at the single entry.
   */
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction)
                VALUES ('e1','child-1','down','they-dial')`).run();

    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1',
      body: { name: 'A'.repeat(400), version: '2.0.0' }, originTs: NOW, receivedAt: NOW,
    });
    assert.equal(db.prepare("SELECT node_name n FROM mesh_mirror_nodes WHERE origin_node_id='child-1'").get().n.length,
      60, 'the 60-character cap the local setter enforces applies to the wire too');

    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1',
      body: { name: 'Site\nB\tnorth ', version: '2.0.0' }, originTs: NOW + 60, receivedAt: NOW + 60,
    });
    const stored = db.prepare("SELECT node_name n FROM mesh_mirror_nodes WHERE origin_node_id='child-1'").get().n;
    // Asserted by code point, so this assertion contains no control characters of its own.
    assert.ok(![...stored].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127),
      `control characters survived: ${JSON.stringify(stored)}`);
    assert.equal(stored, 'Site B north', 'stripped to spaces and trimmed, not deleted outright');
  }
});

test('a report carrying no version leaves the last known one alone', () => {
  // A health-only grant may omit it. "I did not say" must not read as "I am unknown", or the
  // Servers view would flap to blank every time a narrow-grant peer reported.
  const db = freshDb();
  {
    db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_version)
                VALUES ('e1','child-1','down','they-dial','2.0.0-alpha1')`).run();
    ms.upsertNodeHealth(db, {
      edgeId: 'e1', originNodeId: 'child-1', body: { device_count: 1 }, originTs: NOW, receivedAt: NOW,
    });
    assert.equal(db.prepare("SELECT peer_version v FROM mesh_edges WHERE id='e1'").get().v, '2.0.0-alpha1');
  }
});

/*
 * ⚠️ WHAT A CHILD SAYS THIS HUB MAY DO TO IT.
 *
 * The hub has no copy of the child's write grant and must never infer one, so without this
 * announcement it cannot tell an operator whether they may push to a client — it can only let them
 * try and be refused, by a refusal deliberately identical for "no such thing" and "not permitted".
 *
 * Advisory in the strongest sense: the child re-checks its own row on every request. What is tested
 * here is that the hub records it, shape-checks it, and NEVER ends up claiming more than the child
 * offered — including when the offer is malformed, hostile, or absent.
 */

/*
 * A real mesh_edges ROW, because recordWriteOffer UPDATEs it — the in-memory `edge()` builder above
 * is enough for the mirror tables, which key on edge_id without needing the row to exist.
 */
function seedEdge(db, id = 'e1') {
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, peer_version)
              VALUES (?, 'child-1', 'down', 'they-dial', '2.0.0')`).run(id);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(id);
}

test('a write offer from a child is recorded on the edge', () => {
  const db = freshDb();
  const edge = seedEdge(db);
  ms.storeEnvelope(db, edge, {
    type: 'write-offer', origin_node_id: 'child-1', origin_ts: Date.now(),
    body: { categories: ['content-push'], workspaces: ['ws-1'], bytesBudget: 20 * 1024 ** 3, bytesUsed: 5 },
  });
  const offer = JSON.parse(db.prepare('SELECT peer_write_offer AS o FROM mesh_edges WHERE id = ?').get(edge.id).o);
  assert.deepEqual(offer.categories, ['content-push']);
  assert.deepEqual(offer.workspaces, ['ws-1']);
  assert.equal(offer.bytesUsed, 5);
});

test('⚠️ an offer that grants nothing is stored as nothing, not as an empty promise', () => {
  const db = freshDb();
  const edge = seedEdge(db);
  for (const body of [
    { categories: [], workspaces: ['ws-1'] },          // no categories
    { categories: ['content-push'], workspaces: [] },  // no workspaces — enforcement denies this too
    {},
  ]) {
    ms.storeEnvelope(db, edge, { type: 'write-offer', origin_node_id: 'child-1', origin_ts: Date.now(), body });
    const o = db.prepare('SELECT peer_write_offer AS o FROM mesh_edges WHERE id = ?').get(edge.id).o;
    assert.equal(o, null, `${JSON.stringify(body)} must not read as an offer`);
  }
});

test('⚠️ a malformed offer CLEARS the previous one rather than leaving it standing', () => {
  // A stale, more permissive answer surviving a garbled update is the wrong way for this to fail:
  // the hub would keep offering a button the customer has since taken away.
  const db = freshDb();
  const edge = seedEdge(db);
  ms.storeEnvelope(db, edge, {
    type: 'write-offer', origin_node_id: 'child-1', origin_ts: Date.now(),
    body: { categories: ['content-push'], workspaces: ['ws-1'] },
  });
  assert.ok(db.prepare('SELECT peer_write_offer AS o FROM mesh_edges WHERE id = ?').get(edge.id).o);

  ms.storeEnvelope(db, edge, {
    type: 'write-offer', origin_node_id: 'child-1', origin_ts: Date.now(),
    body: { categories: 'everything', workspaces: { all: true } },
  });
  assert.equal(db.prepare('SELECT peer_write_offer AS o FROM mesh_edges WHERE id = ?').get(edge.id).o, null);
});
