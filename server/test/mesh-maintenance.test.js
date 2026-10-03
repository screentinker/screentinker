'use strict';

/*
 * THE SWEEPS THAT WERE DESIGNED, INDEXED FOR, AND NEVER SCHEDULED.
 *
 * Three tables grew without bound on a long-lived node, and each already had everything needed to
 * prune it except a caller: mirror-store.pruneEdge had no callers outside its own tests, and both
 * idx_mesh_write_ops_age and the mesh_pull_tickets expiry index were created for pruners nobody
 * wrote. A retention setting the UI offers and the server never applies is worse than none — it is
 * a promise the product does not keep, on the axis a customer asks about by name.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshmaint-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { sweepOnce, WRITE_OP_RETENTION_DAYS } = require('../services/mesh-maintenance');

const id = () => crypto.randomUUID();
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
let edge;

before(() => {
  edge = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, created_at,
              retention_days, tombstone_purge_days)
              VALUES (?,?,'down','they-dial',strftime('%s','now'), 30, 30)`).run(edge, 'child-1');
});

test('closed alerts past the edge retention are removed; open ones are not', () => {
  const old = nowSec() - 60 * DAY;
  db.prepare(`INSERT INTO mesh_mirror_alerts (origin_node_id, alert_type, severity, opened_at, closed_at, received_at)
              VALUES (?,?,?,?,?,?)`).run('child-1', 'a-closed', 'warn', old, old, old);
  db.prepare(`INSERT INTO mesh_mirror_alerts (origin_node_id, alert_type, severity, opened_at, closed_at, received_at)
              VALUES (?,?,?,?,NULL,?)`).run('child-1', 'a-open', 'warn', old, old);

  sweepOnce(db, { warn() {}, log() {} });

  const left = db.prepare('SELECT alert_type FROM mesh_mirror_alerts WHERE origin_node_id = ?').all('child-1')
    .map((r) => r.alert_type);
  assert.deepEqual(left, ['a-open'],
    'an alert still open is current state however old it is — only history ages out');
});

test('⚠️ settled write ops age out; an IN-FLIGHT one never does', () => {
  const old = nowSec() - (WRITE_OP_RETENTION_DAYS + 5) * DAY;
  const rows = [
    ['op-applied', 1, old],
    ['op-refused', 0, old],
    ['op-inflight', -1, old],       // outcome unknown
    ['op-recent', 1, nowSec()],
  ];
  for (const [op, ok, at] of rows) {
    db.prepare(`INSERT INTO mesh_write_ops (edge_id, op_id, target, intent_seq, ok, outcome, applied_at)
                VALUES (?,?,?,NULL,?,NULL,?)`).run(edge, op, 'playlist:x', ok, at);
  }

  sweepOnce(db, { warn() {}, log() {} });

  const left = db.prepare('SELECT op_id FROM mesh_write_ops WHERE edge_id = ?').all(edge)
    .map((r) => r.op_id).sort();
  /*
   * ⚠️ The in-flight row is the important one. Deleting a write whose outcome nobody knows frees
   * its op id for reuse — and the design instructs the operator to retry with that same id, so the
   * next retry would apply the change a second time instead of replaying the recorded outcome.
   */
  assert.deepEqual(left, ['op-inflight', 'op-recent']);
});

test('expired pull tickets are swept and live ones are kept', () => {
  db.prepare(`INSERT INTO mesh_pull_tickets (token_hash, edge_id, filepath, size, digest, expires_at, created_at)
              VALUES (?,?,?,?,?,?,strftime('%s','now'))`)
    .run('t-dead', edge, 'a.mp4', 10, 'a'.repeat(64), nowSec() - 60);
  db.prepare(`INSERT INTO mesh_pull_tickets (token_hash, edge_id, filepath, size, digest, expires_at, created_at)
              VALUES (?,?,?,?,?,?,strftime('%s','now'))`)
    .run('t-live', edge, 'b.mp4', 10, 'b'.repeat(64), nowSec() + 3600);

  sweepOnce(db, { warn() {}, log() {} });

  const left = db.prepare('SELECT token_hash FROM mesh_pull_tickets').all().map((r) => r.token_hash);
  assert.deepEqual(left, ['t-live']);
});

test('⚠️ one edge failing does not stop the others being swept', () => {
  // I1: this service must never be able to harm its own node. A malformed row on one relationship
  // must not leave every other customer's retention unapplied.
  const broken = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, transport_direction, created_at,
              retention_days) VALUES (?,?,'down','they-dial',strftime('%s','now'), 30)`)
    .run(broken, 'child-broken');
  const old = nowSec() - 60 * DAY;
  db.prepare(`INSERT INTO mesh_mirror_play_logs (origin_node_id, device_id, played_at, received_at)
              VALUES (?,?,?,?)`).run('child-1', 'd1', old, old);

  const r = sweepOnce(db, { warn() {}, log() {} });
  assert.ok(r.playLogs >= 1, 'the healthy edge is still pruned');
});

test('a sweep on an empty database removes nothing and throws nothing', () => {
  const r = sweepOnce(db, { warn() {}, log() {} });
  assert.equal(typeof r.writeOps, 'number');
});

/*
 * ⚠️ A MAP THAT ONLY EVER GAINS ENTRIES STOPS BEING A MAP.
 *
 * mesh_node_paths is learned from relayed payloads and nothing removed a row when they stopped, so
 * a decommissioned site — or one whose owner withdrew consent to being passed further up — stayed
 * on the topology page for ever, and an operator could not tell which of those servers still exist.
 */
test('⚠️ a route whose edge is gone is dropped', () => {
  const gone = id();
  db.prepare(`INSERT INTO mesh_node_paths (node_id, via_edge_id, path, hops, first_seen_at, last_seen_at)
              VALUES (?,?,?,?,?,?)`).run(gone, 'edge-that-never-existed', '["x"]', 2, nowSec(), nowSec());
  sweepOnce(db, { warn() {}, log() {} });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mesh_node_paths WHERE node_id = ?').get(gone).n, 0);
});

test('⚠️ a route that has gone quiet for a fortnight is dropped; a week is NOT', () => {
  /*
   * The age floor has to stay well clear of an ordinary outage. A site off the air for a week is a
   * site with a problem, not a site that has been removed — and dropping it from the map mid-incident
   * is precisely when somebody is looking for it.
   */
  const stale = id(); const recent = id();
  for (const [node, age] of [[stale, 20 * DAY], [recent, 7 * DAY]]) {
    db.prepare(`INSERT INTO mesh_node_paths (node_id, via_edge_id, path, hops, first_seen_at, last_seen_at)
                VALUES (?,?,?,?,?,?)`).run(node, edge, '["x"]', 2, nowSec() - age, nowSec() - age);
  }
  sweepOnce(db, { warn() {}, log() {} });
  const left = db.prepare('SELECT node_id FROM mesh_node_paths').all().map((r) => r.node_id);
  assert.ok(!left.includes(stale), 'a route silent for 20 days is gone');
  assert.ok(left.includes(recent), 'a site down for a week is a site with a problem, not a removed one');
});

test('a live route survives the sweep', () => {
  const live = id();
  db.prepare(`INSERT INTO mesh_node_paths (node_id, via_edge_id, path, hops, first_seen_at, last_seen_at)
              VALUES (?,?,?,?,?,?)`).run(live, edge, '["x"]', 2, nowSec(), nowSec());
  sweepOnce(db, { warn() {}, log() {} });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mesh_node_paths WHERE node_id = ?').get(live).n, 1);
});
