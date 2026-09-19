'use strict';

// Scale-out C1 guards (docs/scale-out-design.md §12). Each test is named in the design and, where
// it protects an invariant, in ARCHITECTURE.md. Most are SOURCE-LEVEL, for the same reason the I9
// guards are: the property being held is an absence — no second writer, no default primary host,
// no trigger on a stock install — and an absence is best asserted against the source.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------------------------------------ */

test('test_change_log_triggers_absent_without_replication_grant: a stock install has no triggers and an empty log', async () => {
  // A REAL boot with every mesh flag off, then inspect the file it left behind.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-stock-'));
  const { freePort } = require('./helpers/free-port');
  const port = await freePort();
  const logFd = fs.openSync(path.join(dir, 'boot.log'), 'w');
  const env = { ...process.env, DATA_DIR: dir, SELF_HOSTED: 'true', NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'x' };
  delete env.MESH_ACCEPT_ENROLLMENT; delete env.MESH_ALLOW_UPLINK; delete env.PRIMARY_URL;
  const proc = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd] });
  try {
    let up = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) { up = true; break; } } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
    assert.ok(up, 'server booted');
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(status.scale_out, undefined, 'a stock install has no scale_out block at all');
    const db = new Database(path.join(dir, 'db', 'remote_display.db'), { readonly: true });
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mesh_cl_%'").all();
    assert.deepEqual(triggers, [], 'no change-log triggers');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mesh_change_log').get().n, 0, 'log empty');
    // And with uplink ON but no edge carrying the grant: still none. The grant, not the flag,
    // is what creates them.
    const replication = require('../lib/mesh/replication');
    const rw = new Database(path.join(dir, 'db', 'remote_display.db'));
    assert.equal(replication.replicationWanted(rw), false);
    assert.equal(replication.ensureTriggers(rw).action, 'absent');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* */ }
  }
});

/* ------------------------------------------------------------------------------------------ */

test('test_replication_blocklist_covers_every_secret_column: no column that looks like a secret ships by omission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-blocklist-'));
  process.env.DATA_DIR = dir; process.env.SELF_HOSTED = 'true'; process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-' + crypto.randomBytes(4).toString('hex');
  const { db } = require('../db/database');
  const replication = require('../lib/mesh/replication');
  const missing = [];
  for (const spec of replication.TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name);
    const block = new Set(replication.BLOCKLIST[spec.table] || []);
    for (const c of cols) {
      if (replication.SECRET_NAME_RE.test(c) && !block.has(c) && !replication.NOT_A_SECRET[`${spec.table}.${c}`]) missing.push(`${spec.table}.${c}`);
    }
    // And nothing on the blocklist is fiction: a misspelt entry would protect nothing.
    for (const b of block) assert.ok(cols.includes(b), `${spec.table}.${b} is on the blocklist but not in the schema`);
  }
  assert.deepEqual(missing, [],
    'A column whose name matches the secret pattern is not on lib/mesh/replication.js BLOCKLIST. ' +
    'Add it there (it will not be copied) or rename it if it is genuinely not a secret.');
  // The projection honours it: a snapshot page of users carries no hash column.
  const cols = replication.columnsFor(db, 'users');
  assert.ok(!cols.includes('password_hash') && !cols.includes('totp_secret_enc'));
  // JSON config columns: encrypted plugin secrets and secret-named keys are scrubbed, the rest kept.
  const enc = require('../lib/plugins/secrets');
  const cfg = JSON.stringify({ url: 'https://feed.example', interval_min: 5, api_key: 'enc:v1:abc', nested: { token: 'x', keep: 1 } });
  const out = JSON.parse(replication.scrubJson(cfg));
  assert.deepEqual(out, { url: 'https://feed.example', interval_min: 5, nested: { keep: 1 } });
  assert.equal(typeof enc.secretNames, 'function'); // the plugin-side redactor the scrub mirrors
});

/* ------------------------------------------------------------------------------------------ */

/**
 * Every mutating HTTP route either runs behind resolveTenancy (where the replica interceptor
 * lives) or is named below with the reason it is NOT workspace-scoped. A new `router.post` in a
 * route file that is mounted without tenancy, or a new inline `app.post` in server.js without
 * resolveTenancy, fails this test until it is either mounted correctly or listed here on purpose.
 */
