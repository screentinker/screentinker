'use strict';

// Choosing a sync protocol from the dashboard has one failure mode that matters: a value the
// resolver does not recognise is read as 'auto'. So a typo — or a client sending a stale/renamed
// value — would store fine, return 200, and leave the UI showing a protocol the group is not
// running. The operator's only clue would be a wall that is subtly out of step.
//
// The other half is reporting. When the request cannot be honoured (native sync on a mixed fleet)
// the group must still be told what it will ACTUALLY run and why, or the setting silently means
// something different from what it says.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sbapi-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-sync-backend-api';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-sa', WS = 'ws-sa', U = 'u-sa', PL = 'pl-sa', G = 'g-sa';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'sa@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, U);
db.prepare('INSERT OR IGNORE INTO playlists (id,user_id,name,workspace_id) VALUES (?,?,?,?)').run(PL, U, 'Shared', WS);
db.prepare(`INSERT OR IGNORE INTO device_groups (id,name,user_id,workspace_id,playlist_id,sync_enabled)
            VALUES (?,?,?,?,?,1)`).run(G, 'Group', U, WS, PL);

// A mixed group: one BrightSign, one Android. Native sync cannot include the Android one.
for (const [id, platform] of [['d-sa-bs', 'brightsign'], ['d-sa-and', 'Android 12']]) {
  db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,playlist_id,status,platform,ip_address,created_at,updated_at)
              VALUES (?,?,?,?, 'online',?, '10.0.0.1', strftime('%s','now'),strftime('%s','now'))`)
    .run(id, id, WS, PL, platform);
  db.prepare('INSERT OR IGNORE INTO device_group_members (group_id,device_id) VALUES (?,?)').run(G, id);
}

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/groups', requireAuth, resolveTenancy, require('../routes/device-groups'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS);

async function put(body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/groups/${G}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('THE TYPO: an unrecognised backend is refused, not stored as a silent "auto"', async () => {
  const { status } = await put({ sync_backend: 'brightsigne' });
  assert.equal(status, 400, 'storing it would show the operator a protocol the group is not running');
  const stored = db.prepare('SELECT sync_backend FROM device_groups WHERE id = ?').get(G).sync_backend;
  assert.equal(stored, 'auto', 'the rejected value must not have been written');
});

test('a refused request is saved but reported with what will actually run, and why', async () => {
  const { status, body } = await put({ sync_backend: 'brightsign' });
  assert.equal(status, 200);
  assert.equal(body.sync_backend, 'brightsign', 'the operator\'s choice is remembered');
  assert.equal(body.sync_effective, 'screentinker', 'but this is what the screens will run');
  assert.equal(body.sync_downgraded, true);
  assert.match(body.sync_reason, /non-BrightSign/);
  // ...and in a form the dashboard can translate instead of printing the English reason.
  assert.equal(body.sync_reason_code, 'non_brightsign');
  assert.equal(body.sync_reason_count, 1);
});

test('the group list carries the same decision, so the UI never disagrees with the players', async () => {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/groups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const groups = await res.json();
  const g = groups.find(x => x.id === G);
  assert.equal(g.sync_effective, 'screentinker');
  assert.equal(g.sync_downgraded, true);
});

test('every accepted value round-trips', async () => {
  for (const v of ['auto', 'screentinker', 'brightsign']) {
    const { status, body } = await put({ sync_backend: v });
    assert.equal(status, 200, v);
    assert.equal(body.sync_backend, v);
  }
});

test.after(() => server.close());
