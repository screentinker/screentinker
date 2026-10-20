'use strict';

/*
 * Scale-out dial-out, end to end, on REAL PROCESSES (lib/mesh/dial-out.js, docs/scale-out.md
 * "A replica behind NAT"). The replica is the side that opens every connection:
 *
 *   1. the primary mints an invite (scope chosen there); the replica joins with it over HTTP to the
 *      primary and then keeps a socket open to the primary's /mesh-in — the primary never dials;
 *   2. the copy converges exactly as with the ordinary pairing, and a write on the replica lands on
 *      the primary (PRIMARY_URL, unchanged);
 *   3. an invite is single-use; a bad token is refused at the door;
 *   4. severing on the primary shuts the socket and the replica says why;
 *   5. REPLICA_JOIN_CODE joins at boot with nobody touching the replica's dashboard (the installer);
 *   6. ADD-ON ONLY: a server without MESH_ALLOW_UPLINK has no invite routes and no /mesh-in door.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dial-out-e2e-'));
const PW = 'Passw0rd123';
const JWT = 'shared-secret-for-dial-out-' + Math.random().toString(36).slice(2);
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o, extra = {}) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extra }, body: o ? JSON.stringify(o) : undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = {};
async function boot(name, extraEnv) {
  const port = await freePort();
  const dataDir = path.join(TMP, name);
  const logFd = fs.openSync(path.join(TMP, `${name}.log`), 'a');
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', JWT_SECRET: JWT, ...extraEnv };
  for (const k of ['MESH_ACCEPT_ENROLLMENT', 'MESH_ALLOW_UPLINK', 'PRIMARY_URL', 'PRIMARY_REDIRECT', 'SELF_HOSTED',
                   'REPLICA_JOIN_CODE', 'REPLICA_JOIN_ROLES']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120; i++) { try { const r = await fetch(base + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error(`${name} did not boot; see ${path.join(TMP, `${name}.log`)}`);
  servers[name] = { name, proc, base, port, dataDir, env };
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
const status = async (s) => (await fetch(s.base + '/api/status')).json();

let primary, replica, primaryAdmin, replicaAdmin, primaryWs;

before(async () => {
  primary = await boot('primary', { MESH_ALLOW_UPLINK: 'true' });
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base });
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  const me = await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json();
  primaryWs = me.current_workspace_id;
  assert.ok(primaryWs, JSON.stringify(me));
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

async function mintInvite() {
  const inv = await (await fetch(primary.base + '/api/mesh/uplink/invite', auth(primaryAdmin, 'POST', { workspaceIds: [primaryWs] }))).json();
  assert.ok(inv.code, JSON.stringify(inv));
  return inv;
}

let invite;
test('add-on only: a server without MESH_ALLOW_UPLINK has no invite routes and no /mesh-in door', async () => {
  const r = await fetch(replica.base + '/api/mesh/invite/preview', jsonPost({ code: 'X' }));
  assert.notEqual(r.status, 200);
  assert.notEqual(r.status, 400, 'no invite handler answered — the route is simply not mounted');
  const { io } = require('socket.io-client');
  const err = await new Promise((resolve) => {
    const s = io(replica.base + '/mesh-in', { transports: ['websocket'], reconnection: false, forceNew: true, auth: { edgeToken: 'x', nodeId: 'y' } });
    s.on('connect', () => { s.disconnect(); resolve(null); });
    s.on('connect_error', (e) => { s.disconnect(); resolve(e); });
  });
  assert.ok(err, 'connecting to /mesh-in on a node without MESH_ALLOW_UPLINK must fail');
  assert.match(String(err.message), /namespace/i);
});

test('the primary mints an invite with the workspace scope chosen there', async () => {
  invite = await mintInvite();
  assert.equal(invite.workspaces, 1);
  assert.ok(invite.expiresAt > Date.now() / 1000 + 86400, 'an invite outlives a 15-minute pairing code');
});

test('the replica joins by dialling out; the primary holds a they-dial edge with no address to dial', async () => {
  const j = await (await fetch(replica.base + '/api/mesh/pair/join', auth(replicaAdmin, 'POST', {
    primaryUrl: primary.base, code: invite.code, roles: ['caches-content'],
  }))).json();
  assert.ok(j.ok, JSON.stringify(j));
  assert.deepEqual(j.capabilities, ['serves-dashboard', 'caches-content', 'consumes-telemetry']);
  assert.deepEqual(j.warnings, [], 'PRIMARY_URL matches the address joined');

  const up = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin))).json();
  assert.equal(up.uplinks.length, 1);
  assert.equal(up.uplinks[0].parentUrl, null, 'the primary was never given an address for the replica');

  const so = await waitFor(async () => {
    const s = await status(primary);
    return s.scale_out && s.scale_out.replicas.length ? s.scale_out : null;
  }, { what: 'primary to see its replica' });
  assert.deepEqual(so.role, ['primary']);
  assert.equal(so.replicas[0].link.connected, true, 'the inbound link is attached');

  const r = await waitFor(async () => {
    const s = await status(replica);
    const x = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return x && x.dial && x.dial.connected && x.edge === 'up' ? x : null;
  }, { what: 'replica dial-out to connect' });
  assert.ok(r.cache, 'caches-content took effect');
});

let deviceId;
test('the copy converges over the replica-opened socket, and a write on the replica lands on the primary', async () => {
  const dev = await (await fetch(primary.base + '/api/devices/web-player', auth(primaryAdmin, 'POST', { name: 'Studio TV' }, { 'x-workspace-id': primaryWs }))).json();
  deviceId = dev.device && dev.device.id;
  assert.ok(deviceId, JSON.stringify(dev));
  await waitFor(async () => {
    const res = await fetch(`${replica.base}/api/devices/${deviceId}`, auth(primaryAdmin, 'GET', undefined, { 'x-workspace-id': primaryWs }));
    return res.ok;
  }, { what: 'device to replicate' });

  const pl = await fetch(replica.base + '/api/playlists', auth(primaryAdmin, 'POST', { name: 'from the studio' }, { 'x-workspace-id': primaryWs }));
  assert.equal(pl.headers.get('x-st-served-by'), 'primary', 'writes still go out to PRIMARY_URL');
  const created = await pl.json();
  assert.ok(created.id || (created.playlist && created.playlist.id), JSON.stringify(created));
  await waitFor(async () => {
    const list = await (await fetch(replica.base + '/api/playlists', auth(primaryAdmin, 'GET', undefined, { 'x-workspace-id': primaryWs }))).json();
    return (Array.isArray(list) ? list : list.playlists || []).some((p) => p.name === 'from the studio');
  }, { what: 'the write to converge back to the replica' });
});

test('an invite is single-use, and a wrong token is refused at /mesh-in', async () => {
  const again = await fetch(replica.base + '/api/mesh/pair/join', auth(replicaAdmin, 'POST', { primaryUrl: primary.base, code: invite.code }));
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /not valid|already/i);

  const { io } = require('socket.io-client');
  const err = await new Promise((resolve) => {
    const s = io(primary.base + '/mesh-in', { transports: ['websocket'], reconnection: false, forceNew: true, auth: { edgeToken: 'not-a-token', nodeId: 'whoever' } });
    s.on('connect', () => { s.disconnect(); resolve(null); });
    s.on('connect_error', (e) => { s.disconnect(); resolve(e); });
  });
  assert.ok(err);
  assert.match(String(err.message), /no longer authorised/i);
});

test('REPLICA_JOIN_CODE: a freshly installed replica joins at boot with nobody opening its dashboard', async () => {
  const inv = await mintInvite();
  const r2 = await boot('replica2', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base, REPLICA_JOIN_CODE: inv.code });
  const x = await waitFor(async () => {
    const s = await status(r2);
    const e = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return e && e.dial && e.dial.connected && e.workspaces > 0 ? e : null;
  }, { what: 'auto-joined replica to copy the workspace' });
  assert.ok(x.cache, 'REPLICA_JOIN_ROLES defaults to caches-content');
  // A restart with the (now burned) code still in the env is a no-op, not an error loop.
  r2.proc.kill('SIGKILL');
  await sleep(300);
  const again = await boot('replica2', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base, REPLICA_JOIN_CODE: inv.code });
  await waitFor(async () => {
    const s = await status(again);
    const e = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return e && e.dial && e.dial.connected;
  }, { what: 'restarted replica to redial with its stored edge' });
  const log = fs.readFileSync(path.join(TMP, 'replica2.log'), 'utf8');
  assert.doesNotMatch(log, /could not join .* REPLICA_JOIN_CODE/, 'an existing edge skips the join');
});

test('severing on the primary closes the replica\'s socket, and the replica says why', async () => {
  // On the primary, an up edge's parentNodeId is the REPLICA; pick the first replica's edge.
  const replicaId = (await (await fetch(replica.base + '/api/mesh/capabilities', auth(replicaAdmin))).json()).nodeId;
  assert.ok(replicaId);
  const up = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin))).json();
  const edge = up.uplinks.find((u) => !u.revoked && u.parentNodeId === replicaId);
  assert.ok(edge, JSON.stringify(up));
  const del = await fetch(`${primary.base}/api/mesh/uplink/${encodeURIComponent(edge.edgeId)}`, auth(primaryAdmin, 'DELETE'));
  assert.ok(del.ok, await del.text());
  const st = await waitFor(async () => {
    const s = await status(replica);
    const e = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return e && e.dial && !e.dial.connected && /no longer authorised/i.test(e.dial.last_error || '') ? e : null;
  }, { tries: 160, what: 'replica to report the refusal' });
  assert.equal(st.dial.connected, false);
});
