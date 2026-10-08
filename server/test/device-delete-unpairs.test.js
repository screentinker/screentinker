'use strict';

// Deleting a display on the dashboard did not reach the display.
//
// DELETE /api/devices/:id removed the row and told the dashboard, and that was all. The player only
// found out on its next register (a reconnect, or an app restart), when the register handler
// answered `device:unpaired {reason: 'not_found'}`. Until then it sat on its old content, and an
// operator who deleted a screen to re-pair it had no pairing code to type in.
//
// The invariants: the delete route tells the device's own room at once, with `reason: 'deleted'`,
// because that reason is the only one a player may wipe its downloads on. not_found is also what a
// restored backup or an unreplicated mesh edge says, and a wipe on it would empty a fleet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delunpair-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-delete-unpair';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');

function seed(suffix) {
  const u = 'u-' + suffix, o = 'o-' + suffix, ws = 'ws-' + suffix, dev = 'd-' + suffix;
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
    .run(u, suffix + '@test.local');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(o, 'org ' + suffix, u);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ws, o, 'ws ' + suffix);
  db.prepare("INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(o, u);
  db.prepare(`INSERT INTO devices (id, name, workspace_id, user_id, created_at, updated_at)
              VALUES (?, 'Screen', ?, ?, strftime('%s','now'), strftime('%s','now'))`).run(dev, ws, u);
  return { u, ws, dev };
}

const mine = seed('mine');
const theirs = seed('theirs');

// Records every emit by namespace and room, the way socket.io would route it.
const sent = [];
const io = {
  of: (ns) => ({ to: (room) => ({ emit: (event, payload) => sent.push({ ns, room, event, payload }) }) }),
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/devices', requireAuth, require('../routes/devices'));
const server = app.listen(0);

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const tokenFor = (u, ws) => generateToken(userRow(u), ws);

async function del(deviceId, token) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

const toDevice = () => sent.filter(s => s.ns === '/device');

test('deleting a display tells that display at once, with the reason a wipe is keyed on', async () => {
  sent.length = 0;
  assert.equal(await del(mine.dev, tokenFor(mine.u, mine.ws)), 200);
  assert.deepEqual(toDevice(), [
    { ns: '/device', room: mine.dev, event: 'device:unpaired', payload: { reason: 'deleted' } },
  ]);
  assert.equal(db.prepare('SELECT 1 FROM devices WHERE id = ?').get(mine.dev), undefined);
  assert.ok(sent.some(s => s.ns === '/dashboard' && s.event === 'dashboard:device-removed'), 'dashboard still told');
});

test('a refused delete tells no display anything', async () => {
  sent.length = 0;
  assert.equal(await del(theirs.dev, tokenFor(mine.u, mine.ws)), 403);
  assert.deepEqual(toDevice(), []);
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE id = ?').get(theirs.dev), 'their display survives');
});

test('the register path still answers not_found, never deleted', () => {
  // Players wipe ONLY on 'deleted'. If the register handler ever sent it, a restored backup would
  // erase every cache in the fleet.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(src, /emit\('device:unpaired', \{ reason: 'not_found' \}\)/);
  assert.doesNotMatch(src, /reason: 'deleted'/);
});

test.after(() => server.close());
