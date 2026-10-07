'use strict';

/*
 * Storage at three levels: instance -> organization -> workspace.
 *
 *   - a workspace's new uploads go to its own override, else its org's default, else the instance's
 *   - a workspace-owned profile is visible to that workspace ONLY (siblings and other orgs get 404)
 *   - an override that no longer resolves falls back instead of failing uploads
 *   - a workspace move touches that workspace only, and pins its override on commit; an org-wide
 *     move leaves workspaces with their own storage alone; abort restores what was there
 *   - who may do what: workspace admins only when the org allows it, and only for their workspace;
 *     the org default and the switch stay with org admins; the instance card is platform-admin only
 *
 * In-memory "buckets" stand in for S3 / Azure / MinIO (test/helpers/storage-memory.js).
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storage-scopes-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.STORAGE_PROVIDER;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const storage = require('../lib/storage');
const migrate = require('../lib/storage/migrate');
const breaker = require('../lib/storage/breaker');
const { installMemoryBackends } = require('./helpers/storage-memory');

const id = () => crypto.randomUUID();
const KEYID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
let userId, orgA, orgB, wsA1, wsA2, wsB1, INST, ORG, WS1, reg, server, base;
const CALLERS = {};

function profile(pid, orgId, wsId, name) {
  db.prepare(`INSERT INTO storage_profiles (id, org_id, workspace_id, name, provider, bucket, mode, manage_scope) VALUES (?, ?, ?, ?, 's3', ?, 'rw', 'st')`)
    .run(pid, orgId, wsId, name, name);
}

before(async () => {
  userId = id(); orgA = id(); orgB = id(); wsA1 = id(); wsA2 = id(); wsB1 = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `s-${userId}@e.test`, 'S', 'x');
  for (const o of [orgA, orgB]) db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(o, 'Org', userId);
  for (const [w, o, n] of [[wsA1, orgA, 'Lobby'], [wsA2, orgA, 'Cafe'], [wsB1, orgB, 'Other']]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, o, n);
  }
  INST = id(); ORG = id(); WS1 = id();
  profile(INST, null, null, 'instance-bucket');
  profile(ORG, orgA, null, 'org-bucket');
  profile(WS1, orgA, wsA1, 'lobby-bucket');
  reg = installMemoryBackends(storage, {});
  for (const p of [INST, ORG, WS1]) storage.backendFor(storage.getProfile(p));
  fs.mkdirSync(config.contentDir, { recursive: true });

  Object.assign(CALLERS, {
    orgAdmin: { organizationId: orgA, workspaceId: wsA1, orgRole: 'org_admin' },
    lobbyAdmin: { organizationId: orgA, workspaceId: wsA1, orgRole: null, workspaceRole: 'workspace_admin' },
    cafeAdmin: { organizationId: orgA, workspaceId: wsA2, orgRole: null, workspaceRole: 'workspace_admin' },
    lobbyEditor: { organizationId: orgA, workspaceId: wsA1, orgRole: null, workspaceRole: 'workspace_editor' },
    platform: { organizationId: null, workspaceId: null, orgRole: null, isPlatformAdmin: true, isPlatformStaff: true },
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { Object.assign(req, { user: { id: userId } }, CALLERS[req.headers['x-who']] || {}); next(); });
  app.use('/api/storage-profiles', require('../routes/storage-profiles'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { migrate.stopAll(); storage._setBackendFactory(null); server && server.close(); });
beforeEach(() => {
  breaker._reset();
  db.prepare("UPDATE storage_migrations SET state = 'done' WHERE state IN ('copying','ready_to_commit','committed','draining')").run();
  db.prepare('UPDATE organizations SET storage_profile_id = NULL, storage_workspace_choice = 0').run();
  db.prepare('UPDATE workspaces SET storage_profile_id = NULL').run();
});

async function call(who, method, p, body) {
  const r = await fetch(base + '/api/storage-profiles' + p, {
    method, headers: { 'content-type': 'application/json', 'x-who': who }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}
const s3Body = (extra = {}) => ({ name: `p-${id().slice(0, 6)}`, provider: 's3', bucket: 'media', credentials: { accessKeyId: KEYID, secretAccessKey: SECRET }, ...extra });
const primaryOf = (ws) => storage.writeTargetsForWorkspace(ws).primary.id;

/* ───────────────────────────── resolution ───────────────────────────── */

