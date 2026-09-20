'use strict';

// Scale-out C1 (docs/scale-out-design.md): the replica's copy is built ONLY by asking the primary
// through the allowlisted reads, and converges. Two real databases from the real schema; the
// "wire" between them is a fake readFrom that calls the primary's answerRead directly — the
// transport is proven elsewhere (mesh-transport.test.js), this pins the replication contract.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scaleout-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-scaleout-' + crypto.randomBytes(4).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// The PRIMARY is the real database module (migrations, triggers can be created on it).
const { db: primary } = require('../db/database');
const replication = require('../lib/mesh/replication');
const nodeData = require('../lib/mesh/node-data');
const { createReplica, applyBatch, upsertRow } = require('../lib/mesh/replica');

// The REPLICA is a second file with the same schema: clone the primary's schema (no rows).
function cloneSchema(src, file) {
  const d = new Database(file);
  d.pragma('journal_mode = WAL'); d.pragma('foreign_keys = ON');
  const objs = src.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'mesh_cl_%'").all();
  for (const o of objs) { try { d.exec(o.sql); } catch (_) { /* index on a table skipped */ } }
  // Seed rows a fresh install has (plans), so local inserts satisfy their foreign keys.
  for (const r of src.prepare('SELECT * FROM plans').all()) {
    const k = Object.keys(r); d.prepare(`INSERT OR IGNORE INTO plans (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((c) => r[c]));
  }
  return d;
}
const replica = cloneSchema(primary, path.join(TMP, 'replica.db'));

const PRIMARY_NODE = 'primary-node-' + crypto.randomBytes(3).toString('hex');
const uid = () => crypto.randomUUID();

// A user, org, workspace and content on the primary.
const userId = uid(), orgId = uid(), wsId = uid();
primary.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'Owner', 'HASH-NEVER-COPIED', 'platform_admin')").run(userId, `owner-${userId.slice(0, 6)}@x.local`);
primary.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, 'Acme', ?, 'free')").run(orgId, userId);
primary.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Main')").run(wsId, orgId);
primary.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(orgId, userId);
primary.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(wsId, userId);

// An up edge on the primary carrying the grant — the trigger set follows it.
primary.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at, up_token, peer_url, shared_workspaces)
                 VALUES (?, 'replica-node', 'up', ?, ?, 'we-dial', 1, ?, 'x', ?, 'tok', 'http://replica', ?)`)
  .run(uid(), JSON.stringify(['serves-dashboard']), JSON.stringify(['workspace-replication']), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600, JSON.stringify([wsId]));
assert.equal(replication.ensureTriggers(primary).action, 'created');

const edgeOnPrimary = () => primary.prepare("SELECT * FROM mesh_edges WHERE direction = 'up'").get();
// The fake wire: what the replica asks is answered by the primary's own answerRead against the live edge row.
// `duringSnapshot` lets a test write on the primary WHILE the replica is paging — the §4 race.
let duringSnapshot = null;
const readFrom = async (_nodeId, req) => {
  if (duringSnapshot && /\/api\/mesh\/snapshot/.test(req.path)) { const f = duringSnapshot; duringSnapshot = null; f(); }
  return nodeData.answerRead(primary, edgeOnPrimary(), req);
};
// The replica's down edge row (what ws/meshSocket would hold).
const downEdge = { id: 'edge-down', peer_node_id: PRIMARY_NODE, direction: 'down', revoked_at: null,
  role_capabilities: JSON.stringify(['serves-dashboard']), grant_categories: JSON.stringify(['workspace-replication']) };
replica.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
                 VALUES (?, ?, 'down', ?, ?, 'they-dial', 1, ?, 'y', ?)`)
  .run(downEdge.id, PRIMARY_NODE, downEdge.role_capabilities, downEdge.grant_categories, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600);

const rep = createReplica(replica, { readFrom, logger: { warn() {}, log() {} } });

test('snapshot copies the shared workspace, tags it, and never carries a password hash', async () => {
  const plId = uid();
  primary.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'Lobby')").run(plId, userId, wsId);
  await rep.sync(downEdge);
  const st = rep.status()[0];
  assert.equal(st.phase, 'idle', st.error || '');
  const ws = replica.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
  assert.ok(ws, 'workspace copied');
  assert.equal(ws.origin_node_id, PRIMARY_NODE, 'tagged with the primary');
  assert.ok(ws.replica_rev >= 1 && ws.replica_as_of > 0, 'position recorded');
  assert.equal(replica.prepare('SELECT name FROM playlists WHERE id = ?').get(plId).name, 'Lobby');
  const u = replica.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  assert.ok(u, 'member copied');
  assert.equal(u.password_hash, null, 'hash never crosses');
  assert.equal(st.workspaces, 1);
});

test('test_snapshot_then_incremental_converges: an edit, a new row and a delete on the primary converge on the replica', async () => {
  const plId = uid();
  primary.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'v1')").run(plId, userId, wsId);
  primary.prepare("UPDATE playlists SET name = 'v2' WHERE id = ?").run(plId);
  const gone = replica.prepare("SELECT id FROM playlists WHERE name = 'Lobby'").get().id;
  primary.prepare('DELETE FROM playlists WHERE id = ?').run(gone);
  await rep.sync(downEdge);
  assert.equal(rep.status()[0].phase, 'idle', rep.status()[0].error || '');
  assert.equal(replica.prepare('SELECT name FROM playlists WHERE id = ?').get(plId).name, 'v2', 'coalesced to the latest');
  assert.equal(replica.prepare('SELECT 1 FROM playlists WHERE id = ?').get(gone), undefined, 'delete reached the copy');
  // Positions agree: the replica's recorded rev is the primary's head, and the primary saw the ack.
  assert.equal(replica.prepare('SELECT replica_rev FROM workspaces WHERE id = ?').get(wsId).replica_rev, replication.headRev(primary));
});

test('test_snapshot_then_incremental_converges: 200 items published DURING the snapshot end up on the replica', async () => {
  // Force a fresh snapshot on a second replica of the same primary, and publish while it pages.
  const replica2 = cloneSchema(primary, path.join(TMP, 'replica2.db'));
  replica2.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
                    VALUES ('edge-down-2', ?, 'down', ?, ?, 'they-dial', 1, ?, 'z', ?)`)
    .run(PRIMARY_NODE, downEdge.role_capabilities, downEdge.grant_categories, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600);
  const rep2 = createReplica(replica2, { readFrom, logger: { warn() {}, log() {} } });
  const plId = uid();
  primary.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'burst')").run(plId, userId, wsId);
  const ids = [];
  duringSnapshot = () => {
    const ins = primary.prepare("INSERT INTO playlist_items (playlist_id, sort_order) VALUES (?, ?)");
    for (let i = 0; i < 200; i++) ids.push(ins.run(plId, i).lastInsertRowid);
    primary.prepare("UPDATE playlists SET name = 'burst-renamed' WHERE id = ?").run(plId);
  };
  await rep2.sync({ ...downEdge, id: 'edge-down-2' });
  assert.equal(rep2.status()[0].phase, 'idle', rep2.status()[0].error || '');
  assert.equal(ids.length, 200, 'the burst ran while paging');
  assert.equal(replica2.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(plId).n, 200);
  assert.equal(replica2.prepare('SELECT name FROM playlists WHERE id = ?').get(plId).name, 'burst-renamed');
  assert.equal(replica2.prepare('SELECT replica_rev FROM workspaces WHERE id = ?').get(wsId).replica_rev, replication.headRev(primary));
  rep2.stop();
  // Bring the first replica up to date too, so later tests start equal.
  await rep.sync(downEdge);
});

