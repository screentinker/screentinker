'use strict';

// Public-API integration suite. Boots the REAL server.js as a subprocess against an
// isolated DB and exercises the token front door end to end. Three tiers:
//   1. Partition firewall   - every JWT-only router 401s a token; derived from the SAME
//                             config/api-surface.js that server.js mounts from, so the
//                             test and the mount list cannot drift.
//   2. Threat model         - the 6 categories we verified by hand (gates, binding,
//                             scope ladder, render bypass, lifecycle, JWT no-regression).
//   3. Device WS round-trip - real socket.io-client: valid token registers, wrong rejected.
// Node built-ins + socket.io-client (devDep) only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS } = require('../config/api-surface');

const PORT = 3978;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-api-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-api-test-' + crypto.randomBytes(4).toString('hex') + '.log');

let proc;
const S = {}; // shared fixtures populated in before()

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok, extra = {}) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...extra } });
const post = (tok, obj, extra) => ({ method: 'POST', ...auth(tok, extra), body: JSON.stringify(obj) });

before(async () => {
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  // wait for the server to answer /api/status
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // user1 (first user -> platform_admin, workspace A); user2 (workspace B)
  let r = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u1@test.local', password: 'test12345', name: 'U1' }) });
  S.jwt = r.body.token; S.user1 = r.body.user.id;
  r = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u2@test.local', password: 'test12345', name: 'U2' }) });
  S.jwt2 = r.body.token;

  // scoped tokens (read/write/full) for user1, all bound to workspace A
  S.tok = {};
  for (const scope of ['read', 'write', 'full']) {
    const c = await jfetch('/api/tokens', post(S.jwt, { name: scope, scope }));
    S.tok[scope] = c.body.token; S.wsA = c.body.workspace_id;
  }
  // workspace B id (from a user2 token)
  S.wsB = (await jfetch('/api/tokens', post(S.jwt2, { name: 'b', scope: 'read' }))).body.workspace_id;

  // marker playlists (one per workspace) + a group + a widget
  S.playlistA = (await jfetch('/api/playlists', post(S.jwt, { name: 'PA-marker' }))).body.id;
  await jfetch('/api/playlists', post(S.jwt2, { name: 'PB-marker' }));
  S.groupId = (await jfetch('/api/groups', post(S.jwt, { name: 'G' }))).body.id;
  S.widgetId = (await jfetch('/api/widgets', post(S.jwt, { name: 'W', widget_type: 'clock', config: {} }))).body.id;

  // layouts + zones in workspace A (user1) and workspace B (user2) - for the gap-fix
  // assertions and the cross-tenant rejection (the is_template OR workspace_id guard).
  const zone = (n) => ({ name: n, x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 });
  const layA = await jfetch('/api/layouts', post(S.jwt, { name: 'LA', zones: [zone('ZA')] }));
  S.layoutA = layA.body.id; S.zoneA = layA.body.zones[0].id;
  const layB = await jfetch('/api/layouts', post(S.jwt2, { name: 'LB', zones: [zone('ZB')] }));
  S.layoutB = layB.body.id; S.zoneB = layB.body.zones[0].id;

  // a paired device with a known token (for the WS round-trip) - inserted into the
  // server's live DB (WAL: a second connection's commit is visible to the server).
  const db = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  S.deviceId = crypto.randomUUID();
  S.deviceToken = 'devtok_' + crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO devices (id,name,user_id,workspace_id,device_token,status,created_at) VALUES (?,?,?,?,?,'offline',strftime('%s','now'))")
    .run(S.deviceId, 'WS-dev', S.user1, S.wsA, S.deviceToken);
  // #109 PiP fixtures: a device in workspace B (cross-tenant isolation) and the wsA
  // device as a member of the wsA group (group-targeting expansion).
  S.deviceIdB = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,user_id,workspace_id,device_token,status,created_at) VALUES (?,?,?,?,?,'offline',strftime('%s','now'))")
    .run(S.deviceIdB, 'WS-dev-B', S.user1, S.wsB, 'devtok_' + crypto.randomBytes(16).toString('hex'));
  db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(S.groupId, S.deviceId);
  db.close();
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

// ───────────────────────── TIER 1: PARTITION FIREWALL ─────────────────────────
// Derived from config/api-surface.js (the same list server.js mounts from). The day
// someone gives a JWT-only router the token door (or moves a privileged router into the
// public set), one of these fails.

for (const r of JWT_ONLY_ROUTERS) {
  test(`firewall: JWT-only ${r.path} rejects a Bearer st_ token (401)`, async () => {
    const res = await jfetch(r.path, auth(S.tok.read));
    assert.equal(res.status, 401, `${r.path} must 401 a token - a token reached a privileged router`);
  });
}
for (const r of PUBLIC_ROUTERS) {
  test(`partition: public ${r.path} accepts a token (not 401)`, async () => {
    const res = await jfetch(r.path, auth(S.tok.read));
    assert.notEqual(res.status, 401, `${r.path} is public but rejected a valid token`);
  });
}
test('partition: known-privileged routers are JWT-only and never public', () => {
  const MUST_BE_PRIVATE = ['/api/admin', '/api/workspaces', '/api/ai', '/api/provision', '/api/white-label', '/api/tokens'];
  const jwtOnly = new Set(JWT_ONLY_ROUTERS.map(r => r.path));
  const publicSet = new Set(PUBLIC_ROUTERS.map(r => r.path));
  for (const p of MUST_BE_PRIVATE) {
    assert.ok(jwtOnly.has(p), `${p} must be in JWT_ONLY_ROUTERS`);
    assert.ok(!publicSet.has(p), `${p} must NOT be on the token door (PUBLIC_ROUTERS)`);
  }
});
test('partition: public and JWT-only sets are disjoint', () => {
  const publicSet = new Set(PUBLIC_ROUTERS.map(r => r.path));
  for (const r of JWT_ONLY_ROUTERS) assert.ok(!publicSet.has(r.path), `${r.path} is in BOTH sets`);
});
test('partition: the public token surface is exactly the reviewed set (snapshot firewall)', () => {
  // Putting a router on the token door must be a DELIBERATE, reviewed change: update this
  // list and justify it in review. A NEW privileged route silently mounted on the token
  // front door (the failure mode we care about) fails HERE.
  const EXPECTED_PUBLIC = [
    '/api/devices', '/api/content', '/api/folders', '/api/assignments', '/api/layouts',
    '/api/widgets', '/api/schedules', '/api/walls', '/api/reports', '/api/groups',
    '/api/playlists', '/api/activity', '/api/kiosk', '/api/pip',
  ].sort();
  assert.deepEqual(PUBLIC_ROUTERS.map(r => r.path).sort(), EXPECTED_PUBLIC);
});

// ───────────────────────── TIER 2: THREAT MODEL ─────────────────────────

// (a) in-handler privileged gates: the role-strip makes platform/elevated checks deny a
// token. /devices/unassigned is the canonical ELEVATED gate; the template-write gates on
// content/folders/layouts/widgets/kiosk share the identical !PLATFORM_ROLES(role='user').
test('gate: GET /api/devices/unassigned denies a token (403, ELEVATED gate via role-strip)', async () => {
  const res = await jfetch('/api/devices/unassigned', auth(S.tok.full)); // full scope passes the scope gate; the in-handler gate fires
  assert.equal(res.status, 403);
});
test('gate: a token cannot create a platform template (role-strip)', async () => {
  // PLATFORM_ROLES gate on layout templates - either 403 or the flag is silently dropped.
  const res = await jfetch('/api/layouts', post(S.tok.full, { name: 'T', is_template: true, zones: [] }));
  const isTemplate = res.body && (res.body.is_template === 1 || res.body.is_template === true);
  assert.ok(res.status === 403 || !isTemplate, 'token created a platform template');
});

// (b) workspace-binding strip - token IGNORES X-Workspace-Id, JWT HONORS it (both directions)
test('binding: a token IGNORES X-Workspace-Id (stays in its bound workspace)', async () => {
  const res = await jfetch('/api/playlists', auth(S.tok.read, { 'X-Workspace-Id': S.wsB }));
  const names = (Array.isArray(res.body) ? res.body : res.body.playlists || []).map(p => p.name);
  assert.ok(names.includes('PA-marker'), 'token should still see workspace A');
  assert.ok(!names.includes('PB-marker'), 'token leaked into workspace B via the header');
});
test('binding: a JWT HONORS X-Workspace-Id (multi-workspace switching intact)', async () => {
  const withHdr = await jfetch('/api/playlists', auth(S.jwt, { 'X-Workspace-Id': S.wsB }));
  const wNames = (Array.isArray(withHdr.body) ? withHdr.body : withHdr.body.playlists || []).map(p => p.name);
  assert.ok(wNames.includes('PB-marker'), 'JWT + header must see workspace B');
  const noHdr = await jfetch('/api/playlists', auth(S.jwt));
  const nNames = (Array.isArray(noHdr.body) ? noHdr.body : noHdr.body.playlists || []).map(p => p.name);
  assert.ok(nNames.includes('PA-marker') && !nNames.includes('PB-marker'), 'JWT default workspace must be A');
});

// (c) scope ladder: read<write<full
test('scope: read token can GET but not POST (403)', async () => {
  assert.equal((await jfetch('/api/playlists', auth(S.tok.read))).status, 200);
  assert.equal((await jfetch('/api/playlists', post(S.tok.read, { name: 'x' }))).status, 403);
});
test('scope: write token can POST but not command (403, command needs full)', async () => {
  assert.equal((await jfetch('/api/playlists', post(S.tok.write, { name: 'w-made' }))).status, 201);
  assert.equal((await jfetch(`/api/groups/${S.groupId}/command`, post(S.tok.write, { type: 'reboot' }))).status, 403);
});
test('scope: full token can command (not 403)', async () => {
  const res = await jfetch(`/api/groups/${S.groupId}/command`, post(S.tok.full, { type: 'reboot' }));
  assert.notEqual(res.status, 403, 'full scope should pass the operational gate');
});

// (d) dual-path render bypass: render public, CRUD locked, no secret leak
test('bypass: GET /api/widgets/:id/render is public (200, no auth) and leaks no secret', async () => {
  const res = await fetch(`${BASE}/api/widgets/${S.widgetId}/render`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const leak of ['device_token', 'workspace_id', 'password', S.tok.read]) {
    assert.ok(!html.includes(leak), `render leaked ${leak}`);
  }
});
test('bypass: widget CRUD still requires auth (no-auth list/PUT -> 401)', async () => {
  assert.equal((await fetch(`${BASE}/api/widgets`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/widgets/${S.widgetId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

// (e) token lifecycle
test('lifecycle: create returns the secret once; list never returns it; revoke -> 401', async () => {
  const created = await jfetch('/api/tokens', post(S.jwt, { name: 'lifecycle', scope: 'read' }));
  const secret = created.body.token;
  assert.ok(secret && secret.startsWith('st_'), 'create must return the full secret once');
  // works
  assert.equal((await jfetch('/api/playlists', auth(secret))).status, 200);
  // list never contains the secret
  const list = await jfetch('/api/tokens', auth(S.jwt));
  assert.ok(!JSON.stringify(list.body).includes(secret), 'list leaked the secret');
  // revoke -> next call 401
  await jfetch(`/api/tokens/${created.body.id}`, { method: 'DELETE', ...auth(S.jwt) });
  assert.equal((await jfetch('/api/playlists', auth(secret))).status, 401, 'revoked token must 401');
});

// (f) bearerAuth byte-equivalence: a JWT caller is unaffected by the new middleware -
// it does every method on the public routers (tokenScopeGate is a no-op for JWT) and
// still reaches the JWT-only routers.
test('no-regression: JWT does full CRUD on a public router (scope gate is a no-op for JWT)', async () => {
  const c = await jfetch('/api/playlists', post(S.jwt, { name: 'jwt-crud' }));
  assert.equal(c.status, 201);
  assert.equal((await jfetch(`/api/playlists/${c.body.id}`, { method: 'PUT', ...auth(S.jwt), body: JSON.stringify({ name: 'jwt-crud2' }) })).status, 200);
  assert.equal((await jfetch(`/api/playlists/${c.body.id}`, { method: 'DELETE', ...auth(S.jwt) })).status, 200);
});
test('no-regression: JWT reaches a JWT-only router (requireAuth path unchanged)', async () => {
  const res = await jfetch('/api/tokens', auth(S.jwt)); // token mgmt is JWT-only
  assert.equal(res.status, 200, 'JWT must still reach JWT-only routers');
});

// ───────────────────────── TIER 3: DEVICE WS ROUND-TRIP ─────────────────────────

function deviceRegister(payload, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { connected: false, registered: false, playlist: false, authError: false };
    const finish = () => { try { sock.close(); } catch { /* */ } resolve(got); };
    sock.on('connect', () => { got.connected = true; sock.emit('device:register', payload); });
    sock.on('device:registered', (d) => { got.registered = d.device_id === payload.device_id; sock.emit('device:heartbeat', { device_id: payload.device_id }); });
    sock.on('device:playlist-update', () => { got.playlist = true; });
    sock.on('device:auth-error', () => { got.authError = true; finish(); });
    setTimeout(finish, timeoutMs);
  });
}
test('device WS: valid device_token registers and receives its playlist', async () => {
  const got = await deviceRegister({ device_id: S.deviceId, device_token: S.deviceToken, device_info: { app_version: 'test' } });
  assert.ok(got.connected, 'device socket should connect');
  assert.ok(got.registered, 'valid device_token should authenticate');
  assert.ok(got.playlist, 'registered device should receive device:playlist-update');
});
test('device WS: wrong device_token is rejected (auth-error, never registered)', async () => {
  const got = await deviceRegister({ device_id: S.deviceId, device_token: 'WRONG-TOKEN', device_info: {} });
  assert.ok(got.authError, 'wrong token should emit device:auth-error');
  assert.ok(!got.registered, 'wrong token must not register');
});

// ───────────────────────── TIER 4: #92 FOLLOW-UP COVERAGE ─────────────────────────
// The non-security gaps named in the self-review (issue #92): the gap-fix fields + the
// cross-tenant guard (the security-relevant one), docs serving, and the token lifecycle
// branches the suite didn't exercise.

test('gap: playlist item accepts zone_id and returns it on read', async () => {
  const created = await jfetch(`/api/playlists/${S.playlistA}/items`, post(S.jwt, { widget_id: S.widgetId, zone_id: S.zoneA }));
  assert.equal(created.status, 201);
  assert.equal(created.body.zone_id, S.zoneA);
  const items = await jfetch(`/api/playlists/${S.playlistA}/items`, auth(S.jwt));
  assert.ok(items.body.some(i => i.zone_id === S.zoneA), 'GET items must return zone_id');
});
test('gap: playlist item REJECTS a cross-tenant zone_id (400, is_template OR workspace_id guard)', async () => {
  const res = await jfetch(`/api/playlists/${S.playlistA}/items`, post(S.jwt, { widget_id: S.widgetId, zone_id: S.zoneB }));
  assert.equal(res.status, 400, 'a zone from another workspace must be rejected');
});
test('gap: device PUT accepts layout_id and returns it on read', async () => {
  const put = await jfetch(`/api/devices/${S.deviceId}`, { method: 'PUT', ...auth(S.jwt), body: JSON.stringify({ layout_id: S.layoutA }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.layout_id, S.layoutA);
  const dev = await jfetch(`/api/devices/${S.deviceId}`, auth(S.jwt));
  assert.equal(dev.body.layout_id, S.layoutA, 'GET device must return layout_id');
});
test('gap: device PUT REJECTS a cross-tenant layout_id (400)', async () => {
  const res = await jfetch(`/api/devices/${S.deviceId}`, { method: 'PUT', ...auth(S.jwt), body: JSON.stringify({ layout_id: S.layoutB }) });
  assert.equal(res.status, 400, 'a layout from another workspace must be rejected');
});

test('docs: /openapi.yaml serves the spec document', async () => {
  const res = await fetch(BASE + '/openapi.yaml');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('openapi: 3.1'), 'must serve the OpenAPI document');
});
test('docs: /docs serves the Redoc viewer wired to the spec', async () => {
  const res = await fetch(BASE + '/docs');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<redoc') && html.includes('/openapi.yaml'), 'must serve the Redoc page pointing at /openapi.yaml');
});

test('token-create: rejects a workspace the caller is not a member of (400)', async () => {
  // user1 is platform_admin (resolveTenancy lets them into wsB via the header) but is NOT
  // a member of wsB; the create endpoint checks accessContext with the platform role
  // stripped to 'user', so it must refuse to bind a token there.
  const res = await jfetch('/api/tokens', post(S.jwt, { name: 'x', scope: 'read' }, { 'X-Workspace-Id': S.wsB }));
  assert.equal(res.status, 400);
  assert.equal((await jfetch('/api/tokens', post(S.jwt, { name: 'x2', scope: 'read' }))).status, 201, 'own workspace still works');
});
// The must_change_password gate is middleware logic and is unit-tested with an injected
// in-memory DB in test/apitoken-unit.test.js (cross-process DB visibility against the
// subprocess server is unreliable for asserting that specific branch).
test('token-auth: last_used_at is stamped on first use', async () => {
  const created = await jfetch('/api/tokens', post(S.jwt, { name: 'lu', scope: 'read' }));
  const before = (await jfetch('/api/tokens', auth(S.jwt))).body.find(t => t.id === created.body.id);
  assert.equal(before.last_used_at, null, 'a fresh token has no last_used_at');
  await jfetch('/api/playlists', auth(created.body.token)); // use it once
  const after = (await jfetch('/api/tokens', auth(S.jwt))).body.find(t => t.id === created.body.id);
  assert.ok(after.last_used_at, 'last_used_at is set after first use');
});

// ───────────────────────── TIER 5: #109 PiP OVERLAY (POST /api/pip) ─────────────────────────
// MVP: image/web overlay pushed to a device/group, full-scope, workspace-isolated.
const pipBody = (over = {}) => ({ device_id: S.deviceId, type: 'image', uri: 'https://example.com/x.png', position: 'top-right', width: 480, height: 360, duration: 30, ...over });

// authz: requireScope('full')
test('pip: read/write tokens are rejected (403, needs full)', async () => {
  assert.equal((await jfetch('/api/pip', post(S.tok.read, pipBody()))).status, 403);
  assert.equal((await jfetch('/api/pip', post(S.tok.write, pipBody()))).status, 403);
});
test('pip: full token is accepted (offline device reported, not queued)', async () => {
  const res = await jfetch('/api/pip', post(S.tok.full, pipBody()));
  assert.equal(res.status, 200);
  assert.equal(res.body.target, 'device');
  assert.ok(res.body.pip_id, 'server generates a pip_id');
  assert.equal(res.body.total, 1);
  assert.equal(res.body.offline, 1, 'the offline device is reported offline');
  assert.equal(res.body.sent, 0);
});

// workspace isolation: a wsA token cannot address a wsB device, nor a non-existent id.
test('pip: workspace isolation — wsA token cannot target a wsB device (404)', async () => {
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ device_id: S.deviceIdB }))).then(r => r.status)), 404);
});
test('pip: unknown device/group id is 404', async () => {
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ device_id: crypto.randomUUID() })))).status, 404);
});