test('new uploads: workspace override -> organization default -> instance default', () => {
  assert.equal(primaryOf(wsA1), INST, 'nothing chosen: the instance profile');
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(ORG, orgA);
  assert.equal(primaryOf(wsA1), ORG, 'the org default wins over the instance');
  assert.equal(primaryOf(wsA2), ORG);
  db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(WS1, wsA1);
  assert.equal(primaryOf(wsA1), WS1, 'the workspace override wins over the org');
  assert.equal(primaryOf(wsA2), ORG, 'its sibling still follows the org');
  db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run('local', wsA2);
  assert.equal(primaryOf(wsA2), 'local', '"local" pins local disk even when the org uses a bucket');
  assert.equal(primaryOf(wsB1), INST, 'another org is untouched');
});

test('a workspace-owned profile is visible to that workspace only', () => {
  assert.ok(storage.profileForWorkspace(WS1, wsA1), 'its own workspace resolves it');
  assert.equal(storage.profileForWorkspace(WS1, wsA2), null, 'a sibling workspace in the same org does not');
  assert.equal(storage.profileForWorkspace(WS1, wsB1), null, 'another org does not');
  assert.equal(storage.profileForOrg(WS1, orgA), null, 'it is never an organization-wide answer');
  assert.ok(storage.profileForOrgAdmin(WS1, orgA), 'but the org admin can manage it');
  assert.equal(storage.profileForOrgAdmin(WS1, orgB), null);
  // A sibling pointed at it (by hand, bypassing the API) falls back instead of writing there.
  db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(WS1, wsA2);
  assert.equal(primaryOf(wsA2), INST);
});

test('an override that stops resolving falls back to the org default instead of failing uploads', () => {
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(ORG, orgA);
  db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(id(), wsA1);
  assert.equal(primaryOf(wsA1), ORG, 'a deleted profile');
  db.prepare("UPDATE storage_profiles SET mode = 'ro' WHERE id = ?").run(WS1);
  db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(WS1, wsA1);
  try { assert.equal(primaryOf(wsA1), ORG, 'a read-only profile'); }
  finally { db.prepare("UPDATE storage_profiles SET mode = 'rw' WHERE id = ?").run(WS1); }
});

/* ───────────────────────────── migration scope ───────────────────────────── */

