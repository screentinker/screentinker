'use strict';

// The schedule dialog offers "Content (single item, optional)". The value was validated for
// cross-tenancy and stored faithfully — and then read by nothing at all. services/scheduler.js acts
// on exactly two columns:
//
//     if (active.layout_id   && ...) { ...apply... }
//     if (active.playlist_id && ...) { ...apply... }
//
// content_id, widget_id and zone_id are consulted nowhere. So a content-only schedule was a
// complete no-op, while the calendar drew a block labelled with the filename as confirmation that
// it would fire.
//
// Rather than thread a third override through the engine and every player, the schedule now gets a
// playlist holding that one item — the shape the whole pipeline already understands.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-schedcontent-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-sched-content';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-sc', WS = 'ws-sc', U = 'u-sc', DEV = 'dev-sc', C = 'c-sc';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'sc@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, U);
db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
            VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(DEV, 'Screen', WS);
db.prepare("INSERT OR IGNORE INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,'promo.jpg','promo.jpg','image/jpeg',1234)").run(C, WS, U);

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/schedules', requireAuth, resolveTenancy, require('../routes/schedules'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS);

async function createSchedule(body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const BASE = { device_id: DEV, title: 'Promo hour', start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T17:00:00' };

test('THE BUG: a content-only schedule now has something the engine can act on', async () => {
  const { status } = await createSchedule({ ...BASE, content_id: C });
  assert.equal(status, 201);   // created
  const s = db.prepare('SELECT * FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  assert.ok(s.playlist_id, 'the engine reads playlist_id; without one the schedule did nothing');
});

test('the generated playlist contains exactly that item, published', () => {
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(s.playlist_id);
  assert.equal(pl.workspace_id, WS, 'and it belongs to the right workspace');
  assert.equal(pl.status, 'published');
  assert.equal(pl.is_auto_generated, 1, 'or the Playlists toggle can never hide it');
  const items = db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ?').all(s.playlist_id);
  assert.deepEqual(items.map(i => i.content_id), [C]);
});

test('the snapshot the players read is populated', () => {
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  const pl = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(s.playlist_id);
  const snap = JSON.parse(pl.published_snapshot || '[]');
  assert.equal(snap.length, 1);
  assert.equal(snap[0].content_id, C);
  assert.ok(snap[0].filename, 'players need the denormalized fields, not just the id');
});

test('an explicit playlist override still wins and no playlist is invented', async () => {
  db.prepare("INSERT OR IGNORE INTO playlists (id,name,workspace_id,user_id) VALUES ('pl-explicit','Mine',?,?)").run(WS, U);
  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  await createSchedule({ ...BASE, content_id: C, playlist_id: 'pl-explicit' });
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  assert.equal(s.playlist_id, 'pl-explicit');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before, 'no throwaway playlist created');
});

test('a schedule with neither content nor playlist is unchanged', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  await createSchedule({ ...BASE, title: 'Layout only' });
  const s = db.prepare('SELECT playlist_id FROM schedules WHERE device_id = ? ORDER BY rowid DESC').get(DEV);
  assert.equal(s.playlist_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before);
});

// A PUT that changes content_id must rewrite the generated playlist's item: the playlist
// holds a COPY of the content, not a reference, so without this the screen keeps playing
// the old file while the calendar shows the new one.
test('PUT with a new content_id rewrites the generated item and republishes', async () => {
  db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
              VALUES ('dev-put','Screen PUT',?,strftime('%s','now'),strftime('%s','now'))`).run(WS);
  db.prepare("INSERT OR IGNORE INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size,duration_sec) VALUES ('c-put2',?,?,'clip.mp4','clip.mp4','video/mp4',999,32)").run(WS, U);
  const created = await createSchedule({ ...BASE, device_id: 'dev-put', content_id: C });
  assert.equal(created.status, 201);
  const schedId = created.body.id;
  const plId = created.body.playlist_id;
  assert.ok(plId);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/schedules/${schedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content_id: 'c-put2' }),
  });
  assert.equal(res.status, 200);

  const items = db.prepare('SELECT content_id, duration_sec FROM playlist_items WHERE playlist_id = ?').all(plId);
  assert.deepEqual(items.map(i => i.content_id), ['c-put2']);
  assert.equal(items[0].duration_sec, 32, 'the new clip keeps its own length, not the flat default');
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(plId).published_snapshot || '[]');
  assert.equal(snap.length, 1);
  assert.equal(snap[0].content_id, 'c-put2', 'players read the snapshot, so the rewrite republishes');
});

// Same PUT on a schedule with an explicit playlist override must NOT touch that playlist:
// content_id is vestigial there, the override wins.
test('PUT content change leaves an explicit playlist override alone', async () => {
  db.prepare("INSERT OR IGNORE INTO playlists (id,name,workspace_id,user_id) VALUES ('pl-keep','Kept',?,?)").run(WS, U);
  const created = await createSchedule({ ...BASE, device_id: 'dev-put', content_id: C, playlist_id: 'pl-keep' });
  assert.equal(created.status, 201);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/schedules/${created.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content_id: 'c-put2' }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get('pl-keep').n, 0);
  assert.equal(db.prepare('SELECT playlist_id FROM schedules WHERE id = ?').get(created.body.id).playlist_id, 'pl-keep');
});

// Deleting the schedule must collect the throwaway it invented — otherwise one orphaned
// single-item playlist accumulates per deleted schedule, invisible once the toggle hides them.
test('DELETE removes the orphaned generated playlist', async () => {
  const created = await createSchedule({ ...BASE, device_id: 'dev-put', content_id: C });
  assert.equal(created.status, 201);
  const plId = created.body.playlist_id;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/schedules/${created.body.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT id FROM playlists WHERE id = ?').get(plId), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(plId).n, 0);
});

test('DELETE keeps a generated playlist a human adopted or still shares', async () => {
  // Adopted: an extra hand-added item means it no longer looks like a throwaway.
  const adopted = await createSchedule({ ...BASE, device_id: 'dev-put', content_id: C });
  const adoptedPl = adopted.body.playlist_id;
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 1, 10)')
    .run(adoptedPl, C);
  await fetch(`http://127.0.0.1:${server.address().port}/api/schedules/${adopted.body.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(db.prepare('SELECT id FROM playlists WHERE id = ?').get(adoptedPl), 'adopted playlist survives');

  // Shared: a second schedule still points at it.
  const first = await createSchedule({ ...BASE, device_id: 'dev-put', content_id: C });
  const sharedPl = first.body.playlist_id;
  const second = await createSchedule({ ...BASE, device_id: 'dev-put', playlist_id: sharedPl });
  await fetch(`http://127.0.0.1:${server.address().port}/api/schedules/${first.body.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(db.prepare('SELECT id FROM playlists WHERE id = ?').get(sharedPl), 'referenced playlist survives');
  await fetch(`http://127.0.0.1:${server.address().port}/api/schedules/${second.body.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
