'use strict';

/*
 * Scale-out C2 end to end, on TWO REAL PROCESSES plus a real socket.io player
 * (docs/scale-out-design.md §6, §7; docs/scale-out.md "Players on a replica").
 *
 *   1. pair: replica mints serves-dashboard + terminates-players; primary redeems; the PRIMARY's
 *      operator sets the player-events write grant on the primary;
 *   2. a player pairs TO THE REPLICA: provisioned on the primary, claimed on the primary, and the
 *      player learns it is paired through a command-relay;
 *   3. a playlist published on the primary reaches the player FROM THE REPLICA's mirror;
 *   4. the player's heartbeat and play events land in the PRIMARY's tables through the outbox;
 *   5. the primary is killed: the player keeps its socket, its heartbeats are acked by the
 *      replica, a reconnect is accepted on the cached verdict, its play events queue;
 *   6. the primary returns: the queue drains in order and play_logs gain the rows;
 *   7. a command issued on the primary — and one issued on the replica's dashboard, which goes
 *      REST -> proxy -> primary — reaches the player through the relay.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { io: ioClient } = require('socket.io-client');

const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-c2-e2e-'));
const PW = 'Passw0rd123';
const JWT = 'shared-' + Math.random().toString(36).slice(2);
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o, extra = {}) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extra }, body: o ? JSON.stringify(o) : undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = {};
async function boot(name, extraEnv, { port } = {}) {
  port = port || await freePort();
  const dataDir = path.join(TMP, name);
  const logFd = fs.openSync(path.join(TMP, `${name}.log`), 'a');
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', JWT_SECRET: JWT, SELF_HOSTED: 'true', ...extraEnv };
  for (const k of ['MESH_ACCEPT_ENROLLMENT', 'MESH_ALLOW_UPLINK', 'PRIMARY_URL', 'PRIMARY_REDIRECT']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error(`${name} did not boot; see ${path.join(TMP, `${name}.log`)}`);
  servers[name] = { name, proc, base, port, dataDir, env, dbPath: path.join(dataDir, 'db', 'remote_display.db') };
  return servers[name];
}
async function register(s, email) {
  const r = await (await fetch(s.base + '/api/auth/register', jsonPost({ email, password: PW }))).json();
  assert.ok(r.token, `${s.name}: register ${email}: ${JSON.stringify(r)}`);
  return r.token;
}
async function waitFor(fn, { tries = 120, every = 500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
/** A real player: one socket to the replica, with a mailbox per event. */
function openPlayer(base) {
  const sock = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  const box = {};
  const waiters = {};
  const push = (ev, d) => { (box[ev] = box[ev] || []).push(d); (waiters[ev] || []).splice(0).forEach((r) => r(d)); };
  for (const ev of ['device:registered', 'device:auth-error', 'device:throttled', 'device:paired', 'device:playlist-update', 'device:command', 'device:heartbeat-ack', 'device:play-offline-ack', 'device:unpaired']) {
    sock.on(ev, (d) => push(ev, d));
  }
  const next = (ev, ms = 8000) => new Promise((resolve, reject) => {
    (waiters[ev] = waiters[ev] || []).push(resolve);
    setTimeout(() => reject(new Error(`no ${ev} within ${ms}ms; got ${JSON.stringify(Object.keys(box))}`)), ms);
  });
  const connected = new Promise((r) => sock.on('connect', r));
  return { sock, box, next, connected, close: () => { try { sock.close(); } catch { /* */ } } };
}

let primary, replica, primaryAdmin, replicaAdmin, primaryWs, primaryNodeId, replicaNodeId, primaryPort;

before(async () => {
  [primary, replica] = await Promise.all([
    boot('primary', { MESH_ALLOW_UPLINK: 'true' }),
    boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true' }),
  ]);
  primaryPort = primary.port;
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  replica.proc.kill('SIGKILL'); await sleep(300);
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base });
  const me = await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json();
  primaryWs = me.current_workspace_id;
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

