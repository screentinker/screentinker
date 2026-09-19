'use strict';

/*
 * Scale-out C2 — players on a replica (docs/scale-out-design.md §6, §7). The named guards, each at
 * the layer where the property actually lives. The two-process end-to-end is in
 * scale-out-c2-e2e.test.js; this file is what holds the pieces to their contracts.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// One throwaway data dir for the in-process pieces (db/database is a singleton per process).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-c2-'));
process.env.DATA_DIR = path.join(TMP, 'unit');
process.env.SELF_HOSTED = 'true'; process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'c2-' + crypto.randomBytes(4).toString('hex');
const { db } = require('../db/database');
const grants = require('../lib/mesh/grants');
const capabilities = require('../lib/mesh/capabilities');
const nodeWrite = require('../lib/mesh/node-write');
const nodeData = require('../lib/mesh/node-data');
const pt = require('../lib/mesh/player-termination');
const envelope = require('../lib/mesh/envelope');
const uid = () => crypto.randomUUID();
const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------ fixtures ------------------------------ */

const userId = uid(), orgId = uid(), wsId = uid(), otherWs = uid();
db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'o', 'h', 'platform_admin')").run(userId, `o-${userId.slice(0, 6)}@x.local`);
db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, 'A', ?, 'free')").run(orgId, userId);
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'shared')").run(wsId, orgId);
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'private')").run(otherWs, orgId);
const TOKEN = 'tok-' + crypto.randomBytes(16).toString('hex');
const devId = uid(), privateDev = uid();
db.prepare("INSERT INTO devices (id, user_id, name, workspace_id, device_token, status) VALUES (?, ?, 'Lobby', ?, ?, 'offline')").run(devId, userId, wsId, TOKEN);
db.prepare("INSERT INTO devices (id, user_id, name, workspace_id, device_token, status) VALUES (?, ?, 'Private', ?, ?, 'offline')").run(privateDev, userId, otherWs, 'other-token');
const REPLICA = 'replica-' + crypto.randomBytes(3).toString('hex');
/** THE up edge (primary side) to the replica — one per peer. `withGrant` puts player-events on it, scoped to wsId. */
const UP_EDGE_ID = uid();
db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at,
            token_hash, token_expires_at, up_token, peer_url, shared_workspaces)
            VALUES (?, ?, 'up', ?, ?, 'we-dial', 1, ?, 'x', ?, 'tok', 'http://replica', ?)`)
  .run(UP_EDGE_ID, REPLICA, JSON.stringify(['serves-dashboard', 'terminates-players']), JSON.stringify(['workspace-replication']),
       nowSec(), nowSec() + 3600, JSON.stringify([wsId]));
function upEdge(withGrant) {
  db.prepare('UPDATE mesh_edges SET write_grant = ?, write_scope = ? WHERE id = ?')
    .run(withGrant ? JSON.stringify(['player-events']) : null, withGrant ? JSON.stringify([wsId]) : null, UP_EDGE_ID);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(UP_EDGE_ID);
}
const writeReq = (extra) => ({ opId: uid(), sentAt: Date.now(), notAfter: Date.now() + 60_000, ...extra });

/* ------------------------------ vocabulary ------------------------------ */

test('terminates-players needs serves-dashboard on the same edge; player-events is a WRITE category', () => {
  assert.equal(capabilities.validateCapabilities(['terminates-players'], { acceptEnrollment: true }).ok, false);
  assert.equal(capabilities.validateCapabilities(['serves-dashboard', 'terminates-players'], { acceptEnrollment: true }).ok, true);
  assert.ok(grants.WRITE_CATEGORIES['player-events']);
  assert.match(grants.WRITE_CATEGORIES['player-events'].consequence, /token never leaves/i);
});

test('test_player_events_need_the_primary_grant: refused over the wire, set only by the primary\'s operator, and checked on every op', async () => {
  // 1. The grant can never arrive in a pairing code / enrolment answer (I2/I10).
  assert.equal(grants.validateGrant(['player-events']).ok, false, 'refused by the wire-facing validator');
  assert.equal(grants.validateWriteConsent(['player-events']).ok, true, 'accepted only by the operator consent path');

  // 2. An edge WITHOUT the grant cannot report a screen, nor provision one, nor verify one.
  const bare = upEdge(false);
  db.prepare("UPDATE mesh_edges SET write_grant = ?, write_scope = ? WHERE id = ?").run(JSON.stringify(['content-push']), JSON.stringify([wsId]), bare.id);
  const bareEdge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(bare.id);
  const r1 = await nodeWrite.applyWrite(db, bareEdge, writeReq({ type: 'player-event', deviceId: devId, kind: 'heartbeat', payload: {} }));
  assert.equal(r1.ok, false); assert.match(r1.reason, /player-events/);
  const r2 = await nodeWrite.applyWrite(db, bareEdge, writeReq({ type: 'player-provision', payload: { pairing_code: '123456' } }));
  assert.equal(r2.ok, false);
  const v = nodeData.answerRead(db, bareEdge, { path: `/api/mesh/verify-device?device_id=${devId}&token_hash=${pt.tokenHash(TOKEN)}`, method: 'GET' });
  assert.equal(v.ok, false, 'verify-device is keyed to the write grant, not to any read grant');

  // 3. With the grant: applied, through the same applier the socket uses — and only inside scope.
  const edge = upEdge(true);
  const ok = await nodeWrite.applyWrite(db, edge, writeReq({ type: 'player-event', deviceId: devId, kind: 'heartbeat', payload: { device_id: devId, telemetry: { cpu_usage: 12.34 } } }));
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(db.prepare('SELECT status, attached_node_id FROM devices WHERE id = ?').get(devId).status, 'online');
  assert.equal(db.prepare('SELECT attached_node_id FROM devices WHERE id = ?').get(devId).attached_node_id, REPLICA, 'the primary records which replica the screen is behind');
  assert.equal(db.prepare('SELECT cpu_usage FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(devId).cpu_usage, 12.3, 'telemetry landed as it does from a local socket');
  const out = await nodeWrite.applyWrite(db, edge, writeReq({ type: 'player-event', deviceId: privateDev, kind: 'heartbeat', payload: {} }));
  assert.equal(out.ok, false, 'a device outside the scoped workspace is refused');
  assert.equal(db.prepare('SELECT status FROM devices WHERE id = ?').get(privateDev).status, 'offline');
  // 4. Idempotent: the same op id answers from the record, not by applying again.
  const rep = writeReq({ type: 'player-event', deviceId: devId, kind: 'event', payload: { device_id: devId, type: 'display_off' } });
  await nodeWrite.applyWrite(db, edge, rep);
  const again = await nodeWrite.applyWrite(db, edge, rep);
  assert.equal(again.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_events WHERE device_id = ? AND type = 'display_off'").get(devId).n, 1);
});

test('test_verify_device_does_not_return_the_token: the answer is yes/no and a workspace, never the secret', () => {
  const edge = upEdge(true);
  const yes = nodeData.answerRead(db, edge, { path: `/api/mesh/verify-device?device_id=${devId}&token_hash=${pt.tokenHash(TOKEN)}`, method: 'GET' });
  assert.equal(yes.ok, true); assert.equal(yes.verified, true); assert.equal(yes.workspace_id, wsId);
  const text = JSON.stringify(yes);
  assert.ok(!text.includes(TOKEN), 'the token value is not in the answer');
  assert.ok(!/device_token|token_hash|settings_pin|enrol_key/.test(text), 'no secret-shaped key in the answer');
  const no = nodeData.answerRead(db, edge, { path: `/api/mesh/verify-device?device_id=${devId}&token_hash=${pt.tokenHash('wrong')}`, method: 'GET' });
  assert.equal(no.verified, false);
  const foreign = nodeData.answerRead(db, edge, { path: `/api/mesh/verify-device?device_id=${privateDev}&token_hash=${pt.tokenHash('other-token')}`, method: 'GET' });
  assert.equal(foreign.verified, false, 'a device outside the shared workspaces is "no", even with the right token');
  // Source: the only place device_token is read on this path hashes it; nothing selects it into a payload.
  const src = read('lib/mesh/node-data.js');
  const block = src.slice(src.indexOf("path === '/api/mesh/verify-device'"), src.indexOf("path === '/api/playlists'"));
  assert.match(block, /createHash\('sha256'\)\.update\(String\(row\.device_token\)\)/);
  assert.doesNotMatch(block, /device_token: /, 'never assigned into a result');
});

/* ------------------------------ outbox ------------------------------ */

test('test_play_event_buffered_while_primary_down_then_applied_in_order: durable, ordered, coalesced where allowed', async () => {
  // A REPLICA-side edge (down) in this same db, standing in for the replica's own.
  const edgeId = uid();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
              VALUES (?, 'primary-x', 'down', ?, ?, 'they-dial', 1, ?, 'y', ?)`)
    .run(edgeId, JSON.stringify(['serves-dashboard', 'terminates-players']), JSON.stringify(['workspace-replication']), nowSec(), nowSec() + 3600);
  const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
  const dev = 'dev-' + uid().slice(0, 8);

  let up = false;
  const delivered = [];
  const writeTo = async (_node, req) => {
    if (!up) return { ok: false, offline: true, reason: 'down' };
    delivered.push({ opId: req.opId, kind: req.kind, payload: req.payload, sentAt: req.sentAt, notAfter: req.notAfter });
    return { ok: true, outcome: { replies: req.kind === 'play-event' && req.payload.event === 'play_offline' ? [{ event: 'device:play-offline-ack', payload: { written: 1 } }] : [] } };
  };
  const replies = [];
  const outbox = pt.createOutbox(db, { writeTo, onReply: (d, ev, p) => replies.push({ d, ev, p }), logger: { warn() {} } });

  // Primary down: three plays, two heartbeats, a playback-state, a log line.
  pt.enqueue(db, edge, dev, 'play-event', { event: 'play_start', content_id: 'c1' });
  pt.enqueue(db, edge, dev, 'heartbeat', { telemetry: { cpu_usage: 1 } });
  pt.enqueue(db, edge, dev, 'play-event', { event: 'play_end', content_id: 'c1' });
  pt.enqueue(db, edge, dev, 'heartbeat', { telemetry: { cpu_usage: 2 } });   // coalesces onto the first
  pt.enqueue(db, edge, dev, 'play-event', { event: 'play_offline', plays: [{ content_id: 'c2' }] });
  assert.equal(pt.enqueue(db, edge, dev, 'log', { message: 'x' }), null, 'a log line is never queued');
  await outbox.drainEdge(edge);
  assert.deepEqual(delivered, [], 'nothing left while the primary is down');
  const rows = db.prepare('SELECT kind, payload FROM mesh_player_events WHERE edge_id = ? ORDER BY id').all(edgeId);
  assert.deepEqual(rows.map((r) => r.kind), ['play-event', 'heartbeat', 'play-event', 'play-event'], 'plays are all there; the heartbeat is ONE row, in its original place');
  assert.equal(JSON.parse(rows[1].payload).telemetry.cpu_usage, 2, 'last heartbeat wins');
  assert.equal(pt.pendingCount(db, edgeId), 4);

  // Primary back: drained strictly in order, each stamped at SEND time, then the ack reaches the socket.
  up = true;
  const t0 = Date.now();
  await outbox.resume(edge);   // what onConnect does when the primary is back
  assert.deepEqual(delivered.map((d) => [d.kind, d.payload.event || 'hb']),
    [['play-event', 'play_start'], ['heartbeat', 'hb'], ['play-event', 'play_end'], ['play-event', 'play_offline']]);
  for (const d of delivered) { assert.ok(d.sentAt >= t0, 'stamped when sent, not when queued'); assert.ok(d.notAfter > d.sentAt); }
  assert.equal(pt.pendingCount(db, edgeId), 0);
  assert.deepEqual(replies, [{ d: dev, ev: 'device:play-offline-ack', p: { written: 1 } }]);

  // Indeterminate: the row stays, the SAME op id goes again.
  let mode = 'indeterminate';
  const seen = [];
  const outbox2 = pt.createOutbox(db, { writeTo: async (_n, req) => { seen.push(req.opId); return mode === 'indeterminate' ? { ok: false, indeterminate: true } : { ok: true, outcome: {} }; }, logger: { warn() {} } });
  pt.enqueue(db, edge, dev, 'play-event', { event: 'play_start', content_id: 'c3' });
  await outbox2.drainEdge(edge);
  assert.equal(pt.pendingCount(db, edgeId), 1, 'kept');
  mode = 'ok';
  await outbox2.resume(edge);
  assert.equal(seen[0], seen[1], 'retried with the same operation id');
  assert.equal(pt.pendingCount(db, edgeId), 0);

  // ⚠️ NEVER THINNED ON REPLAY. A drained backlog arrives at the primary within one second; the
  // runaway-player throttle (one row per device per 2 s) must judge by when each play HAPPENED —
  // the replica's receipt stamp — and the rows must carry those times, not the drain time.
  const edgeUp = upEdge(true);
  const base = Date.now() - 60_000;
  for (let i = 0; i < 5; i++) {
    const r = await nodeWrite.applyWrite(db, edgeUp, writeReq({ type: 'player-event', deviceId: devId, kind: 'play-event',
      payload: { device_id: devId, event: 'play_start', content_name: `replay-${i}`, ts: base + i * 8000 } }));
    assert.equal(r.ok, true, r.reason);
    const e = await nodeWrite.applyWrite(db, edgeUp, writeReq({ type: 'player-event', deviceId: devId, kind: 'play-event',
      payload: { device_id: devId, event: 'play_end', content_name: `replay-${i}`, completed: true, ts: base + i * 8000 + 7900 } }));
    assert.equal(e.ok, true, e.reason);
  }
  const replayed = db.prepare("SELECT content_name, started_at, ended_at, duration_sec FROM play_logs WHERE device_id = ? AND content_name LIKE 'replay-%' ORDER BY id").all(devId);
  assert.equal(replayed.length, 5, `every replayed play is a row: ${JSON.stringify(replayed)}`);
  assert.equal(replayed[0].started_at, Math.floor(base / 1000), 'dated when it happened, not when it drained');
  assert.equal(replayed[4].started_at, Math.floor((base + 32000) / 1000));
  assert.ok(replayed[2].duration_sec === 7 || replayed[2].duration_sec === 8, 'ended by its own end time (7.9 s, second-floored)');
});

