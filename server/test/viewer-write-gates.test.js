'use strict';

// The "read-only viewer" invariant leaked on two write/publish surfaces (server code review):
//   H6 slide-decks — checkDeckAccess had no viewer-deny, and POST / only checked workspaceId, so a
//      workspace_viewer could author, PUBLISH (builds widgets + a playlist, fans a playlist-update to
//      every screen) and delete decks. Every other writable resource (playlists, schedules, pip)
//      denies the viewer.
//   H5 tokens — POST /api/tokens gated only on membership, so a viewer could mint an `agency` token
//      with auto_publish and push content to live screens (the agency surface never re-checks the
//      owner's role). A viewer may mint only a read-scoped token now.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-viewer-gates-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-viewer-gates';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-vg', WS = 'ws-vg';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-vg-owner','vgowner@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-vg-editor','vgeditor@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-vg-viewer','vgviewer@t.local','x','user')").run();
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', 'u-vg-owner');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, 'u-vg-owner');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_editor')").run(WS, 'u-vg-editor');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_viewer')").run(WS, 'u-vg-viewer');
// a deck already in the workspace, for the viewer write/publish/delete attempts
db.prepare("INSERT OR IGNORE INTO slide_decks (id,workspace_id,user_id,name,doc,created_at,updated_at) VALUES ('deck-vg',?,?,'Deck','{\"slides\":[]}',0,0)").run(WS, 'u-vg-editor');

const app = express();
app.use(express.json());
app.use('/api/slide-decks', requireAuth, resolveTenancy, require('../routes/slide-decks'));
app.use('/api/tokens', requireAuth, resolveTenancy, require('../routes/tokens'));
const server = app.listen(0);

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const tokenFor = (id) => generateToken(row(id), WS);
async function call(method, pathname, who, body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.status;
}
test.after(() => { server.close(); });

// ---- H6: slide decks ----
test('viewer cannot create a slide deck', async () => {
  assert.equal(await call('POST', '/api/slide-decks', 'u-vg-viewer', { name: 'x' }), 403);
});
test('viewer cannot edit / publish / delete a deck', async () => {
  assert.equal(await call('PUT', '/api/slide-decks/deck-vg', 'u-vg-viewer', { doc: { slides: [] } }), 403);
  assert.equal(await call('POST', '/api/slide-decks/deck-vg/publish', 'u-vg-viewer', {}), 403);
  assert.equal(await call('DELETE', '/api/slide-decks/deck-vg', 'u-vg-viewer', null), 403);
});
test('viewer CAN still read a deck (read-only, not locked out)', async () => {
  assert.equal(await call('GET', '/api/slide-decks/deck-vg', 'u-vg-viewer', null), 200);
});
test('editor CAN create a deck (the gate does not over-block)', async () => {
  assert.equal(await call('POST', '/api/slide-decks', 'u-vg-editor', { name: 'editor deck' }), 201);
});

// ---- H5: token minting ----
test('viewer cannot mint an agency token (read-only-to-publish escalation)', async () => {
  const s = await call('POST', '/api/tokens', 'u-vg-viewer', { name: 't', scope: 'agency', target_playlist_ids: ['whatever'] });
  assert.equal(s, 403);
});
test('viewer cannot mint a write or full token', async () => {
  assert.equal(await call('POST', '/api/tokens', 'u-vg-viewer', { name: 't', scope: 'write' }), 403);
  assert.equal(await call('POST', '/api/tokens', 'u-vg-viewer', { name: 't', scope: 'full' }), 403);
});
test('viewer CAN mint a read-scoped token', async () => {
  assert.equal(await call('POST', '/api/tokens', 'u-vg-viewer', { name: 'ro', scope: 'read' }), 201);
});
test('editor CAN mint a write token (gate does not over-block)', async () => {
  assert.equal(await call('POST', '/api/tokens', 'u-vg-editor', { name: 'rw', scope: 'write' }), 201);
});
