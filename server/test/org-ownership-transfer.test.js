'use strict';

/*
 * AN ORGANIZATION CAN BE HANDED TO SOMEONE ELSE.
 *
 * An organization has exactly one owner, and nothing could change who that is. So the person who
 * signed up for a company and then left it could not be replaced: they could not delete their own
 * account ("an organization you own has other members"), nobody could remove them, and whoever
 * took over could never hold the owner's powers.
 *
 * The invariant:
 *   - the owner, or the instance operator, can hand an organization to another person who is
 *     already in it; nobody else can, and nobody outside it can be given it;
 *   - afterwards the new person IS the owner (role and all), the previous owner stays as an
 *     organization admin, and can now leave or delete their account;
 *   - the organization's screens, content, members and (once the organization pays) its plan and
 *     subscription are untouched;
 *   - while the PERSON still pays, the plan follows the owner, so a hand-over that would change
 *     the plan is refused until the caller says they know.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-orgown-' + crypto.randomBytes(4).toString('hex'));

const realAuth = require('../middleware/auth');
const authPath = require.resolve('../middleware/auth');
let dbRef;
const asHeaderUser = (req, res, next) => {
  const u = dbRef.prepare('SELECT * FROM users WHERE id = ?').get(req.headers['x-test-user'] || '');
  if (!u) return res.status(401).json({ error: 'no test user' });
  req.user = u; next();
};
require.cache[authPath].exports = { ...realAuth, requireAuth: asHeaderUser };

const { db } = require('../db/database');
dbRef = db;
const orgBilling = require('../lib/org-billing');
const subs = require('../middleware/subscription');
const accountDeletion = require('../lib/account-deletion');
const router = require('../routes/org-ownership');

const rid = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const orgRow = (id) => db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const orgRole = (o, u) => (db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(o, u) || {}).role || null;
let clock = 9000;

function person(name, fields = {}) {
  const id = rid(name);
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, email_verified) VALUES (?, ?, ?, 'x', 'local', 'user', 'free', 1)`).run(id, `${id}@t.local`, name);
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  return id;
}
function organization(owner, name) {
  const o = rid('org'), w = rid('ws');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').run(o, name, owner, clock++);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(o, owner);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(w, o, name + ' ws');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(w, owner);
  return { o, w };
}
const joinWorkspace = (w, u, role = 'workspace_editor') => db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(w, u, role);
function screen(ws, by) {
  const id = rid('d');
  db.prepare(`INSERT INTO devices (id, name, status, user_id, workspace_id, device_token, client_type, created_at) VALUES (?, 'S', 'online', ?, ?, ?, 'apk', ?)`)
    .run(id, by, ws, crypto.randomBytes(16).toString('hex'), clock++);
  return id;
}

let server, base;
const req = (method, p, user, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  for (const [id, max] of [['free', 2], ['starter', 3], ['pro', 5]]) {
    db.prepare(`INSERT INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES (?, ?, ?, ?, 100)
                ON CONFLICT(id) DO UPDATE SET max_devices = excluded.max_devices`).run(id, id, id, max);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { try { orgBilling.switchToPeople(db, { force: true }); } catch { /* */ } await new Promise((r) => server.close(r)); });

test('the owner sees who the organization could be handed to: the people already in it', async () => {
  const owner = person('owner'), a = person('alice'), b = person('bob'), stranger = person('stranger');
  const { o, w } = organization(owner, 'Acme');
  joinWorkspace(w, a); db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(o, b);
  const r = await req('GET', `/api/organizations/${o}/ownership`, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.owner.id, owner);
  assert.deepEqual(r.body.candidates.map((c) => c.id).sort(), [a, b].sort(), 'members and organization admins, not the owner, not strangers');
  assert.equal(r.body.can_transfer, true);
  assert.equal((await req('GET', `/api/organizations/${o}/ownership`, a)).body.can_transfer, false, 'a member can look but not hand it over');
  assert.equal((await req('GET', `/api/organizations/${o}/ownership`, stranger)).status, 404, 'someone outside it cannot see it at all');
});

test('who may hand it over: the owner or the operator, to someone inside it', async () => {
  const owner = person('owner', { plan_id: 'free' }), member = person('member'), admin = person('orgadmin'), stranger = person('stranger');
  const operator = person('operator', { role: 'platform_admin' });
  const { o, w } = organization(owner, 'Rules');
  joinWorkspace(w, member); db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(o, admin);
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, member, { user_id: member })).status, 403, 'a member cannot take it');
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, admin, { user_id: admin })).status, 403, 'nor an organization admin');
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: stranger })).status, 400, 'it cannot go to someone outside it');
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: owner })).status, 400, 'nor to the person who has it');
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: 'nobody' })).status, 400);
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, owner, {})).status, 400);
  assert.equal(orgRow(o).owner_user_id, owner, 'nothing above changed anything');
  const r = await req('POST', `/api/organizations/${o}/ownership`, operator, { user_id: admin });
  assert.equal(r.status, 200, 'the operator can, for an owner who is gone: ' + JSON.stringify(r.body));
  assert.equal(orgRow(o).owner_user_id, admin);
});

