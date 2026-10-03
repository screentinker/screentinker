'use strict';

// Tests for #10 (admin-provisioned user creation) and the must_change_password
// lifecycle, plus the #13 operator denial on this endpoint.
//
// No DB_PATH override (per project constraint): we mount the real routers
// against an isolated in-memory better-sqlite3 instance that we seed here, by
// injecting it into the require cache for ../db/database BEFORE any module that
// requires it is loaded. Node v20 built-ins only (node:test, node:assert, fetch).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-admin-users';

// --- isolated in-memory DB + minimal schema (only what these paths touch) ---
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    provider_id TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    plan_id TEXT DEFAULT 'free',
    email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    -- Mirrors the real schema, where this arrives as
    --   ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0
    -- The DEFAULT 0 is the whole point: it is what left admin-created users facing an
    -- unclearable "confirm your email" banner (#292), so the fixture must carry the same
    -- default or the fix cannot be tested here at all.
    email_verified INTEGER NOT NULL DEFAULT 0,
    welcome_email_sent_at INTEGER,
    activation_nudge_sent_at INTEGER,
    last_login INTEGER,
    trial_started INTEGER,
    trial_plan TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active',
    subscription_ends INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'org_admin',
    invited_by TEXT,
    joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(organization_id, user_id)
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'workspace_viewer',
    invited_by TEXT,
    joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(workspace_id, user_id)
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    owner_user_id TEXT, plan_id TEXT, subscription_status TEXT,
    -- Mirrors the real schema. Login refuses when it cannot determine whether an organization
    -- requires single sign-on, so a fixture missing this column fails closed — correctly, but it
    -- is the fixture that is wrong, not the guard.
    sso_only INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    device_id TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    workspace_id TEXT,
    organization_id TEXT,
    status_code INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// Inject the mock BEFORE requiring anything that pulls ../db/database.
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: { db, pruneTelemetry() {}, pruneScreenshots() {} },
};

const express = require('express');
const bcrypt = require('bcryptjs');
const { generateToken, requireAuth } = require('../middleware/auth');
const { activityLogger } = require('../services/activity');
const adminRouter = require('../routes/admin');
const authRouter = require('../routes/auth');

// --- seed orgs/workspaces/users ---
db.prepare("INSERT INTO organizations (id, name) VALUES ('org-a','Org A'),('org-b','Org B')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a','org-a','Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b','org-b','Workspace B')").run();

function seedUser({ id, email, role = 'user' }) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)")
    .run(id, email, email.split('@')[0], role);
  return { id, email, role };
}
const adminUser = seedUser({ id: 'u-admin', email: 'admin@test.local', role: 'platform_admin' });
const orgAdminA = seedUser({ id: 'u-orgadmin-a', email: 'orgadmin-a@test.local', role: 'user' });
db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-a','u-orgadmin-a','org_admin')").run();
const operator = seedUser({ id: 'u-operator', email: 'operator@test.local', role: 'platform_operator' });
const regular = seedUser({ id: 'u-regular', email: 'regular@test.local', role: 'user' });
// Dedicated target for the role-assignment regression test (kept separate so it
// can't perturb the non-admin/operator tokens used by the deny tests above).
seedUser({ id: 'u-role-target', email: 'role-target@test.local', role: 'user' });

// Workspace move/assign targets (PUT /api/admin/users/:id/workspace).
seedUser({ id: 'u-ws-single', email: 'ws-single@test.local', role: 'user' });
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a','u-ws-single','workspace_editor')").run();
seedUser({ id: 'u-ws-zero', email: 'ws-zero@test.local', role: 'user' });
seedUser({ id: 'u-ws-multi', email: 'ws-multi@test.local', role: 'user' });
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a','u-ws-multi','workspace_viewer')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b','u-ws-multi','workspace_viewer')").run();

const tokens = {
  admin: generateToken(adminUser, null),
  orgAdminA: generateToken(orgAdminA, 'ws-a'),
  operator: generateToken(operator, null),
  regular: generateToken(regular, null),
};

// --- build + start the app ---
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);          // matches prod: auth before activityLogger
app.use(activityLogger);
app.use('/api/admin', requireAuth, adminRouter);
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

