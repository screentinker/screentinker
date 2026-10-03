'use strict';

/*
 * Applying a write a parent asked for — the enforcement, not the transport.
 *
 * Every check here runs on the node that owns the screens, against that node's own rows. The
 * parent's message says what it WANTS; it is never consulted about whether it may have it, and
 * never about which workspace it is touching.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshapply-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { applyWrite } = require('../lib/mesh/node-write');

const id = () => crypto.randomUUID();
let wsA, wsB, plA, plB, userId;
let applied;                       // what the executor was asked to do
/*
 * ⚠️ ASYNC, because the real executor is. A synchronous stub let applyWrite record an unawaited
 * promise as a successful outcome and ack ok:true to the hub before the request had even been sent
 * — and the whole suite stayed green. A stub simpler than its collaborator tests the stub.
 */
const apply = async (call) => { applied.push(call); return { ok: true, id: call.path }; };

before(() => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `a-${userId}@e.com`, 'A', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  wsA = id(); wsB = id();
  for (const w of [wsA, wsB]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
                VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, org, 'ws');
  }
  plA = id(); plB = id();
  db.prepare('INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,?,?)').run(plA, userId, wsA, 'A loop');
  db.prepare('INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,?,?)').run(plB, userId, wsB, 'B loop');
});

