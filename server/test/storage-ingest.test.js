'use strict';

/*
 * Ingest and delete when the workspace writes to a BUCKET.
 *
 *   - sniff / thumbnail / digest run on the local file, then the asset goes to the bucket BEFORE the
 *     row exists; the local copy is removed only once the row and its location are committed
 *   - a refused put inserts nothing and surfaces a 502-shaped StorageWriteError, no SDK detail
 *   - delete: row first, then the object — and an object another row still names is kept
 *   - replace: the old object is RETAINED for history (re-labelled, not copied), and retention
 *     releases it once no revision names it
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storage-ingest-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.STORAGE_PROVIDER;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const storage = require('../lib/storage');
const locations = require('../lib/storage/locations');
const revisions = require('../lib/revisions');
const { ingestUploadedFile } = require('../lib/content-ingest');
const { removeUnreferencedContent } = require('../lib/content-files');
const { installMemoryBackends } = require('./helpers/storage-memory');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const id = () => crypto.randomUUID();
const tick = () => new Promise((r) => setImmediate(r));
let userId, orgId, wsId, P, reg;

before(() => {
  userId = id(); orgId = id(); wsId = id(); P = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `i-${userId}@e.test`, 'I', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(orgId, 'Org', userId);
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(wsId, orgId, 'W');
  db.prepare(`INSERT INTO storage_profiles (id, org_id, name, provider, bucket, mode, manage_scope) VALUES (?, ?, 'bucket', 's3', 'media', 'rw', 'st')`).run(P, orgId);
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(P, orgId);
  reg = installMemoryBackends(storage);
  storage.backendFor(storage.getProfile(P));
  fs.mkdirSync(config.contentDir, { recursive: true });
});
after(() => storage._setBackendFactory(null));

const mem = () => reg.get(P);
function stage(bytes = PNG) {
  const part = path.join(config.contentDir, `${id()}.part`);
  fs.writeFileSync(part, bytes);
  return { path: part, originalname: 'logo.png', size: bytes.length, mimetype: 'application/octet-stream' };
}

test('upload to a bucket workspace: put first, row + primary location, then the local copy goes', async () => {
  const row = await ingestUploadedFile({ file: stage(), userId, workspaceId: wsId });
  const digest = crypto.createHash('sha256').update(PNG).digest('hex');
  const key = `st/${orgId}/${wsId}/${digest}.png`;
  assert.equal(row.byte_digest, digest);
  assert.equal(row.storage_profile_id, P);
  assert.equal(row.object_key, key);
  assert.ok(mem().objects.has(key), 'the asset is in the bucket under the generated key');
  const loc = db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = 'asset'").get(row.id);
  assert.deepEqual([loc.storage_profile_id, loc.role, loc.state, loc.owned], [P, 'primary', 'ready', 1]);
  assert.ok(!fs.existsSync(path.join(config.contentDir, row.filepath)), 'no stray local copy');
  assert.equal(locations.pickForPlayer(row, 'asset').via, 'proxy', 'no public endpoint: served by the origin');
});

test('a refused put inserts no row, and the error is operator-safe', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM content').get().n;
  mem().down = true;
  try {
    await assert.rejects(ingestUploadedFile({ file: stage(Buffer.concat([PNG, crypto.randomBytes(4)])), userId, workspaceId: wsId }),
      (e) => e.name === 'StorageWriteError' && e.status === 502 && !/ECONNREFUSED|stack|AKIA/.test(e.message) && Array.isArray(e.files));
  } finally { mem().down = false; }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, before);
});

test('delete: the object goes after the row — unless another row still names it', async () => {
  const bytes = Buffer.concat([PNG, crypto.randomBytes(16)]);
  const a = await ingestUploadedFile({ file: stage(bytes), userId, workspaceId: wsId });
  const b = await ingestUploadedFile({ file: stage(bytes), userId, workspaceId: wsId });
  assert.equal(a.object_key, b.object_key, 'identical bytes in one org share one object');
  assert.equal(mem().ops('put').filter((p) => p.key === a.object_key).length, 1, 'uploaded once');

  removeUnreferencedContent(a.id);
  await tick(); await tick();
  assert.ok(mem().objects.has(a.object_key), 'b still names it: kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_locations WHERE content_id = ?').get(a.id).n, 0);

  removeUnreferencedContent(b.id);
  await tick(); await tick();
  assert.ok(!mem().objects.has(b.object_key), 'the last reference takes the object');
});

test('a reference-imported object is never deleted by a content delete', async () => {
  const cid = id();
  mem().objects.set('customer/keep-me.mp4', { body: Buffer.from('x') });
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?,?,?,?,?,?)`).run(cid, userId, wsId, 'k', `ref-${cid}.mp4`, 'video/mp4');
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned) VALUES (?, 'asset', ?, 'customer/keep-me.mp4', 'primary', 'ready', 0)`).run(cid, P);
  removeUnreferencedContent(cid);
  await tick(); await tick();
  assert.ok(mem().objects.has('customer/keep-me.mp4'));
  assert.equal(mem().ops('delete').filter((d) => d.key === 'customer/keep-me.mp4').length, 0);
});

test('history: a remote live file is retained by re-label (no copy), and retention releases it', async () => {
  const row = await ingestUploadedFile({ file: stage(Buffer.concat([PNG, crypto.randomBytes(8)])), userId, workspaceId: wsId });
  const putsBefore = mem().ops('put').length;
  const ref = revisions.retainContentFile(db, row.id, row.filepath, 'r1');
  assert.ok(locations.isStorageRef(ref));
  assert.equal(mem().ops('put').length, putsBefore, 'retaining copied nothing');
  assert.equal(revisions.refExists(ref), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_locations WHERE content_id = ? AND kind = 'asset'").get(row.id).n, 0);
  assert.ok(mem().objects.has(row.object_key), 'the old object is kept for the revision');

  // Nothing names the ref -> retention lets it go, through the refcount.
  require('../lib/revision-retention').prune(db, { keep: 3 });
  await tick(); await tick();
  assert.equal(revisions.refExists(ref), false);
  assert.ok(!mem().objects.has(row.object_key));
});

test('settle: a file written locally by a writer that only knows local disk moves to the bucket', async () => {
  const name = `${id()}.png`;
  fs.writeFileSync(path.join(config.contentDir, name), PNG);
  const cid = id();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?,?,?,?,?,?,?)`).run(cid, userId, wsId, 'mesh.png', name, 'image/png', PNG.length);
  const r = await locations.settleRow(cid);
  assert.equal(r.settled, true);
  const loc = db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = 'asset'").get(cid);
  assert.equal(loc.storage_profile_id, P);
  assert.ok(!fs.existsSync(path.join(config.contentDir, name)));
});
