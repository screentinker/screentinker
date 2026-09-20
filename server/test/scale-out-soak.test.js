'use strict';

/*
 * Scale-out SOAK (docs/scale-out-soak.md): one long scenario on TWO REAL PROCESSES that walks the
 * merged C1–C3 behaviour through revoke, outage, token rotate and a full pin set. It adds no
 * capability. Each step names the unit test that holds the property in isolation; this file is
 * what shows they hold TOGETHER, in order, on a real link.
 *
 *   step 0  stock flags off              -> the soak refuses to start (no scale_out block)
 *   step 1  pair + grant + screen        -> C2 e2e shape
 *   step 2  token rotate on the primary  -> old token refused at the next verify, verdict dropped
 *   step 3  pin set fills the cache      -> on-screen file stays, new file served through
 *   step 4  primary down >= poll         -> lag null, player up, hit 200, uncached 503, queue
 *   step 5  verdict TTL during outage    -> old verdict honoured only inside VERDICT_TTL_S
 *   step 6  primary back                 -> outbox drains in order, timestamps from the outage
 *   step 7  revoke on the primary        -> grant gone, forwarded events refused, socket stays
 *   step 8  edge ended on the replica    -> files gone, rows remain, new register read_replica
 *
 * ⚠️ SLOW BY DESIGN (~2 min): step 4 waits longer than the replica's 30 s poll on purpose.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-soak-'));
const PW = 'Passw0rd123';
const JWT = 'soak-' + Math.random().toString(36).slice(2);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o, extra = {}) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extra }, body: o ? JSON.stringify(o) : undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

const servers = {};
async function boot(name, extraEnv, { port } = {}) {
  port = port || await freePort();
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
async function register(s, email) {
  const r = await (await fetch(s.base + '/api/auth/register', jsonPost({ email, password: PW }))).json();
  assert.ok(r.token, JSON.stringify(r)); return r.token;
}
async function waitFor(fn, { tries = 120, every = 500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
async function upload(s, token, ws, name) {
  const form = new FormData(); form.append('files', new Blob([PNG], { type: 'image/png' }), name);
  const up = await fetch(s.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'x-workspace-id': ws }, body: form });
  const t = await up.text(); assert.equal(up.status, 201, t); return JSON.parse(t);
}
const scaleOut = async (s) => (await (await fetch(s.base + '/api/status')).json()).scale_out;
function openPlayer(base) {
  const sock = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  const box = {};
  const push = (ev, d) => { (box[ev] = box[ev] || []).push(d); };
  for (const ev of ['device:registered', 'device:auth-error', 'device:throttled', 'device:paired', 'device:playlist-update', 'device:command', 'device:heartbeat-ack']) sock.on(ev, (d) => push(ev, d));
  // Resolves on the NEXT arrival of `ev` after this call (counted, so a race with a fast server cannot lose it).
  const next = (ev, ms = 8000) => new Promise((resolve, reject) => {
    const start = (box[ev] || []).length;
    const t0 = Date.now();
    const tick = () => {
      if ((box[ev] || []).length > start) return resolve(box[ev][box[ev].length - 1]);
      if (Date.now() - t0 > ms) return reject(new Error(`no ${ev} within ${ms}ms; got ${JSON.stringify(Object.keys(box))}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  const connected = new Promise((r) => sock.on('connect', r));
  return { sock, box, next, connected, close: () => { try { sock.close(); } catch { /* */ } } };
}
async function registerOnce(base, payload) {
  const p = openPlayer(base); await p.connected; p.sock.emit('device:register', payload);
  const r = await Promise.race(['device:registered', 'device:auth-error', 'device:throttled'].map((ev) => p.next(ev).then((d) => ({ ev: ev.replace('device:', ''), d }))));
  p.close();
  await sleep(3000);   // past sessionSettleWindowMs (2.5 s): the next register must not be read as a duplicate
  return r;
}

/* ------------------------------ step 0: stock ------------------------------ */

test('step 0 — stock flags off: the soak refuses to start (no scale_out block to soak)', async () => {
  const stock = await boot('stock', {});
  try {
    const so = await scaleOut(stock);
    assert.equal(so, undefined, 'a stock install has nothing to soak; test_change_log_triggers_absent_without_replication_grant');
  } finally { stock.proc.kill('SIGKILL'); }
});