const mkEdge = (writeGrant, writeScope) => {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope)
              VALUES (?,?,'up','[]','["health"]','we-dial',1,strftime('%s','now'),?,?)`)
    .run(e, id(), writeGrant ? JSON.stringify(writeGrant) : null, writeScope ? JSON.stringify(writeScope) : null);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};
/*
 * ⚠️ Stamps BOTH clock fields, because our own hub stamps both on every write. A fixture that
 * omitted them was modelling a peer this product does not produce — and it hid the fact that the
 * deadline check could be switched off simply by leaving a field out.
 */
const req = (o = {}) => ({
  opId: id(), path: `/api/playlists/${plA}/items`, method: 'POST', body: {},
  sentAt: Date.now(), notAfter: Date.now() + 120_000, ...o,
});

test('a granted write, in scope, is applied', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, req(), { apply });
  assert.equal(r.ok, true, r.reason);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].workspaceId, wsA, 'the workspace must be the one the TARGET belongs to');
});

test('⚠️ the workspace comes from the TARGET, not from the request', async () => {
  /*
   * The scope check is decorative if the parent names its own scope. Here the edge may write wsA,
   * and the request claims wsA — but the playlist it names lives in wsB. The child resolves the
   * target itself, so the claim is irrelevant.
   */
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, req({ path: `/api/playlists/${plB}/items`, body: { workspace_id: wsA } }), { apply });
  assert.equal(r.ok, false, 'a parent naming its own scope must not widen it');
  assert.equal(applied.length, 0);
});

test('an edge with no write grant is refused before the target is even looked up', async () => {
  applied = [];
  const edge = mkEdge(null, null);
  const r = await applyWrite(db, edge, req(), { apply });
  assert.equal(r.ok, false);
  assert.match(r.reason, /may not change anything/i);
});

test('⚠️ an unknown target is refused in the SAME words as a denial', async () => {
  // Otherwise the write door becomes an oracle: a parent could enumerate which playlist ids exist
  // on someone else's server by telling the two refusals apart.
  const edge = mkEdge(['content-push'], [wsA]);
  const denied = await applyWrite(db, edge, req({ path: `/api/playlists/${plB}/items` }), { apply });
  const missing = await applyWrite(db, edge, req({ path: '/api/playlists/does-not-exist/items' }), { apply });
  assert.equal(denied.ok, false);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, denied.reason, 'a missing target and a forbidden one must be indistinguishable');
});

test('a path outside the allowlist is refused however good the grant is', async () => {
  const edge = mkEdge(['content-push', 'device-command'], [wsA, wsB]);
  for (const p of ['/api/admin/users', '/api/tokens', '/api/workspaces', '/api/mesh/uplink/e1/write-grant']) {
    const r = await applyWrite(db, edge, req({ path: p, method: 'POST' }), { apply });
    assert.equal(r.ok, false, `${p} must never be writable`);
  }
});

test('⚠️ a RETRY returns the first outcome instead of applying twice', async () => {
  /*
   * The uplink re-queues on ack timeout, so a dropped link resends the same intent as a matter of
   * course. Without this, "the network hiccuped" and "the operator asked twice" are the same event,
   * and the second one adds a duplicate item to somebody's playlist.
   */
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r1 = await applyWrite(db, edge, req({ opId: 'op-fixed' }), { apply });
  const r2 = await applyWrite(db, edge, req({ opId: 'op-fixed' }), { apply });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.replayed, true, 'the second attempt must be reported as a replay');
  assert.equal(applied.length, 1, 'it must not have been applied twice');
  assert.deepEqual(r2.outcome, r1.outcome, 'a replay returns what happened the first time');
});

test('a write with no operation id is refused, because retrying it could not be safe', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  // Built by hand rather than via req(), so it must still carry the clock fields — otherwise it is
  // refused for missing a deadline and this asserts the wrong refusal.
  const r = await applyWrite(db, edge, {
    path: `/api/playlists/${plA}/items`, method: 'POST', body: {},
    sentAt: Date.now(), notAfter: Date.now() + 120_000,
  }, { apply });
  assert.equal(r.ok, false);
  assert.match(r.reason, /operation id/i);
});

/*
 * ⚠️ THE DEADLINE WAS OPT-IN BY THE SENDER, WHICH IS NOT A GUARD.
 *
 * The whole block ran `if (typeof req.notAfter === 'number')`, so a peer that omitted the field got
 * no deadline — and one that omitted `sentAt` with it disarmed the skew check too, because skew was
 * computed against `req.sentAt || now` and was therefore always zero. It constrained only callers
 * who chose to be constrained.
 *
 * What it protects: revocation means "stop future writes", and the live edge re-read cannot see a
 * write that is already in flight. The deadline is what bounds that window.
 */
test('⚠️ a write with no expiry is refused, however good the grant is', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, {
    path: `/api/playlists/${plA}/items`, method: 'POST', body: {}, opId: id(), sentAt: Date.now(),
  }, { apply });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expiry/i);
  assert.equal(applied.length, 0);
});

test('⚠️ and one that will not say when it was sent is refused too', async () => {
  // Without sentAt there is no clock to check the expiry against, so accepting it would mean
  // trusting a deadline nobody can verify — which is the same as having no deadline.
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, {
    path: `/api/playlists/${plA}/items`, method: 'POST', body: {}, opId: id(),
    notAfter: Date.now() + 120_000,
  }, { apply });
  assert.equal(r.ok, false);
  assert.match(r.reason, /when it was sent/i);
  assert.equal(applied.length, 0);
});

test('⚠️ a STALE intent for the same target is dropped, not applied last-wins', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const newer = await applyWrite(db, edge, req({ intentSeq: 5 }), { apply });
  const older = await applyWrite(db, edge, req({ intentSeq: 2 }), { apply });
  assert.equal(newer.ok, true);
  assert.equal(older.ok, false, 'an older intent must not overwrite a newer one by arriving later');
  assert.match(older.reason, /newer change/i);
  assert.equal(applied.length, 1);
});

test('⚠️ an EXPIRED write is refused — revocation must not be outrun by a slow link', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  const now = Date.now();
  const r = await applyWrite(db, edge, req({ notAfter: now - 1000, sentAt: now }), { apply, now: () => now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/i);
});

test('a peer with absurd clock skew cannot be trusted with a deadline', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  const now = Date.now();
  const r = await applyWrite(db, edge, req({ notAfter: now + 60000, sentAt: now + 40 * 60 * 1000 }), { apply, now: () => now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /clock skew|disagree about the time/i);
});

test('holding content-push never confers device-command', () => {
  const edge = mkEdge(['content-push'], [wsA]);
  // device-command paths are not even in WRITABLE yet — the point is the grant is per-category.
  const { writeAllows } = require('../lib/mesh/grants');
  assert.equal(writeAllows(['content-push'], [wsA], 'device-command', wsA), false);
});

test('⚠️ a write that FAILS locally is reported as failed, not acked as success', async () => {
  /*
   * The bug this pins: applyWrite was not async and did not await apply(). The real executor is
   * async, so the promise was recorded in mesh_write_ops as `ok=1` BEFORE the request had been
   * sent, the hub was told ok:true, and the idempotency record then replayed that invented success
   * on every retry — the write could never recover, and nothing anywhere said so.
   */
  const edge = mkEdge(['content-push'], [wsA]);
  const failing = async () => { const e = new Error('Content not found'); e.status = 404; throw e; };
  const r = await applyWrite(db, edge, req({ opId: 'op-fails' }), { apply: failing });
  assert.equal(r.ok, false, 'a rejected apply must not be reported as success');

  const row = db.prepare('SELECT ok FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?')
    .get(edge.id, 'op-fails');
  assert.equal(row.ok, 0, 'the failure must be recorded as a failure, or a retry replays a lie');
});

test('the recorded outcome is the RESOLVED value, not a promise', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  await applyWrite(db, edge, req({ opId: 'op-shape' }), { apply: async () => ({ status: 201, result: { id: 'x' } }) });
  const row = db.prepare('SELECT outcome FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?')
    .get(edge.id, 'op-shape');
  assert.deepEqual(JSON.parse(row.outcome), { status: 201, result: { id: 'x' } },
    'JSON.stringify of an unawaited promise is "{}" — a recorded outcome that says nothing');
});

/*
 * ⚠️ THE ALLOWLIST IS THE WHOLE SECURITY BOUNDARY, AND A BACKSLASH WALKED THROUGH IT.
 *
 * The matcher split on '/', so `..\..\..\devices\D1` counted as ONE segment and satisfied
 * `DELETE /api/playlists/:id/items/:itemId`. The executor handed that same raw string to fetch(),
 * whose WHATWG parser converts backslashes to slashes and resolves dot segments — so the request
 * that actually arrived was `DELETE /api/devices/D1`. Six segments to the guard, three to the
 * server. `%2e%2e` did it through decoding instead, turning "delete one item" into "delete the
 * whole playlist".
 *
 * These assert on the RESOLVED path both ways round: that a traversal no longer matches, and that
 * what a permitted write sends is byte-identical to what was authorised. The second half matters
 * as much as the first — the bug was not a missing check, it was two parsers disagreeing.
 */
test('⚠️ a traversal hidden in an id cannot reach a route outside the allowlist', async () => {
  const edge = mkEdge(['content-push', 'device-command'], [wsA, wsB]);
  const B = String.fromCharCode(92);   // a literal backslash, kept out of the string escaping
  const escapes = [
    `/api/playlists/${plA}/items/..${B}..${B}..${B}devices${B}D1`,
    `/api/playlists/${plA}/items/..%2f..%2f..%2fdevices%2fD1`,
    `/api/playlists/${plA}/items/%2e%2e`,
    `/api/playlists/${plA}/items/..`,
    `/api/playlists/${plA}/items/.${B}.${B}content${B}c1`,
  ];
  for (const p of escapes) {
    for (const method of ['PUT', 'DELETE']) {
      applied = [];
      const r = await applyWrite(db, edge, req({ path: p, method }), { apply });
      assert.equal(r.ok, false, `${method} ${p} must be refused`);
      assert.equal(applied.length, 0, `${method} ${p} must never reach the executor`);
    }
  }
});

test('⚠️ what the executor sends is exactly what was authorised, resolved', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  /*
   * `/./` resolves AWAY, so this is a real, permitted write whose raw form differs from its
   * resolved form — the only shape that can catch an executor sending req.path instead of the
   * authorised path. A payload that merely gets refused proves nothing here, because a refusal
   * never reaches the executor at all. (My first attempt at this test used a trailing `/./`, which
   * normalises to a trailing slash, fails the segment count, and refuses — so it asserted nothing.)
   */
  const r = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/./items`, method: 'POST', opId: 'op-normalised',
  }), { apply });
  assert.equal(r.ok, true, 'a dot segment that resolves to an allowlisted path is a legitimate write');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].path, `/api/playlists/${plA}/items`,
    'the executor must send the RESOLVED path, never the raw one');
});

