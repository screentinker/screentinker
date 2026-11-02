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

test('editing an active schedule immediately refreshes its resolved playlist', async () => {
  const device = 'dev-immediate';
  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone) VALUES (?,?,?,'online','UTC')").run(device, 'Immediate', WS);
  for (const id of ['pl-immediate-a', 'pl-immediate-b']) db.prepare('INSERT INTO playlists (id,name,workspace_id,user_id) VALUES (?,?,?,?)').run(id, id, WS, U);
  const ns = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }) };
  app.set('io', { of: () => ns });
  const body = { device_id: device, playlist_id: 'pl-immediate-a', start_time: '2020-01-01T00:00:00', end_time: '2099-01-01T00:00:00', timezone: 'UTC' };
  const created = await createSchedule(body);
  assert.equal(created.status, 201);
  const selected = () => db.prepare('SELECT scheduled_playlist_id FROM devices WHERE id = ?').get(device).scheduled_playlist_id;
  const waitFor = async expected => { const deadline = Date.now() + 2000; while (selected() !== expected && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); assert.equal(selected(), expected); };
  await waitFor('pl-immediate-a');
  db.prepare('UPDATE devices SET capabilities = ? WHERE id = ?').run(JSON.stringify(['clock.tz_table', 'offline.schedule_plan']), device);
  const { Server } = require('socket.io');
  const socketServer = new Server(require('node:http').createServer());
  const deviceSocket = require('../ws/deviceSocket');
  deviceSocket(socketServer);
  const offline = deviceSocket.buildPlaylistPayloadUnchecked(device).offline_schedule;
  assert.equal(offline.schedule.start_time, body.start_time);
  assert.equal(offline.schedule.end_time, body.end_time);
  assert.ok(offline.table.spans.length > 0);
  const plan = deviceSocket.buildPlaylistPayloadUnchecked(device).offline_plan;
  assert.equal(plan.protocol_version, 1);
  assert.ok(plan.valid_until_utc_ms > plan.generated_at_utc_ms);
  assert.ok(plan.intervals.some((i) => i.schedule_id === created.body.id));
  assert.ok(plan.states.some((s) => s.schedule_id === created.body.id && s.payload.playback_order));
  socketServer.close();
  const url = `http://127.0.0.1:${server.address().port}/api/schedules/${created.body.id}`;
  const updated = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ playlist_id: 'pl-immediate-b' }) });
  assert.equal(updated.status, 200);
  await waitFor('pl-immediate-b');
  const removed = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(removed.status, 200);
  await waitFor(null);
  app.set('io', null);
});

test('an inactive future schedule is pushed immediately so an offline-capable panel can pre-cache it', async () => {
  const device = 'dev-future-plan';
  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone,capabilities) VALUES (?,?,?,'online','UTC',?)")
    .run(device, 'Future plan', WS, JSON.stringify(['clock.tz_table', 'offline.schedule_plan']));
  db.prepare("INSERT INTO playlists (id,name,workspace_id,user_id,published_snapshot,status) VALUES ('pl-future-plan','Future',?,?,?,'published')")
    .run(WS, U, JSON.stringify([{ content_id: C, filename: 'promo.jpg', filepath: 'promo.jpg', mime_type: 'image/jpeg' }]));
  const emitted = [];
  const ns = { adapter: { rooms: new Map([[device, new Set(['socket'])]]) }, to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };
  app.set('io', { of: () => ns });
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  start.setUTCSeconds(0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const created = await createSchedule({ device_id: device, playlist_id: 'pl-future-plan', start_time: start.toISOString().slice(0, 19), end_time: end.toISOString().slice(0, 19), timezone: 'UTC' });
  assert.equal(created.status, 201);
  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const update = emitted.find((x) => x.event === 'device:playlist-update');
  assert.ok(update, 'future schedule mutation must push a new desired state even when no schedule is active');
  assert.ok(update.payload.offline_plan.intervals.some((i) => i.schedule_id === created.body.id));
  assert.ok(update.payload.offline_plan.states.some((s) => s.schedule_id === created.body.id));
  app.set('io', null);
});

