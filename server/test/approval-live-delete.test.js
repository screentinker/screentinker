'use strict';

/*
 * GHSA-rvxj 9.1: with "require approval" on, deleting content or a widget that a published playlist
 * plays changes what screens show with no reviewer (the delete scrubs it out of the published copy
 * and pushes the screens). Only a reviewer or a workspace admin may; an editor gets 403
 * review_required, before anything is deleted. Content nothing published plays deletes as before,
 * and with approval off nothing changes.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-appr-del-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-approval-delete';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'org-adel', WS = 'ws-adel';
const users = { owner: 'u-adel-owner', admin: 'u-adel-admin', alice: 'u-adel-alice', bob: 'u-adel-bob' };
for (const [k, id] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@adel.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.owner);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Delete WS');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.alice, 'workspace_editor'); mem.run(WS, users.bob, 'workspace_editor');
db.prepare('INSERT OR IGNORE INTO workspace_reviewers (workspace_id,user_id,added_by,created_at) VALUES (?,?,?,0)').run(WS, users.bob, users.admin);

const app = express();
app.use(express.json());
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }), emit: () => {} };
app.set('io', { of: () => nsp });
app.use('/api/content', requireAuth, resolveTenancy, require('../routes/content'));
app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who, body) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(userRow(users[who]), WS)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

const id = () => crypto.randomUUID();
const LIVE = id(), IDLE = id(), VIA_WIDGET = id(), LIVE2 = id();
const W_LIVE = id(), W_SLIDE = id(), W_IDLE = id();
const addContent = (cid, name) => db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,?,?,'image/png',1)")
  .run(cid, users.alice, WS, name, `${cid}.png`);
const addWidget = (wid, name, config) => db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES (?,?,?,'text',?,?)")
  .run(wid, users.alice, WS, name, JSON.stringify(config));
addContent(LIVE, 'live.png'); addContent(IDLE, 'idle.png'); addContent(VIA_WIDGET, 'background.png'); addContent(LIVE2, 'live2.png');
addWidget(W_LIVE, 'Welcome', { text: 'hi' }); addWidget(W_SLIDE, 'Slide', { background_content_id: VIA_WIDGET }); addWidget(W_IDLE, 'Spare', { text: 'x' });
// The published copy is what screens play. IDLE and W_IDLE are in the draft only.
const PL = id();
const SNAPSHOT = JSON.stringify([{ content_id: LIVE }, { content_id: LIVE2 }, { widget_id: W_LIVE }, { widget_id: W_SLIDE }]);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status,published_snapshot) VALUES (?,?,?,'Lobby loop','published',?)").run(PL, users.alice, WS, SNAPSHOT);
for (const [i, c] of [LIVE, IDLE, LIVE2].entries()) db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,?,10)').run(PL, c, i);
for (const [i, w] of [W_LIVE, W_SLIDE, W_IDLE].entries()) db.prepare('INSERT INTO playlist_items (playlist_id,widget_id,sort_order,duration_sec) VALUES (?,?,?,10)').run(PL, w, 10 + i);

const exists = (table, rid) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(rid);
const snapshot = () => db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(PL).published_snapshot;
const approval = (on) => db.prepare('UPDATE workspaces SET require_approval = ? WHERE id = ?').run(on ? 1 : 0, WS);

test('approval on: an editor cannot delete content a published playlist plays, and nothing is touched', async () => {
  approval(true);
  const r = await call('DELETE', `/api/content/${LIVE}`, 'alice');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'review_required');
  assert.match(r.json.error, /"Lobby loop"/);
  assert.ok(exists('content', LIVE)); assert.equal(snapshot(), SNAPSHOT, 'the published copy is untouched');
  // Through a widget whose live config names it (a published slide's background).
  assert.equal((await call('DELETE', `/api/content/${VIA_WIDGET}`, 'alice')).status, 403);
  assert.ok(exists('content', VIA_WIDGET));
});

test('approval on: batch delete is refused as a unit when any item is live', async () => {
  const r = await call('POST', '/api/content/batch/delete', 'alice', { ids: [IDLE, LIVE] });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'review_required'); assert.equal(r.json.id, LIVE);
  assert.ok(exists('content', IDLE), 'the idle item listed first was not deleted either');
  assert.ok(exists('content', LIVE));
});

test('approval on: an editor can still delete what nothing published plays', async () => {
  assert.equal((await call('DELETE', `/api/content/${IDLE}`, 'alice')).status, 200);
  assert.ok(!exists('content', IDLE));
  assert.equal((await call('DELETE', `/api/widgets/${W_IDLE}`, 'alice')).status, 200);
});

test('approval on: an editor cannot delete a widget a published playlist plays', async () => {
  const r = await call('DELETE', `/api/widgets/${W_LIVE}`, 'alice');
  assert.equal(r.status, 403); assert.equal(r.json.code, 'review_required');
  assert.ok(exists('widgets', W_LIVE));
});

test('approval on: a reviewer and a workspace admin may delete live items', async () => {
  assert.equal((await call('DELETE', `/api/widgets/${W_LIVE}`, 'bob')).status, 200, 'reviewer');
  assert.equal((await call('POST', '/api/content/batch/delete', 'admin', { ids: [LIVE] })).status, 200, 'admin');
  assert.ok(!exists('content', LIVE));
});

test('approval off: an editor deletes live content exactly as before', async () => {
  approval(false);
  assert.equal((await call('DELETE', `/api/content/${LIVE2}`, 'alice')).status, 200);
  assert.ok(!exists('content', LIVE2));
});
