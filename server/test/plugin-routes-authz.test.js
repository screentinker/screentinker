'use strict';

// Route-level authorization for the plugin surface, against the REAL routers + real auth/tenancy
// middleware and a real (in-memory) sqlite DB -- the "supertest pass" the review asked for. Closes
// the gap where the submission authz contract was only asserted at the lib level.
//
// Pattern mirrors admin-users.test.js: inject an in-memory better-sqlite3 into the require cache for
// ../db/database BEFORE any router loads, mount the routers as prod does, and drive them over HTTP.
// PLUGINS_ENABLED must be set before config is required (admin-plugins reads it at load).

process.env.PLUGINS_ENABLED = 'true';
process.env.JWT_SECRET = 'test-secret-plugin-authz';
// Point plugin roots at empty temp dirs so rescan() finds nothing (we are testing authz, not loading).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plugauthz-'));
process.env.BUNDLED_PLUGINS_DIR = path.join(TMP, 'bundled');
process.env.PLUGINS_DIR = path.join(TMP, 'data');
process.env.PLUGIN_INBOX_DIR = path.join(TMP, 'inbox');
fs.mkdirSync(process.env.BUNDLED_PLUGINS_DIR, { recursive: true });
fs.mkdirSync(process.env.PLUGINS_DIR, { recursive: true });
fs.mkdirSync(process.env.PLUGIN_INBOX_DIR, { recursive: true });

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', provider_id TEXT, avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT,
    plan_id TEXT, subscription_status TEXT, sso_only INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
    slug TEXT, created_by TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
  CREATE TABLE organization_members (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'org_admin', UNIQUE(organization_id, user_id));
  CREATE TABLE workspace_members (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'workspace_viewer', UNIQUE(workspace_id, user_id));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT,
    action TEXT NOT NULL, details TEXT, ip_address TEXT, workspace_id TEXT, organization_id TEXT,
    status_code INTEGER, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
`);
// The three plugin tables, from the shipped schema so columns cannot drift.
const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec((schema.match(/CREATE TABLE IF NOT EXISTS plugin_[\s\S]*?\);/g) || []).join('\n'));

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = {
  id: dbModulePath, filename: dbModulePath, loaded: true,
  exports: { db, pruneTelemetry() {}, pruneScreenshots() {} },
};

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const adminRouter = require('../routes/admin');
const pluginSubmissionsRouter = require('../routes/plugin-submissions');

// Seed org / workspace / three roles.
db.prepare("INSERT INTO organizations (id, name) VALUES ('org-a','Org A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a','org-a','WS A')").run();
function seed(id, email, role, wsRole) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'x', ?)").run(id, email, id, role);
  if (wsRole) db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', ?, ?)").run(id, wsRole);
  return { id, email, role };
}
const admin = seed('u-admin', 'admin@t.local', 'platform_admin', null);
const editor = seed('u-editor', 'editor@t.local', 'user', 'workspace_editor');
const viewer = seed('u-viewer', 'viewer@t.local', 'user', 'workspace_viewer');
const tokens = {
  admin: generateToken(admin, null),
  editor: generateToken(editor, 'ws-a'),
  viewer: generateToken(viewer, 'ws-a'),
};

const app = express();
app.use(express.json());
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/plugin-submissions', requireAuth, resolveTenancy, pluginSubmissionsRouter);
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function req(method, pathname, token) {
  return fetch(base + pathname, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test('GET /api/admin/plugins is platform-admin only', async () => {
  assert.equal((await req('GET', '/api/admin/plugins', null)).status, 401, 'no token -> 401');
  assert.equal((await req('GET', '/api/admin/plugins', tokens.viewer)).status, 403, 'viewer -> 403');
  assert.equal((await req('GET', '/api/admin/plugins', tokens.editor)).status, 403, 'editor -> 403');
  assert.equal((await req('GET', '/api/admin/plugins', tokens.admin)).status, 200, 'admin -> 200');
});

test('admin install/enable primitives are platform-admin only', async () => {
  // Approve is the RCE-adjacent one; a non-admin must never reach it.
  assert.equal((await req('POST', '/api/admin/plugins/submissions/1/approve', tokens.editor)).status, 403);
  assert.equal((await req('POST', '/api/admin/plugins/some-id/enable', tokens.viewer)).status, 403);
});

test('POST /api/plugin-submissions requires workspace write (canWrite)', async () => {
  // Viewer is refused at the authz gate, before any file handling.
  assert.equal((await req('POST', '/api/plugin-submissions', tokens.viewer)).status, 403, 'viewer cannot submit');
  // Editor passes authz and only then hits the "zip required" check -> proves the gate let them through.
  const editorRes = await req('POST', '/api/plugin-submissions', tokens.editor);
  assert.equal(editorRes.status, 400, 'editor passes authz, fails on missing zip');
  const body = await editorRes.json();
  assert.match(body.error, /zip/i, 'editor reached the file-required check');
  // No token -> 401.
  assert.equal((await req('POST', '/api/plugin-submissions', null)).status, 401, 'no token -> 401');
});

test('GET /api/plugin-submissions: viewer refused, editor allowed', async () => {
  assert.equal((await req('GET', '/api/plugin-submissions', tokens.viewer)).status, 403);
  assert.equal((await req('GET', '/api/plugin-submissions', tokens.editor)).status, 200);
});
