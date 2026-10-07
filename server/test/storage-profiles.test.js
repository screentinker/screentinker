'use strict';

/*
 * Storage profiles (lib/storage): which backend a row's bytes belong to, and the rules that must
 * hold with NO profile configured at all — because that is every install that exists today.
 *
 *   - no STORAGE_PROVIDER, empty table          -> local disk, byte-for-byte the old behaviour
 *   - env set, table empty                      -> the env profile is the instance default
 *   - env set AND a null-org row                -> ENV WINS (a redeploy must not be overridden by a stale row)
 *   - org A's profile is never resolvable for a workspace of org B
 *   - a content row with no location rows resolves to its basename under contentDir
 *   - a delete of one workspace's copy of a shared (mesh-style digest) file keeps the other's
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storage-prof-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.STORAGE_PROVIDER;

const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const storage = require('../lib/storage');
const locations = require('../lib/storage/locations');
const secretbox = require('../lib/secretbox');
const { ingestUploadedFile } = require('../lib/content-ingest');
const { removeUnreferencedContent } = require('../lib/content-files');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const id = () => crypto.randomUUID();
let userId, orgA, orgB, wsA, wsA2, wsB;

const ENV_KEYS = ['STORAGE_PROVIDER', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_PUBLIC_ENDPOINT', 'S3_FORCE_PATH_STYLE'];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; storage._clearBackendCache(); });

before(() => {
  userId = id(); orgA = id(); orgB = id(); wsA = id(); wsA2 = id(); wsB = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `s-${userId}@e.test`, 'S', 'x');
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(o, 'Org', userId);
  }
  for (const [w, o] of [[wsA, orgA], [wsA2, orgA], [wsB, orgB]]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, o, 'W');
  }
  fs.mkdirSync(config.contentDir, { recursive: true });
});

function stageUpload(bytes = PNG) {
  const part = path.join(config.contentDir, `${id()}.part`);
  fs.writeFileSync(part, bytes);
  return { path: part, originalname: 'logo.png', size: bytes.length, mimetype: 'application/octet-stream' };
}

function mkProfile(orgId, extra = {}) {
  const pid = id();
  db.prepare(`INSERT INTO storage_profiles (id, org_id, name, provider, bucket, endpoint, credentials_enc, credentials_hint, mode, manage_scope)
              VALUES (?, ?, ?, 's3', 'media', ?, ?, 'WXYZ', ?, ?)`)
    .run(pid, orgId, `p-${pid.slice(0, 6)}`, extra.endpoint || null,
         secretbox.encrypt(JSON.stringify({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' })),
         extra.mode || 'rw', extra.manage_scope || 'st');
  return pid;
}

test('no env, empty table: the instance default is local disk', () => {
  assert.equal(storage.instanceDefault().provider, 'local');
  assert.equal(storage.writeTargetsForWorkspace(wsA).primary.provider, 'local');
});

test('env-synthesized default is used when the table is empty, and its credentials never touch SQLite', () => {
  process.env.STORAGE_PROVIDER = 's3';
  process.env.S3_ENDPOINT = 'http://minio:9000';
  process.env.S3_BUCKET = 'signage';
  process.env.S3_ACCESS_KEY_ID = 'ENVKEY1234';
  process.env.S3_SECRET_ACCESS_KEY = 'env-secret-value';
  const d = storage.instanceDefault();
  assert.equal(d.id, 'env');
  assert.equal(d.bucket, 'signage');
  const dump = JSON.stringify(db.prepare('SELECT * FROM storage_profiles').all());
  assert.ok(!dump.includes('env-secret-value'));
  assert.ok(!JSON.stringify(storage.publicView(d)).includes('env-secret-value'));
  assert.equal(storage.publicView(d).hint, '1234');
});

test('⚠️ env WINS over a null-org row, so a redeploy cannot be overridden by an old DB row', () => {
  const row = mkProfile(null);
  try {
    assert.equal(storage.instanceDefault().id, row, 'without env, the null-org row is the default');
    process.env.STORAGE_PROVIDER = 's3';
    process.env.S3_BUCKET = 'from-env';
    assert.equal(storage.instanceDefault().id, 'env');
    assert.equal(storage.instanceDefault().bucket, 'from-env');
    process.env.STORAGE_PROVIDER = 'local';
    assert.equal(storage.instanceDefault().provider, 'local', 'an explicit env local also wins');
  } finally { db.prepare('DELETE FROM storage_profiles WHERE id = ?').run(row); }
});

test('a profile from org A is never resolvable with a workspace in org B', () => {
  const pA = mkProfile(orgA);
  assert.ok(storage.profileForWorkspace(pA, wsA), 'own workspace resolves');
  assert.equal(storage.profileForWorkspace(pA, wsB), null, 'other org gets nothing');
  assert.equal(storage.profileForOrg(pA, orgB), null);
  // ...and setting it as org B's default does not make it B's write target.
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(pA, orgB);
  assert.equal(storage.writeTargetsForWorkspace(wsB).primary.provider, 'local');
  db.prepare('UPDATE organizations SET storage_profile_id = NULL WHERE id = ?').run(orgB);
});

test('existing content rows with no profile still resolve to contentDir', () => {
  const cid = id();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?,?,?,?,?,?,?)`)
    .run(cid, userId, wsA, 'old.mp4', 'legacy-uuid.mp4', 'video/mp4', 10);
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(cid);
  const locs = locations.listLocations(row, 'asset');
  assert.equal(locs.length, 1);
  assert.equal(locs[0].implicit, true);
  assert.equal(locs[0].storage_profile_id, null);
  assert.equal(locs[0].object_key, 'legacy-uuid.mp4');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_locations').get().n, 0, 'nothing was backfilled');
});

test('local profile: upload lands in contentDir exactly as before, with no location rows', async () => {
  const row = await ingestUploadedFile({ file: stageUpload(), userId, workspaceId: wsA });
  assert.ok(fs.existsSync(path.join(config.contentDir, row.filepath)));
  assert.equal(row.storage_profile_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_locations WHERE content_id = ?').get(row.id).n, 0);
  const pick = locations.pickForPlayer(row, 'asset');
  assert.equal(pick.via, 'local');
  const r = removeUnreferencedContent(row.id);
  assert.equal(r.removed, true);
  assert.ok(!fs.existsSync(path.join(config.contentDir, row.filepath)), 'delete unlinks the local file');
});

test('local: a second workspace sharing a mesh-style digest name keeps its file when the first is deleted', () => {
  const name = `${'a'.repeat(64)}.png`;
  fs.writeFileSync(path.join(config.contentDir, name), PNG);
  const c1 = id(), c2 = id();
  for (const [c, w] of [[c1, wsA], [c2, wsA2]]) {
    db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?,?,?,?,?,?,?)`).run(c, userId, w, 'shared.png', name, 'image/png', PNG.length);
  }
  // One of them even has an explicit local location (as a migration would leave it).
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state) VALUES (?, 'asset', NULL, ?, 'primary', 'ready')`).run(c1, name);
  removeUnreferencedContent(c1);
  assert.ok(fs.existsSync(path.join(config.contentDir, name)), 'the other workspace still serves it');
  assert.equal(locations.pickForPlayer(db.prepare('SELECT * FROM content WHERE id = ?').get(c2), 'asset').via, 'local');
  removeUnreferencedContent(c2);
  assert.ok(!fs.existsSync(path.join(config.contentDir, name)), 'the last reference takes the file');
});

test('secret redaction: a profile view never carries the secret, only a 4-char hint', () => {
  const pid = mkProfile(orgA);
  const view = storage.publicView(storage.getProfile(pid));
  const json = JSON.stringify(view);
  assert.ok(!json.includes('wJalrXUtnFEMI'));
  assert.ok(!json.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!('credentials' in view) && !('credentials_enc' in view));
  assert.equal(view.configured, true);
  assert.equal(view.hint, 'WXYZ');
});

test('a profile whose secretbox no longer decrypts (JWT_SECRET rotated) says so instead of connecting', () => {
  const pid = mkProfile(orgA);
  db.prepare("UPDATE storage_profiles SET credentials_enc = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?").run(pid);
  const p = storage.getProfile(pid);
  assert.equal(p.credentials_unreadable, true);
  assert.equal(storage.publicView(p).credentials_unreadable, true);
});

test('prefixes and keys are sanitized: no "..", no leading slash, no backslash', () => {
  assert.equal(storage.sanitizePrefix('tenant-a/media/'), 'tenant-a/media');
  for (const bad of ['../x', '/abs', 'a\\b', 'a/../b', 'a//b']) assert.throws(() => storage.sanitizePrefix(bad), /prefix/);
  for (const bad of ['../etc/passwd', '/root', 'a/../../b', 'win\\path', '']) assert.throws(() => storage.assertSafeKey(bad));
  assert.equal(storage.assertSafeKey('campaigns/2026/spring.mp4'), 'campaigns/2026/spring.mp4');
});

test('keys are built from ids and the digest, never from a user filename', () => {
  const sha = 'b'.repeat(64);
  assert.equal(storage.keys.asset('org1', 'ws1', sha, '.mp4'), `st/org1/ws1/${sha}.mp4`);
  assert.equal(storage.keys.thumb('org1', 'ws1', sha), `st/org1/ws1/thumbs/${sha}.jpg`);
  assert.equal(storage.keys.history('org1', 'ws1', 'c1', 'r3', sha, 'x.mp4'), `st/org1/ws1/history/c1/r3/${sha}.mp4`);
  assert.throws(() => storage.keys.asset('../org', 'ws1', sha, '.mp4'));
  assert.throws(() => storage.keys.asset('org1', 'ws1', 'not-a-digest', '.mp4'));
});

test('the write guard: read-only refuses everything; st scope refuses keys outside st/', async () => {
  const ro = storage.getProfile(mkProfile(orgA, { mode: 'ro', manage_scope: 'none' }));
  const rw = storage.getProfile(mkProfile(orgA));
  assert.equal(storage.mayWrite(ro, 'st/x/y'), false);
  assert.equal(storage.mayWrite(rw, 'st/x/y'), true);
  assert.equal(storage.mayWrite(rw, 'customer/own-file.mp4'), false);
  await assert.rejects(storage.backendFor(rw).delete('customer/own-file.mp4'), /does not allow/);
  await assert.rejects(storage.backendFor(ro).put('st/a', Buffer.from('x')), /does not allow/);
});

test('presign TTL is clamped to [60 s, 1 h]', () => {
  assert.equal(storage.presignTtl(5), 60);
  assert.equal(storage.presignTtl(99999), 3600);
  assert.equal(storage.presignTtl(900), 900);
});