/*
 * ⚠️ THE MATCHER IS TESTED DIRECTLY, because applyWrite normalises before calling it and would
 * mask a matcher that had been loosened. Two layers resolve the path; each has to be shown to work
 * on its own, or removing either one leaves every test green. (It did: both mutations survived the
 * first version of these tests.)
 */
test('⚠️ the matcher itself refuses a traversal, independent of its caller', () => {
  const writeProxy = require('../lib/mesh/write-proxy');
  const B = String.fromCharCode(92);
  const raw = [
    `/api/playlists/p1/items/..${B}..${B}..${B}devices${B}D1`,
    '/api/playlists/p1/items/..%2f..%2f..%2fdevices%2fD1',
    '/api/playlists/p1/items/%2e%2e',
  ];
  for (const p of raw) {
    assert.equal(writeProxy.matchPath(p, 'DELETE'), null, `${p} must not match any rule`);
    assert.equal(writeProxy.isWritable(p, 'DELETE'), false);
  }
  // ...and the resolved forms they were smuggling are not writable under any method.
  for (const p of ['/api/devices/D1', '/api/content/c1', '/api/playlists/p1']) {
    assert.equal(writeProxy.matchPath(p, 'DELETE'), null, `${p} must never be deletable`);
  }
});

test('⚠️ authorizeWrite hands back the resolved path, not the one it was given', () => {
  const writeProxy = require('../lib/mesh/write-proxy');
  const r = writeProxy.authorizeWrite(
    {}, '/api/playlists/p1/./items', 'POST', ['content-push'], [wsA], wsA,
  );
  assert.equal(r.ok, true);
  assert.equal(r.path, '/api/playlists/p1/items');
});

