'use strict';

// A plan can be hidden from customers by setting active = 0 — that is how a comped or beta tier is
// kept off the pricing page. But the only plan listing was /api/subscription/plans, which filters
// `active = 1` because it FEEDS that pricing page. So a hidden plan was invisible to the operator
// too: no way to see it existed, or who was on it, from the admin screen that is supposed to show
// exactly that.
//
// Two invariants, and they pull in opposite directions, which is why both are pinned here:
//   - the PUBLIC list must never leak an inactive plan (that is the whole point of hiding it)
//   - the ADMIN list must show every plan, with how many accounts are on each
//
// Isolated in-memory DB injected into the require cache, same approach as admin-users.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-admin-plans';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 2,
    max_storage_mb INTEGER NOT NULL DEFAULT 500,
    remote_control INTEGER NOT NULL DEFAULT 0,
    remote_url INTEGER NOT NULL DEFAULT 0,
    priority_support INTEGER NOT NULL DEFAULT 0,
    price_monthly REAL NOT NULL DEFAULT 0,
    price_yearly REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  -- Columns here are the ones resolveSessionUser selects; a missing one makes requireAuth throw
  -- and the request comes back 401, which reads like an auth bug rather than a schema gap.
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT,
    email_alerts INTEGER DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL, plan_id TEXT
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT
  );

  INSERT INTO plans (id,name,display_name,max_devices,price_monthly,sort_order,active) VALUES
    ('free','free','Free',1,0,0,1),
    ('pro','pro','Pro',15,99,3,1),
    ('beta','beta','Beta Tester',8,0,9,0);

  INSERT INTO users (id,email,role,plan_id) VALUES
    ('padmin','padmin@t.local','platform_admin','pro'),
    ('u1','u1@t.local','user','beta'),
    ('u2','u2@t.local','user','beta'),
    ('u3','u3@t.local','user','pro');

  INSERT INTO organizations (id,name,owner_user_id,plan_id) VALUES ('o1','Org One','u1','beta');
  INSERT INTO workspaces (id,organization_id,name) VALUES ('w1','o1','WS One');
  INSERT INTO devices (id,name,workspace_id) VALUES ('d1','Screen','w1'), ('d2','Screen 2','w1');
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const { requireAuth, generateToken } = require('../middleware/auth');
const adminRouter = require('../routes/admin');
const subscriptionRouter = require('../routes/subscription');

// Use the app's own token factory rather than hand-rolling claims — it owns the secret, the
// algorithm and the claim shape, and a test that guesses those tests the guess.
const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const adminToken = generateToken(row('padmin'), null);
const userToken = generateToken(row('u1'), null);

const app = express();
app.use(express.json());
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/subscription', subscriptionRouter);
const server = app.listen(0);

async function get(pathname, token) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

test('THE POINT: the admin list includes a hidden plan', async () => {
  const { status, body } = await get('/api/admin/plans', adminToken);
  assert.equal(status, 200);
  const ids = body.plans.map(p => p.id);
  assert.ok(ids.includes('beta'), `hidden plan missing from the admin view: ${ids.join(',')}`);
  assert.equal(body.plans.find(p => p.id === 'beta').active, 0);
});

test('and it reports how many accounts are on each plan', async () => {
  const { body } = await get('/api/admin/plans', adminToken);
  const by = Object.fromEntries(body.plans.map(p => [p.id, p]));
  assert.equal(by.beta.user_count, 2);
  assert.equal(by.pro.user_count, 2);   // padmin + u3
  assert.equal(by.free.user_count, 0);
  assert.equal(by.beta.org_count, 1);
  assert.equal(by.beta.device_count, 2, 'screens owned by accounts on the plan');
});

test('THE OTHER HALF: the public list must NOT leak a hidden plan', async () => {
  // If this ever fails, hiding a comped tier stops working and it appears on the pricing page.
  const { status, body } = await get('/api/subscription/plans');
  assert.equal(status, 200);
  const ids = body.map(p => p.id);
  assert.deepEqual(ids.sort(), ['free', 'pro'], `inactive plan leaked: ${ids.join(',')}`);
});

test('visible plans sort before hidden ones, so the list reads naturally', async () => {
  const { body } = await get('/api/admin/plans', adminToken);
  const firstHidden = body.plans.findIndex(p => !p.active);
  const lastVisible = body.plans.reduce((acc, p, i) => (p.active ? i : acc), -1);
  assert.ok(firstHidden > lastVisible, 'hidden plans should come after the visible ones');
});

test('a non-platform-admin cannot read the plan overview', async () => {
  assert.equal((await get('/api/admin/plans', userToken)).status, 403);
});

test('an unauthenticated caller cannot read it either', async () => {
  assert.equal((await get('/api/admin/plans')).status, 401);
});

// The Users table's plan picker is where a plan gets ASSIGNED. It read the public list, so a hidden
// plan (e.g. a customer's own plan) could not be picked there, although the plan editor's help text
// says a hidden plan "can still be assigned to users here". Pin it to the admin list.
test('the Users plan picker offers hidden plans (admin list, not the public one)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../../frontend/js/views/admin.js'), 'utf8');
  const start = src.indexOf('async function loadUsers(');
  assert.ok(start >= 0, 'loadUsers not found');
  const body = src.slice(start, src.indexOf('\nasync function ', start + 1));
  const fetchPart = body.slice(0, body.indexOf('el.innerHTML'));
  assert.match(fetchPart, /api\.adminListPlans\(\)/, 'loadUsers should load plans from the admin list');
  assert.ok(fetchPart.indexOf('adminListPlans') < fetchPart.lastIndexOf("fetch('/api/subscription/plans')"),
    'the public list may only be the fallback for a caller who cannot read the admin list');
});

test.after(() => { server.close(); });
