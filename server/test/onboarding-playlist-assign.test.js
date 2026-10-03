'use strict';

/*
 * 2.0.1 — onboarding finishes with a playlist ON the screen, not with a screen that exists.
 *
 * ⚠️ THE GAP THIS CLOSES. The wizard ended at "paired", congratulated the operator, and sent them
 * to a dashboard showing a display with nothing on it. Assigning something was a separate hunt
 * through Playlists that nothing in the wizard mentioned. A vendor running Juuno alongside this
 * described exactly that as the reason a first setup does not feel finished.
 *
 * ⚠️ WHAT THIS TEST IS ACTUALLY PINNING, and it is not the dropdown. It is that onboarding's assign
 * is THE SAME WRITE the Displays page makes, through the same endpoint — because the tempting
 * shortcut (UPDATE devices SET playlist_id) produces a screen that plays the right thing today and
 * is silently re-inherited from its group later. POST /playlists/:id/assign also stamps
 * playlist_source = 'device', which is what makes the resolver treat it as a real per-screen
 * override. A second, subtly different assign path is the bug this file exists to prevent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-onbassign-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-onboarding-assign';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// devices -> workspaces -> organizations -> users, FK-enforced, so seed the whole chain.
function seed(suffix) {
  const u = 'u-' + suffix, o = 'o-' + suffix, ws = 'ws-' + suffix;
  const dev = 'd-' + suffix, pl = 'p-' + suffix;
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
    .run(u, suffix + '@test.local');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(o, 'org ' + suffix, u);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ws, o, 'ws ' + suffix);
  // accessContext resolves through the MEMBERSHIP tables, not organizations.owner_user_id.
  db.prepare("INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(o, u);
  db.prepare("INSERT INTO playlists (id, name, workspace_id, user_id) VALUES (?, 'Lobby loop', ?, ?)").run(pl, ws, u);
  // The freshly paired screen: a display row with nothing on it, which is exactly the state the
  // wizard used to leave behind.
  db.prepare(`INSERT INTO devices (id, name, workspace_id, user_id, created_at, updated_at)
              VALUES (?, 'New screen', ?, ?, strftime('%s','now'), strftime('%s','now'))`).run(dev, ws, u);
  return { u, ws, dev, pl };
}

const mine = seed('onb');

const app = express();
app.use(express.json());
app.use('/api/playlists', requireAuth, resolveTenancy, require('../routes/playlists'));
app.use('/api/assignments', requireAuth, resolveTenancy, require('../routes/assignments'));
const server = app.listen(0);

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const tokenFor = (u, ws) => generateToken(userRow(u), ws);

async function assign(playlistId, deviceId, token) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/playlists/${playlistId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ device_id: deviceId }),
  });
  return res.status;
}

const deviceRow = (id) => db.prepare('SELECT playlist_id, playlist_source FROM devices WHERE id = ?').get(id);
const playlistRow = (id) => db.prepare('SELECT status, published_snapshot FROM playlists WHERE id = ?').get(id);

async function post(url, body, token) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('the onboarding assign writes the same fields the Displays picker writes', async () => {
  assert.equal(deviceRow(mine.dev).playlist_id, null, 'precondition: the paired screen has nothing on it');

  assert.equal(await assign(mine.pl, mine.dev, tokenFor(mine.u, mine.ws)), 200);

  const after = deviceRow(mine.dev);
  assert.equal(after.playlist_id, mine.pl, 'the screen must end up playing the chosen playlist');
  // The half a direct UPDATE would miss: without this the resolver looks past the assignment at
  // the device's group and the operator's choice is undone the next time anything re-resolves.
  assert.equal(after.playlist_source, 'device', "the assignment must be stamped as this screen's own override");
});

test('onboarding calls the Displays endpoint, not a second assign path of its own', () => {
  const onboarding = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'onboarding.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');

  // What the Displays picker uses (api.assignPlaylistToDevice).
  assert.match(api, /assignPlaylistToDevice:.*\/playlists\/\$\{playlistId\}\/assign/,
    'api.assignPlaylistToDevice no longer posts to /playlists/:id/assign — update this test AND onboarding');

  // The wizard must reach the same endpoint...
  assert.match(onboarding, /\/api\/playlists\/\$\{[^}]+\}\/assign/,
    'onboarding must assign through POST /api/playlists/:id/assign, the same write the Displays page makes');
  // ...and must not have grown a shortcut that sets the column some other way.
  assert.ok(!/playlist_id\s*:/.test(onboarding),
    'onboarding sends playlist_id in a request body — that is a second assign path; use /playlists/:id/assign');
});

test('skipping the picker leaves the screen exactly as it was', async () => {
  // The wizard must never block finishing. Nothing to assert on the server for a skip except the
  // absence of a write, so pin the client side: the assign is guarded on a non-empty selection.
  const onboarding = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'onboarding.js'), 'utf8');
  assert.match(onboarding, /if \(pairedDeviceId && pick && pick !== assignedPlaylistId\)/,
    'the finish handler must only assign when a display was paired AND a playlist was actually chosen');
});


/*
 * ⚠️ THE TRAP UNDER THE UPLOAD STEP, and it is the reason onboarding could finish on a lie.
 *
 * Adding an item to a playlist marks it DRAFT, and ws/deviceSocket builds a device's payload from
 * `published_snapshot` with NO fallback to the live items. So a playlist that has never been
 * published sends the screen an empty list — while the wizard said "Content uploaded and
 * assigned!" and then "Your display is paired and content is playing!".
 *
 * These two tests are a pair on purpose: the first states the behaviour that makes the bug
 * possible (so nobody "fixes" it by deleting the publish call, thinking it redundant), and the
 * second states what onboarding must therefore do.
 */
