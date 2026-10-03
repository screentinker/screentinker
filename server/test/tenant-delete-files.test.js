'use strict';

// Audit F23: deleting a workspace, an org or a user (platform admin routes, stale-account purge)
// must take the tenant's uploaded files, their retained .history copies, and the revisions /
// submissions rows with it - the files are served publicly at /uploads/content, so leaving them
// is not deleting the customer's data. Real schema (db/database.js), temp DATA_DIR.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-tenant-files-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const revisions = require('../lib/revisions');
const { deleteUserCascade, deleteOrgCascade, deleteWorkspaceCascade } = require('../lib/user-deletion');

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

// ── F23 ────────────────────────────────────────────────────────────────────────────────────────
function seedMedia(wsId, contentId, withApproval) {
  fs.mkdirSync(config.contentDir, { recursive: true });
  const file = `${contentId}.mp4`, thumb = `${contentId}_thumb.jpg`;
  fs.writeFileSync(path.join(config.contentDir, file), 'video');
  fs.writeFileSync(path.join(config.contentDir, thumb), 'thumb');
  const hdir = path.join(revisions.historyDir(), contentId);
  fs.mkdirSync(hdir, { recursive: true });
  fs.writeFileSync(path.join(hdir, 'r1__old.mp4'), 'old bytes');
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, thumbnail_path, mime_type, file_size) VALUES (?, 'owner', ?, ?, ?, ?, 'video/mp4', 5)")
    .run(contentId, wsId, file, file, thumb);
  const rev = revisions.recordCurrent(db, 'content', contentId, { actor: { userId: 'owner' }, summary: 'Uploaded' });
  if (withApproval) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO submissions (id, workspace_id, resource_type, resource_id, revision_id, state_hash, submitted_at, updated_at) VALUES (?, ?, 'content', ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), wsId, contentId, rev.id, rev.state_hash, now, now);
    db.prepare("INSERT INTO workspace_reviewers (workspace_id, user_id) VALUES (?, 'owner')").run(wsId);
  }
  return { file: path.join(config.contentDir, file), thumb: path.join(config.contentDir, thumb), hdir };
}
function assertGone(m, contentId, label) {
  assert.equal(fs.existsSync(m.file), false, `${label}: media file removed from /uploads/content`);
  assert.equal(fs.existsSync(m.thumb), false, `${label}: thumbnail removed`);
  assert.equal(fs.existsSync(m.hdir), false, `${label}: retained .history copies removed`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revisions WHERE resource_id = ?").get(contentId).n, 0, `${label}: revisions gone`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM submissions WHERE resource_id = ?").get(contentId).n, 0, `${label}: submissions gone`);
}

test('F23: deleteWorkspaceCascade removes the files, history copies and history rows', () => {
  const id = crypto.randomUUID();
  const m = seedMedia('wsA', id, true);
  deleteWorkspaceCascade(db, { workspaceId: 'wsA' });
  assertGone(m, id, 'workspace');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workspace_reviewers WHERE workspace_id = 'wsA'").get().n, 0);
});

test('F23: deleteOrgCascade removes the files, history copies and history rows', () => {
  const id = crypto.randomUUID();
  const m = seedMedia('wsA', id, true);
  deleteOrgCascade(db, { orgId: 'orgA' });
  assertGone(m, id, 'org');
});

test('F23: deleteUserCascade of a solo owner removes their files; a file another tenant uses is kept', () => {
  user('solo'); org('orgS', 'solo'); ws('wsS', 'orgS', 'solo');
  const id = crypto.randomUUID();
  const m = seedMedia('wsS', id, false);
  // Mesh-received content shares bytes across workspaces: another tenant's row still serves this.
  fs.writeFileSync(path.join(config.contentDir, 'shared.mp4'), 'shared');
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, 'solo', 'wsS', 'shared.mp4', 'shared.mp4', 'video/mp4')").run(crypto.randomUUID());
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, 'owner', 'wsA', 'shared.mp4', 'shared.mp4', 'video/mp4')").run(crypto.randomUUID());

  const out = deleteUserCascade(db, { targetId: 'solo', actingAdminId: 'admin' });
  assertGone(m, id, 'user');
  assert.ok(fs.existsSync(path.join(config.contentDir, 'shared.mp4')), 'a file another row still uses is never removed');
  assert.equal(out.files_removed, 1);
});