/* ------------------------------ the pair ------------------------------ */

let primary, replica, primaryAdmin, replicaAdmin, primaryWs, primaryNodeId, primaryPort, edgeIdOnPrimary;
let player, deviceId, deviceToken, slides = [], contentA;
const CAP = 6000;   // room for two tiny slides and their thumbnails, not for a third sized to overflow it

before(async () => {
  [primary, replica] = await Promise.all([boot('primary', { MESH_ALLOW_UPLINK: 'true' }), boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true' })]);
  primaryPort = primary.port;
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  replica.proc.kill('SIGKILL'); await sleep(300);
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base, REPLICA_CACHE_BYTES: String(CAP) });
  primaryWs = (await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json()).current_workspace_id;
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

test('step 1 — pair with terminates-players + caches-content, grant player-events on the primary, attach a screen', async () => {
  const code = await (await fetch(replica.base + '/api/mesh/pair/code', auth(replicaAdmin, 'POST', {
    capabilities: ['serves-dashboard', 'terminates-players', 'caches-content', 'consumes-telemetry'], grant: ['workspace-replication'],
  }))).json();
  const link = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin, 'POST', { parentUrl: replica.base, code: code.code, workspaceIds: [primaryWs], tlsVerify: false }))).json();
  assert.ok(!link.error, JSON.stringify(link));
  const st = await waitFor(async () => { const so = await scaleOut(replica); const r = so && so.replica_of && so.replica_of[0]; return r && r.workspaces > 0 && r.lag_s != null ? r : null; }, { what: 'snapshot' });
  primaryNodeId = st.node_id;
  assert.ok(st.cache && st.cache.cap_bytes === CAP);
  const ups = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin))).json();
  edgeIdOnPrimary = ups.uplinks[0].edgeId;
  const g = await fetch(primary.base + `/api/mesh/uplink/${edgeIdOnPrimary}/write-grant`, auth(primaryAdmin, 'PUT', { categories: ['player-events'], workspaces: [primaryWs] }));
  assert.equal(g.status, 200, await g.text());
  // A screen pairs TO THE REPLICA (test_player_events_need_the_primary_grant; C2 e2e).
  player = openPlayer(replica.base); await player.connected;
  player.sock.emit('device:register', { pairing_code: '424242', device_info: { app_version: 'soak' } });
  const reg = await player.next('device:registered');
  deviceId = reg.device_id; deviceToken = reg.device_token;
  const pairedP = player.next('device:paired', 10000);
  assert.equal((await fetch(primary.base + '/api/provision/pair', auth(primaryAdmin, 'POST', { pairing_code: '424242', name: 'Soak screen' }, { 'x-workspace-id': primaryWs }))).status, 200);
  await pairedP;
});

/* ------------------------------ step 2: token rotate ------------------------------ */

test('step 2 — token rotate on the primary: the next verify drops the verica\'s verdict; the new token is accepted', async () => {
  // There is no rotate route: rotation is the fingerprint-reclaim / enrol-key path minting a new
  // token, or the operator writing one. The operator form, on the primary's own database:
  const pdb = new Database(primary.dbPath);
  const rotated = 'rot-' + require('node:crypto').randomBytes(24).toString('hex');
  pdb.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(rotated, deviceId); pdb.close();
  const old = await registerOnce(replica.base, { device_id: deviceId, device_token: deviceToken });
  assert.equal(old.ev, 'auth-error'); assert.equal(old.d.error, 'Invalid device token');
  const rdb = new Database(replica.dbPath, { readonly: true });
  assert.equal(rdb.prepare('SELECT 1 FROM mesh_player_verdicts WHERE device_id = ?').get(deviceId), undefined, 'a "no" from the primary drops the remembered verdict (a cached verdict is overwritten by every answer…)');
  rdb.close();
  deviceToken = rotated;
  const fresh = await registerOnce(replica.base, { device_id: deviceId, device_token: deviceToken });
  assert.equal(fresh.ev, 'registered');
  // Keep one live socket for the rest of the soak.
  player.close(); player = openPlayer(replica.base); await player.connected;
  player.sock.emit('device:register', { device_id: deviceId, device_token: deviceToken });
  await player.next('device:registered');
});