function post(pathname, token, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
const newUserBody = (over = {}) => ({
  email: 'created@test.local', name: 'Created User', password: 'TempPass123',
  workspaceId: 'ws-a', role: 'workspace_editor', mustChangePassword: true, ...over,
});

test('platform_admin can create a user (201); response omits password/hash; membership written', async () => {
  const res = await post('/api/admin/users', tokens.admin, newUserBody());
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.email, 'created@test.local');
  assert.equal(body.workspace_role, 'workspace_editor');
  assert.equal(body.must_change_password, 1);
  assert.ok(!('password' in body), 'response must not include password');
  assert.ok(!('password_hash' in body), 'response must not include hash');

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get('created@test.local');
  assert.ok(row && row.password_hash && row.password_hash !== 'TempPass123', 'password is hashed, not plaintext');
  const mem = db.prepare("SELECT * FROM workspace_members WHERE workspace_id='ws-a' AND user_id=?").get(row.id);
  assert.equal(mem.role, 'workspace_editor');
  assert.equal(mem.invited_by, 'u-admin');
  // HOSTED: excluded from welcome + activation-nudge lifecycle.
  assert.ok(row.welcome_email_sent_at && row.activation_nudge_sent_at, 'lifecycle sentinels stamped');
  /*
   * ...and verified, for the same reason (#292). Nobody ever sent this person a link - an
   * administrator typed their address in. Left at the schema default of 0 they saw a
   * "Please confirm your email address" banner they could not dismiss, and on an instance
   * with no SMTP configured could never clear; operators were fixing it by hand in the DB.
   */
  assert.equal(row.email_verified, 1, 'an admin-created user must not be asked to verify');
  // Audit row written, never the password.
  const audit = db.prepare("SELECT * FROM activity_log WHERE action='admin_create_user'").get();
  assert.ok(audit && /created@test\.local/.test(audit.details));
  assert.ok(!/TempPass123/.test(audit.details), 'audit must not contain the password');
});

test('duplicate email returns 409 and does not overwrite', async () => {
  const res = await post('/api/admin/users', tokens.admin, newUserBody({ password: 'Different999' }));
  assert.equal(res.status, 409);
  // original hash unchanged
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('created@test.local');
  assert.ok(bcrypt.compareSync('TempPass123', row.password_hash), 'existing password untouched');
});

test('non-admin user is denied (403)', async () => {
  const res = await post('/api/admin/users', tokens.regular, newUserBody({ email: 'x1@test.local' }));
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get('x1@test.local').c, 0);
});

test('platform_operator is denied from Add User (403) - user mgmt is owner-only', async () => {
  const res = await post('/api/admin/users', tokens.operator, newUserBody({ email: 'x2@test.local' }));
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get('x2@test.local').c, 0);
});

test('org_admin can create in their own org but NOT another org', async () => {
  const ok = await post('/api/admin/users', tokens.orgAdminA, newUserBody({ email: 'in-a@test.local', workspaceId: 'ws-a' }));
  assert.equal(ok.status, 201);

  const denied = await post('/api/admin/users', tokens.orgAdminA, newUserBody({ email: 'in-b@test.local', workspaceId: 'ws-b' }));
  assert.equal(denied.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get('in-b@test.local').c, 0);
});

test('validation: bad email 400, bad role 400, short password 400, missing workspace 404', async () => {
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: 'nope' }))).status, 400);
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: 'r@test.local', role: 'org_admin' }))).status, 400);
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: 'p@test.local', password: 'short' }))).status, 400);
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: 'w@test.local', workspaceId: 'ws-missing' }))).status, 404);
});

test('must_change_password lifecycle: set on create, surfaced on login, cleared on /me password change', async () => {
  // created@test.local was created with mustChangePassword:true in the first test.
  const login = await post('/api/auth/login', null, { email: 'created@test.local', password: 'TempPass123' });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.user.must_change_password, 1, 'login response carries the flag (drives the redirect)');

  // Change password via PUT /api/auth/me -> clears the flag.
  const meRes = await fetch(base + '/api/auth/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({ password: 'BrandNewPass1', current_password: 'TempPass123' }),
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.equal(meBody.must_change_password, 0, '/me response shows the flag cleared');
  const row = db.prepare('SELECT must_change_password FROM users WHERE email=?').get('created@test.local');
  assert.equal(row.must_change_password, 0, 'flag cleared in the DB');
});

