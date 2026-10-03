'use strict';

// #142 (cut 2) — provisioning-row cleanup window correctness. The sweep deletes
// UNCLAIMED provisioning devices older than 24h (it previously used 365*86400 — a
// year — contradicting its own comment). Imported devices (user_id set) and
// non-provisioning devices are preserved. Deterministic, in-process (no server).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-provclean-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { pruneProvisioningDevices } = require('../services/heartbeat');

test('sweeps unclaimed provisioning devices older than 24h, keeps the rest', async () => {
  db.pragma('foreign_keys = OFF'); // seed user_id without a real users row
  db.exec('DELETE FROM devices');
  const ins = db.prepare("INSERT INTO devices (id, status, user_id, created_at) VALUES (?, ?, ?, strftime('%s','now') - ?)");
  ins.run('old-unclaimed', 'provisioning', null, 25 * 3600);   // >24h, unclaimed  -> SWEPT
  ins.run('new-unclaimed', 'provisioning', null, 1 * 3600);    // <24h, unclaimed  -> kept
  ins.run('old-imported', 'provisioning', 'u-imported', 25 * 3600); // >24h but imported (user_id) -> kept
  ins.run('old-online', 'online', null, 25 * 3600);           // >24h but not provisioning -> kept
  db.pragma('foreign_keys = ON');

  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices').get().c, 4, 'seeded 4');

  const deleted = await pruneProvisioningDevices();
  assert.equal(deleted, 1, 'only the >24h unclaimed provisioning device is swept');

  const ids = db.prepare('SELECT id FROM devices ORDER BY id').all().map(r => r.id);
  assert.deepEqual(ids, ['new-unclaimed', 'old-imported', 'old-online']);
  // regression guard: a 25h-old row sits well inside the OLD 365-day window, so this
  // would have survived before the fix.
});

test('idempotent: a second sweep with nothing stale deletes nothing', async () => {
  assert.equal(await pruneProvisioningDevices(), 0);
});

// Audit F21: "unclaimed" is decided by the workspace, not by user_id. A workspace import creates
// provisioning placeholders WITH a workspace, user_id = the importer and created_at copied from the
// export (already >24h old). deleteUserCascade NULLs devices.user_id in orgs the user doesn't own,
// so deleting the member who imported the workspace used to hand those screens to this sweep.
test('F21: an imported screen survives its importer being deleted; an unclaimed row is still swept', async () => {
  const { deleteUserCascade } = require('../lib/user-deletion');
  const old = Math.floor(Date.now() / 1000) - 30 * 86400;
  db.exec('DELETE FROM devices');
  db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES ('f21-owner','f21o@t.test','o','x','local','user'), ('f21-member','f21m@t.test','m','x','local','user'), ('f21-admin','f21a@t.test','a','x','local','platform_admin')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('f21-org', 'Org', 'f21-owner')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('f21-ws', 'f21-org', 'WS')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('f21-ws', 'f21-member', 'workspace_editor')").run();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status, created_at) VALUES ('d-imp', 'f21-member', 'f21-ws', 'Lobby', 'provisioning', ?)").run(old);
  db.prepare("INSERT INTO devices (id, status, created_at) VALUES ('d-junk', 'provisioning', ?)").run(old);

  deleteUserCascade(db, { targetId: 'f21-member', actingAdminId: 'f21-admin' });
  assert.equal(db.prepare("SELECT user_id FROM devices WHERE id = 'd-imp'").get().user_id, null, 'unlinked, as the cascade intends');

  assert.equal(await pruneProvisioningDevices(), 1, 'only the workspace-less row is swept');
  assert.deepEqual(db.prepare('SELECT id FROM devices').all().map((r) => r.id), ['d-imp']);
});
