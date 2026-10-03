'use strict';

/*
 * THE EXECUTOR — the half of a mesh write that actually happens.
 *
 * ⚠️ THIS FILE HAD NO TESTS AT ALL, and that is why two bugs shipped in it. Both were of the same
 * family: the write did not happen, and the caller was told it had.
 *
 *   - The principal it minted a token for had no workspace membership, so tenancy refused every
 *     request and the entire feature was inert behind a generic "Access denied".
 *   - It dialled config.port, which is the API only when TLS is off. With certs present the API
 *     moves to httpsPort and config.port serves a 301-redirect app; fetch follows redirects and
 *     rewrites POST to GET, dropping the body. The call returned 200 for a request the API never
 *     saw, and that invented success was recorded and replayed for ever by idempotency.
 *
 * Both were invisible to the suite because everything above this layer stubs `apply`. So this runs
 * a REAL http server and looks at what arrived.
 */
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-localapply-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { createLocalApply, TOKEN_PREFIX } = require('../lib/mesh/local-apply');

const id = () => crypto.randomUUID();
let ws, origin, server, seen, respond;

before(async () => {
  const userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `l-${userId}@e.com`, 'L', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  ws = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(ws, org, 'W');

  // A stand-in for this node's own API: records what arrived, answers however the test says.
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      respond(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const mkEdge = () => ({ id: id(), peer_node_id: 'peer-node' });
const ok = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"made"}'); };

test('the write reaches the API with a bearer token, and the body intact', async () => {
  seen = []; respond = ok;
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  const r = await apply({ path: '/api/playlists', method: 'POST', body: { name: 'From the hub' }, workspaceId: ws, edge: mkEdge() });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/api/playlists');
  assert.match(seen[0].auth, new RegExp(`^Bearer ${TOKEN_PREFIX}`));
  assert.deepEqual(JSON.parse(seen[0].body), { name: 'From the hub' });
  assert.equal(r.status, 200);
});

test('⚠️ the principal is a member of the workspace, or tenancy refuses every write', async () => {
  seen = []; respond = ok;
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  await apply({ path: '/api/playlists', method: 'POST', body: {}, workspaceId: ws, edge: mkEdge() });

  const principal = db.prepare("SELECT id FROM users WHERE email = 'mesh@localhost.invalid'").get();
  assert.ok(principal, 'the synthetic principal must exist');
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(ws, principal.id);
  assert.ok(member, 'without this row accessContext() returns null and the API answers 403');
});

test('the membership is not duplicated on every write', async () => {
  seen = []; respond = ok;
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  for (let i = 0; i < 3; i++) {
    await apply({ path: '/api/playlists', method: 'POST', body: {}, workspaceId: ws, edge: mkEdge() });
  }
  const principal = db.prepare("SELECT id FROM users WHERE email = 'mesh@localhost.invalid'").get();
  const n = db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(ws, principal.id).n;
  assert.equal(n, 1);
});

test('⚠️ the token is revoked whatever happens, including on a refusal', async () => {
  seen = []; respond = ok;
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  await apply({ path: '/api/playlists', method: 'POST', body: {}, workspaceId: ws, edge: mkEdge() });

  respond = (req, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"nope"}'); };
  await assert.rejects(() => apply({ path: '/api/playlists', method: 'POST', body: {}, workspaceId: ws, edge: mkEdge() }));

  const live = db.prepare(
    "SELECT COUNT(*) AS n FROM api_tokens WHERE prefix LIKE ? AND revoked_at IS NULL",
  ).get(`${TOKEN_PREFIX}%`).n;
  assert.equal(live, 0, 'a token that outlives its request is standing access');
});

test('⚠️ A REDIRECT IS NOT A SUCCESS', async () => {
  /*
   * The exact production shape: with TLS on, config.port answers 301 to https. Following it turns
   * POST into GET with no body and yields a cheerful 200 — a write that never happened, recorded
   * as applied. This must fail loudly instead.
   */
  seen = [];
  respond = (req, res) => { res.writeHead(301, { Location: `${origin}/api/playlists` }); res.end(); };
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  await assert.rejects(
    () => apply({ path: '/api/playlists', method: 'POST', body: { name: 'x' }, workspaceId: ws, edge: mkEdge() }),
    'a 301 must never be reported as an applied write',
  );
  assert.equal(seen.filter((s) => s.method === 'GET').length, 0, 'and it must not be re-issued as a GET');
});

test("the local API's own refusal is passed through, not replaced", async () => {
  seen = [];
  respond = (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"That zone does not exist on this layout"}');
  };
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  await assert.rejects(
    () => apply({ path: '/api/playlists', method: 'POST', body: {}, workspaceId: ws, edge: mkEdge() }),
    /That zone does not exist/,
  );
});

test('a write with no resolved workspace is refused before a token is minted', async () => {
  seen = []; respond = ok;
  const apply = createLocalApply(db, { port: 1 }, { apiOrigin: origin });
  await assert.rejects(() => apply({ path: '/api/playlists', method: 'POST', body: {}, workspaceId: null, edge: mkEdge() }));
  assert.equal(seen.length, 0);
});
