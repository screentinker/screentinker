'use strict';

/*
 * Creating a workspace inside an organization you administer.
 *
 * ⚠️ THE REASON THIS ROUTE DID NOT EXIST UNTIL NOW is worth recording: production had 313
 * organizations and 313 workspaces, exactly one each, all named "Default". That was not a signal
 * about demand — a workspace row was only ever written at signup and by the platform admin, so a
 * second one was unobtainable through the product. The multi-workspace model was fully built
 * underneath (scoping, invites, switching, the JWT context) and had no front door.
 *
 * The tests that matter here are the authorization ones. A create is an ORG-level action, and the
 * failure mode of getting it wrong is not a 500 — it is a workspace quietly appearing inside
 * somebody else's tenant, which every workspace-scoped route downstream would then treat as
 * legitimately theirs.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-wscreate-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');

let server, base;
/** Who the stub auth layer says the caller is. Swapped per test. */
let actingUser = null;

function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${pathname}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = out ? JSON.parse(out) : null; } catch (e) { parsed = out; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const mkUser = (id, email, role = 'user') =>
  db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, email, email, 'x', role);
const mkOrg = (id, owner) =>
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run(id, id + ' org', owner);
const mkOrgMember = (org, user, role) =>
  db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?,?,?)').run(org, user, role);
const mkWs = (id, org, name = 'Default') =>
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?,?,?)').run(id, org, name);

before(async () => {
  mkUser('u-owner', 'owner@x.test');
  mkUser('u-admin', 'admin@x.test');
  mkUser('u-member', 'member@x.test');
  mkUser('u-outsider', 'outsider@x.test');
  mkUser('u-wsadmin', 'wsadmin@x.test');
  mkUser('u-platform', 'platform@x.test', 'platform_admin');

  mkOrg('org-a', 'u-owner');
  mkOrg('org-b', 'u-outsider');
  mkOrgMember('org-a', 'u-owner', 'org_owner');
  mkOrgMember('org-a', 'u-admin', 'org_admin');
  mkOrgMember('org-a', 'u-member', 'org_member');
  mkOrgMember('org-a', 'u-wsadmin', 'org_member');
  mkOrgMember('org-b', 'u-outsider', 'org_owner');

  mkWs('ws-a', 'org-a');
  mkWs('ws-b', 'org-b');
  // u-wsadmin administers ONE workspace but holds no org role — the interesting negative case.
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a','u-wsadmin','workspace_admin')").run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actingUser; next(); });
  app.use('/', require('../routes/workspaces'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { try { server.close(); } catch (e) { /* */ } });

const as = (id, role = 'user') => { actingUser = { id, role }; };
const countIn = (org) => db.prepare('SELECT COUNT(*) c FROM workspaces WHERE organization_id = ?').get(org).c;

/* ================================================================= the happy path */

test('an org owner creates a workspace and is made its admin', async () => {
  as('u-owner');
  const r = await call('POST', '/', { name: 'Retail Floor' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Retail Floor');
  assert.equal(r.body.organization_id, 'org-a', 'the org came from membership, not from the body');
  assert.equal(r.body.can_admin, true);

  const wm = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(r.body.id, 'u-owner');
  assert.equal(wm && wm.role, 'workspace_admin',
    'the creator must be a member, or they own a workspace they cannot administer or invite into');
});

test('an org admin can create one too', async () => {
  as('u-admin');
  const r = await call('POST', '/', { name: 'Head Office' });
  assert.equal(r.status, 201);
  assert.equal(r.body.organization_id, 'org-a');
});

test('a slug is accepted, normalised, and must be unique within the org', async () => {
  as('u-owner');
  const ok = await call('POST', '/', { name: 'Lobby', slug: '  LOBBY  ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.slug, 'lobby', 'the slug should be trimmed and lowercased');

  const dup = await call('POST', '/', { name: 'Lobby Two', slug: 'lobby' });
  assert.equal(dup.status, 409, 'a duplicate slug in the same org must conflict, not silently succeed');
});

/* ================================================================= authorization */

test('⚠️ a workspace_admin with no org role CANNOT create a sibling workspace', async () => {
  /*
   * The distinction the whole route rests on: administering one workspace is a delegated,
   * bounded job. If it also created siblings, anyone handed a corner of a tenant could grow it.
   */
  as('u-wsadmin');
  const before = countIn('org-a');
  const r = await call('POST', '/', { name: 'Sneaky' });
  assert.equal(r.status, 403);
  assert.equal(countIn('org-a'), before, 'nothing may be written on a refusal');
});

test('⚠️ an ordinary org member cannot create one', async () => {
  as('u-member');
  const r = await call('POST', '/', { name: 'Nope' });
  assert.equal(r.status, 403);
});

test('⚠️ organization_id in the body cannot reach a tenant you do not administer', async () => {
  /*
   * The failure this prevents is not an error page — it is a workspace appearing inside someone
   * else's organization, which every workspace-scoped route downstream would then treat as
   * legitimately theirs.
   */
  as('u-owner');                       // owns org-a, nothing in org-b
  const before = countIn('org-b');
  const r = await call('POST', '/', { name: 'Landgrab', organization_id: 'org-b' });
  assert.equal(r.status, 403);
  assert.equal(countIn('org-b'), before, 'no workspace may be written into the other org');
});

test('an unknown organization_id is a 404, not a 500', async () => {
  as('u-owner');
  const r = await call('POST', '/', { name: 'x', organization_id: 'org-does-not-exist' });
  assert.equal(r.status, 404);
});

test('a platform admin may target any organization explicitly', async () => {
  as('u-platform', 'platform_admin');
  const r = await call('POST', '/', { name: 'Support Sandbox', organization_id: 'org-b' });
  assert.equal(r.status, 201);
  assert.equal(r.body.organization_id, 'org-b');
});

test('someone who administers no organization is refused', async () => {
  as('u-member');
  const r = await call('POST', '/', { name: 'x' });
  assert.equal(r.status, 403);
  assert.match(String(r.body.error), /organization owner or admin/i);
});

/* ================================================================= validation + limits */

test('a missing or oversized name is refused', async () => {
  as('u-owner');
  assert.equal((await call('POST', '/', {})).status, 400);
  assert.equal((await call('POST', '/', { name: '   ' })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x'.repeat(81) })).status, 400);
});

test('a malformed slug is refused with a reason', async () => {
  as('u-owner');
  for (const bad of ['-lead', 'trail-', 'double--hyphen', 'Has Space', 'punct!']) {
    const r = await call('POST', '/', { name: 'n', slug: bad });
    assert.equal(r.status, 400, `slug ${JSON.stringify(bad)} should be refused`);
    assert.match(String(r.body.error), /Slug must be/);
  }
});

test('⚠️ the per-org cap stops a scripted caller minting workspaces forever', async () => {
  as('u-owner');
  // Fill org-a to the cap, then ask for one more.
  const cap = 25;
  let guard = 0;
  while (countIn('org-a') < cap && guard++ < 200) {
    const r = await call('POST', '/', { name: 'filler ' + guard });
    if (r.status !== 201) break;
  }
  assert.equal(countIn('org-a'), cap, 'the fill loop should have reached the cap');
  const over = await call('POST', '/', { name: 'one too many' });
  assert.equal(over.status, 409);
  assert.match(String(over.body.error), /maximum of 25/);
  assert.equal(countIn('org-a'), cap, 'the cap must hold');
});
