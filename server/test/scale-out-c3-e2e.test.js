'use strict';

/*
 * Scale-out C3 end to end on TWO REAL PROCESSES: a replica paired with caches-content.
 *   1. a slide uploaded on the primary reaches the replica dashboard; the first read stores it
 *      (x-st-replica-cache: stored), the second is a plain local hit (no proxy header at all);
 *   2. a second slide is uploaded but its bytes are removed from the primary's disk before the
 *      replica ever fetches it — the row replicates, the bytes cannot;
 *   3. the primary is killed: the stored file still serves from the replica; the never-fetched
 *      file answers 503 primary_unreachable — nothing is invented;
 *   4. status reports the cache for that primary.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-c3-e2e-'));
const PW = 'Passw0rd123';
const JWT = 'shared-' + Math.random().toString(36).slice(2);
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o, extra = {}) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extra }, body: o ? JSON.stringify(o) : undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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
async function register(s, email) {
  const r = await (await fetch(s.base + '/api/auth/register', jsonPost({ email, password: PW }))).json();
  assert.ok(r.token, `${s.name}: ${JSON.stringify(r)}`);
  return r.token;
}
async function waitFor(fn, { tries = 120, every = 500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
async function upload(s, token, ws, name) {
  const form = new FormData();
  form.append('files', new Blob([PNG], { type: 'image/png' }), name);
  const up = await fetch(s.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'x-workspace-id': ws }, body: form });
  const t = await up.text(); assert.equal(up.status, 201, t);
  return JSON.parse(t);
}

let primary, replica, primaryAdmin, replicaAdmin, primaryWs, primaryNodeId;

before(async () => {
  [primary, replica] = await Promise.all([boot('primary', { MESH_ALLOW_UPLINK: 'true' }), boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true' })]);
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  replica.proc.kill('SIGKILL'); await sleep(300);
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base });
  primaryWs = (await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json()).current_workspace_id;
  const code = await (await fetch(replica.base + '/api/mesh/pair/code', auth(replicaAdmin, 'POST', {
    capabilities: ['serves-dashboard', 'caches-content', 'consumes-telemetry'], grant: ['workspace-replication'],
  }))).json();
  assert.ok(code.code, JSON.stringify(code));
  const link = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin, 'POST', { parentUrl: replica.base, code: code.code, workspaceIds: [primaryWs], tlsVerify: false }))).json();
  assert.ok(!link.error, JSON.stringify(link));
  const st = await waitFor(async () => {
    const s = await (await fetch(replica.base + '/api/status')).json();
    const r = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0];
    return r && r.workspaces > 0 && r.lag_s != null ? r : null;
  }, { what: 'snapshot' });
  primaryNodeId = st.node_id;
  assert.ok(st.cache, 'status reports a cache for this primary once the edge carries caches-content');
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

let seen, unseen;
test('a slide published on the primary: first read on the replica stores it, the second is a local hit', async () => {
  seen = await upload(primary, primaryAdmin, primaryWs, 'seen.png');
  await waitFor(async () => (await fetch(replica.base + `/api/content/${seen.id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).status === 200, { what: 'row to replicate' });
  const name = path.basename(seen.filepath);
  // The prefetch may already have it; either way the FIRST observable state is "stored", then "hit".
  const first = await fetch(replica.base + '/uploads/content/' + name);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-st-served-by'), null, 'served by the replica, not proxied');
  assert.ok(fs.existsSync(path.join(replica.contentDir, name)), 'bytes are on the replica disk');
  assert.equal(Buffer.compare(Buffer.from(await first.arrayBuffer()), PNG), 0);
  const second = await fetch(replica.base + '/uploads/content/' + name);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-st-served-by'), null);
  assert.equal(second.headers.get('x-st-replica-cache'), null, 'a hit is the ordinary static route');
  const rdb = new Database(replica.dbPath, { readonly: true });
  const row = rdb.prepare('SELECT * FROM mesh_content_cache WHERE content_id = ?').get(seen.id); rdb.close();
  assert.ok(row && row.filename === name && row.bytes >= PNG.length);
  // The authenticated reader too.
  const api = await fetch(replica.base + `/api/content/${seen.id}/file`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }));
  assert.equal(api.status, 200); assert.equal(api.headers.get('x-st-served-by'), null);
});

test('a row whose bytes the replica never got: the row replicates, the bytes cannot, and the replica says so', async () => {
  unseen = await upload(primary, primaryAdmin, primaryWs, 'unseen.png');
  // Take the bytes away on the primary BEFORE the replica can fetch them (row stays).
  const pname = path.basename(unseen.filepath);
  fs.unlinkSync(path.join(primary.contentDir, pname));
  if (unseen.thumbnail_path) { try { fs.unlinkSync(path.join(primary.contentDir, path.basename(unseen.thumbnail_path))); } catch { /* */ } }
  await waitFor(async () => (await fetch(replica.base + `/api/content/${unseen.id}`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }))).status === 200, { what: 'row to replicate' });
  await sleep(2500);   // give the prefetch its (failing) attempt
  const r = await fetch(replica.base + '/uploads/content/' + pname);
  assert.equal(r.status, 404, 'the primary\'s 404 passes through; nothing is invented');
  assert.ok(!fs.existsSync(path.join(replica.contentDir, pname)));
  assert.ok(!fs.existsSync(path.join(replica.contentDir, pname + '.part')), 'no partial left behind');
});

test('primary killed: the stored file still serves; the never-fetched one is 503 primary_unreachable; not an open proxy', async () => {
  primary.proc.kill('SIGKILL');
  await sleep(800);
  const ok = await fetch(replica.base + '/uploads/content/' + path.basename(seen.filepath));
  assert.equal(ok.status, 200, 'the replica origins bytes it has already seen');
  assert.equal(Buffer.compare(Buffer.from(await ok.arrayBuffer()), PNG), 0);
  const api = await fetch(replica.base + `/api/content/${seen.id}/file`, auth(primaryAdmin, 'GET', null, { 'x-workspace-id': primaryWs }));
  assert.equal(api.status, 200);
  const no = await fetch(replica.base + '/uploads/content/' + path.basename(unseen.filepath));
  assert.equal(no.status, 503);
  assert.equal((await no.json()).code, 'primary_unreachable');
  const stranger = await fetch(replica.base + '/uploads/content/not-on-any-row.png');
  assert.equal(stranger.status, 404);
  const st = await (await fetch(replica.base + '/api/status')).json();
  const r = st.scale_out.replica_of.find((x) => x.node_id === primaryNodeId);
  assert.ok(r.cache.files >= 1 && r.cache.bytes >= PNG.length && r.cache.cap_bytes > 0, JSON.stringify(r.cache));
});
