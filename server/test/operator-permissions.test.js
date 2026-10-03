'use strict';

// #13 regression: platform_operator gets cross-org workspace read/write (via the
// canWrite broadening to isPlatformStaff) but must STILL be denied writing
// shared/global assets (workspace_id IS NULL), which carry a SEPARATE
// PLATFORM_ROLES gate on top of canWrite. This is the highest-blast-radius deny
// (operator editing platform-wide content), so we prove both halves:
//   (a) operator CAN update/delete a workspace-scoped content row, and
//   (b) operator CANNOT update/delete a shared (workspace_id IS NULL) row.
//
// Same isolated-in-memory-DB harness as admin-users.test.js: inject the DB into
// the require cache before any module that pulls ../db/database loads. Node v20
// built-ins only. (node --test runs each file in its own process, so this
// injection does not collide with the other suite's.)

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

process.env.JWT_SECRET = 'test-secret-operator-perms';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, UNIQUE(organization_id, user_id)
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(workspace_id, user_id)
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, filepath TEXT NOT NULL, mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL, duration_sec REAL, thumbnail_path TEXT, width INTEGER, height INTEGER,
    remote_url TEXT, user_id TEXT, folder TEXT, folder_id TEXT, workspace_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  -- ⚠️ The delete handler also clears mesh provenance, because that table declares no FOREIGN KEY
  -- and so nothing cascades it: a surviving row would point at a deleted content id, and the next
  -- push of that asset would re-transfer the whole file and charge the allowance again. Absent from
  -- this hand-built fixture, the DELETE threw and the route 500'd — the fixture-drift failure this
  -- suite keeps rediscovering. See mesh-mirror-store.test.js for the guard that catches it early.
  CREATE TABLE mesh_content_provenance (
    origin_node_id TEXT NOT NULL, origin_content_id TEXT NOT NULL, local_content_id TEXT NOT NULL,
    edge_id TEXT, bytes INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (origin_node_id, origin_content_id)
  );
  -- Empty, but the DELETE handler queries these for playlist cleanup.
  -- ⚠️ The device columns here are the ones device_resolved_playlist reads. The delete fan-out
  -- resolves inheritance rather than reading devices.playlist_id, because a screen that INHERITS
  -- the playlist holding this content has no copy of the id on its row — and would otherwise be
  -- left showing a file that no longer exists on disk.
  CREATE TABLE devices (id TEXT PRIMARY KEY, playlist_id TEXT, playlist_source TEXT, wall_id TEXT, layout_id TEXT, scheduled_playlist_id TEXT, scheduled_layout_id TEXT);
  CREATE TABLE playlists (id TEXT PRIMARY KEY, workspace_id TEXT, published_snapshot TEXT);
  CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT, content_id TEXT);
  CREATE TABLE video_walls (id TEXT PRIMARY KEY, playlist_id TEXT);
  CREATE TABLE device_groups (id TEXT PRIMARY KEY, playlist_id TEXT, priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE device_group_members (device_id TEXT, group_id TEXT);
`);
// The SAME view definition the migration applies — imported, not pasted, so this fixture cannot
// drift into proving things about a database that does not exist.
require('../lib/playlist-resolver-sql').applyResolverViews(db);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = {
  id: dbModulePath, filename: dbModulePath, loaded: true,
  exports: { db, pruneTelemetry() {}, pruneScreenshots() {} },
};

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const contentRouter = require('../routes/content');

// Seed: org + workspace, a platform_operator user, and two content rows.
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a','org-a','Workspace A')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-op','op@test.local','platform_operator')").run();
const operator = { id: 'u-op', email: 'op@test.local', role: 'platform_operator' };
// JWT carries current_workspace_id so resolveTenancy lands the operator (acting-as) in ws-a.
const opToken = generateToken(operator, 'ws-a');

const wsContentId = uuidv4();
const sharedContentId = uuidv4();
function seedContent(id, workspaceId) {
  db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id)
              VALUES (?, 'orig.png', '/does/not/exist.png', 'image/png', 123, ?)`).run(id, workspaceId);
}
seedContent(wsContentId, 'ws-a');     // workspace-scoped
seedContent(sharedContentId, null);   // shared / platform-global (workspace_id IS NULL)

const app = express();
app.use(express.json());
app.use('/api/content', requireAuth, resolveTenancy, contentRouter);
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const op = (method, id, body) => fetch(`${base}/api/content/${id}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opToken}` },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

// (a) Proves the operator's cross-org write actually works (so (b) isn't just
// "operator can't write anything").
test('operator CAN update a workspace-scoped content row', async () => {
  const res = await op('PUT', wsContentId, { filename: 'renamed.png' });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT filename FROM content WHERE id=?').get(wsContentId).filename, 'renamed.png');
});

// (b) The separate PLATFORM_ROLES gate on workspace_id IS NULL must deny operator.
test('operator CANNOT update a shared (workspace_id IS NULL) content row -> 403', async () => {
  const res = await op('PUT', sharedContentId, { filename: 'hijacked.png' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT filename FROM content WHERE id=?').get(sharedContentId).filename, 'orig.png',
    'shared row must be unchanged');
});

test('operator CANNOT delete a shared (workspace_id IS NULL) content row -> 403', async () => {
  const res = await op('DELETE', sharedContentId);
  assert.equal(res.status, 403);
  assert.ok(db.prepare('SELECT 1 FROM content WHERE id=?').get(sharedContentId), 'shared row must still exist');
});

// Delete last so the workspace-scoped row survives the update assertion above.
test('operator CAN delete a workspace-scoped content row', async () => {
  const res = await op('DELETE', wsContentId);
  assert.equal(res.status, 200);
  assert.ok(!db.prepare('SELECT 1 FROM content WHERE id=?').get(wsContentId), 'workspace row deleted');
});
