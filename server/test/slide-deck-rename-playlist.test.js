'use strict';

/*
 * Renaming a deck renames the playlist it published — while that playlist still carries the deck's
 * old name. A playlist somebody renamed on the Playlists page keeps the name they chose.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-deck-rename-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-deck-rename';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-dr', WS = 'ws-dr', WS2 = 'ws-dr-other', U = 'u-dr-editor';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-dr-owner','drowner@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,'dreditor@t.local','x','user')").run(U);
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', 'u-dr-owner');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O, 'Other');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, 'u-dr-owner');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_editor')").run(WS, U);

const playlist = (id, ws, name) => db.prepare(
  "INSERT INTO playlists (id,user_id,workspace_id,name,created_at,updated_at,status) VALUES (?,?,?,?,0,0,'published')",
).run(id, U, ws, name);
const deck = (id, name, playlistId) => db.prepare(
  "INSERT INTO slide_decks (id,workspace_id,user_id,name,doc,playlist_id,created_at,updated_at) VALUES (?,?,?,?,'{\"slides\":[]}',?,0,0)",
).run(id, WS, U, name, playlistId);
const plName = (id) => db.prepare('SELECT name FROM playlists WHERE id = ?').get(id).name;
const plStatus = (id) => db.prepare('SELECT status FROM playlists WHERE id = ?').get(id).status;

const app = express();
app.use(express.json());
app.use('/api/slide-decks', requireAuth, resolveTenancy, require('../routes/slide-decks'));
const server = app.listen(0);
test.after(() => { server.close(); });

async function rename(deckId, name) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(U);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/slide-decks/${deckId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(user, WS)}` },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('renaming a deck renames its playlist when the playlist still has the old name', async () => {
  playlist('pl-dr-1', WS, 'Lobby');
  deck('deck-dr-1', 'Lobby', 'pl-dr-1');
  const out = await rename('deck-dr-1', 'Front lobby');
  assert.equal(out.name, 'Front lobby');
  assert.equal(plName('pl-dr-1'), 'Front lobby');
  // A name is not playback: the playlist is not pushed back to draft.
  assert.equal(plStatus('pl-dr-1'), 'published');
});

test('a playlist renamed on its own keeps the name it was given', async () => {
  playlist('pl-dr-2', WS, 'Main entrance (do not touch)');
  deck('deck-dr-2', 'Entrance', 'pl-dr-2');
  await rename('deck-dr-2', 'Entrance v2');
  assert.equal(plName('pl-dr-2'), 'Main entrance (do not touch)');
});

test('a playlist in another workspace is never renamed through a deck', async () => {
  playlist('pl-dr-3', WS2, 'Shared');
  deck('deck-dr-3', 'Shared', 'pl-dr-3');
  await rename('deck-dr-3', 'Mine now');
  assert.equal(plName('pl-dr-3'), 'Shared');
});

test('saving without a name change leaves the playlist alone', async () => {
  playlist('pl-dr-4', WS, 'Cafe');
  deck('deck-dr-4', 'Cafe', 'pl-dr-4');
  const before = db.prepare('SELECT updated_at FROM playlists WHERE id = ?').get('pl-dr-4').updated_at;
  await rename('deck-dr-4', 'Cafe');
  assert.equal(db.prepare('SELECT updated_at FROM playlists WHERE id = ?').get('pl-dr-4').updated_at, before);
});