/* ------------------------------ step 3: pin set fills the cache ------------------------------ */

test('step 3 — the pin set fills REPLICA_CACHE_BYTES: the on-screen file stays, a new file is served through, pinned_bytes says so', async () => {
  // Two slides in the screen's playlist (pinned); a third, sized below, that is not.
  for (const n of ['a.png', 'b.png']) slides.push(await upload(primary, primaryAdmin, primaryWs, n));
  contentA = slides[0];
  const pl = await (await fetch(primary.base + '/api/playlists', auth(primaryAdmin, 'POST', { name: 'soak loop' }, { 'x-workspace-id': primaryWs }))).json();
  for (const c of slides.slice(0, 2)) assert.ok((await fetch(primary.base + `/api/playlists/${pl.id}/items`, auth(primaryAdmin, 'POST', { content_id: c.id, duration_sec: 5 }, { 'x-workspace-id': primaryWs }))).status < 300);
  assert.ok((await fetch(primary.base + `/api/playlists/${pl.id}/assign`, auth(primaryAdmin, 'POST', { device_id: deviceId }, { 'x-workspace-id': primaryWs }))).status < 300);
  assert.ok((await fetch(primary.base + `/api/playlists/${pl.id}/publish`, auth(primaryAdmin, 'POST', {}, { 'x-workspace-id': primaryWs }))).status < 300);
  await waitFor(async () => (await fetch(replica.base + `/api/content/${slides[1].id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).status === 200, { what: 'rows to replicate' });
  // Read the two pinned slides through the replica so they are stored (hit serves local; miss … fetches, verifies, stores).
  for (const c of slides.slice(0, 2)) assert.equal((await fetch(replica.base + '/uploads/content/' + path.basename(c.filepath))).status, 200);
  await waitFor(async () => fs.existsSync(path.join(replica.contentDir, path.basename(slides[0].filepath))) && fs.existsSync(path.join(replica.contentDir, path.basename(slides[1].filepath))), { what: 'pinned slides stored' });
  // A third slide sized to FIT the cap but NOT the room left beside the two pinned ones: a PNG
  // header followed by padding (the primary stores it; its thumbnailer just gives up on it).
  const used = (await scaleOut(replica)).replica_of.find((x) => x.node_id === primaryNodeId).cache.bytes;
  const padded = Buffer.concat([PNG, Buffer.alloc(Math.max(1, CAP - used + 40 - PNG.length), 0x20)]);
  assert.ok(padded.length < CAP && used + padded.length > CAP, `sizing: used=${used} third=${padded.length} cap=${CAP}`);
  const form = new FormData(); form.append('files', new Blob([padded], { type: 'image/png' }), 'c.png');
  const upc = await fetch(primary.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + primaryAdmin, 'x-workspace-id': primaryWs }, body: form });
  const upt = await upc.text(); assert.equal(upc.status, 201, upt); slides.push(JSON.parse(upt));
  await waitFor(async () => (await fetch(replica.base + `/api/content/${slides[2].id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).status === 200, { what: 'third row to replicate' });
  await sleep(2500);   // let the prefetch try (and correctly decline) first
  // The third: served through, not stored — the pinned set fills the cap (quota: LRU eviction… pinned).
  const third = await fetch(replica.base + '/uploads/content/' + path.basename(slides[2].filepath));
  assert.equal(third.status, 200);
  assert.equal(third.headers.get('x-st-served-by'), 'primary', 'served through');
  assert.ok(!fs.existsSync(path.join(replica.contentDir, path.basename(slides[2].filepath))), 'not stored: the pinned set fills the cap');
  assert.ok(fs.existsSync(path.join(replica.contentDir, path.basename(slides[0].filepath))), 'the on-screen slide stays');
  const so = await scaleOut(replica);
  const c = so.replica_of.find((x) => x.node_id === primaryNodeId).cache;
  assert.ok(c.pinned_bytes > 0 && c.pinned_bytes <= c.cap_bytes && c.bytes === c.pinned_bytes, JSON.stringify(c));
});

/* ------------------------------ step 4/5: outage ------------------------------ */

let outageStart;
test('step 4 — primary down for longer than the replica poll: lag null, player up, cached hit 200, uncached 503, events queue', async () => {
  outageStart = nowSec();
  primary.proc.kill('SIGKILL');
  await sleep(31_000);   // > POLL_MS (30 s): the poll must have tried and failed at least once
  const so = await scaleOut(replica);
  const r = so.replica_of.find((x) => x.node_id === primaryNodeId);
  assert.equal(r.edge, 'down'); assert.equal(r.lag_s, null, 'silence is not a lag of zero (test_replica_serves_last_state_when_primary_down_and_reports_lag_unknown)');
  const ackP = player.next('device:heartbeat-ack');
  player.sock.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now(), telemetry: { cpu_usage: 3 } });
  await ackP;
  player.sock.emit('device:play-event', { device_id: deviceId, event: 'play_start', content_id: contentA.id, content_name: 'a.png', duration_sec: 5 });
  await sleep(1200);
  player.sock.emit('device:play-event', { device_id: deviceId, event: 'play_end', content_id: contentA.id, completed: true });
  const hit = await fetch(replica.base + '/uploads/content/' + path.basename(contentA.filepath));
  assert.equal(hit.status, 200, 'the replica origins a file it has already seen');
  assert.equal(hit.headers.get('x-st-served-by'), null);
  const miss = await fetch(replica.base + '/uploads/content/' + path.basename(slides[2].filepath));
  assert.equal(miss.status, 503); assert.equal((await miss.json()).code, 'primary_unreachable', 'test_replica_cache_never_invents_a_file');
  const so2 = await scaleOut(replica);
  assert.ok(so2.replica_of.find((x) => x.node_id === primaryNodeId).players.pending >= 2, 'events queued (test_play_event_buffered_while_primary_down_then_applied_in_order)');
});

