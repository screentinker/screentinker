'use strict';

/*
 * The Reviews page has to be readable by a person: "Changes since the live version" names the
 * files, widgets and playlists (not their ids), and adding one item does not mark every other
 * item as changed. Fresh data dir, so the migrations run here too.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-review-diff-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-review-diff';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'org-rd', WS = 'ws-rd', WS2 = 'ws-rd-other';
const users = { admin: 'u-rd-admin', alice: 'u-rd-alice', bob: 'u-rd-bob', other: 'u-rd-other' };
for (const [k, id] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@rd.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.admin);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Review WS');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O, 'Other WS');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.alice, 'workspace_editor'); mem.run(WS, users.bob, 'workspace_editor');
mem.run(WS2, users.other, 'workspace_admin');

const app = express();
app.use(express.json());
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }), emit: () => {} };
app.set('io', { of: () => nsp });
for (const p of ['playlists', 'approvals']) app.use(`/api/${p}`, requireAuth, resolveTenancy, require(`../routes/${p}`));
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who, body) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(row(users[who]), WS)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

const addContent = (id, file, ws = WS) => db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES (?,?,?,?,?,'image/png')")
  .run(id, users.alice, ws, file, `${id}.png`);

test('a review names what changed and only marks what changed', async () => {
  addContent('rd-a', 'menu-front.png'); addContent('rd-b', 'menu-back.png'); addContent('rd-c', 'new-offer.png');
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES ('rd-w',?,?,'clock','Lobby clock','{}')").run(users.alice, WS);
  const pl = await call('POST', '/api/playlists', 'alice', { name: 'Counter loop' });
  assert.equal(pl.status, 201, JSON.stringify(pl.json));
  const id = pl.json.id;
  for (const body of [{ content_id: 'rd-a', duration_sec: 8 }, { content_id: 'rd-b', duration_sec: 8 }, { widget_id: 'rd-w', duration_sec: 15 }]) {
    const r = await call('POST', `/api/playlists/${id}/items`, 'alice', body);
    assert.ok(r.status < 300, JSON.stringify(r.json));
  }
  // A dayparted item: the live snapshot keeps its blocks in another shape, which is not a change.
  const first = (await call('GET', `/api/playlists/${id}`, 'alice')).json.items;
  const sch = await call('PUT', `/api/playlists/${id}/items/${first[1].id}/schedules`, 'alice', { blocks: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '11:00' }] });
  assert.equal(sch.status, 200, JSON.stringify(sch.json));
  assert.equal((await call('POST', `/api/playlists/${id}/publish`, 'alice')).status, 200, 'approval off: a direct publish');

  const on = await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.bob], require_approval: true });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  // One new item, added at the TOP so every other item's position moves.
  const add = await call('POST', `/api/playlists/${id}/items`, 'alice', { content_id: 'rd-c', duration_sec: 8 });
  assert.ok(add.status < 300, JSON.stringify(add.json));
  const items = (await call('GET', `/api/playlists/${id}`, 'alice')).json.items;
  const reorder = await call('POST', `/api/playlists/${id}/items/reorder`, 'alice', { order: [items[3].id, items[0].id, items[1].id, items[2].id] });
  assert.ok(reorder.status < 300, JSON.stringify(reorder.json));

  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: id });
  assert.equal(sub.status, 201, JSON.stringify(sub.json));
  const detail = await call('GET', `/api/approvals/${sub.json.id}`, 'bob');
  assert.equal(detail.status, 200);
  const d = detail.json.diff_from_live.items;
  assert.deepEqual(d.added.map((a) => a.content_id), ['rd-c']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, [], 'the unchanged items are not reported as changed');
  assert.equal(d.reordered, false, 'adding an item at the top is not a reorder of the others');
  // Names for every id the diff or the preview mentions, from this workspace only.
  assert.equal(detail.json.names.content['rd-c'], 'new-offer.png');
  assert.equal(detail.json.names.content['rd-a'], 'menu-front.png');
  assert.equal(detail.json.names.widget['rd-w'], 'Lobby clock');

  // A real change to an existing item is still reported, and only that one.
  const wd = await call('POST', `/api/approvals/${sub.json.id}/withdraw`, 'alice');
  assert.equal(wd.status, 200, JSON.stringify(wd.json));
  const rdA = items.find((it) => it.content_id === 'rd-a');
  const put = await call('PUT', `/api/playlists/${id}/items/${rdA.id}`, 'alice', { duration_sec: 12 });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const sub2 = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: id });
  assert.equal(sub2.status, 201, JSON.stringify(sub2.json));
  const d2 = (await call('GET', `/api/approvals/${sub2.json.id}`, 'bob')).json.diff_from_live.items;
  assert.deepEqual(d2.changed.map((c) => [c.item.content_id, c.changes.map((x) => x.field)]), [['rd-a', ['duration_sec']]]);
});