test('after a hand-over the new person is the owner, the old one an admin who can now leave', async () => {
  const owner = person('owner'), next = person('next');
  const { o, w } = organization(owner, 'Handover');
  joinWorkspace(w, next);
  const d1 = screen(w, owner), d2 = screen(w, next);
  assert.equal(accountDeletion.deletionInfo(db, userRow(owner), {}).blocked, 'org_has_other_members', 'before: the owner cannot delete their account');
  const r = await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: next });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.owner.id, next);
  assert.equal(orgRow(o).owner_user_id, next);
  assert.equal(orgRole(o, next), 'org_owner');
  assert.equal(orgRole(o, owner), 'org_admin', 'the previous owner keeps access, as an organization admin');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM organization_members WHERE organization_id = ? AND role = 'org_owner'").get(o).c, 1, 'exactly one owner');
  assert.deepEqual(db.prepare('SELECT id FROM devices WHERE workspace_id = ? ORDER BY created_at').all(w).map((x) => x.id), [d1, d2], 'screens untouched');
  assert.notEqual(accountDeletion.deletionInfo(db, userRow(owner), {}).blocked, 'org_has_other_members', 'after: they can delete their account');
  assert.equal((await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: owner })).status, 403, 'and they can no longer hand it to anyone');
  const log = db.prepare("SELECT details FROM activity_log WHERE action = 'org:ownership_transferred' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log && log.details.includes('Handover'), 'it is in the activity log');
});

test('while the person pays, a hand-over that would change the plan is refused until acknowledged', async () => {
  assert.equal(subs.billingSource(), 'user');
  const owner = person('payer', { plan_id: 'pro', stripe_customer_id: 'cus_p', stripe_subscription_id: 'sub_p' }), next = person('nextfree');
  const { o, w } = organization(owner, 'Paid');
  joinWorkspace(w, next);
  const r = await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: next });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PLAN_FOLLOWS_OWNER');
  assert.equal(r.body.from_plan, 'pro'); assert.equal(r.body.to_plan, 'free');
  assert.equal(orgRow(o).owner_user_id, owner, 'nothing changed');
  const ok = await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: next, acknowledge_plan_change: true });
  assert.equal(ok.status, 200);
  assert.equal(orgRow(o).plan_id, 'free', 'the organization now follows its new owner\'s plan');
  assert.equal(userRow(owner).stripe_subscription_id, 'sub_p', 'the subscription stays with the person who pays for it');
  // Same plan on both sides: no question asked.
  const a = person('a', { plan_id: 'free' }), b = person('b', { plan_id: 'free' });
  const second = organization(a, 'Same'); joinWorkspace(second.w, b);
  assert.equal((await req('POST', `/api/organizations/${second.o}/ownership`, a, { user_id: b })).status, 200);
});

test('once the organization pays, a hand-over leaves its plan and subscription exactly where they are', async () => {
  const owner = person('orgpayer', { plan_id: 'pro', stripe_customer_id: 'cus_o', stripe_subscription_id: 'sub_o' }), next = person('successor');
  const { o, w } = organization(owner, 'OrgPays');
  joinWorkspace(w, next);
  const nextOwn = organization(next, 'Successor personal');       // the successor already owns one of their own, on Free
  assert.equal(orgBilling.switchToOrganizations(db).ok, true);
  try {
    const r = await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: next });
    assert.equal(r.status, 200, 'no acknowledgement needed: ' + JSON.stringify(r.body));
    const org = orgRow(o);
    assert.equal(org.owner_user_id, next);
    assert.equal(org.plan_id, 'pro'); assert.equal(org.stripe_subscription_id, 'sub_o'); assert.equal(org.stripe_customer_id, 'cus_o');
    assert.equal(orgRow(nextOwn.o).plan_id, 'free', 'the successor\'s own organization is not given the plan');
    // The previous owner now owns nothing: their own row no longer claims the subscription.
    const old = userRow(owner);
    assert.equal(old.plan_id, 'free'); assert.equal(old.stripe_subscription_id, null); assert.equal(old.stripe_customer_id, null);
    // The successor's row is the copy of their OLDEST organization (the one just handed over is older).
    assert.equal(userRow(next).plan_id, 'pro');
    assert.equal(subs.getOrgPlan(o).max_devices, 5, 'the organization\'s limits did not move');
  } finally { orgBilling.switchToPeople(db, { force: true }); }
});
