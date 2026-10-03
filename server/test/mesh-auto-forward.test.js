'use strict';

/*
 * PASSING RECEIVED CONTENT ON WITHOUT BEING ASKED EACH TIME.
 *
 * An MSP with one campaign and forty sites should not push it forty times, and the middle node
 * already holds the bytes. But automating it puts three separate decisions in one place, and the
 * whole value of these tests is that none of them can quietly substitute for another:
 *
 *   the content's owner  — may this travel further at all?          (provenance.relayable)
 *   this operator        — do I want it passed to this client?      (edge.auto_forward)
 *   each server below    — do I accept it?                          (its own grant, on arrival)
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-autofwd-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { db } = require('../db/database');
const autoForward = require('../lib/mesh/auto-forward');

const id = () => crypto.randomUUID();
let ws, userId, contentDir;

before(() => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `f-${userId}@e.com`, 'F', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  ws = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(ws, org, 'W');
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-files-'));
});

beforeEach(() => {
  db.prepare("DELETE FROM mesh_edges").run();
  db.prepare('DELETE FROM mesh_content_provenance').run();
});

function downEdge(peer, { autoForward: af = 1 } = {}) {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, auto_forward)
              VALUES (?,?,'down','[]','["health"]','they-dial',1,strftime('%s','now'),?)`).run(e, peer, af);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
}

function received(localId, { relayable, fromNode = 'hub-above' }) {
  const name = `${'a'.repeat(64)}.mp4`;
  fs.writeFileSync(path.join(contentDir, name), 'bytes');
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size)
              VALUES (?,?,?,?,?,?,?)`).run(localId, userId, ws, 'Campaign.mp4', name, 'video/mp4', 5);
  db.prepare(`INSERT INTO mesh_content_provenance
                (origin_node_id, origin_content_id, local_content_id, edge_id, bytes,
                 first_seen_at, last_seen_at, relayable)
              VALUES (?,?,?,?,?,strftime('%s','now'),strftime('%s','now'),?)`)
    .run(fromNode, 'origin-' + localId, localId, 'edge-above', 5, relayable ? 1 : 0);
  return { localId, oid: 'origin-' + localId };
}

const capture = () => {
  const sent = [];
  return { sent, offerTo: async (nodeId, req) => { sent.push({ nodeId, req }); return { ok: true, stored: [{}] }; } };
};
const deps = (c) => ({ contentDir, offerTo: c.offerTo, workspaceFor: () => ws });

test('content the owner allowed to travel reaches a client set to receive it', async () => {
  const site = downEdge('site-1');
  const item = received(id(), { relayable: true });
  const c = capture();

  const r = await autoForward.forwardReceived(db, [item], { peer_node_id: 'hub-above' }, deps(c));
  assert.equal(r.forwarded.length, 1);
  assert.equal(c.sent[0].nodeId, 'site-1');
  assert.equal(c.sent[0].req.manifest.content.length, 1);
  // ⚠️ Passed on as relayable again: the owner's permission does not expire at the first hop, and a
  // node further down still decides for itself.
  assert.equal(c.sent[0].req.manifest.content[0].rl, true);
  assert.ok(site);
});

test('⚠️ content the owner did NOT mark is never passed on, however the local flag is set', async () => {
  downEdge('site-1');
  const item = received(id(), { relayable: false });
  const c = capture();

  const r = await autoForward.forwardReceived(db, [item], { peer_node_id: 'hub-above' }, deps(c));
  assert.equal(c.sent.length, 0, 'that decision belongs to whoever owns the file');
  assert.equal(r.forwarded.length, 0);
  assert.match(r.skipped[0].why, /not marked/i);
});

test('⚠️ a client that has not opted in receives nothing', async () => {
  downEdge('site-quiet', { autoForward: 0 });
  const item = received(id(), { relayable: true });
  const c = capture();

  await autoForward.forwardReceived(db, [item], { peer_node_id: 'hub-above' }, deps(c));
  assert.equal(c.sent.length, 0, 'automation is opt-in per client, by the operator who holds them');
});

test('⚠️ it never goes back the way it came', async () => {
  /*
   * Two nodes each set to pass content on would otherwise hand the same asset to each other for
   * ever — and because the digest makes every hop after the first a no-op, it would be invisible
   * traffic rather than an obvious loop.
   */
  downEdge('hub-above');            // the sender is also, somehow, a client
  downEdge('site-1');
  const item = received(id(), { relayable: true });
  const c = capture();

  await autoForward.forwardReceived(db, [item], { peer_node_id: 'hub-above' }, deps(c));
  assert.deepEqual(c.sent.map((x) => x.nodeId), ['site-1']);
});

test('⚠️ a client with several workspaces is skipped rather than guessed at', async () => {
  downEdge('site-many');
  const item = received(id(), { relayable: true });
  const c = capture();

  const r = await autoForward.forwardReceived(db, [item], { peer_node_id: 'hub-above' },
    { contentDir, offerTo: c.offerTo, workspaceFor: () => null });
  assert.equal(c.sent.length, 0);
  assert.match(r.skipped[0].why, /workspace/i,
    'guessing would drop a campaign into the wrong customer\'s screens');
});

test('one client refusing does not stop the others', async () => {
  downEdge('site-1');
  downEdge('site-2');
  const item = received(id(), { relayable: true });
  const sent = [];
  const offerTo = async (nodeId, req) => {
    sent.push(nodeId);
    if (nodeId === 'site-1') return { ok: false, reason: 'out of allowance' };
    return { ok: true, stored: [{}] };
  };

  const r = await autoForward.forwardReceived(db, [item], { peer_node_id: 'hub-above' },
    { contentDir, offerTo, workspaceFor: () => ws });
  assert.equal(sent.length, 2);
  assert.equal(r.forwarded.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /allowance/);
});
