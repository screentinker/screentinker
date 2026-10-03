'use strict';

/*
 * WHAT ANOTHER SERVER DID TO THIS ONE.
 *
 * The simplest question in the whole feature, and it had no answer. mesh_write_ops looks like it
 * should answer it and cannot — an idempotency ledger with no path, no method, no actor, and
 * nothing anywhere that reads it. A customer could grant write access and then have no way to find
 * out what was done with it.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshaudit-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { applyWrite } = require('../lib/mesh/node-write');
const { getActivity } = require('../services/activity');

const id = () => crypto.randomUUID();
let wsA, wsB, plA, userId;
let applied;
const apply = async (call) => { applied.push(call); return { ok: true }; };

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
  plA = id();
  db.prepare(`INSERT INTO playlists (id,name,user_id,workspace_id,created_at,updated_at)
              VALUES (?,?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(plA, 'A', userId, wsA);
});

beforeEach(() => { applied = []; db.prepare("DELETE FROM activity_log WHERE action LIKE 'mesh:%'").run(); });

const mkEdge = (grant = ['content-push'], scope = [wsA], peerName = 'Acme HQ') => {
  const e = id();
  // ⚠️ A unique peer per edge: (peer_node_id, direction) is unique, so reusing one id makes the
  // SECOND test in the file fail on a constraint rather than on what it is testing.
  const peer = `hub-node-${e.slice(0, 8)}`;
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope, peer_name)
              VALUES (?,?,'up','[]','["health"]','we-dial',1,strftime('%s','now'),?,?,?)`)
    .run(e, peer, JSON.stringify(grant), JSON.stringify(scope), peerName);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};

const req = (over = {}) => ({
  path: `/api/playlists/${plA}/items`, method: 'POST', body: { content_id: null },
  // Both clock fields — see the note in mesh-write-apply.test.js.
  opId: id(), sentAt: Date.now(), notAfter: Date.now() + 120_000, ...over,
});

const meshRows = () => db.prepare(
  "SELECT * FROM activity_log WHERE action LIKE 'mesh:%' ORDER BY id").all();

test('an applied change is recorded, with what was changed and who asked', async () => {
  const edge = mkEdge();
  await applyWrite(db, edge, req({ actor: { name: 'Priya Raman', email: 'priya@msp.example' } }), { apply });

  const rows = meshRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'mesh:write');
  assert.match(rows[0].details, /Acme HQ/, 'the peer is named the way the operator knows it');
  assert.match(rows[0].details, /applied/);
  assert.match(rows[0].details, /POST \/api\/playlists/);
  assert.match(rows[0].details, /Priya Raman/);
  assert.equal(rows[0].workspace_id, wsA, 'scoped to the workspace that was changed');
});

/*
 * ⚠️ THE HALF THAT MATTERS MOST. After narrowing a grant, what an operator wants to see is what has
 * been TRIED and stopped — and the auto-logger cannot supply it: it only fires on 2xx, and a mesh
 * refusal never reaches Express at all. An audit showing only successes describes the relationship
 * as it was permitted rather than as it was attempted.
 */
test('⚠️ a REFUSED change is recorded too, with the reason', async () => {
  const edge = mkEdge(['content-push'], [wsB]);          // grant does not cover this playlist
  const r = await applyWrite(db, edge, req(), { apply });
  assert.equal(r.ok, false);

  const rows = meshRows();
  assert.equal(rows.length, 1, 'a refusal is an event, not a non-event');
  assert.match(rows[0].details, /refused/);
  assert.match(rows[0].details, /reason:/);
  assert.equal(applied.length, 0);
});

test('a write with no grant at all still leaves a trace', async () => {
  const edge = mkEdge([], []);
  await applyWrite(db, edge, req(), { apply });
  assert.equal(meshRows().length, 1, 'the attempt is exactly what the operator needs to see');
});

test('a path outside the allowlist is recorded as an attempt', async () => {
  const edge = mkEdge();
  await applyWrite(db, edge, req({ path: '/api/admin/users', method: 'POST' }), { apply });
  const rows = meshRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0].details, /refused/);
});

/*
 * ⚠️ The uplink re-queues on ack timeout, so the same intent arrives repeatedly as a matter of
 * course. Recording each arrival would turn one operator action into a page of identical lines and
 * bury the events that matter.
 */
test('⚠️ a replayed write is NOT audited a second time', async () => {
  const edge = mkEdge();
  const one = req({ opId: 'op-replayed' });
  await applyWrite(db, edge, one, { apply });
  const r2 = await applyWrite(db, edge, one, { apply });

  assert.equal(r2.replayed, true);
  assert.equal(meshRows().length, 1, 'one action, one line');
  assert.equal(applied.length, 1);
});

/*
 * ⚠️ THE ACTOR IS AN UNVERIFIABLE CLAIM AND MUST READ AS ONE. The hub says who asked; this node
 * cannot check it. Recorded because it is useful, labelled because it is not proof.
 */
test('⚠️ the actor is labelled as reported by the other server, not verified', async () => {
  const edge = mkEdge();
  await applyWrite(db, edge, req({ actor: { name: 'Someone' } }), { apply });
  const details = meshRows()[0].details;
  assert.match(details, /Someone/);
  assert.match(details, /reported by that server, not verified here/i,
    'anything a peer says about itself is evidence, never proof, and the line must say so');
});

