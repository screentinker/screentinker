'use strict';

/*
 * NOC — the live graph of THIS node's mesh (docs/scale-out.md "NOC on this server"). What it must
 * be: one O(edges) poll built from what this node already holds, owner-only, absent where the
 * mesh is off, and a read that MOVES NOTHING — opening it must not start a snapshot, a cache fill
 * or a mesh read. Two real processes for the last one.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-noc-'));
const PW = 'Passw0rd123';
const JWT = 'noc-' + Math.random().toString(36).slice(2);
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
  const proc = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error(`${name} did not boot`);
  servers[name] = { name, proc, base, port, dataDir, dbPath: path.join(dataDir, 'db', 'remote_display.db'), contentDir: path.join(dataDir, 'uploads', 'content'), log: path.join(TMP, `${name}.log`) };
  return servers[name];
}
async function register(s, email) { const r = await (await fetch(s.base + '/api/auth/register', jsonPost({ email, password: PW }))).json(); assert.ok(r.token, JSON.stringify(r)); return r.token; }
async function waitFor(fn, { tries = 120, every = 500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}

/* ------------------------------ source-level: the poller ------------------------------ */

test('the NOC module polls only while it is the active, visible view: one setInterval, in start(), cleared on stop/cleanup/hidden', () => {
  const src = read('../frontend/js/views/noc.js');
  const intervals = src.match(/setInterval\(/g) || [];
  assert.equal(intervals.length, 1, 'exactly one setInterval in the module');
  const startFn = src.slice(src.indexOf('function start()'), src.indexOf('function stop()'));
  assert.match(startFn, /if \(timer \|\| !active \|\| document\.visibilityState === 'hidden'\) return;/, 'guarded on active + visible');
  assert.match(startFn, /setInterval\(tick, POLL_MS\)/);
  assert.match(src, /export function cleanup\(\) \{\s*stop\(\);/, 'the view swap clears it');
  assert.match(src, /function onVisibility\(\) \{ if \(document\.visibilityState === 'hidden'\) stop\(\);/, 'a hidden tab stops polling');
  assert.match(src, /const POLL_MS = (2000|3000|4000|5000);/, 'browser poll is 2–5 s');
  // No streaming and no second transport: the only data call is the one GET.
  assert.doesNotMatch(src, /socket|io\(|EventSource|WebSocket/i);
  assert.match(src, /api\.get\('\/mesh\/noc'\)/);
  assert.doesNotMatch(src, /api\.get\('\/mesh\/(snapshot|changes|devices)/, 'no per-device scan and no replication reads from the browser');
  // No hosts, no discovery.
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /https?:\/\/[a-z0-9-]+\.[a-z]{2,}/i);
  // The poll is the plain GET plus, while a node is selected, ONE bounded ?node= for that node
  // only — never a screen list for every node. The per-node call lives in a single place.
  const tickFn = src.slice(src.indexOf('async function tick()'), src.indexOf('function detectMovement'));
  assert.match(tickFn, /api\.get\('\/mesh\/noc'\)/);
  assert.match(tickFn, /if \(selected\) await loadSelected\(selected\);/, 'the drawer ages with the graph, for the selected node only');
  assert.doesNotMatch(tickFn, /for \(const n of|nodes\.map|nodes\.forEach/, 'not for every node');
  const loadFn = src.slice(src.indexOf('async function loadSelected'), src.indexOf('/* ------------------------------ layout'));
  assert.match(loadFn, /api\.get\(`\/mesh\/noc\?node=/);
  assert.equal((src.match(/noc\?node=/g) || []).length, 1, 'exactly one place asks for a node\'s screens');
  // Pulse: applied rev or outbox depth only.
  const mv = src.slice(src.indexOf('function detectMovement'), src.indexOf('async function loadSelected'));
  assert.match(mv, /rev\(l\) !== rev\(p\) \|\| depth\(l\) !== depth\(p\)/);
  assert.doesNotMatch(mv, /last_sync_at|cache_stored|relays/, 'not on a heartbeat or a byte counter');
  // Copy lag is captioned as such and never drawn as a number on a dead link.
  assert.match(src, /copy lag \$\{l\.state === 'down' \|\| l\.lag_s == null \? '\?'/);
  // The chip is attention, the drawer is the board: no CPU/memory/disk on a chip, the edge caption
  // is hidden until hover or selection, and this server's host strip renders null as a dash, never 0.
  const chip = src.slice(src.indexOf('const nodeBox ='), src.indexOf('const edgeLine ='));
  assert.doesNotMatch(chip, /cpu|rss|mem_pct|disk/i, 'no host figures on the chip');
  assert.match(chip, /<title>/, 'role and id live in the hover title');
  assert.match(chip, /'no screens'/);
  assert.match(src, /\.noc-edge \.noc-cap \{ display: none;/, 'captions hidden by default');
  assert.match(src, /\.noc-edge:hover \.noc-cap, \.noc-edge\.noc-sel \.noc-cap \{ display: block; \}/, 'shown on hover and on the selected node\'s links');
  assert.match(src, /const fmtPct = \(v\) => \(v == null \? '—'/, 'null is a dash');
  assert.match(src, /const fmtBytes = \(b\) => \(b == null \? '—'/, 'null is a dash');
  assert.match(src, /DISK_ALERT_FRACTION = 0\.10/);
  // Optional screen columns only when a row can fill them; playlist only when a title exists.
  assert.match(src, /const has = \(k\) => !!\(sd && sd\.screens\.some\(\(d\) => d\[k\] != null && d\[k\] !== ''\)\)/);
  assert.match(src, /showPlaylist = has\('playlist'\)/);
});

test('the host probe is O(1) and answers null, never 0, when it cannot read', () => {
  const probeSrc = read('lib/host-probe.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(probeSrc, /readFrom|snapshot|changes|uploads|require\('\.\.\/db|prepare\(|socket|fetch\(|readdir|exec/i, 'no table, no socket, no scan');
  const probe = require('../lib/host-probe');
  probe._reset();
  const first = probe.sample();
  assert.equal(first.cpu_pct, null, 'a percentage needs two readings');
  assert.ok(first.rss_bytes > 0);
  assert.ok(first.disk_free_bytes > 0 && first.disk_total_bytes >= first.disk_free_bytes, 'DATA_DIR filesystem');
  const second = probe.sample();
  assert.ok(typeof second.cpu_pct === 'number' && second.cpu_pct >= 0);
  const nowhere = probe.sample({ dir: path.join(TMP, 'does-not-exist') });
  assert.equal(nowhere.disk_free_bytes, null, 'a failed probe is null, not 0');
  assert.equal(nowhere.disk_total_bytes, null);
  for (const v of Object.values({ ...first, ...second, ...nowhere })) assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v)));
});

test('the endpoint itself moves nothing: no readFrom, no replica sync, no cache ensure, no per-device scan', () => {
  const src = read('routes/mesh-enroll.js');
  const block = src.slice(src.indexOf("router.get('/noc'"), src.indexOf("router.get('/shareable-workspaces'"));
  assert.doesNotMatch(block, /readFrom|__meshReadFrom|\.sync\(|\.tick\(|ensure\(|snapshotPage|changesSince|writeTo|fetch\(|screenshot|\/api\/content|uploads\/content/);
  assert.match(block, /LIMIT \?`\)\.all\((want, )?LIMIT\)/, 'the per-node screen list is bounded');
  assert.match(block, /GROUP BY origin_node_id/, 'screens are grouped counts');
  assert.doesNotMatch(block, /SELECT \* FROM devices\b/, 'no per-device scan');
  assert.match(block, /requireInstanceOwner/, 'owner only');
  assert.match(block, /host: require\('\.\.\/lib\/host-probe'\)\.sample\(\)/, 'this process only');
  assert.doesNotMatch(block, /os\.cpus|loadavg|du |statfs/, 'no second probe, no per-core scan');
  assert.match(block, /LEFT JOIN device_telemetry t ON t\.rowid = \(SELECT rowid FROM device_telemetry x WHERE x\.device_id = d\.id ORDER BY x\.reported_at DESC LIMIT 1\)/, 'one bounded telemetry row per listed screen');
});

/* ------------------------------ flags off ------------------------------ */

test('flags off: the route is 404 and the nav item is not shown', async () => {
  const stock = await boot('stock', {});
  try {
    const t = await register(stock, 'owner@stock.local');
    assert.equal((await fetch(stock.base + '/api/mesh/noc', auth(t))).status, 404);
    // The nav item follows the Servers gate (mesh capability from /me), then owner-only.
    const app = read('../frontend/js/app.js');
    assert.match(app, /nocNav\.style\.display = serversNav\.style\.display !== 'none' && role === 'platform_admin' \? '' : 'none'/, 'derived from the Servers gate, then owner-only');
    const me = await (await fetch(stock.base + '/api/auth/me', auth(t))).json();
    assert.equal(me.mesh.enroll, false);
  } finally { stock.proc.kill('SIGKILL'); }
});

/* ------------------------------ two processes ------------------------------ */

let primary, replica, primaryAdmin, replicaAdmin, primaryWs, primaryNodeId, replicaNodeId, editorToken;

before(async () => {
  [primary, replica] = await Promise.all([boot('primary', { MESH_ALLOW_UPLINK: 'true' }), boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true' })]);
  primaryAdmin = await register(primary, 'admin@primary.local');
  replicaAdmin = await register(replica, 'admin@replica.local');
  replica.proc.kill('SIGKILL'); await sleep(300);
  replica = await boot('replica', { MESH_ACCEPT_ENROLLMENT: 'true', PRIMARY_URL: primary.base });
  primaryWs = (await (await fetch(primary.base + '/api/auth/me', auth(primaryAdmin))).json()).current_workspace_id;
  const code = await (await fetch(replica.base + '/api/mesh/pair/code', auth(replicaAdmin, 'POST', { capabilities: ['serves-dashboard', 'terminates-players', 'caches-content', 'consumes-telemetry'], grant: ['workspace-replication'] }))).json();
  replicaNodeId = code.nodeId;
  const link = await (await fetch(primary.base + '/api/mesh/uplink', auth(primaryAdmin, 'POST', { parentUrl: replica.base, code: code.code, workspaceIds: [primaryWs], tlsVerify: false }))).json();
  assert.ok(!link.error, JSON.stringify(link));
  const st = await waitFor(async () => { const s = await (await fetch(replica.base + '/api/status')).json(); const r = s.scale_out && s.scale_out.replica_of && s.scale_out.replica_of[0]; return r && r.workspaces > 0 && r.lag_s != null ? r : null; }, { what: 'snapshot' });
  primaryNodeId = st.node_id;
  // A second user on the replica who is NOT the instance owner (a workspace admin of their own workspace).
  const e = await (await fetch(replica.base + '/api/auth/register', jsonPost({ email: 'editor@replica.local', password: PW }))).json();
  editorToken = e.token;
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

test('instance owner loads it; a user without instance rights cannot', async () => {
  const ok = await fetch(replica.base + '/api/mesh/noc', auth(replicaAdmin));
  assert.equal(ok.status, 200);
  const no = await fetch(replica.base + '/api/mesh/noc', auth(editorToken));
  assert.equal(no.status, 403);
  // And on the child side too (mounted under MESH_ALLOW_UPLINK), same gate.
  assert.equal((await fetch(primary.base + '/api/mesh/noc', auth(primaryAdmin))).status, 200);
});

test('the topology matches the edges in the database, on both sides', async () => {
  const r = await (await fetch(replica.base + '/api/mesh/noc', auth(replicaAdmin))).json();
  const rdb = new Database(replica.dbPath, { readonly: true });
  const edges = rdb.prepare('SELECT id, peer_node_id, direction FROM mesh_edges WHERE revoked_at IS NULL').all(); rdb.close();
  assert.deepEqual(r.links.map((l) => [l.edgeId, l.direction]).sort(), edges.map((e) => [e.id, e.direction]).sort());
  assert.equal(r.self.id, replicaNodeId); assert.deepEqual(r.self.roles, ['replica', 'hub']);
  const child = r.nodes.find((n) => n.id === primaryNodeId);
  assert.equal(child.kind, 'child');
  assert.deepEqual(child.capabilitiesHere.sort(), ['caches-content', 'serves-dashboard', 'terminates-players']);
  assert.ok(child.screens && typeof child.screens.total === 'number', 'screens are counts');
  const down = r.links.find((l) => l.edgeId === edges[0].id);
  assert.equal(down.state, 'connected'); assert.equal(typeof down.lag_s, 'number');
  assert.ok(down.players && down.cache, 'C2/C3 counters ride the down link');
  assert.equal(r.depthCap, 2);
  // This server's host figures ride the plain poll, O(1), for this process only; a child has none.
  assert.ok(r.self.host && ['cpu_pct', 'rss_bytes', 'disk_free_bytes', 'disk_total_bytes'].every((k) => k in r.self.host));
  assert.ok(r.self.host.disk_free_bytes > 0 && r.self.host.rss_bytes > 0);
  assert.ok(!('host' in child), 'nothing scraped for a child');
  // Primary side: one up link, its uplink state, acked vs head.
  const p = await (await fetch(primary.base + '/api/mesh/noc', auth(primaryAdmin))).json();
  assert.deepEqual(p.self.roles, ['primary']);
  const up = p.links.find((l) => l.direction === 'up');
  assert.equal(up.state, 'connected'); assert.equal(up.to, replicaNodeId);
  assert.ok(up.headRev != null && up.ackedRev != null);
  const parent = p.nodes.find((n) => n.kind === 'parent');
  assert.deepEqual(parent.roles.sort(), ['caches-content', 'serves-dashboard', 'terminates-players']);
});

test('test_noc_poll_moves_no_data: twenty polls change no replication position, fetch no file, drain nothing', async () => {
  const pdb = () => new Database(primary.dbPath, { readonly: true });
  const rdb = () => new Database(replica.dbPath, { readonly: true });
  const snap = () => {
    const a = pdb(), b = rdb();
    const s = {
      head: a.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM mesh_change_log').get().m,
      ops: a.prepare('SELECT COUNT(*) AS n FROM mesh_write_ops').get().n,
      applied: b.prepare('SELECT replica_rev FROM workspaces WHERE id = ?').get(primaryWs).replica_rev,
      cache: b.prepare('SELECT COUNT(*) AS n FROM mesh_content_cache').get().n,
      files: fs.existsSync(replica.contentDir) ? fs.readdirSync(replica.contentDir).length : 0,
      logLines: fs.readFileSync(primary.log, 'utf8').split('\n').length,
    };
    a.close(); b.close(); return s;
  };
  // A content row exists on the primary (not yet cached anywhere): a poll must not go and get it.
  const form = new FormData(); form.append('files', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'x.png');
  await fetch(primary.base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + primaryAdmin, 'x-workspace-id': primaryWs }, body: form });
  // Let the replication + prefetch settle first, so the only thing that could move is the poll.
  await sleep(6000);
  const before = snap();
  for (let i = 0; i < 20; i++) {
    const r = await fetch(replica.base + '/api/mesh/noc', auth(replicaAdmin));
    assert.equal(r.status, 200);
    // ...and the selected-node form the drawer re-asks on every tick while a node is selected.
    const rs = await fetch(replica.base + `/api/mesh/noc?node=${primaryNodeId}`, auth(replicaAdmin));
    assert.equal(rs.status, 200);
    const p = await fetch(primary.base + '/api/mesh/noc', auth(primaryAdmin));
    assert.equal(p.status, 200);
    await sleep(100);
  }
  const after = snap();
  assert.deepEqual({ ...after, logLines: 0 }, { ...before, logLines: 0 }, 'nothing moved: no rev, no op, no file, no cache row');
  // The primary's read worker answered nothing new for these polls (a snapshot/changes read logs on the worker).
  const tail = fs.readFileSync(primary.log, 'utf8').split('\n').slice(before.logLines - 1);
  assert.ok(!tail.some((l) => /mesh:read|snapshot|changes/.test(l)), `a poll caused a mesh read: ${tail.filter((l) => /mesh/.test(l)).join(' | ')}`);
});

test('?node= returns the selected node\'s screens (stale first, capped at 50 with "more") and last alerts; the plain poll carries none', async () => {
  // Seed screens: 60 on the primary in the copied workspace (they replicate to the replica).
  const pdb = new Database(primary.dbPath);
  const userId = pdb.prepare('SELECT id FROM users LIMIT 1').get().id;
  const ins = pdb.prepare("INSERT INTO devices (id, user_id, name, workspace_id, status, last_heartbeat, device_token) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 60; i++) ins.run(`scr-${String(i).padStart(3, '0')}`, userId, `Screen ${i}`, primaryWs, i % 3 === 0 ? 'online' : 'offline', now - i * 60, `t${i}`);
  pdb.close();
  await waitFor(async () => { const r = new Database(replica.dbPath, { readonly: true }); const n = r.prepare("SELECT COUNT(*) AS n FROM devices WHERE id LIKE 'scr-%'").get().n; r.close(); return n === 60; }, { what: 'screens to replicate' });
  const plain = await (await fetch(replica.base + '/api/mesh/noc', auth(replicaAdmin))).json();
  assert.equal(plain.selected, null, 'no screens on the plain poll');
  const sel = await (await fetch(replica.base + `/api/mesh/noc?node=${primaryNodeId}`, auth(replicaAdmin))).json();
  assert.equal(sel.selected.id, primaryNodeId);
  assert.equal(sel.selected.screens.length, 50, 'capped');
  assert.equal(sel.selected.more, 10, 'and N more');
  assert.equal(sel.selected.screens[0].status, 'offline', 'stale first');
  assert.ok(sel.selected.screens.every((d) => typeof d.seen_s === 'number' && d.seen_s >= 0), 'seen = seconds since last heartbeat');
  assert.ok(sel.selected.screens.every((d) => d.attached === 'primary'), 'not attached here: their sockets are on the owner');
  assert.ok(Array.isArray(sel.selected.alerts) && sel.selected.alerts.length <= 5);
  // The child count on the node card agrees with the table's universe.
  const child = sel.nodes.find((n) => n.id === primaryNodeId);
  assert.equal(child.screens.total, 60);
  // A screen's latest telemetry rides its row (cpu %, memory %, storage free), null where it never
  // reported — on the primary's own list, which is where those rows live.
  const pdb2 = new Database(primary.dbPath);
  pdb2.prepare("INSERT INTO device_telemetry (device_id, cpu_usage, ram_free_mb, ram_total_mb, storage_free_mb, storage_total_mb, reported_at) VALUES ('scr-059', 42.5, 1000, 4000, 512, 8000, ?)").run(now - 100);
  pdb2.prepare("INSERT INTO device_telemetry (device_id, cpu_usage, ram_free_mb, ram_total_mb, storage_free_mb, storage_total_mb, reported_at) VALUES ('scr-059', 7, 3000, 4000, 256, 8000, ?)").run(now);
  pdb2.close();
  const own = await (await fetch(primary.base + `/api/mesh/noc?node=${(await (await fetch(primary.base + '/api/mesh/noc', auth(primaryAdmin))).json()).self.id}`, auth(primaryAdmin))).json();
  const reported = own.selected.screens.find((d) => d.id === 'scr-059');
  assert.ok(reported, 'scr-059 is in the stale-first page');
  assert.deepEqual({ cpu: reported.cpu_pct, mem: reported.mem_pct, st: reported.storage_free_bytes }, { cpu: 7, mem: 25, st: 256 * 1048576 }, 'the LATEST telemetry row');
  const silent = own.selected.screens.find((d) => d.id !== 'scr-059');
  assert.deepEqual({ cpu: silent.cpu_pct, mem: silent.mem_pct, st: silent.storage_free_bytes }, { cpu: null, mem: null, st: null }, 'never reported → null, never 0');
  // Selecting THIS node lists its own screens (none here), and an unknown node answers an empty summary, not an error.
  const me = await (await fetch(replica.base + `/api/mesh/noc?node=${replicaNodeId}`, auth(replicaAdmin))).json();
  assert.deepEqual(me.selected.screens, []);
  assert.equal((await fetch(replica.base + '/api/mesh/noc?node=nope', auth(replicaAdmin))).status, 200);
});

test('lag_s is null on a down link, and the link says down', async () => {
  primary.proc.kill('SIGKILL');
  const link = await waitFor(async () => {
    const r = await (await fetch(replica.base + '/api/mesh/noc', auth(replicaAdmin))).json();
    const l = r.links.find((x) => x.direction === 'down');
    return l.state === 'down' ? l : null;
  }, { what: 'link down', tries: 90 });
  assert.equal(link.lag_s, null, 'silence is not a lag of zero');
  const r = await (await fetch(replica.base + '/api/mesh/noc', auth(replicaAdmin))).json();
  assert.ok(r.links[0].movement && 'last_applied_rev' in r.links[0].movement, 'movement counters are still reported for the pulse');
});
