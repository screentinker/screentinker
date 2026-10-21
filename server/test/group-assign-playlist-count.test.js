'use strict';

// The group "Set Playlist..." toast said "Playlist assigned to 2 devices" although one of the two
// kept its own playlist (playlist_source = 'device' outranks the group). The route returned
// members.length; it now counts the members that actually resolve to the playlist, and reports
// the rest separately so the dashboard can say so.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gapc-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-group-assign-count';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-gc', WS = 'ws-gc', U = 'u-gc', G = 'g-gc';
const PL_GROUP = 'pl-gc-group', PL_OWN = 'pl-gc-own';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'gc@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, U);
for (const [id, name] of [[PL_GROUP, 'Morning menu'], [PL_OWN, 'Window TV own']]) {
  db.prepare('INSERT OR IGNORE INTO playlists (id,user_id,name,workspace_id) VALUES (?,?,?,?)').run(id, U, name, WS);
}
db.prepare('INSERT OR IGNORE INTO device_groups (id,name,user_id,workspace_id) VALUES (?,?,?,?)').run(G, 'Cafe', U, WS);

// Counter TV inherits; Window TV has chosen its own playlist.
const members = [['d-gc-counter', null, null], ['d-gc-window', PL_OWN, 'device']];
for (const [id, playlistId, source] of members) {
  db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,playlist_id,playlist_source,status,created_at,updated_at)
              VALUES (?,?,?,?,?, 'online', strftime('%s','now'),strftime('%s','now'))`)
    .run(id, id, WS, playlistId, source);
  db.prepare('INSERT OR IGNORE INTO device_group_members (group_id,device_id) VALUES (?,?)').run(G, id);
}

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/groups', requireAuth, resolveTenancy, require('../routes/device-groups'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS);

async function assign(playlistId) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/groups/${G}/assign-playlist`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlist_id: playlistId }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('a member that keeps its own playlist is not counted as assigned', async () => {
  const { status, body } = await assign(PL_GROUP);
  assert.equal(status, 200);
  assert.equal(body.devices_updated, 1, 'only Counter TV now plays the group playlist');
  assert.equal(body.devices_overridden, 1, 'Window TV kept its own, and the response says so');
  const own = db.prepare('SELECT playlist_id, playlist_source FROM devices WHERE id = ?').get('d-gc-window');
  assert.equal(own.playlist_id, PL_OWN, 'and the route still does not touch the member\'s own choice');
});

test('when the member\'s own playlist IS the one assigned, everyone is counted', async () => {
  const { body } = await assign(PL_OWN);
  assert.equal(body.devices_updated, 2);
  assert.equal(body.devices_overridden, undefined, 'no override to report');
});

test.after(() => server.close());