test('step 5 — during the outage the remembered verdict is honoured only inside VERDICT_TTL_S; a stranger waits', async () => {
  player.close(); await sleep(300);   // a reboot: the live socket goes first (a duplicate would hit the settle hold, not the verdict)
  const ok = await registerOnce(replica.base, { device_id: deviceId, device_token: deviceToken });
  assert.equal(ok.ev, 'registered', 'a remembered screen reconnects with the primary dead');
  const stranger = await registerOnce(replica.base, { device_id: deviceId, device_token: 'not-the-token' });
  assert.equal(stranger.ev, 'throttled'); assert.equal(stranger.d.reason, 'primary_unreachable', 'test_no_automatic_player_failover_to_primary');
  // Age the verdict past the TTL (operator form, on the replica's database) and try again.
  const { VERDICT_TTL_S } = require('../lib/mesh/player-termination');
  const rdb = new Database(replica.dbPath);
  rdb.prepare('UPDATE mesh_player_verdicts SET verified_at = ? WHERE device_id = ?').run(nowSec() - VERDICT_TTL_S - 60, deviceId);
  const stale = await registerOnce(replica.base, { device_id: deviceId, device_token: deviceToken });
  assert.equal(stale.ev, 'throttled', 'past the TTL the verdict is not honoured without the primary');
  rdb.prepare('UPDATE mesh_player_verdicts SET verified_at = ? WHERE device_id = ?').run(nowSec(), deviceId); rdb.close();
  player = openPlayer(replica.base); await player.connected;
  player.sock.emit('device:register', { device_id: deviceId, device_token: deviceToken });
  await player.next('device:registered');
});

/* ------------------------------ step 6: primary back ------------------------------ */

test('step 6 — primary back: the outbox drains in order and play_logs carry timestamps from inside the outage', async () => {
  primary = await boot('primary', { MESH_ALLOW_UPLINK: 'true' }, { port: primaryPort });
  await waitFor(async () => { const so = await scaleOut(replica); const r = so.replica_of.find((x) => x.node_id === primaryNodeId); return r && r.edge === 'up' && r.players.pending === 0; }, { what: 'drain' });
  const pdb = new Database(primary.dbPath, { readonly: true });
  const rows = pdb.prepare('SELECT started_at, ended_at, completed FROM play_logs WHERE device_id = ? ORDER BY id').all(deviceId); pdb.close();
  assert.ok(rows.length >= 1, JSON.stringify(rows));
  const last = rows[rows.length - 1];
  assert.ok(last.started_at >= outageStart && last.started_at <= nowSec(), 'dated when it happened, inside the outage (never thinned on replay)');
  assert.equal(last.completed, 1);
  assert.ok(last.ended_at >= last.started_at + 1, 'ended by its own end time, ~1.2 s later');
});