test('a heartbeat-shaped device update is not logged; a rename is; volatile state arrives via device-summary', async () => {
  const devId = uid();
  primary.prepare("INSERT INTO devices (id, user_id, name, workspace_id, device_token, settings_pin) VALUES (?, ?, 'TV', ?, 'TOKEN-NEVER-COPIED', '123456')").run(devId, userId, wsId);
  await rep.sync(downEdge);
  const before = replication.headRev(primary);
  primary.prepare("UPDATE devices SET last_heartbeat = ?, status = 'online' WHERE id = ?").run(Math.floor(Date.now() / 1000), devId);
  assert.equal(replication.headRev(primary), before, 'heartbeat did not touch the log');
  primary.prepare("UPDATE devices SET name = 'Lobby TV' WHERE id = ?").run(devId);
  assert.equal(replication.headRev(primary), before + 1, 'rename did');
  await rep.sync(downEdge);
  const d = replica.prepare('SELECT * FROM devices WHERE id = ?').get(devId);
  assert.equal(d.name, 'Lobby TV');
  assert.equal(d.device_token, null, 'token never crosses');
  assert.equal(d.settings_pin, null, 'pin never crosses');
  // Liveness rides the existing summary envelope, onto the copied row.
  rep.onEnvelope(downEdge, { type: 'device-summary', body: { id: devId, status: 'online', last_heartbeat: 1234567 } });
  assert.equal(replica.prepare('SELECT status, last_heartbeat FROM devices WHERE id = ?').get(devId).last_heartbeat, 1234567);
});

