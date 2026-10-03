'use strict';

/*
 * ⚠️ AN API TOKEN IS BOUND TO ONE WORKSPACE — ON EVERY ROUTE, NOT JUST THE LIST.
 *
 * A token authenticates AS its owner (role forced to 'user'), and its binding used to reach only
 * resolveTenancy -> req.workspaceId, which the list and create routes filter on. Every by-id route
 * checked accessContext(owner, ws-of-the-row), which asks "can this USER reach ws?" — so a token
 * minted in wsA by someone who is also a member (or org admin) of wsB could read and write wsB
 * devices, playlists, content and schedules by id (audit F01). GET /api/devices returned only wsA,
 * which hid the gap.
 *
 * And when the owner lost access to the bound workspace, resolveTenancy's first-membership fallback
 * moved the token to the owner's OTHER workspace instead of killing it (audit F12).
 *
 * Mounted exactly as server.js mounts the PUBLIC_ROUTERS: bearerAuth + resolveTenancy +
 * tokenScopeGate.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-token-binding-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-token-binding';

const express = require('express');
const { db } = require('../db/database');
const { bearerAuth, tokenScopeGate, hashToken } = require('../middleware/apiToken');
const { resolveTenancy, resourceAccess } = require('../lib/tenancy');

const O = 'o-tb', WA = 'ws-tb-a', WB = 'ws-tb-b', U = 'u-tb-owner';
db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,?,'user')").run(U, 'tb@t.local', 'x');
db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('u-tb-orgadmin','tboa@t.local','x','user')").run();
db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WA, O, 'A');
db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WB, O, 'B');
// The owner is workspace_admin in BOTH, joined wsB FIRST — so the old fallback picks wsB.
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?,?, 'workspace_admin', 1)").run(WB, U);
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?,?, 'workspace_admin', 2)").run(WA, U);
// An org_admin with NO direct memberships: reaches both workspaces through act-as.
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?, 'u-tb-orgadmin', 'org_admin')").run(O);

for (const [id, ws] of [['d-tb-a', WA], ['d-tb-b', WB]]) {
  db.prepare('INSERT INTO devices (id,user_id,name,workspace_id) VALUES (?,?,?,?)').run(id, U, 'orig-' + id, ws);
  db.prepare('INSERT INTO playlists (id,user_id,name,workspace_id) VALUES (?,?,?,?)').run('p' + id, U, 'pl-' + id, ws);
  db.prepare("INSERT INTO content (id,user_id,filename,mime_type,workspace_id) VALUES (?,?,?,'image/png',?)").run('c' + id, U, 'f-' + id + '.png', ws);
}

function mint(userId, ws, scope = 'full') {
  const secret = 'st_' + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), hashToken(secret), secret.slice(0, 11), 'n', userId, ws, scope);
  return secret;
}

const app = express();
app.use(express.json());
const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }), to: () => ({ emit() {} }), emit() {} };
app.set('io', io);
for (const r of ['devices', 'playlists', 'content', 'schedules']) {
  app.use('/api/' + r, bearerAuth, resolveTenancy, tokenScopeGate, require('../routes/' + r));
}
const server = app.listen(0);
test.after(() => { server.close(); });

async function call(method, pathname, token, body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

test('F01: a token bound to wsA cannot read or write a wsB resource by id, even though its owner can', async () => {
  const tok = mint(U, WA);
  assert.equal((await call('GET', '/api/devices/d-tb-b', tok)).status, 403, 'GET wsB device');
  assert.equal((await call('PUT', '/api/devices/d-tb-b', tok, { name: 'pwned' })).status, 403, 'PUT wsB device');
  assert.equal(db.prepare('SELECT name FROM devices WHERE id = ?').get('d-tb-b').name, 'orig-d-tb-b', 'the wsB device is untouched');
  assert.equal((await call('GET', '/api/playlists/pd-tb-b', tok)).status, 403, 'GET wsB playlist');
  assert.equal((await call('PUT', '/api/playlists/pd-tb-b', tok, { name: 'x' })).status, 403, 'PUT wsB playlist');
  assert.equal((await call('GET', '/api/content/cd-tb-b', tok)).status, 403, 'GET wsB content');
  assert.equal((await call('PUT', '/api/content/cd-tb-b', tok, { filename: 'x' })).status, 403, 'PUT wsB content');
  const sched = await call('POST', '/api/schedules', tok, { device_id: 'd-tb-b', playlist_id: 'pd-tb-b', title: 't', start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T01:00:00Z' });
  assert.ok(sched.status === 403 || sched.status === 404, `schedule targeting a wsB device must be refused, got ${sched.status}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schedules WHERE device_id = ?').get('d-tb-b').n, 0);
});

test('F01: the same token is not over-blocked inside its own workspace', async () => {
  const tok = mint(U, WA);
  assert.equal((await call('GET', '/api/devices/d-tb-a', tok)).status, 200);
  assert.equal((await call('PUT', '/api/devices/d-tb-a', tok, { name: 'renamed' })).status, 200);
  assert.equal((await call('GET', '/api/playlists/pd-tb-a', tok)).status, 200);
  assert.equal((await call('GET', '/api/content/cd-tb-a', tok)).status, 200);
});

test('F01: an org_admin token bound to wsA does not reach wsB through act-as', async () => {
  const tok = mint('u-tb-orgadmin', WA);
  assert.equal((await call('GET', '/api/devices/d-tb-a', tok)).status, 200, 'act-as into the bound workspace still works');
  assert.equal((await call('GET', '/api/devices/d-tb-b', tok)).status, 403);
});

test('F01: resourceAccess leaves JWT sessions exactly as accessContext had them', () => {
  const wsB = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(WB);
  const sessionReq = { user: { id: U, role: 'user' } };
  assert.ok(resourceAccess(sessionReq, wsB), 'a session reaches every workspace its user can');
  const tokenReq = { user: { id: U, role: 'user' }, viaToken: true, apiToken: { workspace_id: WA } };
  assert.equal(resourceAccess(tokenReq, wsB), null);
});

test('F01: no route checks a resource with the raw accessContext(req.user...) form', () => {
  const dir = path.join(__dirname, '..', 'routes');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /accessContext\(req\.user\.id,\s*req\.user\.role/,
      `routes/${f}: use resourceAccess(req, ws) so an API token's workspace binding applies`);
  }
});

test('F12: a token whose owner lost its bound workspace is refused, not moved to another one', async () => {
  // A dedicated owner so the earlier tests' memberships are not disturbed.
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('u-tb-gone','tbg@t.local','x','user')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?, 'u-tb-gone', 'workspace_admin', 1)").run(WB);
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?, 'u-tb-gone', 'workspace_admin', 2)").run(WA);
  const tok = mint('u-tb-gone', WA);
  const before = await call('GET', '/api/devices', tok);
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.map(d => d.id), ['d-tb-a'], 'bound to wsA while the owner is a member');

  db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = 'u-tb-gone'").run(WA);
  const after = await call('GET', '/api/devices', tok);
  assert.equal(after.status, 403, `the token must die, not fall back to wsB (got ${after.status} ${JSON.stringify(after.json)})`);
  assert.equal((await call('POST', '/api/playlists', tok, { name: 'leak' })).status, 403, 'no creates in the fallback workspace either');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM playlists WHERE name = 'leak'").get().n, 0);
});