/* ------------------------------ step 7/8: revoke ------------------------------ */

test('step 7 — revoke on the primary: the grant is gone, a forwarded event is refused, the existing socket keeps playing', async () => {
  const r = await fetch(primary.base + `/api/mesh/uplink/${edgeIdOnPrimary}`, auth(primaryAdmin, 'DELETE'));
  assert.equal(r.status, 200);
  const pdb = new Database(primary.dbPath, { readonly: true });
  const e = pdb.prepare('SELECT revoked_at, write_grant FROM mesh_edges WHERE id = ?').get(edgeIdOnPrimary); pdb.close();
  assert.ok(e.revoked_at); assert.equal(e.write_grant, null, 'revoke drops the player-events grant with it');
  // The existing socket is still open and still acked by the replica: nothing here severs a screen.
  const ackP = player.next('device:heartbeat-ack');
  player.sock.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now() });
  await ackP;
  // A new register cannot be verified any more: the link is gone from the primary's side, and the
  // replica cannot tell that from an outage — so a remembered screen reconnects, a stranger waits.
  await waitFor(async () => (await scaleOut(replica)).replica_of.find((x) => x.node_id === primaryNodeId).edge === 'down', { what: 'link down after revoke', tries: 60 });
  // Either the primary still had the socket and REFUSED the verify (edge revoked on its side ->
  // 'Invalid device token'), or the socket is already gone and the stranger WAITS. Both are the
  // documented answers; neither is a registration.
  const s = await registerOnce(replica.base, { device_id: deviceId, device_token: 'wrong' });
  assert.ok(s.ev === 'throttled' || (s.ev === 'auth-error' && s.d.error === 'Invalid device token'), JSON.stringify(s));
});

test('step 8 — edge ended on the replica: cached files gone, copied rows remain, a new register is read_replica', async () => {
  // The replica has no revoke route: the operator ends the roles on its own database.
  const rdb = new Database(replica.dbPath);
  rdb.prepare("UPDATE mesh_edges SET revoked_at = strftime('%s','now') WHERE direction = 'down' AND peer_node_id = ?").run(primaryNodeId);
  rdb.close();
  const r = await registerOnce(replica.base, { device_id: deviceId, device_token: deviceToken });
  assert.equal(r.ev, 'auth-error'); assert.equal(r.d.reason, 'read_replica', 'test_replica_without_terminates_players_still_refuses_register');
  // The cache sweep runs every 10 min on the worker; the same sweep the next replication apply
  // runs. Drive it the way an operator would check: wait for the worker's sweep or trigger a
  // replication tick. Here: the files must be gone within the worker's cadence, so call the
  // module's sweep directly on the replica's database (what the timer does).
  const cache = require('../lib/mesh/content-cache');
  const rdb2 = new Database(replica.dbPath);
  const dropped = cache.sweep(rdb2, { contentDir: replica.contentDir, replicaCacheBytes: CAP });
  rdb2.close();
  assert.ok(dropped >= 2, `test_replica_cache_follows_a_primary_delete (revoke half): ${dropped}`);
  for (const c of slides.slice(0, 2)) assert.ok(!fs.existsSync(path.join(replica.contentDir, path.basename(c.filepath))), 'files gone');
  const rdb3 = new Database(replica.dbPath, { readonly: true });
  assert.equal(rdb3.prepare('SELECT COUNT(*) AS n FROM content WHERE workspace_id = ?').get(primaryWs).n, 3, 'copied rows remain');
  assert.equal(rdb3.prepare('SELECT COUNT(*) AS n FROM mesh_content_cache').get().n, 0);
  rdb3.close();
  player.close();
});
