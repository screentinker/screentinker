'use strict';

/*
 * The replica ends it (follow-up to #398). DELETE /api/mesh/links/:nodeId on the node HOLDING the
 * copy — the parent-side disenroll that lib/mesh/edge-status.js has carried since Phase 2 and that
 * nothing mounted. Two real processes:
 *   - the replica's operator disconnects the primary;
 *   - the primary's live socket is dropped and its next connection is refused at the door — the
 *     primary SEES the edge dead (scale_out.replicas[].link);
 *   - media cached for that edge is gone; copied rows stay (retain-and-mark-stale, as the child's
 *     own revoke does);
 *   - new screens are refused with read_replica; the screen already attached keeps playing;
 *   - the replica loop stops pulling: a change on the primary no longer arrives.
 * Plus: a stock node has no such route; a node with the hub mounted answers 404 for an unknown
 * node and 409 for one already disconnected.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-disc-'));
const PW = 'Passw0rd123';
const JWT = 'disc-' + Math.random().toString(36).slice(2);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o, extra = {}) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extra }, body: o ? JSON.stringify(o) : undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = {};
async function boot(name, extraEnv) {
  const port = await freePort();
  const dataDir = path.join(TMP, name);
  const logFd = fs.openSync(path.join(TMP, `${name}.log`), 'a');
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', JWT_SECRET: JWT, SELF_HOSTED: 'true', ...extraEnv };
  for (const k of ['MESH_ACCEPT_ENROLLMENT', 'MESH_ALLOW_UPLINK', 'PRIMARY_URL', 'REPLICA_CACHE_BYTES']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error(`${name} did not boot`);
  servers[name] = { name, proc, base, port, dataDir, dbPath: path.join(dataDir, 'db', 'remote_display.db'), contentDir: path.join(dataDir, 'uploads', 'content') };
  return servers[name];
}
async function register(s, email) { const r = await (await fetch(s.base + '/api/auth/register', jsonPost({ email, password: PW }))).json(); assert.ok(r.token); return r.token; }
async function waitFor(fn, { tries = 120, every = 500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
const scaleOut = async (s) => (await (await fetch(s.base + '/api/status')).json()).scale_out;
function openPlayer(base) {
  const sock = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  const box = {};
  for (const ev of ['device:registered', 'device:auth-error', 'device:throttled', 'device:paired', 'device:playlist-update', 'device:heartbeat-ack']) sock.on(ev, (d) => { (box[ev] = box[ev] || []).push(d); });
  const next = (ev, ms = 8000) => new Promise((resolve, reject) => {
    const start = (box[ev] || []).length; const t0 = Date.now();
    const tick = () => { if ((box[ev] || []).length > start) return resolve(box[ev][box[ev].length - 1]); if (Date.now() - t0 > ms) return reject(new Error(`no ${ev}`)); setTimeout(tick, 25); };
    tick();
  });
  const connected = new Promise((r) => sock.on('connect', r));
  return { sock, box, next, connected, close: () => { try { sock.close(); } catch { /* */ } } };
}

let primary, replica, primaryAdmin, replicaAdmin, primaryWs, primaryNodeId, player, deviceId, deviceToken, slide;