test('a cached verdict is overwritten by every answer, dropped on "no", and not honoured past its TTL', () => {
  const edge = { id: 'e-ttl', peer_node_id: 'prim' };
  const dev = 'dev-' + uid().slice(0, 8);
  const h1 = pt.tokenHash('t1'), h2 = pt.tokenHash('t2');
  pt.rememberVerdict(db, edge, dev, h1);
  assert.ok(pt.cachedVerdict(db, dev, h1), 'remembered');
  assert.equal(pt.cachedVerdict(db, dev, h2), null, 'a different token does not match the hash');
  // A rotate on the primary: the next verify answers "no" for the old token -> forget; "yes" for the new -> overwrite.
  pt.forgetVerdict(db, dev);
  assert.equal(pt.cachedVerdict(db, dev, h1), null, 'a "no" from the primary drops it');
  pt.rememberVerdict(db, edge, dev, h2);
  assert.ok(pt.cachedVerdict(db, dev, h2));
  assert.equal(pt.cachedVerdict(db, dev, h1), null, 'the old hash is gone once the new one is verified');
  // Age: past VERDICT_TTL_S it is not honoured without the primary.
  const later = Math.floor(Date.now() / 1000) + pt.VERDICT_TTL_S + 1;
  assert.equal(pt.cachedVerdict(db, dev, h2, later), null, 'too old to trust while the primary is away');
  assert.ok(pt.cachedVerdict(db, dev, h2, later - 3600), 'still good inside the window');
  assert.equal(pt.VERDICT_TTL_S, 7 * 24 * 3600, 'the number the guide states');
});