test('pair with terminates-players; the PRIMARY operator grants player-events', async () => {
  const code = await (await fetch(replica.base + '/api/mesh/pair/code', auth(replicaAdmin, 'POST', {
    capabilities: ['serves-dashboard', 'terminates-players', 'consumes-telemetry'], grant: ['workspace-replication'],
  }))).json();
  assert.ok(code.code, JSON.stringify(code));
  replicaNodeId = code.nodeId;
  const link = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin, 'POST', {
    parentUrl: replica.base, code: code.code, workspaceIds: [primaryWs], tlsVerify: false,
  }))).json();
  assert.ok(!link.error, JSON.stringify(link));
  const st = await waitFor(async () => {
    const s = await (await fetch(replica.base + '/api/status')).json();
    const r = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return r && r.workspaces > 0 && r.lag_s != null ? r : null;
  }, { what: 'snapshot' });
  primaryNodeId = st.node_id;
  // The write grant is set on the PRIMARY, by the primary's operator. Nothing on the wire could.
  const ups = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin))).json();
  const edgeId = ups.uplinks[0].edgeId;
  const g = await fetch(primary.base + `/api/mesh/uplink/${edgeId}/write-grant`, auth(primaryAdmin, 'PUT', { categories: ['player-events'], workspaces: [primaryWs] }));
  assert.equal(g.status, 200, await g.text());
});

let player, deviceId, deviceToken;
const CODE = '777777';

test('a NEW screen pairs to the replica: provisioned on the primary, claimed on the primary, told through the relay', async () => {
  player = openPlayer(replica.base);
  await player.connected;
  player.sock.emit('device:register', { pairing_code: CODE, device_info: { app_version: 'e2e-player' }, client_type: 'player', client_version: '1' });
  const reg = await player.next('device:registered');
  assert.equal(reg.status, 'provisioning');
  deviceId = reg.device_id; deviceToken = reg.device_token;
  assert.ok(deviceId && deviceToken);
  // The row is on the primary (with the token) and NOT on the replica (the token is nowhere here).
  const pdb = new Database(primary.dbPath, { readonly: true });
  const prow = pdb.prepare('SELECT device_token, attached_node_id, pairing_code FROM devices WHERE id = ?').get(deviceId);
  pdb.close();
  assert.equal(prow.device_token, deviceToken);
  assert.equal(prow.attached_node_id, replicaNodeId);
  const rdb = new Database(replica.dbPath, { readonly: true });
  assert.equal(rdb.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId), undefined, 'no row on the replica yet');
  assert.equal(rdb.prepare('SELECT token_hash FROM mesh_player_verdicts WHERE device_id = ?').get(deviceId).token_hash.length, 64, 'only a hash is remembered');
  assert.ok(!fs.readFileSync(replica.dbPath).includes(deviceToken), 'the token is not in the replica database file');
  rdb.close();

  // The operator claims it — on the primary (the replica's dashboard would proxy here anyway).
  const pairedP = player.next('device:paired', 10000);
  const claim = await fetch(primary.base + '/api/provision/pair', auth(primaryAdmin, 'POST', { pairing_code: CODE, name: 'Replica screen' }, { 'x-workspace-id': primaryWs }));
  assert.equal(claim.status, 200, await claim.text());
  const paired = await pairedP;
  assert.equal(paired.device_id, deviceId);
  assert.equal(paired.name, 'Replica screen');
  // ...and the row replicates to the replica as a copied device.
  await waitFor(async () => {
    const r = new Database(replica.dbPath, { readonly: true });
    const row = r.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId); r.close();
    return row && row.workspace_id === primaryWs;
  }, { what: 'device row to replicate' });
});

