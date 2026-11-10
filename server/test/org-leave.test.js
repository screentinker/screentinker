'use strict';

/*
 * A PERSON CAN LEAVE AN ORGANIZATION; ITS OWNER ONLY BY NAMING A SUCCESSOR.
 *
 * Membership was something only an administrator could end: a member who wanted out had to ask
 * (DELETE .../members/<themself> answered "Admin access required"), and the owner could not go at
 * all. Leaving is the member's own decision.
 *
 * The invariant:
 *   - anyone can list the organizations they are in and leave one: every workspace membership in
 *     it and their organization role go, and nothing else of theirs does;
 *   - the OWNER cannot leave without choosing a new owner in the same request, and that choice
 *     follows every rule of a hand-over (someone inside it; the plan question while the person
 *     pays). A refused hand-over leaves them the owner and still a member;
 *   - a workspace is never left without an administrator while other people remain in it;
 *   - what they set up stays: the screens, the content, the playlists.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-orgleave-' + crypto.randomBytes(4).toString('hex'));

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
const router = require('../routes/org-ownership');
const workspaces = require('../routes/workspaces');

const rid = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const orgRow = (id) => db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
const orgRole = (o, u) => (db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(o, u) || {}).role || null;
const wsRole = (w, u) => (db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(w, u) || {}).role || null;
let clock = 12000;

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
function workspaceIn(o, name) { const w = rid('ws'); db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(w, o, name); return w; }
const join = (w, u, role = 'workspace_editor') => db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(w, u, role);
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
  for (const [id, max] of [['free', 2], ['pro', 5]]) {
    db.prepare(`INSERT INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES (?, ?, ?, ?, 100)
                ON CONFLICT(id) DO UPDATE SET max_devices = excluded.max_devices`).run(id, id, id, max);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', router);
  app.use('/api/workspaces', asHeaderUser, workspaces);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

test('a person sees the organizations they are in, and what leaving each would need', async () => {
  const owner = person('owner'), member = person('member');
  const { o, w } = organization(owner, 'Listed');
  join(w, member);
  const mine = await req('GET', '/api/organizations/mine', member);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const row = mine.body.organizations.find((x) => x.id === o);
  assert.deepEqual({ name: row.name, is_owner: row.is_owner, can_leave: row.can_leave }, { name: 'Listed', is_owner: false, can_leave: true });
  const own = (await req('GET', '/api/organizations/mine', owner)).body.organizations.find((x) => x.id === o);
  assert.equal(own.is_owner, true);
  assert.equal(own.needs_new_owner, true, 'the owner is told a successor is needed');
  assert.deepEqual(own.candidates.map((c) => c.id), [member]);
});

test('a member leaves: their memberships in it go, their work stays', async () => {
  const owner = person('owner'), member = person('member');
  const { o, w } = organization(owner, 'Leaving');
  const w2 = workspaceIn(o, 'Second'); join(w2, owner, 'workspace_admin');
  join(w, member); join(w2, member, 'workspace_viewer');
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_member')").run(o, member);
  const other = organization(member, 'Their own');                 // an organization of their own, untouched
  const d = screen(w, member);
  const r = await req('POST', `/api/organizations/${o}/leave`, member, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wsRole(w, member), null); assert.equal(wsRole(w2, member), null); assert.equal(orgRole(o, member), null);
  assert.equal(wsRole(other.w, member), 'workspace_admin', 'their own organization is untouched');
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE id = ?').get(d), 'the screen they paired stays with the workspace');
  assert.equal(orgRow(o).owner_user_id, owner);
  assert.equal((await req('POST', `/api/organizations/${o}/leave`, member, {})).status, 404, 'they are no longer in it');
  const log = db.prepare("SELECT details FROM activity_log WHERE action = 'org:member_left' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log && log.details.includes('Leaving'));
});

test('a plain member can also leave one workspace on their own', async () => {
  const owner = person('owner'), member = person('member');
  const { w } = organization(owner, 'OneWs');
  join(w, member);
  assert.equal((await req('DELETE', `/api/workspaces/${w}/members/${owner}`, member)).status, 403, 'they still cannot remove anyone else');
  const r = await req('DELETE', `/api/workspaces/${w}/members/${member}`, member);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wsRole(w, member), null);
});

test('the owner cannot leave without naming a new owner', async () => {
  const owner = person('owner'), member = person('member'), stranger = person('stranger');
  const { o, w } = organization(owner, 'Owned');
  join(w, member);
  const bare = await req('POST', `/api/organizations/${o}/leave`, owner, {});
  assert.equal(bare.status, 409, JSON.stringify(bare.body));
  assert.equal(bare.body.code, 'OWNER_MUST_HAND_OVER');
  assert.deepEqual(bare.body.candidates.map((c) => c.id), [member], 'and is told who it could be');
  assert.equal((await req('POST', `/api/organizations/${o}/leave`, owner, { new_owner_id: stranger })).status, 400, 'someone outside it is not a choice');
  assert.equal((await req('POST', `/api/organizations/${o}/leave`, owner, { new_owner_id: owner })).status, 400);
  assert.equal((await req('DELETE', `/api/workspaces/${w}/members/${owner}`, owner)).status, 409, 'nor by removing themself from its workspace');
  assert.equal(orgRow(o).owner_user_id, owner); assert.equal(wsRole(w, owner), 'workspace_admin'); assert.equal(orgRole(o, owner), 'org_owner');
});

test('the owner leaves by handing over: the successor owns and administers it, the old owner is gone from it', async () => {
  const owner = person('owner'), member = person('member');
  const { o, w } = organization(owner, 'Succession');
  join(w, member, 'workspace_viewer');
  const d = screen(w, owner);
  const r = await req('POST', `/api/organizations/${o}/leave`, owner, { new_owner_id: member });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(orgRow(o).owner_user_id, member); assert.equal(orgRole(o, member), 'org_owner');
  assert.equal(orgRole(o, owner), null); assert.equal(wsRole(w, owner), null);
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE id = ?').get(d));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM organization_members WHERE organization_id = ? AND role = 'org_owner'").get(o).c, 1);
});

test('an owner alone in the organization has nobody to hand it to, and is told so', async () => {
  const owner = person('solo');
  const { o } = organization(owner, 'Solo');
  const r = await req('POST', `/api/organizations/${o}/leave`, owner, {});
  assert.equal(r.status, 409); assert.equal(r.body.code, 'OWNER_MUST_HAND_OVER');
  assert.deepEqual(r.body.candidates, []);
  assert.match(r.body.error, /delete/i, 'the way out is deleting it (or the account), and it says so');
});

test('while the person pays, leaving with a hand-over that changes the plan needs the same acknowledgement', async () => {
  const owner = person('payer', { plan_id: 'pro', stripe_subscription_id: 'sub_x' }), member = person('free');
  const { o, w } = organization(owner, 'PaidLeave');
  join(w, member);
  const r = await req('POST', `/api/organizations/${o}/leave`, owner, { new_owner_id: member });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'PLAN_FOLLOWS_OWNER');
  assert.equal(orgRow(o).owner_user_id, owner, 'refused: still the owner');
  assert.equal(wsRole(w, owner), 'workspace_admin', 'and still a member');
  const ok = await req('POST', `/api/organizations/${o}/leave`, owner, { new_owner_id: member, acknowledge_plan_change: true });
  assert.equal(ok.status, 200);
  assert.equal(orgRow(o).owner_user_id, member); assert.equal(wsRole(w, owner), null);
});

test('an organization copied from another server is not changed here', async () => {
  const owner = person('owner'), member = person('member');
  const { o, w } = organization(owner, 'Copied');
  join(w, member);
  db.prepare("UPDATE workspaces SET origin_node_id = 'node-elsewhere' WHERE id = ?").run(w);
  const leave = await req('POST', `/api/organizations/${o}/leave`, member, {});
  assert.equal(leave.status, 409); assert.equal(leave.body.code, 'COPIED_ORGANIZATION');
  const hand = await req('POST', `/api/organizations/${o}/ownership`, owner, { user_id: member });
  assert.equal(hand.status, 409); assert.equal(hand.body.code, 'COPIED_ORGANIZATION');
  assert.equal(orgRow(o).owner_user_id, owner); assert.equal(wsRole(w, member), 'workspace_editor', 'nothing changed');
});

test('a workspace is not left without an administrator while other people are in it', async () => {
  const owner = person('owner'), lead = person('lead'), staff = person('staff');
  const { o } = organization(owner, 'Headless');
  const w2 = workspaceIn(o, 'Branch'); join(w2, lead, 'workspace_admin'); join(w2, staff);
  const r = await req('POST', `/api/organizations/${o}/leave`, lead, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LAST_WORKSPACE_ADMIN');
  assert.deepEqual(r.body.workspaces.map((x) => x.name), ['Branch']);
  assert.equal(wsRole(w2, lead), 'workspace_admin', 'nothing changed');
  db.prepare("UPDATE workspace_members SET role = 'workspace_admin' WHERE workspace_id = ? AND user_id = ?").run(w2, staff);
  assert.equal((await req('POST', `/api/organizations/${o}/leave`, lead, {})).status, 200, 'once someone else administers it, they can go');
  // The last person in a workspace takes nobody's administrator away by leaving.
  const w3 = workspaceIn(o, 'Empty soon'); const only = person('only'); join(w3, only, 'workspace_admin');
  assert.equal((await req('POST', `/api/organizations/${o}/leave`, only, {})).status, 200);
});