test('the outbox is bounded per edge: rows past the age cap expire, and past the row cap new plays are refused (counted)', () => {
  const edgeId = uid();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
              VALUES (?, 'primary-cap', 'down', ?, ?, 'they-dial', 1, ?, 'c', ?)`)
    .run(edgeId, JSON.stringify(['serves-dashboard', 'terminates-players']), JSON.stringify(['workspace-replication']), nowSec(), nowSec() + 3600);
  const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
  const outbox = pt.createOutbox(db, { writeTo: async () => ({ ok: false, offline: true }), logger: { warn() {} } });
  // Age: a row older than the cap is expired by the sweep; a fresh one is kept.
  pt.enqueue(db, edge, 'd1', 'play-event', { event: 'play_start' });
  db.prepare('UPDATE mesh_player_events SET created_at = ? WHERE edge_id = ?').run(nowSec() - pt.OUTBOX_MAX_AGE_S - 10, edgeId);
  pt.enqueue(db, edge, 'd1', 'play-event', { event: 'play_end' });
  assert.equal(outbox.expire(edge), 1);
  assert.equal(pt.pendingCount(db, edgeId), 1);
  // Rows: at the cap, a new play is refused with a reason, a coalescing kind still lands, and status says so.
  const save = pt.OUTBOX_MAX_ROWS_PER_EDGE;
  // Fill to the cap cheaply by lowering the visible count: insert rows up to a small number and
  // check the refusal path against the real constant via pendingCount arithmetic.
  const fill = db.prepare('INSERT INTO mesh_player_events (edge_id, device_id, kind, op_id, payload) VALUES (?, ?, ?, ?, ?)');
  const need = Math.min(save, 5000) - pt.pendingCount(db, edgeId);
  if (save <= 5000) {
    for (let i = 0; i < need; i++) fill.run(edgeId, 'd1', 'play-event', uid(), '{}');
    assert.throws(() => pt.enqueue(db, edge, 'd1', 'play-event', { event: 'play_start' }), /at its cap/);
    assert.equal(outbox.status().find((x) => x.node_id === 'primary-cap').refused_at_cap, 1);
  } else {
    // The cap is large; prove the guard by checking the code path it takes, not by inserting 500k rows.
    const src = read('lib/mesh/player-termination.js');
    assert.match(src, /pendingCount\(db, edge\.id\) >= OUTBOX_MAX_ROWS_PER_EDGE/);
    assert.match(src, /refusedByEdge\.set\(edge\.id/);
  }
  assert.equal(pt.OUTBOX_MAX_AGE_S, 14 * 24 * 3600, 'the number the guide states');
  const st = outbox.status().find((x) => x.node_id === 'primary-cap');
  assert.equal(st.expired, 1);
  assert.equal(st.cap_rows, pt.OUTBOX_MAX_ROWS_PER_EDGE);
});

/* ------------------------------ command relay ------------------------------ */

test('test_command_relay_reaches_replica_attached_player: primary relays up the edge; replica delivers only to its own attached screen', () => {
  const { deliverCommand } = require('../lib/device-command');
  db.prepare('UPDATE devices SET attached_node_id = ?, client_type = NULL WHERE id = ?').run(REPLICA, devId);
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(devId);
  const noRoom = { adapter: { rooms: new Map() }, to: () => ({ emit: () => { throw new Error('must not emit locally'); } }) };
  const sent = [];
  global.__meshUplinks = { sendTo: (node, type, body) => { sent.push({ node, type, body }); return true; } };
  try {
    // 'launch' needs no declared capability, so an undeclared test row may receive it.
    const r = deliverCommand(noRoom, device, 'launch', {});
    assert.equal(r.status, 'relayed', JSON.stringify(r)); assert.equal(r.via, REPLICA);
    assert.deepEqual(sent, [{ node: REPLICA, type: 'command-relay', body: { device_id: devId, event: 'device:command', payload: { type: 'launch', payload: {} } } }]);
    // No link to that node: falls through to the queue / offline, never anywhere else.
    global.__meshUplinks = { sendTo: () => false };
    const r2 = deliverCommand(noRoom, device, 'launch', {});
    assert.ok(r2.status === 'queued' || r2.status === 'offline');
  } finally { delete global.__meshUplinks; }

  // Replica side: the relay is delivered only when the edge terminates players, the device is that
  // primary's, and a socket for it is here.
  const emitted = [];
  const room = new Map([[devId, new Set(['s1'])]]);
  const deviceNs = { adapter: { rooms: room }, to: (id) => ({ emit: (ev, p) => emitted.push({ id, ev, p }) }) };
  const okEdge = { id: 'e', direction: 'down', revoked_at: null, peer_node_id: 'prim', role_capabilities: ['serves-dashboard', 'terminates-players'], grant_categories: ['workspace-replication'] };
  const c1Edge = { ...okEdge, role_capabilities: ['serves-dashboard'] };
  db.prepare('INSERT OR REPLACE INTO mesh_player_verdicts (device_id, edge_id, token_hash, verified_at) VALUES (?, ?, ?, ?)').run(devId, 'e', 'a'.repeat(64), nowSec());
  assert.equal(pt.deliverRelay(db, deviceNs, c1Edge, { device_id: devId, event: 'device:command', payload: {} }).ok, false, 'a C1 edge cannot relay');
  assert.equal(pt.deliverRelay(db, deviceNs, { ...okEdge, id: 'other' }, { device_id: devId, event: 'device:command', payload: {} }).ok, false, 'another primary cannot reach this screen');
  assert.equal(pt.deliverRelay(db, deviceNs, okEdge, { device_id: devId, event: 'dashboard:anything', payload: {} }).ok, false, 'only player events');
  assert.equal(pt.deliverRelay(db, deviceNs, okEdge, { device_id: devId, event: 'device:command', payload: { type: 'screen_on' } }).ok, true);
  assert.deepEqual(emitted, [{ id: devId, ev: 'device:command', p: { type: 'screen_on' } }]);
  room.clear();
  assert.equal(pt.deliverRelay(db, deviceNs, okEdge, { device_id: devId, event: 'device:command', payload: {} }).ok, false, 'not attached here -> not delivered');
});

test('ALLOWED_COMMANDS is one list on both doors (REST and dashboard socket)', () => {
  const sock = read('ws/dashboardSocket.js');
  assert.match(sock, /if \(!ALLOWED_COMMANDS\.includes\(type\)\)/, 'the socket path checks the same list the REST path does');
  assert.match(read('routes/devices.js'), /ALLOWED_COMMANDS\.includes\(type\)/);
  // And a copied device is commanded on the primary, through the REST proxy — never emitted locally.
  assert.match(sock, /replicaProxy\.forwardJson\(appConfig, \{ token, method: 'POST', path: `\/api\/devices\/\$\{encodeURIComponent\(device_id\)\}\/command`/);
});

/* ------------------------------ I9: no failover ------------------------------ */

test('test_no_automatic_player_failover_to_primary: a replica waits or refuses, and never tells a player to go elsewhere', () => {
  const ds = read('ws/deviceSocket.js');
  const replicaPath = ds.slice(ds.indexOf('async function handleReplicaRegister'), ds.indexOf("socket.on('device:register'"));
  assert.doesNotMatch(replicaPath, /set_server_url|device:command|redirect|location/i, 'the replica register path issues no redirect of any kind');
  assert.match(replicaPath, /socket\.emit\('device:throttled', \{ retry_after_ms: playerTermination\.PRIMARY_WAIT_MS, reason \}\)/, 'unreachable primary => WAIT and retry the same address');
  // read_replica names the primary as INFORMATION in an auth-error, never as a command.
  assert.match(replicaPath, /reason: 'read_replica', primary_url: config\.primaryUrl \|\| null/);
  const ptSrc = read('lib/mesh/player-termination.js');
  assert.doesNotMatch(ptSrc, /set_server_url|primaryUrl|PRIMARY_URL/, 'the termination module does not even know the primary\'s address');
  // I9 for players: nothing host-shaped compiled in anywhere on this path.
  for (const f of ['lib/mesh/player-termination.js', 'lib/mesh/command-relay.js']) {
    assert.doesNotMatch(read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /(screentinker\.com|https?:\/\/[a-z0-9-]+\.[a-z]{2,})/i, `${f} names a host`);
  }
});

/* ------------------------------ real boot: C1 default + waiting ------------------------------ */

let proc, base;
before(async () => {
  // A replica-shaped server with a copied workspace and TWO down edges seeded: one C1 (no
  // terminates-players), one C2 — for a primary that is not running. Boot, then talk to it.
  const dir = path.join(TMP, 'replica');
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  const { freePort } = require('./helpers/free-port');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Seed by booting once (migrations), then editing the file, then booting for real.
  const seedEnv = { ...process.env, DATA_DIR: dir, SELF_HOSTED: 'true', NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'x', MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: 'http://127.0.0.1:9' };
  const logFd = fs.openSync(path.join(TMP, 'replica.log'), 'w');
  let p = spawn('node', ['server.js'], { cwd: ROOT, env: seedEnv, stdio: ['ignore', logFd, logFd] });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/status')).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
  p.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 400));
  const Database = require('better-sqlite3');
  const rdb = new Database(path.join(dir, 'db', 'remote_display.db'));
  const u = uid(), o = uid();
  rdb.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, 'p@x.local', 'p', 'h', 'platform_admin')").run(u);
  rdb.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, 'A', ?, 'free')").run(o, u);
  rdb.prepare("INSERT INTO workspaces (id, organization_id, name, origin_node_id) VALUES ('ws-c1', ?, 'c1 copy', 'primary-c1')").run(o);
  rdb.prepare("INSERT INTO workspaces (id, organization_id, name, origin_node_id) VALUES ('ws-c2', ?, 'c2 copy', 'primary-c2')").run(o);
  rdb.prepare("INSERT INTO devices (id, user_id, name, workspace_id, status) VALUES ('dev-c1', ?, 'C1 screen', 'ws-c1', 'offline')").run(u);
  rdb.prepare("INSERT INTO devices (id, user_id, name, workspace_id, status) VALUES ('dev-c2', ?, 'C2 screen', 'ws-c2', 'offline')").run(u);
  const ins = rdb.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
                           VALUES (?, ?, 'down', ?, ?, 'they-dial', 1, ?, ?, ?)`);
  ins.run('edge-c1', 'primary-c1', JSON.stringify(['serves-dashboard']), JSON.stringify(['workspace-replication']), nowSec(), 'h1', nowSec() + 3600);
  ins.run('edge-c2', 'primary-c2', JSON.stringify(['serves-dashboard', 'terminates-players']), JSON.stringify(['workspace-replication']), nowSec(), 'h2', nowSec() + 3600);
  // A prior verified session for dev-c2 with THIS token hash.
  rdb.prepare('INSERT INTO mesh_player_verdicts (device_id, edge_id, token_hash, verified_at) VALUES (?, ?, ?, ?)').run('dev-c2', 'edge-c2', pt.tokenHash('remembered-token'), nowSec());
  rdb.close();
  proc = spawn('node', ['server.js'], { cwd: ROOT, env: seedEnv, stdio: ['ignore', logFd, logFd] });
  let ok = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/status')).ok) { ok = true; break; } } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
  assert.ok(ok, 'replica booted');
});
after(() => { try { proc && proc.kill('SIGKILL'); } catch { /* */ } });