let contentId;
test('publish on the primary; the player receives the playlist from the replica mirror', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('files', new Blob([png], { type: 'image/png' }), 'slide.png');
  const up = await fetch(primary.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + primaryAdmin, 'x-workspace-id': primaryWs }, body: form });
  const upText = await up.text(); assert.equal(up.status, 201, upText);
  contentId = JSON.parse(upText).id;
  const pl = await (await fetch(primary.base + '/api/playlists', auth(primaryAdmin, 'POST', { name: 'Lobby loop' }, { 'x-workspace-id': primaryWs }))).json();
  assert.ok(pl.id, JSON.stringify(pl));
  const it = await fetch(primary.base + `/api/playlists/${pl.id}/items`, auth(primaryAdmin, 'POST', { content_id: contentId, duration_sec: 5 }, { 'x-workspace-id': primaryWs }));
  assert.ok(it.status < 300, await it.text());
  const updP = player.next('device:playlist-update', 20000);
  const asg = await fetch(primary.base + `/api/playlists/${pl.id}/assign`, auth(primaryAdmin, 'POST', { device_id: deviceId }, { 'x-workspace-id': primaryWs }));
  assert.ok(asg.status < 300, await asg.text());
  const pub = await fetch(primary.base + `/api/playlists/${pl.id}/publish`, auth(primaryAdmin, 'POST', {}, { 'x-workspace-id': primaryWs }));
  assert.ok(pub.status < 300, await pub.text());
  // Keep waiting until an update carries the content — the first one may be the pre-publish push.
  let payload = await updP;
  for (let i = 0; i < 6 && !JSON.stringify(payload).includes(contentId); i++) payload = await player.next('device:playlist-update', 20000);
  assert.ok(JSON.stringify(payload).includes(contentId), 'the mirror served the published item');
  // And the bytes: the player builds /uploads/content/<filepath> from the item, exactly as it does
  // against its own server, and the replica fetches it through from the primary (no cache in C2).
  const fp = JSON.stringify(payload).match(/"filepath":"([^"]+)"/);
  assert.ok(fp, 'payload carries the item filepath');
  const media = await fetch(replica.base + '/uploads/content/' + path.basename(fp[1]));
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('x-st-served-by'), 'primary');
});

test('the player\'s events land on the primary through the outbox', async () => {
  const ackP = player.next('device:heartbeat-ack');
  player.sock.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now(), telemetry: { cpu_usage: 42.4, storage_free_mb: 100, storage_total_mb: 1000 } });
  await ackP;
  player.sock.emit('device:play-event', { device_id: deviceId, event: 'play_start', content_id: contentId, content_name: 'slide.png', duration_sec: 5 });
  await waitFor(async () => {
    const p = new Database(primary.dbPath, { readonly: true });
    const n = p.prepare('SELECT COUNT(*) AS n FROM play_logs WHERE device_id = ?').get(deviceId).n;
    const t = p.prepare('SELECT cpu_usage FROM device_telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(deviceId);
    const d = p.prepare('SELECT status, attached_node_id FROM devices WHERE id = ?').get(deviceId);
    p.close();
    return n >= 1 && t && t.cpu_usage === 42.4 && d.status === 'online' && d.attached_node_id === replicaNodeId;
  }, { what: 'play_logs + telemetry on the primary' });
  const r = new Database(replica.dbPath, { readonly: true });
  assert.equal(r.prepare('SELECT COUNT(*) AS n FROM play_logs WHERE device_id = ?').get(deviceId).n, 0, 'no play_logs on the replica: events go to the primary, they are not copied');
  r.close();
});