test('a hostile actor claim cannot inject into the audit line', async () => {
  const edge = mkEdge();
  await applyWrite(db, edge, req({
    actor: { name: `admin\n\nmesh:write · ${'x'.repeat(400)} — applied` },
  }), { apply });
  const details = meshRows()[0].details;
  assert.ok(!details.includes('\n'), 'newlines would let a peer forge extra audit lines');
  assert.ok(details.length < 800, 'and an unbounded name would push the real detail out of view');
});

test('acting_user_id stays NULL while the flag records that somebody else was behind it', async () => {
  /*
   * ⚠️ acting_user_id is TEXT REFERENCES users(id), and a person on another server has no row in
   * this one — the foreign key would reject the insert and the audit row would be LOST. That is
   * exactly how a break-glass session went unrecorded here for months.
   */
  const edge = mkEdge();
  await applyWrite(db, edge, req({ actor: { name: 'Remote Person' } }), { apply });
  const row = meshRows()[0];
  assert.equal(row.acting_user_id, null);
  assert.equal(row.was_acting_as, 1);
});

/*
 * ⚠️ getActivity could not filter by workspace, though rows have carried workspace_id since the
 * Phase 2.2 writer-leak fix. On a multi-tenant install the trail was readable only in full or not
 * at all — and a caller wanting a scoped view had to fetch everything and filter afterwards, which
 * is the shape that leaks the moment somebody adds a count.
 */
test('⚠️ activity can be scoped to one workspace', async () => {
  const edgeA = mkEdge(['content-push'], [wsA]);
  await applyWrite(db, edgeA, req(), { apply });

  const inA = getActivity({ workspaceId: wsA, action: 'mesh:write' });
  const inB = getActivity({ workspaceId: wsB, action: 'mesh:write' });
  assert.ok(inA.length >= 1);
  assert.equal(inB.length, 0, "another workspace's audit must not appear here");
});

test('retention actually deletes, and only past the horizon', () => {
  const { pruneActivityLog } = require('../services/activity');
  db.prepare(`INSERT INTO activity_log (user_id, action, details, created_at)
              VALUES (?, 'mesh:write', 'old', strftime('%s','now') - (120 * 86400))`).run(userId);
  db.prepare(`INSERT INTO activity_log (user_id, action, details, created_at)
              VALUES (?, 'mesh:write', 'recent', strftime('%s','now'))`).run(userId);

  const removed = pruneActivityLog(90);
  assert.ok(removed >= 1, 'this existed for a long time and was never once called');
  const left = db.prepare("SELECT details FROM activity_log WHERE action='mesh:write'").all().map((r) => r.details);
  assert.ok(!left.includes('old'));
  assert.ok(left.includes('recent'));
});

/*
 * ⚠️ THE IMPORT PATH IS THE FIFTH WRITER THAT OWES byte_digest A VALUE.
 *
 * A restore used to insert every content row with a NULL digest and rename every file to a fresh
 * uuid. Two consequences, both silent: a hub re-pushing afterwards found no matching digest,
 * concluded the assets were absent, re-transferred all of them and charged the customer's allowance
 * a second time for bytes they already had — and because `filepath` sits inside the player's
 * structural fingerprint, the rename restarted playback at item 1 on every web and BrightSign
 * screen in the estate, for files whose bytes had not changed.
 */
test('⚠️ a content-addressed filename survives a restore', () => {
  const { isDigestName } = require('../lib/content-digest');
  const digestName = `${'a'.repeat(64)}.mp4`;
  assert.equal(isDigestName(digestName), true);
  assert.equal(isDigestName('holiday-promo.mp4'), false);
  assert.equal(isDigestName(`${id()}.mp4`), false, 'a uuid name is not a digest name');

  // The rule the restore applies: keep a digest name, rename anything else to the new row id.
  const restoredName = (original, newId) =>
    (isDigestName(original) ? original : `${newId}.mp4`);
  assert.equal(restoredName(digestName, 'new-id'), digestName,
    'renaming this would restart every web and BrightSign screen for unchanged bytes');
  assert.match(restoredName('holiday-promo.mp4', 'new-id'), /^new-id\.mp4$/);
});

test('the synchronous digest agrees with the streamed one', async () => {
  /*
   * The restore runs inside a better-sqlite3 transaction, which cannot await — so it uses a
   * chunked synchronous digest. Two implementations of one hash is two chances to disagree, and a
   * digest that disagrees with itself is worse than no digest: it would report content as changed
   * on every push, for ever.
   */
  const os2 = require('node:os');
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const { digestFile, digestFileSync } = require('../lib/content-digest');

  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'digest-agree-'));
  const f = path2.join(dir, 'x.bin');
  // Bigger than the sync reader's chunk, so the chunking itself is exercised rather than skipped.
  fs2.writeFileSync(f, crypto.randomBytes(3 * 1024 * 1024));

  assert.equal(digestFileSync(f), await digestFile(f));
  assert.equal(digestFileSync(path2.join(dir, 'missing.bin')), null, 'and both fail the same way');
  assert.equal(await digestFile(path2.join(dir, 'missing.bin')), null);
});