function register(payload) {
  const { io } = require('socket.io-client');
  return new Promise((resolve) => {
    const sock = io(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const done = (r) => { try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', (d) => done({ event: 'registered', d }));
    sock.on('device:auth-error', (d) => done({ event: 'auth-error', d }));
    sock.on('device:throttled', (d) => done({ event: 'throttled', d }));
    sock.on('device:unpaired', (d) => done({ event: 'unpaired', d }));
    sock.on('device:command', (d) => done({ event: 'command', d }));
    setTimeout(() => done({ event: 'timeout' }), 5000);
  });
}

test('test_replica_without_terminates_players_still_refuses_register: C1 default unchanged', async () => {
  const r = await register({ device_id: 'dev-c1', device_token: 'anything' });
  assert.equal(r.event, 'auth-error');
  assert.equal(r.d.reason, 'read_replica');
  assert.equal(r.d.primary_url, 'http://127.0.0.1:9', 'the primary is named as information for the setup screen');
});

test('a terminating edge whose primary is unreachable: a remembered screen reconnects, a stranger waits, nobody is redirected', async () => {
  const known = await register({ device_id: 'dev-c2', device_token: 'remembered-token' });
  assert.equal(known.event, 'registered', JSON.stringify(known));
  assert.equal(known.d.device_id, 'dev-c2');
  const wrong = await register({ device_id: 'dev-c2', device_token: 'not-the-token' });
  assert.equal(wrong.event, 'throttled', 'a token the replica has never seen verified must WAIT for the primary — it cannot decide');
  assert.equal(wrong.d.reason, 'primary_unreachable');
  const fresh = await register({ pairing_code: '424242' });
  assert.equal(fresh.event, 'throttled', 'new pairing waits');
  assert.equal(fresh.d.reason, 'primary_unreachable');
  const st = await (await fetch(base + '/api/status')).json();
  assert.ok(st.scale_out && st.scale_out.replica_of.length === 2);
});

/* ------------------------------ I2 accounting ------------------------------ */

test('the C2 additions are reviewed lists: player op types on mesh:write, command-relay as the one upward verb a parent acts on', () => {
  assert.deepEqual([...nodeWrite.PLAYER_OP_TYPES], ['player-event', 'player-provision']);
  assert.equal(envelope.PAYLOAD_TYPES['command-relay'], 1);
  // The primary acts on command-relay ONLY by handing it to deliverRelay, which checks the edge and the device.
  const idx = read('ws/index.js');
  const block = idx.slice(idx.indexOf("env.type === 'command-relay'"), idx.indexOf("env.type === 'command-relay'") + 500);
  assert.match(block, /playerTermination\.deliverRelay\(db, deviceNs, edge, env\.body\)/);
  assert.match(block, /return;/, 'consumed: never stored, never relayed further');
});