test('platform_operator is assignable via PUT /users/:id/role (regression for #13/#14 whitelist gap)', async () => {
  const res = await fetch(base + '/api/auth/users/u-role-target/role', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.admin}` },
    body: JSON.stringify({ role: 'platform_operator' }),
  });
  assert.equal(res.status, 200);
  const dbRole = db.prepare('SELECT role FROM users WHERE id = ?').get('u-role-target').role;
  assert.equal(dbRole, 'platform_operator', 'role actually persisted as platform_operator');
});

// ---- PUT /api/admin/users/:id/workspace (move / assign single workspace) ----
function setWorkspace(userId, workspaceId, token) {
  return fetch(base + `/api/admin/users/${userId}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId }),
  });
}
const wsRows = id => db.prepare('SELECT workspace_id, role FROM workspace_members WHERE user_id = ?').all(id);

test('workspace move: single-membership user moved to another workspace (200, membership changed)', async () => {
  const res = await setWorkspace('u-ws-single', 'ws-b', tokens.admin);
  assert.equal(res.status, 200);
  const rows = wsRows('u-ws-single');
  assert.equal(rows.length, 1, 'still exactly one membership');
  assert.equal(rows[0].workspace_id, 'ws-b', 'moved to ws-b');
  assert.equal(rows[0].role, 'workspace_viewer', 'default role on move');
});

test('workspace assign: zero-membership user assigned a workspace (200)', async () => {
  const res = await setWorkspace('u-ws-zero', 'ws-a', tokens.admin);
  assert.equal(res.status, 200);
  const rows = wsRows('u-ws-zero');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, 'ws-a');
  assert.equal(rows[0].role, 'workspace_viewer');
});

test('workspace move REFUSED for a multi-membership user (400, untouched)', async () => {
  const res = await setWorkspace('u-ws-multi', 'ws-a', tokens.admin);
  assert.equal(res.status, 400);
  assert.equal(wsRows('u-ws-multi').length, 2, 'both memberships preserved');
});

test('workspace move denied for a non-platform-admin (403)', async () => {
  const reg = await setWorkspace('u-ws-zero', 'ws-b', tokens.regular);
  assert.equal(reg.status, 403);
  // platform_operator is also denied (platform user-mgmt is owner-only)
  const op = await setWorkspace('u-ws-zero', 'ws-b', tokens.operator);
  assert.equal(op.status, 403);
  assert.equal(wsRows('u-ws-zero')[0].workspace_id, 'ws-a', 'unchanged by denied calls');
});

