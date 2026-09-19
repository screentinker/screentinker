'use strict';

/*
 * Scale-out C1, end to end, on TWO REAL PROCESSES (docs/scale-out-design.md §12, "definition of
 * done"). A primary and a replica boot as ordinary servers with their own DATA_DIR; the replica is
 * enrolled as the primary's mesh parent with `serves-dashboard` + the `workspace-replication`
 * grant; then:
 *
 *   1. the replica converges to the primary's copy (snapshot, then incremental);
 *   2. a GET on the replica answers the same body as the same GET on the primary;
 *   3. a POST on the replica lands on the primary (x-st-served-by: primary) and shows up on both;
 *   4. the primary is killed: GETs on the replica still answer, POSTs answer 503 primary_unreachable;
 *   5. I8 harness: the primary is SELF_HOSTED and the replica is hosted-shaped (SELF_HOSTED unset).
 *      A copied workspace must be served exactly as the primary serves it — the replica's own
 *      billing/trial/verify plumbing must not leak into the answer. The ONLY tolerated differences
 *      are named in I8_VOLATILE.
 *
 * ⚠️ Slow on purpose (two boots, a real WebSocket, a real poll). The user asked for it in C1 anyway:
 * "Hosted-shaped billing routes on a replica of a self-hosted primary is exactly the footgun."
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scale-out-e2e-'));
const PW = 'Passw0rd123';
const JWT = 'shared-secret-for-both-nodes-' + Math.random().toString(36).slice(2);
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o, extra = {}) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extra }, body: o ? JSON.stringify(o) : undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = {};
async function boot(name, extraEnv) {
  const port = await freePort();
  const dataDir = path.join(TMP, name);
  const logFd = fs.openSync(path.join(TMP, `${name}.log`), 'w');
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', JWT_SECRET: JWT, ...extraEnv };
  // Flags are set per node below; make sure nothing leaks in from the shell.
  for (const k of ['MESH_ACCEPT_ENROLLMENT', 'MESH_ALLOW_UPLINK', 'PRIMARY_URL', 'PRIMARY_REDIRECT', 'SELF_HOSTED']) if (!(k in extraEnv)) delete env[k];
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

let primary, replica, primaryAdmin, replicaAdmin, primaryWs;

before(async () => {
  [primary, replica] = await Promise.all([
    // The primary: a self-hosted install that dials out to its replica (mesh child).
    boot('primary', { SELF_HOSTED: 'true', MESH_ALLOW_UPLINK: 'true' }),
    // The replica: HOSTED-SHAPED on purpose (I8), accepts enrollment (mesh parent), knows its primary.
    boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', HOSTED_INSTANCE: '' }),
  ]);
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  // Restart the replica with PRIMARY_URL now the primary's port is known (an operator would type it).
  replica.proc.kill('SIGKILL');
  await sleep(300);
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base });
  const me = await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json();
  primaryWs = me.current_workspace_id;
  assert.ok(primaryWs, `primary default workspace: ${JSON.stringify(me)}`);
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

test('before enrollment neither node exposes a scale_out block: roles come from edges, not from a NODE_ROLE', async () => {
  const p = await (await fetch(primary.base + '/api/status')).json();
  const r = await (await fetch(replica.base + '/api/status')).json();
  assert.equal(p.scale_out, undefined);
  assert.equal(r.scale_out, undefined, 'MESH_ACCEPT_ENROLLMENT + PRIMARY_URL alone make nothing a replica');
});

test('enroll: the replica mints a serves-dashboard code, the primary redeems it with the workspace-replication grant', async () => {
  const code = await (await fetch(replica.base + '/api/mesh/pair/code', auth(replicaAdmin, 'POST', {
    capabilities: ['serves-dashboard', 'consumes-telemetry'],
    grant: ['workspace-replication'],
  }))).json();
  assert.ok(code.code, JSON.stringify(code));
  assert.match([].concat(code.grantDescription).join(' '), /never copied/i, 'consent copy is spelled out next to the grant');
  const link = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin, 'POST', {
    parentUrl: replica.base, code: code.code, workspaceIds: [primaryWs], tlsVerify: false,
  }))).json();
  assert.ok(!link.error, JSON.stringify(link));
  // Triggers appear on the primary only now — the grant, not the flag, creates them.
  const so = await waitFor(async () => {
    const s = await (await fetch(primary.base + '/api/status')).json();
    return s.scale_out && s.scale_out.role.includes('primary') && s.scale_out.replicas.length ? s.scale_out : null;
  }, { what: 'primary to see its replica' });
  assert.equal(so.replicas[0].node_id.length > 0, true);
  assert.deepEqual(so.role, ['primary']);
  const r = await (await fetch(replica.base + '/api/status')).json();
  assert.deepEqual(r.scale_out.role, ['replica']);
});

let deviceId;
test('I8: a hosted-shaped replica serves a self-hosted primary\'s workspace identically — same status, same body, on every route that matters', async () => {
  // Seed some state on the primary FIRST so the snapshot has something to carry.
  const dev = await (await fetch(primary.base + '/api/devices/web-player', auth(primaryAdmin, 'POST', { name: 'Lobby TV' }, { 'x-workspace-id': primaryWs }))).json();
  deviceId = dev.device && dev.device.id;
  assert.ok(deviceId, JSON.stringify(dev));
  const st = await waitFor(async () => {
    const s = await (await fetch(replica.base + '/api/status')).json();
    const r = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return r && r.workspaces > 0 && r.phase !== 'snapshot' && r.lag_s != null ? r : null;
  }, { what: 'replica snapshot to finish' });
  assert.equal(st.edge, 'up');

  // I8 harness: the same GET, with the primary's user token (shared JWT_SECRET), on both nodes.
  const ROUTES = ['/api/devices', `/api/devices/${deviceId}`, '/api/playlists', '/api/content', '/api/schedules', '/api/layouts', '/api/device-groups'];
  // Volatile: fields a heartbeat moves. Secret: BLOCKLIST columns, null on the copy BY DESIGN
  // (the test asserts they are null on the replica below, so a leak fails loudly).
  const I8_VOLATILE = new Set(['last_heartbeat', 'last_seen', 'updated_at', 'status', 'lag_s', 'uptime']);
  const I8_SECRET = new Set(['settings_pin', 'claim_secret', 'device_token', 'enrol_key', 'trigger_secret', 'trigger_clear_all_token', 'pairing_code']);
  const secretsSeen = [];
  // Layout templates (is_template=1) are seeded on EVERY node at boot and served to every
  // workspace — node-local by design, so their seed timestamps are the one tolerated row difference.
  const strip = (v, onReplica) => {
    if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === 'object' && x.is_template === 1)).map((x) => strip(x, onReplica));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (I8_VOLATILE.has(k)) continue;
        if (I8_SECRET.has(k)) { if (onReplica && x != null) secretsSeen.push(k); continue; }
        o[k] = strip(x, onReplica);
      }
      return o;
    }
    return v;
  };
  for (const route of ROUTES) {
    const [p, r] = await Promise.all([
      fetch(primary.base + route, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs })),
      fetch(replica.base + route, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs })),
    ]);
    const [pt, rt] = [await p.text(), await r.text()];
    assert.equal(r.status, p.status, `${route}: status differs (primary ${p.status}, replica ${r.status}) — ${rt.slice(0, 200)}`);
    assert.equal(r.headers.get('x-st-served-by'), null, `${route}: a GET is served locally, never proxied`);
    let pb, rb;
    try { pb = JSON.parse(pt); rb = JSON.parse(rt); } catch (e) { assert.fail(`${route}: not JSON (primary ${p.status}: ${pt.slice(0, 120)} / replica ${r.status}: ${rt.slice(0, 120)})`); }
    assert.deepEqual(strip(rb, true), strip(pb, false), `${route}: replica body differs from primary`);
  }
  assert.deepEqual(secretsSeen, [], 'a secret column reached the replica');
});

test('test_replica_refuses_or_proxies_every_non_get_for_remote_workspaces: a write on the replica lands on the primary, then converges back', async () => {
  const res = await fetch(replica.base + `/api/devices/${deviceId}`, auth(primaryAdmin, 'PUT', { name: 'Lobby TV (renamed via replica)' }, { 'x-workspace-id': primaryWs }));
  assert.equal(res.headers.get('x-st-served-by'), 'primary', 'the write was forwarded');
  assert.ok(res.status < 300, `${res.status} ${await res.text()}`);
  const onPrimary = await (await fetch(primary.base + `/api/devices/${deviceId}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).json();
  assert.equal((onPrimary.device || onPrimary).name, 'Lobby TV (renamed via replica)');
  await waitFor(async () => {
    const d = await (await fetch(replica.base + `/api/devices/${deviceId}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).json();
    return (d.device || d).name === 'Lobby TV (renamed via replica)';
  }, { what: 'rename to converge on the replica' });
  // The replica's own workspace is still its own: a write there is applied locally, not forwarded.
  const mine = await fetch(replica.base + '/api/devices/web-player', auth(replicaAdmin, 'POST', { name: 'Replica-local screen' }));
  assert.equal(mine.headers.get('x-st-served-by'), null);
  assert.ok(mine.status < 300, await mine.text());
});

test('content bytes: an upload through the replica lands on the primary, the row comes back by replication, the file is fetched through', async () => {
  // 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('files', new Blob([png], { type: 'image/png' }), 'dot.png');
  const up = await fetch(replica.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + primaryAdmin, 'x-workspace-id': primaryWs }, body: form });
  assert.equal(up.headers.get('x-st-served-by'), 'primary', 'the multipart body was streamed to the primary');
  const upText = await up.text();
  assert.equal(up.status, 201, upText);
  const row = JSON.parse(upText);
  assert.ok(row.id, JSON.stringify(row));
  // The row arrives by replication; the bytes never do.
  await waitFor(async () => {
    const r = await fetch(replica.base + `/api/content/${row.id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }));
    return r.status === 200;
  }, { what: 'content row to replicate' });
  const file = await fetch(replica.base + `/api/content/${row.id}/file`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }));
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(file.status, 200, bytes.toString().slice(0, 200));
  assert.equal(file.headers.get('x-st-served-by'), 'primary', 'bytes fetched through, not from a local file that does not exist');
  assert.equal(Buffer.compare(bytes, png), 0, 'byte-identical');
  // The public static path the dashboard uses for thumbnails: same fetch-through, and only for
  // names that belong to a copied row.
  const base = String(row.filepath || '').split('/').pop();
  const pub = await fetch(replica.base + `/uploads/content/${base}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('x-st-served-by'), 'primary');
  const nope = await fetch(replica.base + '/uploads/content/not-a-copied-file.png');
  assert.equal(nope.status, 404);
  assert.equal(nope.headers.get('x-st-served-by'), null, 'an unknown name is a local miss, never a probe of the primary');
});

test('login on the replica as a copied user proxies to the primary; the replica never verifies a password', async () => {
  const r = await fetch(replica.base + '/api/auth/login', jsonPost({ email: 'admin@primary.local', password: PW }));
  assert.equal(r.headers.get('x-st-served-by'), 'primary');
  const body = await r.json();
  assert.ok(body.token, JSON.stringify(body));
  // And that token (minted by the primary) is good on the replica: shared JWT_SECRET.
  const me = await fetch(replica.base + '/api/auth/me', auth(body.token));
  assert.equal(me.status, 200);
  // A wrong password is the PRIMARY's refusal, passed through.
  const bad = await fetch(replica.base + '/api/auth/login', jsonPost({ email: 'admin@primary.local', password: 'wrong' }));
  assert.equal(bad.headers.get('x-st-served-by'), 'primary');
  assert.equal(bad.status, 401);
});

test('test_replica_serves_last_state_when_primary_down_and_reports_lag_unknown: reads keep answering, writes answer 503, lag reads null', async () => {
  primary.proc.kill('SIGKILL');
  await sleep(500);
  const read = await fetch(replica.base + '/api/devices', auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }));
  assert.equal(read.status, 200);
  const devices = await read.json();
  assert.ok((devices.devices || devices).some((d) => d.id === deviceId), 'the copy still serves the primary\'s device');
  const write = await fetch(replica.base + `/api/devices/${deviceId}`, auth(primaryAdmin, 'PUT', { name: 'nope' }, { 'x-workspace-id': primaryWs }));
  assert.equal(write.status, 503);
  const wb = await write.json();
  assert.equal(wb.code, 'primary_unreachable');
  assert.equal(wb.retry_after, 30);
  const st = await waitFor(async () => {
    const s = await (await fetch(replica.base + '/api/status')).json();
    const r = s.scale_out.replica_of[0];
    return r.edge === 'down' ? r : null;
  }, { what: 'replica to notice the edge is down', tries: 60 });
  assert.equal(st.lag_s, null, 'silence is not a lag of zero');
});