test('primary killed: playback continues, heartbeats are acked by the replica, a reconnect is accepted, events queue', async () => {
  primary.proc.kill('SIGKILL');
  await sleep(1500);
  const ackP = player.next('device:heartbeat-ack');
  player.sock.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now(), telemetry: { cpu_usage: 7 } });
  await ackP;
  player.sock.emit('device:play-event', { device_id: deviceId, event: 'play_end', content_id: contentId, completed: true });
  player.sock.emit('device:play-event', { device_id: deviceId, event: 'play_start', content_id: contentId, content_name: 'slide.png', duration_sec: 5 });
  // A heartbeat ack after the plays proves they were received (one socket, in order) before the
  // socket is closed — closing straight after an emit can drop the packet on the client side.
  const ack2 = player.next('device:heartbeat-ack');
  player.sock.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now() });
  await ack2;
  // Reconnect (a reboot, say): accepted on the cached verdict, playlist still served from the mirror.
  player.close();
  player = openPlayer(replica.base);
  await player.connected;
  player.sock.emit('device:register', { device_id: deviceId, device_token: deviceToken, device_info: { app_version: 'e2e-player' } });
  const reg = await player.next('device:registered');
  assert.equal(reg.device_id, deviceId);
  const pl = await player.next('device:playlist-update');
  assert.ok(JSON.stringify(pl).includes(contentId), 'the mirror still serves the playlist with the primary gone');
  const st = await (await fetch(replica.base + '/api/status')).json();
  const r = st.scale_out.replica_of.find((x) => x.node_id === primaryNodeId);
  assert.ok(r.players && r.players.pending >= 2, `events are queued: ${JSON.stringify(r.players)}`);
  await waitFor(async () => {
    const s2 = await (await fetch(replica.base + '/api/status')).json();
    const x = s2.scale_out.replica_of.find((y) => y.node_id === primaryNodeId);
    return x.edge === 'down' && x.lag_s === null;
  }, { what: 'edge down + lag unknown', tries: 60 });
  // A stranger cannot get in while the primary is away — it must wait, and nothing redirects it.
  const stranger = openPlayer(replica.base);
  await stranger.connected;
  stranger.sock.emit('device:register', { device_id: deviceId, device_token: 'wrong-token' });
  const t = await stranger.next('device:throttled');
  assert.equal(t.reason, 'primary_unreachable');
  assert.equal(stranger.box['device:command'], undefined);
  stranger.close();
});

test('primary returns: the queue drains in order and play_logs gain the rows; commands relay both ways', async () => {
  primary = await boot('primary', { MESH_ALLOW_UPLINK: 'true' }, { port: primaryPort });
  await waitFor(async () => {
    const st = await (await fetch(replica.base + '/api/status')).json();
    const r = st.scale_out.replica_of.find((x) => x.node_id === primaryNodeId);
    return r && r.edge === 'up' && r.players && r.players.pending === 0;
  }, { what: 'outbox to drain', tries: 120 });
  const p = new Database(primary.dbPath, { readonly: true });
  const rows = p.prepare('SELECT content_id, ended_at, completed FROM play_logs WHERE device_id = ? ORDER BY id').all(deviceId);
  assert.ok(rows.length >= 2, `play_logs has the queued plays: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].completed, 1, 'the play_end that was queued closed the first play, in order');
  assert.equal(p.prepare('SELECT attached_node_id FROM devices WHERE id = ?').get(deviceId).attached_node_id, replicaNodeId);
  p.close();

  // A command from the primary's own dashboard/API: no local socket -> relayed up the edge.
  const cmdP = player.next('device:command');
  const c = await (await fetch(primary.base + `/api/devices/${deviceId}/command`, auth(primaryAdmin, 'POST', { type: 'launch' }, { 'x-workspace-id': primaryWs }))).json();
  assert.equal(c.status, 'relayed', JSON.stringify(c));
  assert.equal((await cmdP).type, 'launch');
  // A command from the REPLICA's dashboard: REST -> proxy -> primary -> relay. Never emitted locally.
  const cmdP2 = player.next('device:command');
  const c2 = await fetch(replica.base + `/api/devices/${deviceId}/command`, auth(primaryAdmin, 'POST', { type: 'set_volume', payload: { level: 3 } }, { 'x-workspace-id': primaryWs }));
  assert.equal(c2.headers.get('x-st-served-by'), 'primary');
  assert.equal((await c2.json()).status, 'relayed');
  const got = await cmdP2;
  assert.equal(got.type, 'set_volume'); assert.deepEqual(got.payload, { level: 3 });
  player.close();
});
