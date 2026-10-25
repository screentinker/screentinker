'use strict';

/*
 * #714 admin-only playlists: a workspace admin can lock a playlist so a content manager
 * (workspace_editor) can no longer edit, add/remove items, reorder or delete it, while every other
 * playlist stays editable. The lock is enforced in the API (routes/playlists.js loadPlaylistAccess),
 * not just the UI — these drive the routes directly and prove the denied and the allowed paths.
 *
 * Runs against a FRESH data dir so the #714 migration (playlists.admin_locked) runs here too.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-adminlock-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-adminlock';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'org-al', WS = 'ws-al';
const users = { admin: 'u-al-admin', editor: 'u-al-editor', viewer: 'u-al-viewer' };
for (const [k, id] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@al.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.admin);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'AdminLock WS');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin');
mem.run(WS, users.editor, 'workspace_editor');
mem.run(WS, users.viewer, 'workspace_viewer');

const app = express();
app.use(express.json());
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }), emit: () => {} };
app.set('io', { of: () => nsp });
for (const p of ['playlists', 'widgets']) {
  app.use(`/api/${p}`, requireAuth, resolveTenancy, require(`../routes/${p}`));
}
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

const S = {};
before(async () => {
  S.widget = (await call('POST', '/api/widgets', 'admin', { name: 'Clock', widget_type: 'clock', config: {} })).json.id;
  assert.ok(S.widget, 'widget created');
  // A locked playlist with one item (so reorder has something to touch).
  S.locked = (await call('POST', '/api/playlists', 'admin', { name: 'Head office notices' })).json.id;
  assert.ok(S.locked, 'locked playlist created');
  const it = await call('POST', `/api/playlists/${S.locked}/items`, 'admin', { widget_id: S.widget });
  assert.equal(it.status, 201, JSON.stringify(it.json));
  S.lockedItem = it.json.id;
  // A second playlist left unlocked, to prove the editor can still work on the others.
  S.open = (await call('POST', '/api/playlists', 'admin', { name: 'Team board' })).json.id;
  assert.ok(S.open, 'open playlist created');
});

test('admin locks the playlist; the flag is stored and reflected in GET', async () => {
  const r = await call('PUT', `/api/playlists/${S.locked}`, 'admin', { admin_locked: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.admin_locked, 1);
  assert.equal(db.prepare('SELECT admin_locked FROM playlists WHERE id = ?').get(S.locked).admin_locked, 1);
  // The editor may still READ it (and sees the flag), so the UI can show the locked indicator.
  const g = await call('GET', `/api/playlists/${S.locked}`, 'editor');
  assert.equal(g.status, 200);
  assert.equal(g.json.admin_locked, 1);
});

test('an editor is refused every write on a locked playlist', async () => {
  const rename = await call('PUT', `/api/playlists/${S.locked}`, 'editor', { name: 'Hacked' });
  assert.equal(rename.status, 403);
  assert.equal(rename.json.code, 'PLAYLIST_ADMIN_LOCKED');
  assert.equal(db.prepare('SELECT name FROM playlists WHERE id = ?').get(S.locked).name, 'Head office notices', 'rename did not take effect');

  assert.equal((await call('POST', `/api/playlists/${S.locked}/items`, 'editor', { widget_id: S.widget })).status, 403);
  assert.equal((await call('POST', `/api/playlists/${S.locked}/items/reorder`, 'editor', { order: [S.lockedItem] })).status, 403);
  assert.equal((await call('DELETE', `/api/playlists/${S.locked}/items/${S.lockedItem}`, 'editor')).status, 403);
  assert.equal((await call('POST', `/api/playlists/${S.locked}/publish`, 'editor')).status, 403);
  assert.equal((await call('DELETE', `/api/playlists/${S.locked}`, 'editor')).status, 403);
  // The item survived every refused attempt.
  assert.ok(db.prepare('SELECT 1 FROM playlist_items WHERE id = ?').get(S.lockedItem), 'item still present');
});

test('an admin is unaffected by the lock', async () => {
  assert.equal((await call('PUT', `/api/playlists/${S.locked}`, 'admin', { name: 'Head office notices v2' })).status, 200);
  assert.equal((await call('POST', `/api/playlists/${S.locked}/items/reorder`, 'admin', { order: [S.lockedItem] })).status, 200);
  assert.equal(db.prepare('SELECT name FROM playlists WHERE id = ?').get(S.locked).name, 'Head office notices v2');
});

test('an editor can still edit an unlocked playlist', async () => {
  assert.equal((await call('PUT', `/api/playlists/${S.open}`, 'editor', { name: 'Team board edited' })).status, 200);
  assert.equal((await call('POST', `/api/playlists/${S.open}/items`, 'editor', { widget_id: S.widget })).status, 201);
});

test('an editor cannot set the admin-only flag themselves', async () => {
  const r = await call('PUT', `/api/playlists/${S.open}`, 'editor', { admin_locked: 1 });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'PLAYLIST_ADMIN_LOCKED');
  assert.equal(db.prepare('SELECT admin_locked FROM playlists WHERE id = ?').get(S.open).admin_locked, 0, 'flag unchanged');
});

test('a viewer is refused the lock toggle (read-only) and admin can unlock', async () => {
  assert.equal((await call('PUT', `/api/playlists/${S.open}`, 'viewer', { admin_locked: 1 })).status, 403);
  // Admin unlocks the first playlist; the editor can edit it again.
  assert.equal((await call('PUT', `/api/playlists/${S.locked}`, 'admin', { admin_locked: 0 })).status, 200);
  assert.equal((await call('PUT', `/api/playlists/${S.locked}`, 'editor', { name: 'Now shared' })).status, 200);
});