before(async () => {
  [primary, replica] = await Promise.all([boot('primary', { MESH_ALLOW_UPLINK: 'true' }), boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true' })]);
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  replica.proc.kill('SIGKILL'); await sleep(300);
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base });
  primaryWs = (await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json()).current_workspace_id;
  const code = await (await fetch(replica.base + '/api/mesh/pair/code', auth(replicaAdmin, 'POST', { capabilities: ['serves-dashboard', 'terminates-players', 'caches-content', 'consumes-telemetry'], grant: ['workspace-replication'] }))).json();
  const link = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin, 'POST', { parentUrl: replica.base, code: code.code, workspaceIds: [primaryWs], tlsVerify: false }))).json();
  assert.ok(!link.error, JSON.stringify(link));
  const st = await waitFor(async () => { const so = await scaleOut(replica); const r = so && so.replica_of && so.replica_of[0]; return r && r.workspaces > 0 && r.lag_s != null ? r : null; }, { what: 'snapshot' });
  primaryNodeId = st.node_id;
  const ups = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin))).json();
  await fetch(primary.base + `/api/mesh/uplink/${ups.uplinks[0].edgeId}/write-grant`, auth(primaryAdmin, 'PUT', { categories: ['player-events'], workspaces: [primaryWs] }));
  // A screen attached to the replica, and a slide cached there.
  player = openPlayer(replica.base); await player.connected;
  player.sock.emit('device:register', { pairing_code: '515151', device_info: { app_version: 'disc' } });
  const reg = await player.next('device:registered'); deviceId = reg.device_id; deviceToken = reg.device_token;
  const pairedP = player.next('device:paired', 10000);
  assert.equal((await fetch(primary.base + '/api/provision/pair', auth(primaryAdmin, 'POST', { pairing_code: '515151', name: 'Disc screen' }, { 'x-workspace-id': primaryWs }))).status, 200);
  await pairedP;
  const form = new FormData(); form.append('files', new Blob([PNG], { type: 'image/png' }), 'slide.png');
  const up = await fetch(primary.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + primaryAdmin, 'x-workspace-id': primaryWs }, body: form });
  slide = JSON.parse(await up.text());
  await waitFor(async () => (await fetch(replica.base + `/api/content/${slide.id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).status === 200, { what: 'row' });
  assert.equal((await fetch(replica.base + '/uploads/content/' + path.basename(slide.filepath))).status, 200);
  await waitFor(async () => fs.existsSync(path.join(replica.contentDir, path.basename(slide.filepath))), { what: 'cached' });
});
after(() => { try { player && player.close(); } catch { /* */ } for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

test('the route exists only where the hub is mounted; unknown node 404; the child\'s own side is untouched', async () => {
  const stock = await boot('stock', {});
  try {
    assert.equal((await fetch(stock.base + '/api/mesh/links/anything', auth(replicaAdmin, 'DELETE'))).status, 404, 'no hub, no route');
  } finally { stock.proc.kill('SIGKILL'); }
  const r = await fetch(replica.base + '/api/mesh/links/not-a-node', auth(replicaAdmin, 'DELETE'));
  assert.equal(r.status, 404);
  assert.equal((await fetch(primary.base + '/api/mesh/links/' + primaryNodeId, auth(primaryAdmin, 'DELETE'))).status, 404, 'the primary has no hub mounted');
});

test('the replica disconnects the primary: edge revoked here, live socket dropped, primary refused at its next connection', async () => {
  const r = await fetch(replica.base + `/api/mesh/links/${primaryNodeId}`, auth(replicaAdmin, 'DELETE', { reason: 'copy no longer wanted' }));
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.ok(body.filesDropped >= 1, 'media cached for that edge was removed: ' + JSON.stringify(body));
  assert.equal(body.copiedWorkspacesRetained, 1);
  assert.match(body.summary, /kept and marked stale/);
  const rdb = new Database(replica.dbPath, { readonly: true });
  const e = rdb.prepare("SELECT revoked_at, token_hash FROM mesh_edges WHERE peer_node_id = ? AND direction = 'down'").get(primaryNodeId);
  assert.ok(e.revoked_at); assert.equal(e.token_hash, null);
  rdb.close();
  // The primary sees it: its uplink is refused at the door on reconnect.
  const dead = await waitFor(async () => {
    const so = await scaleOut(primary);
    const rep = so && so.replicas && so.replicas.find((x) => x.node_id !== undefined);
    return rep && rep.link && rep.link.connected === false && rep.link.last_error ? rep.link : null;
  }, { what: 'primary to see the edge dead', tries: 80 });
  assert.match(dead.last_error, /no longer authorised|revoked/i, JSON.stringify(dead));
  // Twice is a 409, not a second revoke.
  assert.equal((await fetch(replica.base + `/api/mesh/links/${primaryNodeId}`, auth(replicaAdmin, 'DELETE'))).status, 409);
});

test('after the disconnect: files gone, rows stay, new screens refused, the attached screen keeps playing, pulling has stopped', async () => {
  const name = path.basename(slide.filepath);
  assert.ok(!fs.existsSync(path.join(replica.contentDir, name)), 'cached file gone');
  const rdb = new Database(replica.dbPath, { readonly: true });
  assert.equal(rdb.prepare('SELECT COUNT(*) AS n FROM content WHERE workspace_id = ?').get(primaryWs).n, 1, 'copied rows stay');
  assert.equal(rdb.prepare('SELECT COUNT(*) AS n FROM mesh_content_cache').get().n, 0);
  assert.ok(rdb.prepare('SELECT origin_node_id FROM workspaces WHERE id = ?').get(primaryWs).origin_node_id, 'still a copy, just stale');
  rdb.close();
  // The dashboard still reads the copy (retain-and-mark-stale); the file it cached is no longer served here.
  assert.equal((await fetch(replica.base + `/api/content/${slide.id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).status, 200);
  assert.equal(await scaleOut(replica), undefined, 'no scale_out block: the edge no longer makes this node a replica');
  // The attached screen keeps playing; a new register is C1's answer.
  const ackP = player.next('device:heartbeat-ack');
  player.sock.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now() });
  await ackP;
  const p2 = openPlayer(replica.base); await p2.connected;
  p2.sock.emit('device:register', { device_id: deviceId, device_token: deviceToken });
  const refused = await p2.next('device:auth-error');
  assert.equal(refused.reason, 'read_replica'); p2.close();
  // Pulling has stopped: a rename on the primary never arrives.
  const ren = await fetch(primary.base + `/api/content/${slide.id}`, auth(primaryAdmin, 'PUT', { filename: 'renamed-after-disconnect.png' }, { 'x-workspace-id': primaryWs }));
  assert.ok(ren.status < 300, await ren.text());
  await sleep(4000);
  const row = await (await fetch(replica.base + `/api/content/${slide.id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).json();
  assert.notEqual(row.filename, 'renamed-after-disconnect.png', 'stale, as documented — no further data is shared');
});