test('a workspace-replication grant carries health and identity in device summaries (its authored implies list), so a copied screen\'s status follows its primary', () => {
  const grants = require('../lib/mesh/grants');
  const mirror = require('../lib/mesh/mirror');
  assert.equal(grants.grantAllows(['workspace-replication'], 'health'), true);
  assert.equal(grants.grantAllows(['workspace-replication'], 'identity'), true);
  assert.equal(grants.grantAllows(['workspace-replication'], 'display-capture'), false, 'not implied: screenshots need their own tick');
  assert.equal(grants.grantAllows(['health'], 'identity'), false, 'a plain category implies nothing');
  const out = mirror.projectDevice({ id: 'd', status: 'online', last_heartbeat: 5, name: 'Lobby', device_token: 'never' }, ['workspace-replication']);
  assert.equal(out.status, 'online'); assert.equal(out.name, 'Lobby');
  assert.equal(out.device_token, undefined, 'still no secret');
});

test('the snapshot only covers the SHARED workspaces; another workspace on the primary never crosses', async () => {
  const otherWs = uid();
  primary.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Private')").run(otherWs, orgId);
  primary.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'Secret')").run(uid(), userId, otherWs);
  await rep.sync(downEdge);
  assert.equal(replica.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(otherWs), undefined);
  assert.equal(replica.prepare("SELECT 1 FROM playlists WHERE name = 'Secret'").get(), undefined);
});

test('a local user with the same email is never overwritten by a copy', () => {
  replica.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES ('local-1', 'shared@x.local', 'Local', 'LOCALHASH', 'user')").run();
  const r = upsertRow(replica, 'users', { id: 'remote-1', email: 'shared@x.local', name: 'Remote', role: 'user' }, PRIMARY_NODE);
  assert.equal(r.applied, false);
  assert.equal(replica.prepare("SELECT password_hash FROM users WHERE email = 'shared@x.local'").get().password_hash, 'LOCALHASH');
});