test('a malformed path is refused rather than thrown', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  for (const p of [null, '', 'not-a-path', '//evil.example.com/api/devices/x']) {
    applied = [];
    const r = await applyWrite(db, edge, req({ path: p, method: 'POST' }), { apply });
    assert.equal(r.ok, false, `${p} must be refused`);
    assert.equal(applied.length, 0);
  }
});

/*
 * ⚠️ AUTHORISE AND APPLY MUST NAME THE SAME OBJECT.
 *
 * This is the sharpest form of the two-parsers bug, and the reason the path is resolved BEFORE the
 * target is looked up rather than only inside the matcher. `/api/playlists/<A>/../<B>/items`
 * resolves to playlist B — but a raw split reads segment 3 as playlist A. Look the workspace up
 * from the raw string and the grant is checked against A's workspace, which the parent may write,
 * while the request that goes out modifies B, which it may not.
 *
 * Nothing is malformed here and nothing is refused by the matcher: both are real playlists and the
 * resolved path is a legitimately allowlisted rule. The only defence is that both steps read the
 * same resolved path.
 */
test('⚠️ a dot segment cannot authorise against one playlist and write to another', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);          // may write wsA, NOT wsB
  const r = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/../${plB}/items`,       // reads as plA, resolves to plB
    method: 'POST',
    opId: 'op-cross-workspace',
  }), { apply });

  assert.equal(r.ok, false, 'the grant must be judged against the playlist actually being written');
  assert.equal(applied.length, 0, 'nothing may reach the executor');
  // And if it were ever permitted, it must at least never touch the ungranted playlist.
  for (const call of applied) assert.ok(!call.path.includes(plB));
});

/*
 * ⚠️ THE RETRY THE DESIGN MANDATES USED TO DOUBLE-APPLY.
 *
 * The idempotency record was written AFTER apply() returned, with nothing in between, so two
 * arrivals carrying the same op id both found no row and both applied. Not theoretical: writeTo
 * times out an ack at 15s, POST /items re-probes video duration with a 15s ffprobe timeout, and the
 * route then answers 504 telling the operator to retry with the SAME id. A slow probe produces
 * exactly the duplicate playlist item this table exists to prevent.
 */
test('⚠️ two arrivals of the same opId apply ONCE, even fully concurrently', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowApply = async (call) => { applied.push(call); await gate; return { ok: true }; };

  const both = Promise.all([
    applyWrite(db, edge, req({ opId: 'op-concurrent' }), { apply: slowApply }),
    applyWrite(db, edge, req({ opId: 'op-concurrent' }), { apply: slowApply }),
  ]);
  release();
  const [a, b] = await both;

  assert.equal(applied.length, 1, 'the executor must run exactly once');
  const outcomes = [a, b];
  assert.equal(outcomes.filter((r) => r.ok).length + outcomes.filter((r) => r.indeterminate).length, 2,
    'the loser is told the truth — applied, or still running — never "refused"');
  assert.equal(outcomes.filter((r) => r.ok === false && !r.indeterminate).length, 0);
});

/*
 * ⚠️ A REFUSAL AND A FAILURE ARE DIFFERENT OUTCOMES.
 *
 * Both used to be recorded as a permanent ok=0, and the route reports that as 403 — whose text says
 * no retry will help. So a momentary 503, a restart mid-write or a dropped loopback connection
 * poisoned the op id for ever, while the 504 branch four lines above told the operator to retry
 * with that same id. The only escape was a fresh id, which is what the design forbids.
 */
test('⚠️ a transient failure can be retried; the op id is not poisoned', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  let attempt = 0;
  const flaky = async () => {
    attempt += 1;
    if (attempt === 1) { const e = new Error('local API returned 503'); e.status = 503; throw e; }
    return { ok: true, id: 'landed' };
  };

  const first = await applyWrite(db, edge, req({ opId: 'op-transient' }), { apply: flaky });
  assert.equal(first.ok, false);
  assert.equal(first.indeterminate, true, 'a 5xx is not an answer, so it must be retryable');

  const second = await applyWrite(db, edge, req({ opId: 'op-transient' }), { apply: flaky });
  assert.equal(second.ok, true, 'the same op id must be usable again after a transient failure');
  assert.equal(attempt, 2);
});

test('a transport error with no status at all is treated as transient too', async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  const dead = async () => { throw new Error('ECONNRESET'); };
  const r = await applyWrite(db, edge, req({ opId: 'op-noconn' }), { apply: dead });
  assert.equal(r.indeterminate, true);
  const row = db.prepare('SELECT * FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?').get(edge.id, 'op-noconn');
  assert.equal(row, undefined, 'no permanent record may survive an outcome nobody knows');
});

test("a 4xx from this node's own API IS deterministic and stays refused", async () => {
  const edge = mkEdge(['content-push'], [wsA]);
  let calls = 0;
  const refuse = async () => {
    calls += 1;
    const e = new Error('That zone does not exist on this layout'); e.status = 400; throw e;
  };
  const first = await applyWrite(db, edge, req({ opId: 'op-deterministic' }), { apply: refuse });
  assert.equal(first.ok, false);
  assert.ok(!first.indeterminate, 'the API saw it and said no — it will say no again');

  const second = await applyWrite(db, edge, req({ opId: 'op-deterministic' }), { apply: refuse });
  assert.equal(second.replayed, true);
  assert.equal(calls, 1, 'a settled refusal must not be re-attempted against different state');
});

test('⚠️ a parent may never be pointed at the screen the host server itself is', async () => {
  /*
   * mesh_node.self_device_id marks the case where one box is both the server and the panel in
   * reception. That device sits in a workspace like any other, so an ordinary content-push grant
   * covering the workspace covers the host too — every other guard here reasons about workspaces
   * and none of them can see the difference. The column had zero readers anywhere before this.
   */
  applied = [];
  const selfDevice = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)')
    .run(selfDevice, 'Reception (this server)', wsA);
  const ordinary = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(ordinary, 'Lobby', wsA);
  // The singleton identity row may not exist yet in this fixture; an UPDATE against no rows is a
  // silent no-op, which would leave the guard unarmed and this test asserting nothing.
  db.prepare(`INSERT INTO mesh_node (singleton, node_id, created_at, self_device_id)
              VALUES (1, ?, strftime('%s','now'), ?)
              ON CONFLICT(singleton) DO UPDATE SET self_device_id = excluded.self_device_id`)
    .run(id(), selfDevice);
  const armed = db.prepare('SELECT self_device_id FROM mesh_node LIMIT 1').get();
  assert.equal(armed && armed.self_device_id, selfDevice, 'the guard must actually be armed');

  const edge = mkEdge(['content-push'], [wsA]);
  const blocked = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/assign`, method: 'POST',
    body: { device_id: selfDevice }, opId: 'op-self-device',
  }), { apply });
  assert.equal(blocked.ok, false, 'the host may not be retargeted by a parent');
  assert.equal(applied.length, 0);

  // ...and an ordinary screen in the same workspace is still perfectly assignable.
  const allowed = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/assign`, method: 'POST',
    body: { device_id: ordinary }, opId: 'op-ordinary-device',
  }), { apply });
  assert.equal(allowed.ok, true, 'the guard must be about the HOST, not about assignment');
  db.prepare('UPDATE mesh_node SET self_device_id = NULL').run();
});

/*
 * ⚠️ THE PARENT'S CONTENT IDS ARE NOT THIS NODE'S CONTENT IDS.
 *
 * A hub adding an item sends the content id from ITS OWN library. Ids are generated independently
 * on every node, so that id does not exist here — the playlist route looked it up, found nothing
 * and answered 404. Nothing translated between the two, so this failed even for content that HAD
 * been transferred: the bytes arrived, a local row was created with a fresh local id, and the hub
 * went on naming its own. mesh_content_provenance is exactly this mapping, and it was written on
 * receipt and read nowhere.
 */
test('⚠️ a content id from the hub is translated to the local row it became', async () => {
  applied = [];
  const localContent = id();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
              VALUES (?,?,?,?,?,?,?)`)
    .run(localContent, userId, wsA, 'Clip.mp4', 'abc.mp4', 'video/mp4', 10);

  const edge = mkEdge(['content-push'], [wsA]);
  const originId = 'content-id-on-the-hub';
  db.prepare(`INSERT INTO mesh_content_provenance
                (origin_node_id, origin_content_id, local_content_id, edge_id, bytes, first_seen_at, last_seen_at)
              VALUES (?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))`)
    .run(edge.peer_node_id, originId, localContent, edge.id, 10);

  const r = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/items`, method: 'POST',
    body: { content_id: originId }, opId: 'op-translate',
  }), { apply });

  assert.equal(r.ok, true, r.reason);
  assert.equal(applied[0].body.content_id, localContent,
    'the executor must be handed the id that exists on THIS node');
});

test('⚠️ content that was never sent is refused with an ACTIONABLE reason', async () => {
  applied = [];
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/items`, method: 'POST',
    body: { content_id: 'never-sent-here' }, opId: 'op-missing-content',
  }), { apply });

  assert.equal(r.ok, false);
  assert.equal(applied.length, 0);
  // Deliberately NOT the generic refusal: this is not a permission problem, and telling somebody
  // "not permitted" when the answer is "send the file first" costs them an afternoon.
  assert.match(r.reason, /has not been sent to this server yet/i);
  assert.notEqual(r.reason, require('../lib/mesh/write-proxy').REFUSED);
});