test('publishing a future scheduled playlist refreshes the offline plan before its interval starts', async () => {
  const device = 'dev-future-publish';
  const playlist = 'pl-future-publish';
  const secondContent = 'c-future-publish-2';
  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone,capabilities) VALUES (?,?,?,'online','UTC',?)")
    .run(device, 'Future publish', WS, JSON.stringify(['offline.schedule_plan']));
  db.prepare("INSERT INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,'second.jpg','second.jpg','image/jpeg',123)")
    .run(secondContent, WS, U);
  db.prepare("INSERT INTO playlists (id,name,workspace_id,user_id,status,published_snapshot) VALUES (?,?,?,?, 'published', '[]')")
    .run(playlist, 'Future publish', WS, U);
  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)')
    .run(playlist, C);
  require('../routes/playlists').publishPlaylist(playlist, null);

  const emitted = [];
  const ns = { adapter: { rooms: new Map([[device, new Set(['socket'])]]) }, to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };
  const io = { of: () => ns };
  app.set('io', io);
  const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
  start.setUTCSeconds(0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const created = await createSchedule({
    device_id: device,
    playlist_id: playlist,
    start_time: start.toISOString().slice(0, 19),
    end_time: end.toISOString().slice(0, 19),
    timezone: 'UTC',
  });
  assert.equal(created.status, 201);
  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  emitted.length = 0;

  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,1,10)')
    .run(playlist, secondContent);
  db.prepare("UPDATE playlists SET status = 'draft' WHERE id = ?").run(playlist);
  require('../routes/playlists').publishPlaylist(playlist, io);

  const update = emitted.find((x) => x.event === 'device:playlist-update');
  assert.ok(update, 'future-only schedule target was omitted from playlist publish fan-out');
  const state = update.payload.offline_plan.states.find((s) => s.schedule_id === created.body.id);
  assert.ok(state, 'refreshed plan omitted the future schedule state');
  assert.deepEqual(state.payload.assignments.map((a) => a.content_id), [C, secondContent]);
  app.set('io', null);
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

test('offline schedule states preserve a scheduled playlist’s published PiP layout and zone assignments', async () => {
  const device = 'dev-offline-pip-layout';
  const playlist = 'pl-offline-pip-layout';
  const layout = 'layout-offline-pip';
  const video = 'content-offline-pip-video';
  const overlay = 'content-offline-pip-overlay';
  const backgroundZone = 'z-offline-pip-background';
  const overlayZone = 'z-offline-pip-overlay';

  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone,capabilities) VALUES (?,?,?,'online','UTC',?)")
    .run(device, 'Offline PiP', WS, JSON.stringify(['clock.tz_table', 'offline.schedule_plan']));
  db.prepare('INSERT INTO layouts (id,user_id,workspace_id,name,width,height) VALUES (?,?,?,?,1920,1080)')
    .run(layout, U, WS, 'Offline PiP layout');
  db.prepare(`INSERT INTO layout_zones
      (id,layout_id,name,x_percent,y_percent,width_percent,height_percent,z_index,sort_order,is_main)
      VALUES (?,?,'Background',0,0,100,100,0,0,1), (?,?,'Overlay',65,5,30,30,1,1,0)`)
    .run(backgroundZone, layout, overlayZone, layout);
  db.prepare("INSERT INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,'background.mp4','background.mp4','video/mp4',123), (?,?,?,'overlay.png','overlay.png','image/png',123)")
    .run(video, WS, U, overlay, WS, U);
  db.prepare("INSERT INTO playlists (id,name,workspace_id,user_id,status,layout_id) VALUES (?,?,?,?, 'draft', ?)")
    .run(playlist, 'Offline PiP playlist', WS, U, layout);
  db.prepare(`INSERT INTO playlist_items (playlist_id,content_id,zone_id,sort_order,duration_sec)
      VALUES (?,?,?,?,10), (?,?,?,?,10)`)
    .run(playlist, video, backgroundZone, 0, playlist, overlay, overlayZone, 1);
  require('../routes/playlists').publishPlaylist(playlist, null);

  const emitted = [];
  const ns = { adapter: { rooms: new Map([[device, new Set(['socket'])]]) }, to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };
  app.set('io', { of: () => ns });
  const created = await createSchedule({
    device_id: device,
    playlist_id: playlist,
    start_time: '2020-01-01T00:00:00',
    end_time: '2099-01-01T00:00:00',
    timezone: 'UTC',
  });
  assert.equal(created.status, 201);

  // The schedule route commits first and then asks the shared scheduler to
  // resolve the device.  Wait for that committed resolution rather than
  // accidentally asserting the pre-schedule resolver view.
  const deadline = Date.now() + 2000;
  while (db.prepare('SELECT scheduled_playlist_id FROM devices WHERE id = ?').get(device).scheduled_playlist_id !== playlist && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.prepare('SELECT scheduled_playlist_id FROM devices WHERE id = ?').get(device).scheduled_playlist_id, playlist);

  const { Server } = require('socket.io');
  const socketServer = new Server(require('node:http').createServer());
  const deviceSocket = require('../ws/deviceSocket');
  deviceSocket(socketServer);
  const live = deviceSocket.buildPlaylistPayloadUnchecked(device);
  const state = live.offline_plan.states.find((entry) => entry.schedule_id === created.body.id);
  assert.equal(live.layout.id, layout, 'the live scheduled payload must inherit the playlist layout');
  assert.ok(state, 'the active schedule must have a cached offline state');
  assert.equal(state.layout_id, layout, 'the state must record the inherited published layout');
  assert.equal(state.payload.layout.id, layout, 'the nested payload must retain the same layout');
  assert.deepEqual(
    state.payload.assignments.map((item) => item.zone_id).sort(),
    [backgroundZone, overlayZone].sort(),
    'both PiP assignments must retain their own zones rather than collapsing to fullscreen',
  );
  socketServer.close();
  app.set('io', null);
});