test('test_circuit_breaker_is_constructed_by_the_replica_pull: a dead primary is skipped, not waited on, and lag reads null', async () => {
  const deadEdge = { ...downEdge, id: 'edge-dead', peer_node_id: 'dead-primary' };
  replica.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
                   VALUES (?, ?, 'down', ?, ?, 'they-dial', 1, ?, 'z', ?)`)
    .run(deadEdge.id, 'dead-primary', deadEdge.role_capabilities, deadEdge.grant_categories, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600);
  let asks = 0;
  const r2 = createReplica(replica, { readFrom: async () => { asks++; return { ok: false, offline: true, reason: 'not connected' }; }, logger: { warn() {}, log() {} } });
  for (let i = 0; i < 6; i++) await r2.sync(deadEdge);
  const st = r2.status().find((s) => s.node_id === 'dead-primary');
  assert.equal(st.edge, 'down');
  assert.equal(st.lag_s, null, 'silence is not a number');
  assert.ok(asks < 6, `breaker opened: only ${asks} of 6 attempts reached the wire`);
  assert.ok(r2.breakers.status(Date.now()).some((b) => b.childId === 'dead-primary' && b.state === 'open'));
  replica.prepare('DELETE FROM mesh_edges WHERE id = ?').run(deadEdge.id);
});

test('a primary whose socket has closed reads "down" at once, not after the next pull fails (found on a flapping estate)', async () => {
  // Same edge, same synced state; only the live socket check changes. Before this, a SIGKILLed
  // primary stayed "connected · copy lag Ns" on the hub NOC for up to pollMs (30 s).
  let live = true;
  const r3 = createReplica(replica, { readFrom, isConnected: () => live, logger: { warn() {}, log() {} } });
  await r3.sync(downEdge);
  let st = r3.status().find((s) => s.node_id === downEdge.peer_node_id);
  assert.equal(st.edge, 'up');
  assert.ok(st.lag_s != null);
  live = false;
  st = r3.status().find((s) => s.node_id === downEdge.peer_node_id);
  assert.equal(st.edge, 'down', 'socket closed → down without waiting for a read to fail');
  assert.equal(st.lag_s, null, 'silence is not a number');
  live = true;
  st = r3.status().find((s) => s.node_id === downEdge.peer_node_id);
  assert.equal(st.edge, 'up', 'socket back → up again');
});

test('changes in a workspace the edge does not share still move the replica\'s position to the head (found on a second-tier hub)', () => {
  // Austin (a hub with its own primary above it) kept its change log moving with COPIES of its
  // leaves' workspaces, which the top hub is not granted. The top hub's cursor stuck at the last
  // rev it was granted, so Austin showed "acked 437/626" and could never prune past 437.
  const otherWs = uid();
  primary.prepare("INSERT INTO workspaces (id, organization_id, name, origin_node_id) VALUES (?, ?, 'A copy held here', 'some-child')").run(otherWs, orgId);
  const before = replication.headRev(primary);
  for (let i = 0; i < 5; i++) primary.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(`copy tick ${i}`, otherWs);
  const head = replication.headRev(primary);
  assert.ok(head > before, 'the trigger logged the copied workspace\'s writes');
  const r = replication.changesSince(primary, [wsId], before, 500);
  assert.equal(r.rows.length, 0, 'nothing for the shared workspace');
  assert.equal(r.upto, head, 'the cursor parks at the examined head, not at the last granted rev');
  // A full page still stops at the last returned rev: the rest has not been examined.
  for (let i = 0; i < 3; i++) primary.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(`shared tick ${i}`, wsId);
  const paged = replication.changesSince(primary, [wsId], head, 2);
  assert.equal(paged.more, true);
  assert.ok(paged.upto < replication.headRev(primary), 'a full page never jumps past what it returned');
  primary.prepare('DELETE FROM workspaces WHERE id = ?').run(otherWs);
});

test('applyBatch drops a column this build does not have rather than failing the batch', () => {
  const r = applyBatch(replica, [{ op: 'upsert', table: 'playlists', row: { id: 'pl-future', user_id: userId, workspace_id: wsId, name: 'F', column_from_2030: 'x' } }], PRIMARY_NODE);
  assert.deepEqual(r.skipped, []);
  assert.equal(replica.prepare("SELECT name FROM playlists WHERE id = 'pl-future'").get().name, 'F');
});

test('dropping the grant drops the triggers; a write afterwards leaves no trace', () => {
  primary.prepare("UPDATE mesh_edges SET revoked_at = ? WHERE direction = 'up'").run(Math.floor(Date.now() / 1000));
  assert.equal(replication.ensureTriggers(primary).action, 'dropped');
  const head = replication.headRev(primary);
  primary.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'after')").run(uid(), userId, wsId);
  assert.equal(replication.headRev(primary), head);
  assert.equal(replication.installedTriggers(primary).length, 0);
});