test('⚠️ the origin node is the EDGE, never anything in the body', async () => {
  /*
   * A parent that could name the origin node could address ANOTHER parent's provenance rows and
   * attach that node's content to a playlist here.
   */
  applied = [];
  const otherLocal = id();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
              VALUES (?,?,?,?,?,?,?)`)
    .run(otherLocal, userId, wsA, 'Other.mp4', 'other.mp4', 'video/mp4', 10);
  const edge = mkEdge(['content-push'], [wsA]);
  db.prepare(`INSERT INTO mesh_content_provenance
                (origin_node_id, origin_content_id, local_content_id, edge_id, bytes, first_seen_at, last_seen_at)
              VALUES ('a-different-hub','shared-oid',?,?,?,strftime('%s','now'),strftime('%s','now'))`)
    .run(otherLocal, edge.id, 10);

  const r = await applyWrite(db, edge, req({
    path: `/api/playlists/${plA}/items`, method: 'POST',
    body: { content_id: 'shared-oid', origin_node_id: 'a-different-hub' }, opId: 'op-cross-origin',
  }), { apply });

  assert.equal(r.ok, false, "another hub's provenance must not be addressable from this edge");
  assert.equal(applied.length, 0);
});

/*
 * ⚠️ COMMANDING SCREENS — a different grant, and a narrower one than the path suggests.
 *
 * Every other rule on the allowlist is fully described by its path. `POST /command` is not: the
 * same URL carries `reboot`, and `shell`, and `install_apk`. The consent sentence says "Reboot,
 * reload, change settings on screens", so the grant must permit that and no more — and only a body
 * check can tell those apart.
 */
test('⚠️ a hub with content-push alone cannot command screens', async () => {
  applied = [];
  const dev = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(dev, 'Lobby', wsA);
  const edge = mkEdge(['content-push'], [wsA]);
  const r = await applyWrite(db, edge, req({
    path: `/api/devices/${dev}/command`, method: 'POST', body: { type: 'reboot' },
  }), { apply });
  assert.equal(r.ok, false, 'changing what plays and restarting the hardware are different powers');
  assert.equal(applied.length, 0);
});

test('a hub with device-command may reboot a screen in scope', async () => {
  applied = [];
  const dev = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(dev, 'Lobby', wsA);
  const edge = mkEdge(['device-command'], [wsA]);
  const r = await applyWrite(db, edge, req({
    path: `/api/devices/${dev}/command`, method: 'POST', body: { type: 'reboot' },
  }), { apply });
  assert.equal(r.ok, true, r.reason);
  assert.equal(applied[0].body.type, 'reboot');
});

test('⚠️ and may NOT run a shell command or install software on it', async () => {
  const dev = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(dev, 'Lobby', wsA);
  const edge = mkEdge(['device-command'], [wsA]);
  for (const type of ['shell', 'install_apk', 'kiosk_lock', 'block_uninstall', 'update']) {
    applied = [];
    const r = await applyWrite(db, edge, req({
      path: `/api/devices/${dev}/command`, method: 'POST', body: { type, payload: { cmd: 'id' } },
    }), { apply });
    assert.equal(r.ok, false, `${type} must never be reachable from another server`);
    assert.equal(applied.length, 0, `${type} must not reach the executor`);
    // ⚠️ The SAME refusal as "you may not command at all" — telling those apart would hand a caller
    // a map of which verbs are worth trying.
    assert.equal(r.reason, require('../lib/mesh/write-proxy').REFUSED);
  }
});

test('a command with no type, or a non-string one, is refused', async () => {
  const dev = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(dev, 'Lobby', wsA);
  const edge = mkEdge(['device-command'], [wsA]);
  for (const body of [{}, { type: null }, { type: ['reboot'] }, { type: { toString: () => 'reboot' } }]) {
    applied = [];
    const r = await applyWrite(db, edge, req({ path: `/api/devices/${dev}/command`, method: 'POST', body }), { apply });
    assert.equal(r.ok, false);
    assert.equal(applied.length, 0);
  }
});

test('⚠️ a device in another workspace is refused, exactly as a playlist would be', async () => {
  applied = [];
  const dev = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(dev, 'Other', wsB);
  const edge = mkEdge(['device-command'], [wsA]);
  const r = await applyWrite(db, edge, req({
    path: `/api/devices/${dev}/command`, method: 'POST', body: { type: 'reboot' },
  }), { apply });
  assert.equal(r.ok, false);
  assert.equal(applied.length, 0);
});

test('⚠️ the resolver itself refuses a target with no workspace', () => {
  /*
   * ⚠️ TESTED DIRECTLY, because writeAllows also denies a falsy workspace — so removing this check
   * changes nothing observable through applyWrite and the mutation survives. Two layers refuse it;
   * each has to be shown to work alone, or deleting either leaves the suite green. (That is the
   * third time in this feature that a defence-in-depth guard needed its own test to be real.)
   */
  const { resolveTargetWorkspace } = require('../lib/mesh/node-write');
  const orphan = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,NULL)').run(orphan, 'Orphan');
  assert.equal(resolveTargetWorkspace(db, `/api/devices/${orphan}/command`), null,
    'a row whose owner is unknown must not resolve — "I do not know whose this is" is never "yours"');

  const owned = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(owned, 'Lobby', wsA);
  assert.deepEqual(resolveTargetWorkspace(db, `/api/devices/${owned}/command`),
    { kind: 'devices', workspaceId: wsA, id: owned });

  // ...and a table nobody allowlisted does not resolve at all, whatever the id.
  assert.equal(resolveTargetWorkspace(db, '/api/users/abc/command'), null);
});

test('⚠️ a device row with no workspace is refused rather than treated as unowned', async () => {
  // For content, NULL workspace means "platform template, shared with everyone" — a deliberate
  // global. For a device it means the row predates tenancy or was written wrong, and the safe
  // reading of "I do not know whose this is" is never "yours".
  applied = [];
  const dev = id();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,NULL)').run(dev, 'Orphan');
  const edge = mkEdge(['device-command'], [wsA]);
  const r = await applyWrite(db, edge, req({
    path: `/api/devices/${dev}/command`, method: 'POST', body: { type: 'reboot' },
  }), { apply });
  assert.equal(r.ok, false);
  assert.equal(applied.length, 0);
});