test('one offline plan preserves every future scheduled playlist and its distinct multi-zone layout', () => {
  const device = 'dev-multi-offline-plan';
  const firstPlaylist = 'pl-multi-offline-first';
  const secondPlaylist = 'pl-multi-offline-second';
  const firstLayout = 'layout-multi-offline-first';
  const secondLayout = 'layout-multi-offline-second';
  const firstZone = 'z-multi-offline-first';
  const secondZone = 'z-multi-offline-second';
  const secondContent = 'content-multi-offline-second';
  const now = Math.floor(Date.now() / 60000) * 60000;
  const stamp = (value) => new Date(value).toISOString().slice(0, 16);

  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone,reported_timezone,capabilities) VALUES (?,?,?,'online','UTC','UTC',?)")
    .run(device, 'Multiple offline states', WS, JSON.stringify(['clock.tz_table', 'offline.schedule_plan']));
  for (const [layout, zone, name] of [[firstLayout, firstZone, 'First'], [secondLayout, secondZone, 'Second']]) {
    db.prepare('INSERT INTO layouts (id,user_id,workspace_id,name,width,height) VALUES (?,?,?,?,1920,1080)')
      .run(layout, U, WS, name + ' layout');
    db.prepare(`INSERT INTO layout_zones
      (id,layout_id,name,x_percent,y_percent,width_percent,height_percent,z_index,sort_order,is_main)
      VALUES (?,?,?,0,0,80,100,0,0,1), (?,?,? ,80,0,20,100,1,1,0)`)
      .run(zone, layout, name + ' main zone', zone + '-side', layout, name + ' side zone');
  }
  db.prepare("INSERT INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,'next.jpg','next.jpg','image/jpeg',123)")
    .run(secondContent, WS, U);
  for (const [playlist, layout, content, zone] of [[firstPlaylist, firstLayout, C, firstZone], [secondPlaylist, secondLayout, secondContent, secondZone]]) {
    db.prepare("INSERT INTO playlists (id,name,workspace_id,user_id,status,layout_id) VALUES (?,?,?,?, 'draft', ?)")
      .run(playlist, playlist, WS, U, layout);
    db.prepare('INSERT INTO playlist_items (playlist_id,content_id,zone_id,sort_order,duration_sec) VALUES (?,?,?,?,10)')
      .run(playlist, content, zone, 0);
    require('../routes/playlists').publishPlaylist(playlist, null);
  }
  for (const [id, playlist, start, end] of [
    ['sched-multi-offline-first', firstPlaylist, now - 5 * 60000, now + 5 * 60000],
    ['sched-multi-offline-second', secondPlaylist, now + 5 * 60000, now + 15 * 60000],
  ]) {
    db.prepare(`INSERT INTO schedules
      (id,user_id,device_id,playlist_id,title,start_time,end_time,timezone,enabled,priority)
      VALUES (?,?,?,?,?,?,?,?,1,0)`)
      .run(id, U, device, playlist, id, stamp(start), stamp(end), 'UTC');
  }

  const { Server } = require('socket.io');
  const socketServer = new Server(require('node:http').createServer());
  const deviceSocket = require('../ws/deviceSocket');
  deviceSocket(socketServer);
  const plan = deviceSocket.buildPlaylistPayloadUnchecked(device).offline_plan;
  const bySchedule = Object.fromEntries(plan.states.map((state) => [state.schedule_id, state]));
  for (const [schedule, layout, zone] of [
    ['sched-multi-offline-first', firstLayout, firstZone],
    ['sched-multi-offline-second', secondLayout, secondZone],
  ]) {
    assert.equal(bySchedule[schedule].layout_id, layout, schedule + ' must retain its published layout id');
    assert.equal(bySchedule[schedule].payload.layout.id, layout, schedule + ' must retain its layout payload');
    assert.deepEqual(bySchedule[schedule].payload.assignments.map((item) => item.zone_id), [zone], schedule + ' must retain its own zone assignment');
  }
  assert.ok(plan.intervals.some((interval) => interval.schedule_id === 'sched-multi-offline-first'));
  assert.ok(plan.intervals.some((interval) => interval.schedule_id === 'sched-multi-offline-second'));
  socketServer.close();
});
