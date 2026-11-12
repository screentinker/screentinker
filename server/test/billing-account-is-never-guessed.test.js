'use strict';
const S = require('node:path').join(__dirname, '..');
const R = (p) => require(S + '/' + p);
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const os = require('node:os'); const http = require('node:http'); const crypto = require('node:crypto');
const express = require('express');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-rv-' + crypto.randomBytes(4).toString('hex'));
const fakeStripe = () => ({
  customers: { create: async () => ({ id: 'cus_x' }), update: async () => ({}) },
  checkout: { sessions: { create: async () => ({ url: 'u' }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'u' }) } },
  subscriptions: { retrieve: async () => { throw new Error('stub'); } },
  webhooks: { constructEvent: (b) => JSON.parse(b) },
});
const sp = require.resolve('stripe', { paths: [S] });
require.cache[sp] = { id: sp, filename: sp, loaded: true, exports: fakeStripe };
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
const { db } = R('db/database');
const subs = R('middleware/subscription');
const orgBilling = R('lib/org-billing');
const stripeRouter = R('routes/stripe');
const { deleteOrgCascade } = R('lib/user-deletion');
const rid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');
const now = () => Math.floor(Date.now() / 1000);
let clock = 1000;
function person(name, f = {}) {
  const id = rid(name);
  db.prepare(`INSERT INTO users (id,email,name,password_hash,auth_provider,role,plan_id) VALUES (?,?,?,'x','local','user','free')`).run(id, id + '@t.local', name);
  const k = Object.keys(f); if (k.length) db.prepare(`UPDATE users SET ${k.map((x) => x + '=?').join(',')} WHERE id=?`).run(...k.map((x) => f[x]), id);
  return id;
}
function org(owner, name) {
  const o = rid('org'), w = rid('ws');
  db.prepare('INSERT INTO organizations (id,name,owner_user_id,created_at) VALUES (?,?,?,?)').run(o, name, owner, clock++);
  db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,'org_owner')").run(o, owner);
  db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(w, o, name);
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'workspace_admin')").run(w, owner);
  return { o, w };
}
const orgRow = (id) => db.prepare('SELECT * FROM organizations WHERE id=?').get(id);
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
let server, base;
const webhook = (type, object) => fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, data: { object } }) }).then((r) => r.json());
const X = {};
before(async () => {
  for (const [id, max] of [['free', 2], ['starter', 3], ['pro', 5]]) db.prepare(`INSERT INTO plans (id,name,display_name,max_devices,max_storage_mb) VALUES (?,?,?,?,100) ON CONFLICT(id) DO UPDATE SET max_devices=excluded.max_devices`).run(id, id, id, max);
  db.prepare("UPDATE plans SET stripe_price_monthly='price_pro_m' WHERE id='pro'").run();
  // A member who pays personally (Pro) and owns no organization: invited into Acme.
  X.boss = person('boss'); X.acme = org(X.boss, 'Acme');
  X.payer = person('payer', { plan_id: 'pro', stripe_customer_id: 'cus_payer', stripe_subscription_id: 'sub_payer' });
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'workspace_editor')").run(X.acme.w, X.payer);
  // An owner of two orgs; the second will be deleted while it pays (set after switch).
  X.two = person('two', { trial_started: now() - 86400, trial_plan: 'pro', plan_id: 'pro' });
  X.first = org(X.two, 'First');   // oldest: on a running trial
  X.second = org(X.two, 'Second');
  const r = orgBilling.switchToOrganizations(db);
  X.switch = r;
  const app = express(); app.use('/api/stripe', stripeRouter);
  server = http.createServer(app); await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { try { orgBilling.switchToPeople(db, { force: true }); } catch {} await new Promise((r) => server.close(r)); });


test('a person who pays but owns no organization blocks the switch, and is named', () => {
  assert.equal(X.switch.ok, false);
  assert.deepEqual(X.switch.drift, []);
  assert.deepEqual(X.switch.stranded.map((x) => [x.user_id, x.stripe_subscription_id]), [[X.payer, 'sub_payer']]);
  assert.equal(orgBilling.source(db), 'user', 'still the person paying');
});

test('once the payer is dealt with, the switch goes ahead', () => {
  db.prepare('UPDATE users SET stripe_subscription_id = NULL WHERE id = ?').run(X.payer);
  assert.equal(orgBilling.switchToOrganizations(db).ok, true);
  assert.equal(orgBilling.source(db), 'org');
});

test("a deleted organization's Stripe events touch no other organization", async () => {
  db.prepare("UPDATE organizations SET plan_id='pro', stripe_customer_id='cus_second', stripe_subscription_id='sub_second', trial_started=NULL WHERE id=?").run(X.second.o);
  deleteOrgCascade(db, { orgId: X.second.o, unlink: () => {} });
  const before = orgRow(X.first.o);
  await webhook('customer.subscription.deleted', { id: 'sub_second', customer: 'cus_second', status: 'canceled', metadata: { org_id: X.second.o, user_id: X.two, plan_id: 'pro' } });
  const mid = orgRow(X.first.o);
  assert.equal(mid.plan_id, before.plan_id, 'a cancellation did not end the other organization\'s plan');
  assert.equal(mid.subscription_status ?? null, before.subscription_status ?? null);
  await webhook('customer.subscription.updated', { id: 'sub_second', customer: 'cus_second', status: 'active', metadata: { org_id: X.second.o, user_id: X.two, plan_id: 'pro' }, items: { data: [{ price: { id: 'price_pro_m' } }] } });
  const f = orgRow(X.first.o);
  assert.equal(f.plan_id, before.plan_id);
  assert.equal(f.subscription_status ?? null, before.subscription_status ?? null);
  assert.equal(f.stripe_subscription_id ?? null, null);
});

test('the billing view exists even when the mirror cannot be filled', () => {
  const Database = require('better-sqlite3');
  const m = new Database(':memory:'); m.pragma('foreign_keys = OFF');
  m.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY);
    INSERT INTO plans(id) VALUES ('free');
    CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT, name TEXT, plan_id TEXT DEFAULT 'free' REFERENCES plans(id), stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT, trial_started INT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY, name TEXT, owner_user_id TEXT REFERENCES users(id), plan_id TEXT DEFAULT 'free' REFERENCES plans(id), created_at INT, updated_at INT);
    CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT, updated_at INT);
    INSERT INTO users(id, email, plan_id) VALUES ('u1', 'a@b.c', 'a_plan_that_is_gone');
    INSERT INTO organizations(id, name, owner_user_id, created_at) VALUES ('o1', 'O', 'u1', 1);`);
  m.pragma('foreign_keys = ON');
  const r = orgBilling.install(m, null);
  assert.equal(r.installed, false, 'the fill fails on the orphaned plan (the precondition)');
  assert.deepEqual(m.prepare(`SELECT id, email, plan_id FROM ${orgBilling.VIEW}`).all(), [{ id: 'u1', email: 'a@b.c', plan_id: 'a_plan_that_is_gone' }]);
});
