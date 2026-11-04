'use strict';

// Twin of schedule-content-item.test.js for widget-only schedules.
//
// The schedule dialog (and the template gallery's "use" flow) can leave a schedule carrying
// only a widget_id. The engine acts on layout_id and playlist_id alone, so a widget-only
// schedule stored playlist_id = NULL — fired, changed nothing, and the calendar drew a
// confirmation block the panel never saw. Validated live Nov 2026 on the Orsay test panel:
// an active priority-1 widget schedule left devices.scheduled_playlist_id untouched; the same
// schedule with an assigned playlist_id flipped it on the next tick.
//
// Same resolution as content: give the widget its own one-item playlist through the shared
// published/assign/push pipeline. (The panel that motivated this — a Samsung DB48E running
// PR #782's renderer — plays template widgets from playlists fine.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-schedwidget-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-sched-widget';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-sw', WS = 'ws-sw', U = 'u-sw', DEV = 'dev-sw', W = 'w-sw';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'sw@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, U);
db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
            VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(DEV, 'Screen', WS);
db.prepare(`INSERT OR IGNORE INTO widgets (id,user_id,widget_type,name,config,workspace_id)
            VALUES (?,?,?,?,?,?)`).run(W, U, 'template', 'Clinic directory', '{}', WS);
// The template-gallery flow keeps gallery widgets in a NULL workspace (platform template);
// a schedule must still accept one (checkRefInWorkspace allowNullWorkspace path).
const WG = 'w-sw-gallery';
db.prepare(`INSERT OR IGNORE INTO widgets (id,user_id,widget_type,name,config,workspace_id)
            VALUES (?,?,?,?,?,NULL)`).run(WG, U, 'template', 'Gallery directory', '{}');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/schedules', requireAuth, resolveTenancy, require('../routes/schedules'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS);