const NOT_WORKSPACE_SCOPED = Object.freeze({
  // route file -> why its writes are not workspace writes (and so cannot land on a copied workspace)
  'auth.js': 'account/session endpoints; login on a replica proxies for copied users (routes/auth.js /login)',
  'org-sso.js': 'organization-level SSO configuration; not replicated (§3.1)',
  'subscription.js': 'billing, owner-only, not scaled (Phase D)',
  'stripe.js': 'webhook from Stripe, not a user write',
  'billing.js': 'billing, not scaled',
  'contact.js': 'contact form, no workspace',
  'player-debug.js': 'player-authenticated debug log ingest; players are on the primary in C1',
  'mesh.js': 'hub-side mesh routes (clients, writes TO children) — node-local bookkeeping',
  'mesh-enroll.js': 'pairing/enrollment — node-local edges',
  'status.js': 'import/backup, owner-only, resolves its own session and workspace (see sessionWorkspaceId)',
  'embedded.js': 'embedded-renderer cursor, device-authenticated',
  'workspaces.js': 'creates/edits workspaces and memberships — a copied workspace is refused by origin tag inside the handler (C1: replica-side edits of copied workspaces are node-local bookkeeping only)',
  'admin.js': 'platform-admin, node-local',
  'admin-plugins.js': 'platform-admin plugin management, node-local',
  'diagnostics.js': 'platform-admin diagnostics, node-local',
  'telemetry-collector.js': 'stats.screentinker.com ingest, node-local',
  'hardware-submissions.js': 'public community report, no workspace',
  'plugin-submissions.js': 'mounted with tenancy in api-surface; listed for the inline rate-limit mount',
  'agency.js': 'agency-token surface, mounted behind bearerAuth + resolveTenancy (AGENCY_ROUTERS)',
  'kiosk.js': 'mounted with tenancy (PUBLIC_ROUTERS)',
});

const INLINE_NOT_WORKSPACE_SCOPED = Object.freeze({
  '/api/stripe/webhook': 'Stripe webhook',
  '/api/brightsign/snapshot': 'device-authenticated capture upload',
  '/api/trigger': 'LAN trigger from a player/sensor, device-authenticated',
  '/api/widgets/:id/telemetry': 'player-authenticated widget telemetry',
  '/api/plugin-submissions': 'rate-limit mount only; the handler is the tenancy router',
  '/api/admin/plugins/submissions': 'platform-admin, node-local',
  '/api/device/exit': 'player exit beacon, device-authenticated',
  '/api/devices/:id/live/publish': 'device-authenticated live-video publish',
});

