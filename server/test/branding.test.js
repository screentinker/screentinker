'use strict';

// Issue #15: instance-level default branding. Tests the resolver order
// (workspace row -> custom-domain -> platform default -> hardcoded) and the
// platform-admin GET/PUT /api/admin/branding endpoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-branding';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE white_labels (
    id TEXT PRIMARY KEY, user_id TEXT, brand_name TEXT NOT NULL DEFAULT 'ScreenTinker',
    logo_url TEXT, favicon_url TEXT, primary_color TEXT DEFAULT '#e65c00',
    secondary_color TEXT DEFAULT '#1E293B', bg_color TEXT DEFAULT '#111827',
    custom_domain TEXT, custom_css TEXT, hide_branding INTEGER DEFAULT 0,
    workspace_id TEXT, created_at INTEGER DEFAULT (strftime('%s','now')), updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT NOT NULL,
    details TEXT, ip_address TEXT, workspace_id TEXT, created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db, pruneTelemetry() { }, pruneScreenshots() { } } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveBranding } = require('../lib/branding');
const adminRouter = require('../routes/admin');

db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES ('u-admin','admin@test.local','platform_admin','x')").run();
db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES ('u-reg','reg@test.local','user','x')").run();
const tokens = {
  admin: generateToken({ id: 'u-admin', email: 'admin@test.local', role: 'platform_admin' }, null),
  reg: generateToken({ id: 'u-reg', email: 'reg@test.local', role: 'user' }, null),
};

const app = express();
app.use(express.json());
app.use('/api/admin', requireAuth, adminRouter);
const server = app.listen(0);
let base;
test.before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

const wl = (id, fields) => db.prepare(
  `INSERT INTO white_labels (id, user_id, brand_name, custom_domain, workspace_id) VALUES (?, 'u-admin', ?, ?, ?)`
).run(id, fields.brand_name, fields.custom_domain || null, fields.workspace_id || null);

test('resolver order: workspace row > domain > platform default > hardcoded', () => {
  db.prepare('DELETE FROM white_labels').run();
  wl('w1', { brand_name: 'WS One', workspace_id: 'ws1' });
  // a custom-domain row belongs to a workspace (realistic); also seed a legacy
  // null-workspace row to prove the fixed-id sentinel ignores it.
  wl('dom', { brand_name: 'Domain Brand', custom_domain: 'cust.example', workspace_id: 'ws-dom' });
  wl('legacy', { brand_name: 'Legacy Null WS', workspace_id: null });
  wl('platform-default', { brand_name: 'Global Default', workspace_id: null }); // fixed-id platform default

  assert.equal(resolveBranding(db, { workspaceId: 'ws1' }).brand_name, 'WS One', 'workspace row wins');
  assert.equal(resolveBranding(db, { domain: 'cust.example' }).brand_name, 'Domain Brand', 'domain match');
  assert.equal(resolveBranding(db, { workspaceId: 'ws-none' }).brand_name, 'Global Default', 'unbranded workspace inherits platform default (not the legacy null-ws row)');
  assert.equal(resolveBranding(db, {}).brand_name, 'Global Default', 'no context -> platform default');

  db.prepare("DELETE FROM white_labels WHERE id='platform-default'").run();
  assert.equal(resolveBranding(db, {}).brand_name, 'ScreenTinker', 'no platform default -> hardcoded (legacy null-ws row not used)');
});

test('GET /api/admin/branding returns hardcoded default when none set', async () => {
  db.prepare('DELETE FROM white_labels').run();
  const res = await fetch(base + '/api/admin/branding', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).brand_name, 'ScreenTinker');
});

test('PUT /api/admin/branding creates then updates the single platform-default row', async () => {
  const put = (body) => fetch(base + '/api/admin/branding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.admin}` }, body: JSON.stringify(body),
  });
  let res = await put({ brand_name: 'Acme Signage', primary_color: '#10b981', hide_branding: true });
  assert.equal(res.status, 200);
  // exactly one platform-default row, with workspace_id NULL
  let rows = db.prepare("SELECT * FROM white_labels WHERE id = 'platform-default'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brand_name, 'Acme Signage');
  assert.equal(rows[0].primary_color, '#10b981');
  assert.equal(rows[0].hide_branding, 1);

  // second PUT updates the same row (no second row)
  res = await put({ brand_name: 'Acme Displays' });
  assert.equal(res.status, 200);
  rows = db.prepare("SELECT * FROM white_labels WHERE id = 'platform-default'").all();
  assert.equal(rows.length, 1, 'still a single platform-default row');
  assert.equal(rows[0].brand_name, 'Acme Displays');

  // and now an unbranded workspace resolves to it
  assert.equal(resolveBranding(db, { workspaceId: 'whatever' }).brand_name, 'Acme Displays');
});

test('branding endpoints are platform-admin only (403 for a regular user)', async () => {
  const get = await fetch(base + '/api/admin/branding', { headers: { Authorization: `Bearer ${tokens.reg}` } });
  assert.equal(get.status, 403);
  const put = await fetch(base + '/api/admin/branding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.reg}` }, body: JSON.stringify({ brand_name: 'Hacker' }),
  });
  assert.equal(put.status, 403);
});