async function api(method, url, body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/schedules${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function createSchedule(body) { return api('POST', '', body); }

const BASE = { device_id: DEV, title: 'Clinic hour', start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T17:00:00' };

test('THE BUG: a widget-only schedule now has something the engine can act on', async () => {
  const { status } = await createSchedule({ ...BASE, widget_id: W });
  assert.equal(status, 201);
  const s = db.prepare('SELECT * FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  assert.ok(s.playlist_id, 'the engine reads playlist_id; without one the schedule did nothing');
});

test('the generated playlist contains exactly the widget item, published', () => {
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(s.playlist_id);
  assert.equal(pl.workspace_id, WS, 'and it belongs to the right workspace');
  assert.equal(pl.status, 'published');
  assert.equal(pl.is_auto_generated, 1, 'or the Playlists toggle can never hide it');
  assert.match(pl.name, /^Scheduled: /, 'a human-titled playlist would be indistinguishable from an adopted one at DELETE time');
  const items = db.prepare('SELECT widget_id, duration_sec FROM playlist_items WHERE playlist_id = ?').all(s.playlist_id);
  assert.deepEqual(items.map(i => i.widget_id), [W]);
  assert.ok(items[0].duration_sec >= 1, 'a 0/NaN dwell self-loops and black-screens the TV');
});

test('the snapshot the players read is populated', () => {
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(s.playlist_id).published_snapshot || '[]');
  assert.equal(snap.length, 1);
  assert.equal(snap[0].widget_id, W);
});

test('an explicit playlist override still wins and no playlist is invented', async () => {
  db.prepare("INSERT OR IGNORE INTO playlists (id,name,workspace_id,user_id) VALUES ('pl-explicit-sw','Mine',?,?)").run(WS, U);
  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  await createSchedule({ ...BASE, widget_id: W, playlist_id: 'pl-explicit-sw' });
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  assert.equal(s.playlist_id, 'pl-explicit-sw');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before, 'no throwaway playlist created');
});

test('a widget from another workspace cannot be turned into an auto-generated schedule playlist', async () => {
  db.prepare("INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES ('ws-sw-foreign', ?, 'Other workspace')").run(O);
  db.prepare(`INSERT OR IGNORE INTO widgets (id,user_id,widget_type,name,config,workspace_id)
              VALUES ('w-sw-foreign', ?, 'template', 'Other workspace', '{}', 'ws-sw-foreign')`).run(U);
  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  const { status, body } = await createSchedule({ ...BASE, title: 'Cross-workspace widget', widget_id: 'w-sw-foreign' });
  assert.equal(status, 403);
  assert.match(body.error, /not in this workspace/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before, 'refusal happens before an auto-generated playlist is created');
});

test('a gallery (NULL workspace) widget schedules like a workspace widget', async () => {
  const { status } = await createSchedule({ ...BASE, title: 'Gallery hour', widget_id: WG });
  assert.equal(status, 201);
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE widget_id = ?').get(WG);
  assert.ok(s.playlist_id, 'platform-template widgets must schedule, not silently no-op');
  const pl = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(s.playlist_id);
  assert.equal(pl.workspace_id, WS, 'the invented playlist still belongs to the scheduler workspace');
});

test('a schedule with neither widget nor playlist is unchanged', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  await createSchedule({ ...BASE, title: 'Layout only' });
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE title = ?').get('Layout only');
  assert.equal(s.playlist_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before);
});

// A PUT that adds a widget_id to a playlist-less schedule (the exact defect shape operators
// hit when editing after creation) must convert it too — otherwise the edit re-arms the no-op.
test('PUT a widget_id onto a playlist-less schedule invents the playlist', async () => {
  db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
              VALUES ('dev-put-sw','Screen PUT',?,strftime('%s','now'),strftime('%s','now'))`).run(WS);
  const created = await createSchedule({ ...BASE, device_id: 'dev-put-sw' });
  assert.equal(created.status, 201);
  assert.equal(created.body.playlist_id, null, 'precondition: created with no playlist');

  const res = await api('PUT', `/${created.body.id}`, { widget_id: W });
  assert.equal(res.status, 200);
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE id = ?').get(created.body.id);
  assert.ok(s.playlist_id, 'the schedule must act on something after the edit');
  const items = db.prepare('SELECT widget_id FROM playlist_items WHERE playlist_id = ?').all(s.playlist_id);
  assert.deepEqual(items.map(i => i.widget_id), [W]);
});

test('PUT a widget change leaves a schedule that already has a playlist alone', async () => {
  db.prepare("INSERT OR IGNORE INTO playlists (id,name,workspace_id,user_id) VALUES ('pl-keep-sw','Kept',?,?)").run(WS, U);
  const created = await createSchedule({ ...BASE, device_id: 'dev-put-sw', playlist_id: 'pl-keep-sw' });
  assert.equal(created.status, 201);
  const res = await api('PUT', `/${created.body.id}`, { widget_id: W });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get('pl-keep-sw').n, 0, 'the adopted playlist belongs to its human');
  assert.equal(db.prepare('SELECT playlist_id FROM schedules WHERE id = ?').get(created.body.id).playlist_id, 'pl-keep-sw');
});

test('DELETE removes the orphaned generated playlist', async () => {
  const created = await createSchedule({ ...BASE, device_id: 'dev-put-sw', widget_id: W });
  assert.equal(created.status, 201);
  const plId = created.body.playlist_id;
  const res = await api('DELETE', `/${created.body.id}`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT id FROM playlists WHERE id = ?').get(plId), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(plId).n, 0);
});

test('DELETE keeps a generated playlist a human adopted or still shares', async () => {
  const adopted = await createSchedule({ ...BASE, device_id: 'dev-put-sw', widget_id: W });
  const adoptedPl = adopted.body.playlist_id;
  db.prepare('INSERT INTO playlist_items (playlist_id, widget_id, sort_order, duration_sec) VALUES (?, ?, 1, 10)')
    .run(adoptedPl, W);
  await api('DELETE', `/${adopted.body.id}`);
  assert.ok(db.prepare('SELECT id FROM playlists WHERE id = ?').get(adoptedPl), 'adopted playlist survives');

  const first = await createSchedule({ ...BASE, device_id: 'dev-put-sw', widget_id: W });
  const sharedPl = first.body.playlist_id;
  const second = await createSchedule({ ...BASE, device_id: 'dev-put-sw', playlist_id: sharedPl });
  await api('DELETE', `/${first.body.id}`);
  assert.ok(db.prepare('SELECT id FROM playlists WHERE id = ?').get(sharedPl), 'referenced playlist survives');
  await api('DELETE', `/${second.body.id}`);
  assert.equal(db.prepare('SELECT id FROM playlists WHERE id = ?').get(sharedPl), undefined, 'the last reference gone, the throwaway goes too');

  server.close();
  server.closeAllConnections();
});