function seedOn(pid, ws) {
  const bytes = crypto.randomBytes(64);
  const cid = id();
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const org = storage.orgOfWorkspace(ws);
  const key = storage.keys.asset(org, ws, digest, '.mp4');
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, byte_digest, storage_profile_id, object_key)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cid, userId, ws, 'clip.mp4', `${id()}.mp4`, 'video/mp4', bytes.length, digest, pid, key);
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, byte_digest, size)
              VALUES (?, 'asset', ?, ?, 'primary', 'ready', 1, ?, ?)`).run(cid, pid, key, digest, bytes.length);
  reg.get(pid).objects.set(key, { body: bytes, contentType: 'video/mp4' });
  return cid;
}
const primaryLoc = (cid) => db.prepare("SELECT storage_profile_id FROM content_locations WHERE content_id = ? AND kind = 'asset' AND role = 'primary'").get(cid).storage_profile_id;

test('a workspace move copies and flips that workspace only, and pins its override on commit', async () => {
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(ORG, orgA);
  const lobby = seedOn(ORG, wsA1);
  const cafe = seedOn(ORG, wsA2);
  const m = migrate.start({ orgId: orgA, workspaceId: wsA1 }, WS1);
  assert.equal(m.workspace_id, wsA1);
  assert.equal(m.total, db.prepare("SELECT COUNT(*) AS n FROM content WHERE workspace_id = ? AND filepath != '' AND remote_url IS NULL").get(wsA1).n, 'counts the workspace only');
  const done = await migrate._settle(m.id);
  assert.equal(done.state, 'ready_to_commit');
  assert.ok(db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? AND storage_profile_id = ?').get(lobby, WS1), 'the lobby file was copied');
  assert.equal(db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? AND storage_profile_id = ?').get(cafe, WS1), undefined, 'the cafe file was not');

  migrate.commit(orgA, WS1);
  assert.equal(primaryLoc(lobby), WS1);
  assert.equal(primaryLoc(cafe), ORG, 'the sibling keeps its primary');
  assert.equal(db.prepare('SELECT storage_profile_id FROM workspaces WHERE id = ?').get(wsA1).storage_profile_id, WS1, 'the workspace override is pinned');
  assert.equal(db.prepare('SELECT storage_profile_id FROM organizations WHERE id = ?').get(orgA).storage_profile_id, ORG, 'the org default is untouched');

  migrate.abort(orgA, WS1);
  assert.equal(primaryLoc(lobby), ORG, 'abort puts the primary back');
  assert.equal(db.prepare('SELECT storage_profile_id FROM workspaces WHERE id = ?').get(wsA1).storage_profile_id, null, 'and restores the workspace to following its org');
});

test('an org-wide move leaves a workspace with its own storage alone', async () => {
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(ORG, orgA);
  db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(WS1, wsA1);
  const lobby = seedOn(WS1, wsA1);
  const cafe = seedOn(ORG, wsA2);
  const m = await migrate._settle(migrate.start(orgA, INST).id);
  assert.equal(m.state, 'ready_to_commit');
  assert.ok(db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? AND storage_profile_id = ?').get(cafe, INST));
  assert.equal(db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? AND storage_profile_id = ?').get(lobby, INST), undefined, 'the overridden workspace was not copied');
  migrate.commit(orgA, INST);
  assert.equal(primaryLoc(cafe), INST);
  assert.equal(primaryLoc(lobby), WS1, 'and not flipped');
  assert.equal(primaryOf(wsA1), WS1, 'it keeps writing to its own storage');
});

test('during a workspace move only that workspace dual-writes to the target', () => {
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(ORG, orgA);
  const m = migrate.start({ orgId: orgA, workspaceId: wsA1 }, WS1);
  try {
    const t1 = storage.writeTargetsForWorkspace(wsA1);
    assert.equal(t1.primary.id, WS1);
    assert.equal(t1.dualWrite.id, ORG);
    const t2 = storage.writeTargetsForWorkspace(wsA2);
    assert.equal(t2.primary.id, ORG, 'the sibling is not part of the move');
    assert.equal(t2.dualWrite, null);
  } finally { migrate.abort(orgA, WS1); }
  assert.equal(m.workspace_id, wsA1);
});

/* ───────────────────────────── who may do what ───────────────────────────── */

test('a workspace admin is refused until the org allows workspaces to choose', async () => {
  assert.equal((await call('lobbyAdmin', 'GET', '/')).status, 403);
  assert.equal((await call('lobbyAdmin', 'POST', '/', s3Body({ scope: 'workspace' }))).status, 403);
  // Only an org admin may turn it on.
  assert.equal((await call('lobbyAdmin', 'PUT', '/settings/current', { workspace_choice: true })).status, 403);
  const on = await call('orgAdmin', 'PUT', '/settings/current', { workspace_choice: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.workspace_choice, true);
  assert.equal((await call('lobbyAdmin', 'GET', '/')).status, 200);
  assert.equal((await call('lobbyEditor', 'GET', '/')).status, 403, 'an editor never manages storage');
});

test('with the switch on, a workspace admin manages their own workspace only', async () => {
  db.prepare('UPDATE organizations SET storage_workspace_choice = 1 WHERE id = ?').run(orgA);
  const mine = await call('lobbyAdmin', 'POST', '/', s3Body({ scope: 'workspace' }));
  assert.equal(mine.status, 201, mine.text);
  assert.equal(mine.body.scope, 'workspace');
  assert.equal(mine.body.workspace_id, wsA1);
  assert.equal((await call('lobbyAdmin', 'POST', '/', s3Body({ scope: 'organization' }))).status, 403, 'cannot create an org-wide profile');
  assert.equal((await call('lobbyAdmin', 'PUT', '/settings/current', { default_profile_id: mine.body.id })).status, 403, 'cannot set the org default');

  const set = await call('lobbyAdmin', 'PUT', '/settings/current', { workspace_profile_id: mine.body.id });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.body.workspace.override, mine.body.id);
  assert.equal(primaryOf(wsA1), mine.body.id);

  // The cafe admin can neither see nor use the lobby's profile.
  const cafeList = await call('cafeAdmin', 'GET', '/');
  assert.equal(cafeList.status, 200);
  assert.ok(!cafeList.body.profiles.some((p) => p.id === mine.body.id), 'not listed for a sibling');
  assert.equal((await call('cafeAdmin', 'GET', `/${mine.body.id}`)).status, 404);
  assert.equal((await call('cafeAdmin', 'PUT', '/settings/current', { workspace_profile_id: mine.body.id })).status, 404);
  assert.equal((await call('cafeAdmin', 'DELETE', `/${mine.body.id}`)).status, 404);
  // A workspace admin cannot edit an org-wide profile, though they may use it.
  assert.equal((await call('lobbyAdmin', 'PUT', `/${ORG}`, { name: 'x' })).status, 403);
  // The org admin sees every workspace's profile, labelled.
  const orgList = await call('orgAdmin', 'GET', '/');
  const row = orgList.body.profiles.find((p) => p.id === mine.body.id);
  assert.ok(row && row.workspace_name === 'Lobby');
  // A profile a workspace points at cannot be deleted from under it.
  assert.equal((await call('orgAdmin', 'DELETE', `/${mine.body.id}`)).status, 409);
});

test('a workspace admin can only start a move of their own workspace, and never act on an org-wide one', async () => {
  db.prepare('UPDATE organizations SET storage_workspace_choice = 1, storage_profile_id = ? WHERE id = ?').run(ORG, orgA);
  const r = await call('lobbyAdmin', 'POST', `/${WS1}/migrate`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.migration.workspace_id, wsA1, 'scoped to their workspace even without asking');
  await migrate._settle(r.body.migration.id);
  assert.equal((await call('lobbyAdmin', 'POST', `/${WS1}/migrate/abort`, {})).status, 200);

  const org = await call('orgAdmin', 'POST', `/${ORG}/migrate`, {});
  assert.equal(org.status, 200, org.text);
  assert.equal(org.body.migration.workspace_id, null);
  await migrate._settle(org.body.migration.id);
  assert.equal((await call('lobbyAdmin', 'POST', `/${ORG}/migrate/abort`, {})).status, 403, 'not theirs to stop');
  assert.equal((await call('lobbyAdmin', 'GET', '/migration/current')).body.migration, null, 'and not shown to them');
  await call('orgAdmin', 'POST', `/${ORG}/migrate/abort`, {});
});

test('the instance card is platform-admin only, and works without an organization context', async () => {
  assert.equal((await call('orgAdmin', 'GET', '/instance')).status, 403);
  const inst = await call('platform', 'GET', '/instance');
  assert.equal(inst.status, 200, inst.text);
  assert.equal(inst.body.profile.id, INST);
  assert.equal(inst.body.profile.active, true, 'no env set: the stored instance profile is in effect');
  assert.equal(inst.body.env, null);
  const t = await call('platform', 'POST', `/${INST}/test`, {});
  assert.equal(t.status, 200, t.text);
  const ed = await call('platform', 'PUT', `/${INST}`, { name: 'instance-renamed' });
  assert.equal(ed.status, 200, ed.text);
  assert.equal(ed.body.name, 'instance-renamed');
  assert.equal((await call('orgAdmin', 'PUT', `/${INST}`, { name: 'nope' })).status, 403, 'an org admin may use it but not edit it');
  const dup = await call('platform', 'POST', '/', s3Body({ scope: 'instance' }));
  assert.equal(dup.status, 409, 'one instance profile at most');
});

test('env wins: the instance card shows the environment and marks the stored profile inactive', async () => {
  process.env.STORAGE_PROVIDER = 's3';
  process.env.S3_BUCKET = 'from-env';
  process.env.S3_ACCESS_KEY_ID = KEYID;
  process.env.S3_SECRET_ACCESS_KEY = SECRET;
  try {
    const inst = await call('platform', 'GET', '/instance');
    assert.equal(inst.status, 200, inst.text);
    assert.ok(inst.body.env && inst.body.env.bucket === 'from-env');
    assert.equal(inst.body.profile.active, false);
    assert.equal(inst.body.effective_id, 'env');
    assert.ok(!inst.text.includes(SECRET), 'never the key');
  } finally {
    for (const k of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
  }
});