// ---- Per-user multi-workspace membership management (Manage workspaces modal) ----
function ws(method, userId, token, { workspaceId, role, suffix = '' } = {}) {
  return fetch(base + `/api/admin/users/${userId}/workspaces${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(workspaceId || role ? { body: JSON.stringify({ workspaceId, role }) } : {}),
  });
}
seedUser({ id: 'u-mgmt', email: 'mgmt@test.local', role: 'user' });

test('membership mgmt: add a user to multiple workspaces with per-workspace roles', async () => {
  const a = await ws('POST', 'u-mgmt', tokens.admin, { workspaceId: 'ws-a', role: 'workspace_editor' });
  assert.equal(a.status, 201);
  const b = await ws('POST', 'u-mgmt', tokens.admin, { workspaceId: 'ws-b', role: 'workspace_viewer' });
  assert.equal(b.status, 201);
  const list = await (await ws('GET', 'u-mgmt', tokens.admin)).json();
  assert.equal(list.length, 2, 'user is now in two workspaces');
  assert.deepEqual(
    list.map(m => [m.workspace_id, m.role]).sort(),
    [['ws-a', 'workspace_editor'], ['ws-b', 'workspace_viewer']].sort()
  );
  assert.ok(list[0].workspace_name && list[0].organization_name, 'list carries names for the picker/summary');
});

test('membership mgmt: change role in one workspace', async () => {
  const r = await ws('PUT', 'u-mgmt', tokens.admin, { role: 'workspace_admin', suffix: '/ws-a' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT role FROM workspace_members WHERE user_id='u-mgmt' AND workspace_id='ws-a'").get().role, 'workspace_admin');
});

test('membership mgmt: re-adding an existing workspace updates the role (upsert, 200)', async () => {
  const r = await ws('POST', 'u-mgmt', tokens.admin, { workspaceId: 'ws-a', role: 'workspace_viewer' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT role FROM workspace_members WHERE user_id='u-mgmt' AND workspace_id='ws-a'").get().role, 'workspace_viewer');
});

test('membership mgmt: remove memberships, including the last one (-> unassigned)', async () => {
  assert.equal((await ws('DELETE', 'u-mgmt', tokens.admin, { suffix: '/ws-a' })).status, 200);
  assert.equal((await ws('DELETE', 'u-mgmt', tokens.admin, { suffix: '/ws-b' })).status, 200); // last one allowed
  assert.equal((await (await ws('GET', 'u-mgmt', tokens.admin)).json()).length, 0, 'user now unassigned');
});

test('membership mgmt: bad role 400, missing workspace 404, unknown user 404', async () => {
  assert.equal((await ws('POST', 'u-mgmt', tokens.admin, { workspaceId: 'ws-a', role: 'org_admin' })).status, 400);
  assert.equal((await ws('POST', 'u-mgmt', tokens.admin, { workspaceId: 'ws-missing', role: 'workspace_viewer' })).status, 404);
  assert.equal((await ws('GET', 'nobody', tokens.admin)).status, 404);
});

test('membership mgmt: non-platform-admin denied (403)', async () => {
  assert.equal((await ws('GET', 'u-mgmt', tokens.regular)).status, 403);
  assert.equal((await ws('POST', 'u-mgmt', tokens.operator, { workspaceId: 'ws-a', role: 'workspace_viewer' })).status, 403);
});

// --- #35: POST /api/admin/orgs (create org + first workspace, owned by admin) ---
test('platform_admin creates an org + Default workspace, owned by them (201)', async () => {
  const res = await post('/api/admin/orgs', tokens.admin, { name: 'Bold Media Group' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.name, 'Bold Media Group');
  assert.ok(body.id && body.workspace_id, 'returns org id + workspace id');
  assert.equal(body.owner_user_id, 'u-admin');

  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(body.id);
  assert.equal(org.owner_user_id, 'u-admin');
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(body.workspace_id);
  assert.equal(ws.organization_id, body.id);
  assert.equal(ws.name, 'Default');
  assert.equal(db.prepare("SELECT role FROM organization_members WHERE organization_id=? AND user_id='u-admin'").get(body.id).role, 'org_owner');
  assert.equal(db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id='u-admin'").get(body.workspace_id).role, 'workspace_admin');
  // audited
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action='admin_create_org'").get(), 'org creation audited');
});

test('create org: empty name is rejected (400), nothing created', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM organizations').get().c;
  const res = await post('/api/admin/orgs', tokens.admin, { name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM organizations').get().c, before);
});

test('create org: non-admin and operator denied (403)', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM organizations').get().c;
  assert.equal((await post('/api/admin/orgs', tokens.regular, { name: 'X' })).status, 403);
  assert.equal((await post('/api/admin/orgs', tokens.operator, { name: 'Y' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM organizations').get().c, before, 'no org created by denied callers');
});

// --- #36: DELETE /api/admin/orgs/:id and /workspaces/:id ---
const delReq = (pathname, token) => fetch(base + pathname, {
  method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test('platform_admin deletes an org (200): org + workspace + members removed', async () => {
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-del','Del Org','u-admin')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-del','u-admin','org_owner')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-del','org-del','Del WS')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-del','u-admin','workspace_admin')").run();

  const res = await delReq('/api/admin/orgs/org-del', tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM organizations WHERE id='org-del'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE id='ws-del'").get().c, 0);
  // member-table FK cascade is verified against the real cascaded FKs in
  // user-deletion.test.js (this minimal harness models no FKs).
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action='admin_delete_org'").get(), 'audited');
});

test('delete org: 404 unknown; 403 for non-admin + operator (no delete)', async () => {
  assert.equal((await delReq('/api/admin/orgs/nope', tokens.admin)).status, 404);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-keep','Keep','u-admin')").run();
  assert.equal((await delReq('/api/admin/orgs/org-keep', tokens.regular)).status, 403);
  assert.equal((await delReq('/api/admin/orgs/org-keep', tokens.operator)).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM organizations WHERE id='org-keep'").get().c, 1, 'denied callers did not delete');
});

test('platform_admin deletes a workspace (200): ws gone, parent org intact', async () => {
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-wd','WD','u-admin')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-wd','org-wd','WD WS')").run();
  const res = await delReq('/api/admin/workspaces/ws-wd', tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE id='ws-wd'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM organizations WHERE id='org-wd'").get().c, 1, 'org intact');
});
