'use strict';

// Audit F20 (and F23, in tenant-delete-files.test.js): what deleting a user does to the data AROUND it,
// against the REAL schema (db/database.js, foreign_keys ON) rather than the hand-built subset in
// user-deletion.test.js - every one of these bugs lived in an FK clause or a column the subset
// does not model.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-userdel-int-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { deleteUserCascade } = require('../lib/user-deletion');

function user(id, role = 'user') {
  db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)")
    .run(id, `${id}@t.test`, id, role);
}
function org(id, ownerId) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id, id, ownerId);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(id, ownerId);
}
function ws(id, orgId, ...members) {
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id, orgId, id);
  for (const m of members) db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(id, m);
}
const ids = (sql, ...a) => db.prepare(sql).all(...a).map((r) => r.id);

beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  for (const t of ['submissions', 'revisions', 'workspace_reviewers', 'content', 'content_folders', 'devices',
    'workspace_members', 'organization_members', 'workspaces', 'organizations', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.pragma('foreign_keys = ON');
  user('admin', 'platform_admin');
  user('owner'); user('member');
  org('orgA', 'owner');
  ws('wsA', 'orgA', 'owner', 'member');
});

// ── F20 ────────────────────────────────────────────────────────────────────────────────────────
test('F20: deleting a member keeps the shared folders they created (and the subfolders others made inside)', () => {
  db.prepare("INSERT INTO content_folders (id, user_id, workspace_id, name) VALUES ('F1', 'member', 'wsA', 'Campaigns')").run();
  db.prepare("INSERT INTO content_folders (id, user_id, workspace_id, parent_id, name) VALUES ('F2', 'owner', 'wsA', 'F1', 'Q4')").run();
  // A workspace-less legacy folder is visible only to its creator: it may go with them.
  db.prepare("INSERT INTO content_folders (id, user_id, workspace_id, name) VALUES ('F3', 'member', NULL, 'mine')").run();
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, folder_id) VALUES ('c1', 'owner', 'wsA', 'c1.png', 'c1.png', 'image/png', 'F2')").run();

  deleteUserCascade(db, { targetId: 'member', actingAdminId: 'admin' });

  assert.deepEqual(ids('SELECT id FROM content_folders ORDER BY id'), ['F1', 'F2'], 'shared folders survive the creator');
  assert.equal(db.prepare("SELECT user_id FROM content_folders WHERE id = 'F1'").get().user_id, 'owner', 'reassigned to the org owner');
  assert.equal(db.prepare("SELECT folder_id FROM content WHERE id = 'c1'").get().folder_id, 'F2', 'the file is still in its folder');
});