test('THE TRAP: uploading content to a screen leaves the playlist a draft with no snapshot', async () => {
  const s2 = seed('trap');
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size)
              VALUES ('c-trap', ?, ?, 'clip.mp4', 'clip.mp4', 'video/mp4', 30, 100)`).run(s2.u, s2.ws);
  const token = tokenFor(s2.u, s2.ws);

  const r = await post(`/api/assignments/device/${s2.dev}`, { content_id: 'c-trap' }, token);
  assert.equal(r.status, 201);

  const pl = playlistRow(deviceRow(s2.dev).playlist_id);
  assert.equal(pl.status, 'draft');
  assert.equal(pl.published_snapshot, null,
    'if this is no longer null the assign path started publishing — check onboarding still needs its publish call');
});

test('THE FIX: publishing after the upload is what actually puts content on the screen', async () => {
  const s2 = seed('fix');
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size)
              VALUES ('c-fix', ?, ?, 'clip.mp4', 'clip.mp4', 'video/mp4', 30, 100)`).run(s2.u, s2.ws);
  const token = tokenFor(s2.u, s2.ws);

  await post(`/api/assignments/device/${s2.dev}`, { content_id: 'c-fix' }, token);
  const playlistId = deviceRow(s2.dev).playlist_id;

  const pub = await post(`/api/playlists/${playlistId}/publish`, {}, token);
  assert.equal(pub.status, 200);

  const pl = playlistRow(playlistId);
  assert.equal(pl.status, 'published');
  const snapshot = JSON.parse(pl.published_snapshot);
  assert.equal(snapshot.length, 1, 'the screen must now receive the item it was told is playing');
  assert.equal(snapshot[0].content_id, 'c-fix');
});

test('onboarding publishes what it assigns', () => {
  const onboarding = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'onboarding.js'), 'utf8');
  assert.match(onboarding, /\/api\/playlists\/\$\{playlistId\}\/publish/,
    'onboarding must publish through POST /api/playlists/:id/publish, or the wizard finishes on a blank screen');
  assert.match(onboarding, /const published = await publish\(assignedPlaylistId\)/,
    'the upload step must publish the playlist it just created');
  // A playlist that already has a snapshot may carry someone's in-progress draft edits; a setup
  // wizard must not push those to every screen using it.
  assert.match(onboarding, /if \(neverPublished\.has\(pick\)\)/,
    'the picker must publish ONLY playlists that have never been published');
});

test.after(() => { try { server.close(); } catch { /* */ } });