// group targeting: device_id resolves to a group and expands to its members.
test('pip: group id expands to members (group with 1 member)', async () => {
  const res = await jfetch('/api/pip', post(S.tok.full, pipBody({ device_id: S.groupId })));
  assert.equal(res.status, 200);
  assert.equal(res.body.target, 'group');
  assert.equal(res.body.total, 1, 'the group has one member device');
});

// payload validation
test('pip: payload validation (type / uri / position / bounds / color)', async () => {
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ type: 'video' })))).status, 400);   // not in allowlist
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ uri: 'ftp://x/y' })))).status, 400); // bad scheme
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ uri: 'not a url' })))).status, 400);
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ position: 'middle' })))).status, 400);
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ width: 5 })))).status, 400);          // below DIM_MIN
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ duration: -1 })))).status, 400);
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ opacity: 2 })))).status, 400);
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ background_color: 'red' })))).status, 400);
  assert.equal((await jfetch('/api/pip', post(S.tok.full, pipBody({ device_id: '' })))).status, 400);
});

// clear: POST /api/pip/clear and DELETE /api/pip, both full-scope.
test('pip clear: full token clears (POST /clear and DELETE), read token rejected', async () => {
  assert.equal((await jfetch('/api/pip/clear', post(S.tok.full, { device_id: S.deviceId }))).status, 200);
  assert.equal((await jfetch('/api/pip/clear', post(S.tok.read, { device_id: S.deviceId }))).status, 403);
  const del = await jfetch('/api/pip', { method: 'DELETE', ...auth(S.tok.full), body: JSON.stringify({ device_id: S.deviceId }) });
  assert.equal(del.status, 200);
});