test('test_every_mutating_route_passes_resolveTenancy: no second writer can hide in an unlisted route', () => {
  const surface = require('../config/api-surface');
  const tenancyMods = new Set([
    ...surface.PUBLIC_ROUTERS.map((r) => path.basename(r.mod) + '.js'),
    ...surface.JWT_ONLY_ROUTERS.filter((r) => r.tenancy).map((r) => path.basename(r.mod) + '.js'),
    ...surface.AGENCY_ROUTERS.map((r) => path.basename(r.mod) + '.js'),
  ]);
  const unaccounted = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes')).filter((f) => f.endsWith('.js'))) {
    const src = read(path.join('routes', f));
    const writes = (src.match(/router\.(post|put|patch|delete)\(/g) || []).length;
    if (!writes) continue;
    if (tenancyMods.has(f)) continue;
    if (!NOT_WORKSPACE_SCOPED[f]) unaccounted.push(`routes/${f} (${writes} mutating handlers)`);
  }
  const server = read('server.js');
  for (const m of server.matchAll(/app\.(post|put|patch|delete)\('([^']+)'([^\n]*)/g)) {
    const [, , route, rest] = m;
    if (/resolveTenancy/.test(rest)) continue;
    if (!INLINE_NOT_WORKSPACE_SCOPED[route]) unaccounted.push(`server.js inline ${route}`);
  }
  assert.deepEqual(unaccounted, [],
    'A mutating route is neither mounted behind resolveTenancy (config/api-surface.js) nor named in ' +
    'NOT_WORKSPACE_SCOPED with a reason. On a replica it would be a second writer for a copied workspace.');

  // The two GETs that write are named, so they cannot drift back into "reads".
  const { WRITING_GETS } = require('../lib/replica-proxy');
  assert.deepEqual([...WRITING_GETS].sort(), ['/api/auth/verify-email', '/api/update/check']);
  assert.match(read('routes/auth.js'), /router\.get\('\/verify-email'/);
  assert.match(server, /'\/api\/update\/check'/);

  // And the interceptor is where the design says: in the resolver, before next().
  const tenancy = read('lib/tenancy.js');
  assert.match(tenancy, /replicaProxy\.shouldIntercept\(req, req\.workspace\)/);
  assert.match(tenancy, /replicaProxy\.proxyToPrimary\(req, res, config\)/);
});

/* ------------------------------------------------------------------------------------------ */

test('test_no_builtin_primary_url: PRIMARY_URL has no default and nothing host-shaped is compiled in (I9)', () => {
  const config = read('config.js');
  const m = config.match(/primaryUrl:\s*([^\n]+)/);
  assert.ok(m, 'config.primaryUrl exists');
  assert.match(m[1], /process\.env\.PRIMARY_URL/);
  assert.match(m[1], /\|\|\s*null/, 'unset means null, never a host');
  const HOSTNAME = /(screentinker\.com|relay\.|\.amazonaws\.|\.cloudfront\.|https?:\/\/[a-z0-9-]+\.[a-z]{2,})/i;
  for (const f of ['lib/replica-proxy.js', 'lib/mesh/replica.js', 'lib/mesh/replication.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(src, HOSTNAME, `${f} names a host; the primary address is operator-typed only`);
  }
  // No automatic reroute: a failed proxy answers 503, it never tries another address.
  const proxy = read('lib/replica-proxy.js');
  assert.doesNotMatch(proxy, /fallback\s*(to)?\s*(relay|primary|host)|retryWith|alternate(Url|Host)/i);
  assert.match(proxy, /primary_unreachable/);
});

/* ------------------------------------------------------------------------------------------ */

test('test_replica_never_runs_primary_sweeps: every background writer filters to local rows, and a copied device is not swept', () => {
  const rowSweeps = ['services/heartbeat', 'services/scheduler', 'services/content-expiry', 'services/threshold-alerts', 'services/alerts', 'lib/data-sources/service'];
  for (const s of rowSweeps) assert.match(read(`${s}.js`), /LOCAL_ROWS_SQL\(/, `${s}.js must scope its sweep with LOCAL_ROWS_SQL`);
  // User-driven lifecycle sweeps (hosted-shaped) must skip the primary's users too — I8.
  for (const s of ['services/activationNudge', 'services/trialExpiry']) assert.match(read(`${s}.js`), /LOCAL_USERS_SQL\(/, `${s}.js must scope with LOCAL_USERS_SQL`);
  // Behavioural half, on the real schema: the SQL fragment keeps unfiled rows and local rows, and
  // drops rows of a copied workspace.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sweep-'));
  process.env.DATA_DIR = dir; process.env.SELF_HOSTED = 'true'; process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-' + crypto.randomBytes(4).toString('hex');
  const { db } = require('../db/database');
  const { LOCAL_ROWS_SQL } = require('../lib/replica-proxy');
  const uid = () => crypto.randomUUID();
  const userId = uid(), orgId = uid(), localWs = uid(), copiedWs = uid();
  db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'o', 'h', 'platform_admin')").run(userId, `o-${userId.slice(0, 6)}@x.local`);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, 'A', ?, 'free')").run(orgId, userId);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'local')").run(localWs, orgId);
  db.prepare("INSERT INTO workspaces (id, organization_id, name, origin_node_id) VALUES (?, ?, 'copy', 'some-primary')").run(copiedWs, orgId);
  db.prepare("INSERT INTO devices (id, user_id, name, workspace_id, status) VALUES ('d-local', ?, 'L', ?, 'online')").run(userId, localWs);
  db.prepare("INSERT INTO devices (id, user_id, name, workspace_id, status) VALUES ('d-copy', ?, 'C', ?, 'online')").run(userId, copiedWs);
  db.prepare("INSERT INTO devices (id, user_id, name, workspace_id, status) VALUES ('d-unfiled', ?, 'U', NULL, 'online')").run(userId);
  const swept = db.prepare(`SELECT id FROM devices WHERE status = 'online' AND ${LOCAL_ROWS_SQL('devices')} ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(swept, ['d-local', 'd-unfiled'], 'the copied device is invisible to a sweep');
});

/* ------------------------------------------------------------------------------------------ */

test('test_replica_refuses_or_proxies_every_non_get_for_remote_workspaces: the interceptor lets GETs through and stops every mutating method for a copied workspace', () => {
  const { shouldIntercept } = require('../lib/replica-proxy');
  const copy = { id: 'w', origin_node_id: 'p' };
  const mine = { id: 'w', origin_node_id: null };
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(shouldIntercept({ method: m }, copy), false, m);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(shouldIntercept({ method: m }, copy), true, m);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(shouldIntercept({ method: m }, mine), false, `${m} on my own workspace`);
});
