'use strict';

/*
 * #796: folders for the widget, playlist and schedule libraries (routes/library-folders.js).
 *
 * Real HTTP against the real routers (auth + tenancy + the router), on a fresh database:
 *   - folder CRUD for each kind, counts, subfolders, cycles, the per-kind separation
 *   - moving items is organisational ONLY: the widget, playlist, schedule and playlist_items rows are
 *     byte-for-byte what they were (widgets.updated_at is the player's widget revision)
 *   - deleting a folder moves its subfolders and items up; nothing inside is deleted
 *   - workspace isolation: another workspace's folder or item is a 400 / 404, never a write
 *   - a read-only member can browse but not create, rename, move or delete
 *   - deleting an item forgets where it was filed; existing items need no migration (they are at the root)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-libfolders-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-library-folders';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-lf', WS = 'ws-lf', WS2 = 'ws-lf2';
for (const [id, email] of [['u-lf-owner', 'lfowner@t.local'], ['u-lf-editor', 'lfeditor@t.local'], ['u-lf-viewer', 'lfviewer@t.local'], ['u-lf-other', 'lfother@t.local']]) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')").run(id, email);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', 'u-lf-owner');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run('o-lf2', 'Org2', 'u-lf-other');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, 'o-lf2', 'WS2');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?,'org_owner')").run(O, 'u-lf-owner');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?,'org_owner')").run('o-lf2', 'u-lf-other');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'workspace_editor')").run(WS, 'u-lf-editor');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'workspace_viewer')").run(WS, 'u-lf-viewer');

// Fixtures: what existed before the feature. Old timestamps so a write that touched them would show.
db.prepare("INSERT INTO devices (id,name,workspace_id) VALUES ('d-lf','Lobby',?)").run(WS);
db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config,created_at,updated_at) VALUES ('w-1','u-lf-owner',?,'clock','Clinic clock','{}',1000,1000)").run(WS);
db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config,created_at,updated_at) VALUES ('w-2','u-lf-owner',?,'text','Room numbers','{}',1000,1000)").run(WS);
db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES ('w-tpl',NULL,NULL,'clock','Template clock','{}')").run();
db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES ('w-other','u-lf-other',?,'clock','Theirs','{}')").run(WS2);
db.prepare(`INSERT INTO playlists (id,user_id,workspace_id,name,status,published_snapshot,created_at,updated_at)
            VALUES ('p-1','u-lf-owner',?,'Clinic loop','published','[{"widget_id":"w-1"}]',1000,1000)`).run(WS);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p-2','u-lf-owner',?,'Spare')").run(WS);
db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p-other','u-lf-other',?,'Theirs')").run(WS2);
db.prepare("INSERT INTO playlist_items (playlist_id,widget_id,sort_order) VALUES ('p-1','w-1',0)").run();
db.prepare("UPDATE devices SET playlist_id = 'p-1' WHERE id = 'd-lf'").run();
db.prepare(`INSERT INTO schedules (id,user_id,workspace_id,device_id,playlist_id,title,start_time,end_time,recurrence,priority,created_at,updated_at)
            VALUES ('s-1','u-lf-owner',?,'d-lf','p-1','Clinic hours','2026-01-01T09:00:00','2026-01-01T17:00:00','FREQ=WEEKLY;BYDAY=MO',5,1000,1000)`).run(WS);

const app = express();
app.use(express.json());
const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) };
app.set('io', io);
app.use('/api/library-folders', requireAuth, resolveTenancy, require('../routes/library-folders'));
app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
app.use('/api/schedules', requireAuth, resolveTenancy, require('../routes/schedules'));
const server = app.listen(0);
test.after(() => { server.close(); });

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who = 'u-lf-editor', body, ws = WS) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(row(who), ws)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, body: json };
}
const snap = () => ({
  widgets: db.prepare('SELECT * FROM widgets ORDER BY id').all(),
  playlists: db.prepare('SELECT * FROM playlists ORDER BY id').all(),
  items: db.prepare('SELECT * FROM playlist_items ORDER BY id').all(),
  schedules: db.prepare('SELECT * FROM schedules ORDER BY id').all(),
  devices: db.prepare('SELECT id, playlist_id, updated_at FROM devices ORDER BY id').all(),
});

test('existing items need no migration: everything starts at the root, with usage', async () => {
  const w = await call('GET', '/api/library-folders/widget');
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.folders, []);
  assert.deepEqual(w.body.placements, {});
  assert.equal(w.body.usage['w-1'], 1, 'w-1 is in one playlist (draft and published copy count once)');
  assert.equal(w.body.usage['w-2'] || 0, 0, 'w-2 is unused');
  const p = await call('GET', '/api/library-folders/playlist');
  assert.ok(p.body.usage['p-1'] >= 2, 'p-1 is on a screen and in a schedule');
  assert.equal(p.body.usage['p-2'] || 0, 0);
  assert.ok(!('p-other' in p.body.usage), 'no usage from another workspace');
  const s = await call('GET', '/api/library-folders/schedule');
  assert.equal(s.status, 200);
  assert.equal(typeof s.body.recent_days, 'number');
  assert.equal((await call('GET', '/api/library-folders/content')).status, 404, 'unknown library');
});

let hospital, floor4, clinics;
test('folders and subfolders: create, list with counts, rename, reparent, cycles refused', async () => {
  hospital = (await call('POST', '/api/library-folders/widget/folders', 'u-lf-editor', { name: 'Hospital' })).body;
  assert.ok(hospital.id);
  floor4 = (await call('POST', '/api/library-folders/widget/folders', 'u-lf-editor', { name: 'Fourth Floor', parent_id: hospital.id })).body;
  clinics = (await call('POST', '/api/library-folders/widget/folders', 'u-lf-editor', { name: 'Clinics', parent_id: floor4.id })).body;
  assert.equal(clinics.parent_id, floor4.id);

  assert.equal((await call('POST', '/api/library-folders/widget/folders', 'u-lf-editor', { name: '  ' })).status, 400);
  assert.equal((await call('POST', '/api/library-folders/widget/folders', 'u-lf-editor', { name: 'x'.repeat(101) })).status, 400);
  // A folder of one library is not a parent in another.
  assert.equal((await call('POST', '/api/library-folders/playlist/folders', 'u-lf-editor', { name: 'P', parent_id: hospital.id })).status, 400);

  const r = await call('PUT', `/api/library-folders/widget/folders/${floor4.id}`, 'u-lf-editor', { name: '4th Floor' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, '4th Floor');
  assert.equal((await call('PUT', `/api/library-folders/widget/folders/${hospital.id}`, 'u-lf-editor', { parent_id: clinics.id })).body.error, 'Move would create a cycle');
  assert.equal((await call('PUT', `/api/library-folders/widget/folders/${hospital.id}`, 'u-lf-editor', { parent_id: hospital.id })).status, 400);

  const list = await call('GET', '/api/library-folders/widget');
  assert.deepEqual(list.body.folders.map((f) => f.name).sort(), ['4th Floor', 'Clinics', 'Hospital']);
  assert.ok(list.body.folders.every((f) => f.count === 0));
  // Separate per kind.
  assert.deepEqual((await call('GET', '/api/library-folders/playlist')).body.folders, []);
});

test('moving items is organisational only: no widget, playlist, item or schedule row changes', async () => {
  const pf = (await call('POST', '/api/library-folders/playlist/folders', 'u-lf-editor', { name: 'Clinic Playlists' })).body;
  const sf = (await call('POST', '/api/library-folders/schedule/folders', 'u-lf-editor', { name: 'Clinic Schedules' })).body;
  const before = snap();

  let r = await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['w-1', 'w-2'], folder_id: clinics.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 2);
  r = await call('POST', '/api/library-folders/playlist/move', 'u-lf-editor', { ids: ['p-1'], folder_id: pf.id });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/library-folders/schedule/move', 'u-lf-editor', { ids: ['s-1'], folder_id: sf.id });
  assert.equal(r.status, 200);
  // Re-filing and back to the root.
  r = await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['w-2'], folder_id: null });
  assert.equal(r.status, 200);

  assert.deepEqual(snap(), before, 'a move wrote nothing but its own filing rows');

  const w = (await call('GET', '/api/library-folders/widget')).body;
  assert.deepEqual(w.placements, { 'w-1': clinics.id });
  assert.equal(w.folders.find((f) => f.id === clinics.id).count, 1);
  assert.equal((await call('GET', '/api/library-folders/playlist')).body.placements['p-1'], pf.id);
  assert.equal((await call('GET', '/api/library-folders/schedule')).body.placements['s-1'], sf.id);
});

test('a move is refused for templates, other kinds and other workspaces, and changes nothing', async () => {
  const before = db.prepare('SELECT * FROM library_folder_items ORDER BY kind, item_id').all();
  const pf = (await call('GET', '/api/library-folders/playlist')).body.folders[0];
  // A platform template is shared by every workspace: no one workspace may file it.
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['w-tpl'], folder_id: clinics.id })).status, 404);
  // Another workspace's item.
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['w-other'], folder_id: clinics.id })).status, 404);
  // A playlist id in the widget library, a widget folder for a playlist.
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['p-2'], folder_id: clinics.id })).status, 404);
  assert.equal((await call('POST', '/api/library-folders/playlist/move', 'u-lf-editor', { ids: ['p-2'], folder_id: clinics.id })).status, 400);
  // Mixed: one good, one foreign. All or nothing.
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['w-2', 'w-other'], folder_id: clinics.id })).status, 404);
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: [], folder_id: null })).status, 400);

  // The other workspace sees none of this, and cannot use, rename or delete this workspace's folders.
  const theirs = await call('GET', '/api/library-folders/widget', 'u-lf-other', null, WS2);
  assert.deepEqual(theirs.body.folders, []);
  assert.deepEqual(theirs.body.placements, {});
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-other', { ids: ['w-other'], folder_id: clinics.id }, WS2)).status, 400);
  assert.equal((await call('PUT', `/api/library-folders/widget/folders/${clinics.id}`, 'u-lf-other', { name: 'Mine' }, WS2)).status, 404);
  assert.equal((await call('DELETE', `/api/library-folders/playlist/folders/${pf.id}`, 'u-lf-other', null, WS2)).status, 404);
  assert.equal((await call('POST', '/api/library-folders/widget/folders', 'u-lf-other', { name: 'Sub', parent_id: clinics.id }, WS2)).status, 400);

  assert.deepEqual(db.prepare('SELECT * FROM library_folder_items ORDER BY kind, item_id').all(), before);
  assert.equal(db.prepare('SELECT name FROM library_folders WHERE id = ?').get(clinics.id).name, 'Clinics');
});

test('a read-only member can browse but not create, rename, move or delete', async () => {
  const g = await call('GET', '/api/library-folders/widget', 'u-lf-viewer');
  assert.equal(g.status, 200);
  assert.equal(g.body.folders.length, 3);
  assert.equal((await call('POST', '/api/library-folders/widget/folders', 'u-lf-viewer', { name: 'V' })).status, 403);
  assert.equal((await call('PUT', `/api/library-folders/widget/folders/${clinics.id}`, 'u-lf-viewer', { name: 'V' })).status, 403);
  assert.equal((await call('POST', '/api/library-folders/widget/move', 'u-lf-viewer', { ids: ['w-2'], folder_id: clinics.id })).status, 403);
  assert.equal((await call('DELETE', `/api/library-folders/widget/folders/${clinics.id}`, 'u-lf-viewer')).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM library_folders WHERE name = 'V'").get().n, 0);
});

test('deleting a folder moves its subfolders and items up a level and deletes nothing inside', async () => {
  const before = snap();
  // 4th Floor holds Clinics (which holds w-1). Delete 4th Floor: Clinics moves under Hospital.
  let r = await call('DELETE', `/api/library-folders/widget/folders/${floor4.id}`);
  assert.equal(r.status, 200);
  let w = (await call('GET', '/api/library-folders/widget')).body;
  assert.equal(w.folders.find((f) => f.id === clinics.id).parent_id, hospital.id);
  assert.equal(w.placements['w-1'], clinics.id);
  // Delete Clinics: w-1 is filed in Hospital now.
  r = await call('DELETE', `/api/library-folders/widget/folders/${clinics.id}`);
  assert.equal(r.body.items, 1);
  w = (await call('GET', '/api/library-folders/widget')).body;
  assert.equal(w.placements['w-1'], hospital.id);
  // Delete Hospital (a root folder): w-1 is back at the root.
  r = await call('DELETE', `/api/library-folders/widget/folders/${hospital.id}`);
  assert.equal(r.status, 200);
  w = (await call('GET', '/api/library-folders/widget')).body;
  assert.deepEqual(w.folders, []);
  assert.deepEqual(w.placements, {});
  assert.deepEqual(snap(), before, 'no widget, playlist or schedule was touched');
  assert.equal((await call('DELETE', `/api/library-folders/widget/folders/${hospital.id}`)).status, 404);
});

test('deleting an item forgets where it was filed', async () => {
  const f = (await call('POST', '/api/library-folders/widget/folders', 'u-lf-editor', { name: 'Doomed' })).body;
  await call('POST', '/api/library-folders/widget/move', 'u-lf-editor', { ids: ['w-2'], folder_id: f.id });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM library_folder_items WHERE item_id = 'w-2'").get().n, 1);
  assert.equal((await call('DELETE', '/api/widgets/w-2')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM library_folder_items WHERE item_id = 'w-2'").get().n, 0);
  const sf = (await call('GET', '/api/library-folders/schedule')).body.folders[0];
  assert.equal((await call('DELETE', '/api/schedules/s-1')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM library_folder_items WHERE item_id = 's-1'").get().n, 0);
  assert.equal((await call('GET', '/api/library-folders/schedule')).body.folders.find((x) => x.id === sf.id).count, 0);
});

test('the router is mounted with tenancy and kept off the token door', () => {
  const surface = require('../config/api-surface');
  const entry = surface.JWT_ONLY_ROUTERS.find((r) => r.path === '/api/library-folders');
  assert.ok(entry && entry.tenancy, 'JWT only, with resolveTenancy');
  assert.ok(!surface.PUBLIC_ROUTERS.some((r) => r.path === '/api/library-folders'));
  // Nothing in the router or its lib writes the resources themselves.
  for (const f of ['routes/library-folders.js', 'lib/library-folders.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /(UPDATE|INSERT INTO|DELETE FROM)\s+(widgets|playlists|schedules|playlist_items)\b/i, `${f} writes a resource row`);
  }
});
