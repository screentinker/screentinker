'use strict';

/*
 * LIVE MIGRATION: copy, dual-read, commit, drain — and a screen keeps playing through all of it.
 *
 * Two in-memory "buckets" (A = where the org's media is, B = where it is going) stand in for S3 /
 * Azure / MinIO; every call they receive is recorded, so "nothing was deleted" is asserted as
 * "delete was never called", not inferred from end state.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storage-mig-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.STORAGE_PROVIDER;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const config = require('../config');
const storage = require('../lib/storage');
const locations = require('../lib/storage/locations');
const migrate = require('../lib/storage/migrate');
const breaker = require('../lib/storage/breaker');
const { installMemoryBackends } = require('./helpers/storage-memory');
const setupDeviceSocket = require('../ws/deviceSocket');

const id = () => crypto.randomUUID();
let userId, orgId, wsA, wsB, A, B, reg, httpServer, io, buildPlaylistPayload;

before(() => {
  userId = id(); orgId = id(); wsA = id(); wsB = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `m-${userId}@e.test`, 'M', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(orgId, 'Org', userId);
  for (const w of [wsA, wsB]) db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, orgId, 'W');
  A = id(); B = id();
  for (const [pid, name] of [[A, 'bucket-a'], [B, 'bucket-b']]) {
    db.prepare(`INSERT INTO storage_profiles (id, org_id, name, provider, bucket, endpoint, mode, manage_scope) VALUES (?, ?, ?, 's3', ?, 'http://10.0.0.5:9000', 'rw', 'st')`).run(pid, orgId, name, name);
  }
  reg = installMemoryBackends(storage, { [A]: { presignBase: 'https://a.example.com' }, [B]: { presignBase: 'https://b.example.com' } });
  storage.backendFor(storage.getProfile(A)); storage.backendFor(storage.getProfile(B));
  fs.mkdirSync(config.contentDir, { recursive: true });
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
});
after(() => { migrate.stopAll(); storage._setBackendFactory(null); io && io.close(); });
beforeEach(() => {
  breaker._reset();
  for (const be of reg.values()) { be.down = false; be.calls.length = 0; }
  db.prepare("UPDATE storage_migrations SET state = 'done' WHERE state IN ('copying','ready_to_commit','committed','draining')").run();
  db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(A, orgId);
});

const mem = (pid) => reg.get(pid);
const row = (cid) => db.prepare('SELECT * FROM content WHERE id = ?').get(cid);
const locs = (cid, kind = 'asset') => db.prepare('SELECT * FROM content_locations WHERE content_id = ? AND kind = ? ORDER BY id').all(cid, kind);

/** A content row whose only copy is on profile `pid`. */
function seedOn(pid, ws, bytes = crypto.randomBytes(64)) {
  const cid = id();
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const key = storage.keys.asset(orgId, ws, digest, '.mp4');
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, byte_digest, storage_profile_id, object_key)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cid, userId, ws, 'clip.mp4', `${id()}.mp4`, 'video/mp4', bytes.length, digest, pid, key);
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, byte_digest, size)
              VALUES (?, 'asset', ?, ?, 'primary', 'ready', 1, ?, ?)`).run(cid, pid, key, digest, bytes.length);
  mem(pid).objects.set(key, { body: bytes, contentType: 'video/mp4' });
  return { cid, key, digest, bytes };
}

/** A device whose resolved playlist plays `cid`. */
function deviceFor(cid, ws) {
  const pl = id(), dev = id();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, published_snapshot) VALUES (?,?,?,?,?)')
    .run(pl, userId, ws, 'pl', JSON.stringify([{ content_id: cid, filename: 'clip.mp4', mime_type: 'video/mp4', filepath: row(cid).filepath, duration_sec: 10 }]));
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,?,?)').run(pl, cid, 0, 10);
  db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, playlist_id) VALUES (?,?,?,?,?)').run(dev, userId, ws, 'panel', pl);
  return dev;
}

async function streamText(cid) {
  const out = await locations.openForRead(row(cid), 'asset');
  const chunks = [];
  for await (const c of out.stream) chunks.push(c);
  return { body: Buffer.concat(chunks), via: out.loc.storage_profile_id };
}

async function migrateTo(target) {
  const m = migrate.start(orgId, target);
  return migrate._settle(m.id);
}

test('two ready locations: the primary\'s breaker is open -> the replica is served; neither is deleted', async () => {
  const s = seedOn(A, wsA);
  const keyB = s.key;
  mem(B).objects.set(keyB, { body: s.bytes, contentType: 'video/mp4' });
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, byte_digest, size) VALUES (?, 'asset', ?, ?, 'replica', 'ready', 1, ?, ?)`).run(s.cid, B, keyB, s.digest, s.bytes.length);

  breaker._forceOpen(A);
  const pick = locations.pickForPlayer(row(s.cid), 'asset');
  assert.equal(pick.loc.storage_profile_id, B);
  assert.match(pick.url, /^https:\/\/b\.example\.com\//);
  const read = await streamText(s.cid);
  assert.equal(read.via, B);
  assert.deepEqual(read.body, s.bytes);
  assert.equal(mem(A).ops('get').length, 0, 'an open breaker sends nothing to A');
  assert.equal(locs(s.cid).length, 2);
  assert.equal(mem(A).ops('delete').length + mem(B).ops('delete').length, 0);
});

test('a copy that errors is skipped, not fatal: three failures open the breaker', async () => {
  const s = seedOn(A, wsA);
  mem(B).objects.set(s.key, { body: s.bytes });
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, byte_digest) VALUES (?, 'asset', ?, ?, 'replica', 'ready', 1, ?)`).run(s.cid, B, s.key, s.digest);
  mem(A).down = true;
  for (let i = 0; i < 3; i++) assert.equal((await streamText(s.cid)).via, B);
  assert.equal(breaker.isOpen(A), true);
  const before = mem(A).calls.length;
  await streamText(s.cid);
  assert.equal(mem(A).calls.length, before, 'no further timeouts are paid on A while it is open');
});

test('the only copy behind an open breaker fails FAST: no request reaches the dead store', async () => {
  const s = seedOn(A, wsA);
  breaker._forceOpen(A);
  await assert.rejects(locations.openForRead(row(s.cid), 'asset'), { code: 'not_found' });
  assert.equal(mem(A).calls.length, 0);
  assert.equal(locations.pickForPlayer(row(s.cid), 'asset'), null, 'the payload gets no bucket URL; the player keeps its relative path');
});

test('mid-migration the row has both copies ready, and a playlist build succeeds with the source forced down', async () => {
  const s = seedOn(A, wsA);
  const dev = deviceFor(s.cid, wsA);
  const m = await migrateTo(B);
  assert.equal(m.state, 'ready_to_commit');
  assert.equal(m.verified, m.total);
  const l = locs(s.cid);
  assert.deepEqual(l.map((x) => [x.storage_profile_id, x.role, x.state]), [[A, 'primary', 'ready'], [B, 'replica', 'ready']]);
  assert.equal(row(s.cid).storage_profile_id, A, 'copying does not flip anything');

  mem(A).down = true; breaker._forceOpen(A);
  const payload = buildPlaylistPayload(dev);
  const item = payload.assignments.find((a) => a.content_id === s.cid);
  assert.ok(item, 'the item is in the payload');
  assert.equal(item.filepath, row(s.cid).filepath, 'old players still get the relative field');
  assert.match(item.file_url, /^https:\/\/b\.example\.com\//, 'new players are pointed at the copy that is up');
  assert.deepEqual((await streamText(s.cid)).body, s.bytes);
  migrate.abort(orgId, B);
});

test('commit flips primary to the target; the old copy is draining and still readable', async () => {
  const s = seedOn(A, wsA);
  await migrateTo(B);
  const out = migrate.commit(orgId, B);
  assert.equal(out.state, 'committed');
  const l = locs(s.cid);
  assert.equal(l.find((x) => x.storage_profile_id === B).role, 'primary');
  assert.equal(l.find((x) => x.storage_profile_id === A).role, 'draining');
  assert.equal(row(s.cid).storage_profile_id, B);
  assert.equal(db.prepare('SELECT storage_profile_id FROM organizations WHERE id = ?').get(orgId).storage_profile_id, B);
  assert.equal(locations.pickForPlayer(row(s.cid), 'asset').loc.storage_profile_id, B, 'reads prefer the target at once');
  mem(B).down = true; breaker._forceOpen(B);
  assert.equal((await streamText(s.cid)).via, A, 'the draining copy still serves when the target errors');
  assert.equal(mem(A).ops('delete').length, 0);
  migrate.abort(orgId, B);
});

test('abort restores the old primary and does not delete the copied replica', async () => {
  const s = seedOn(A, wsA);
  await migrateTo(B);
  migrate.commit(orgId, B);
  const out = migrate.abort(orgId, B);
  assert.equal(out.state, 'aborted');
  const l = locs(s.cid);
  assert.equal(l.find((x) => x.storage_profile_id === A).role, 'primary');
  assert.equal(l.find((x) => x.storage_profile_id === B).role, 'replica');
  assert.ok(mem(B).objects.has(l.find((x) => x.storage_profile_id === B).object_key), 'the replica is still there');
  assert.equal(mem(A).ops('delete').length + mem(B).ops('delete').length, 0);
  assert.equal(db.prepare('SELECT storage_profile_id FROM organizations WHERE id = ?').get(orgId).storage_profile_id, A);
});

test('new uploads during a migration dual-write: target primary, previous primary replica', async () => {
  const s = seedOn(A, wsA);
  const m = migrate.start(orgId, B);
  await migrate._settle(m.id);
  const file = path.join(config.contentDir, `${id()}.png`);
  fs.writeFileSync(file, crypto.randomBytes(100));
  const plan = await locations.placeFiles({ workspaceId: wsA, files: [{ kind: 'asset', abs: file, basename: path.basename(file) }], mime: 'image/png' });
  assert.deepEqual(plan.placed.map((p) => [p.storage_profile_id, p.role]), [[B, 'primary'], [A, 'replica']]);
  // A failure of the OLD location is logged, not a failed upload; a failure of the target is.
  mem(A).down = true;
  const plan2 = await locations.placeFiles({ workspaceId: wsA, files: [{ kind: 'asset', abs: file, basename: path.basename(file) }], mime: 'image/png' });
  assert.deepEqual(plan2.placed.map((p) => p.storage_profile_id), [B]);
  mem(A).down = false; mem(B).down = true;
  await assert.rejects(locations.placeFiles({ workspaceId: wsA, files: [{ kind: 'asset', abs: file, basename: path.basename(file) }], mime: 'image/png' }));
  migrate.abort(orgId, B);
  assert.ok(s);
});

test('the copier dedupes on (target, digest): one file pushed to two workspaces is uploaded once', async () => {
  const bytes = crypto.randomBytes(128);
  const one = seedOn(A, wsA, bytes);
  const two = seedOn(A, wsB, bytes);
  await migrateTo(B);
  const puts = mem(B).ops('put').filter((p) => p.key.endsWith(`${one.digest}.mp4`));
  assert.equal(puts.length, 1);
  const kOne = locs(one.cid).find((x) => x.storage_profile_id === B).object_key;
  const kTwo = locs(two.cid).find((x) => x.storage_profile_id === B).object_key;
  assert.equal(kOne, kTwo, 'both rows point at the one object');
  migrate.abort(orgId, B);
});

test('drain refuses to delete a key another ready location still needs, and never a reference import', async () => {
  // X is draining on A under key K; Y is a live (primary) row on A under the SAME key K.
  const bytes = crypto.randomBytes(64);
  const x = seedOn(A, wsA, bytes);
  const y = seedOn(A, wsB, bytes);
  assert.equal(x.key === y.key, false);
  db.prepare('UPDATE content_locations SET object_key = ? WHERE content_id = ?').run(x.key, y.cid);
  mem(B).objects.set('st/elsewhere-x', { body: bytes });
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned) VALUES (?, 'asset', ?, 'st/elsewhere-x', 'primary', 'ready', 1)`).run(x.cid, B);
  db.prepare("UPDATE content_locations SET role = 'draining' WHERE content_id = ? AND storage_profile_id = ?").run(x.cid, A);

  // A reference import (owned = 0) that is draining, with a primary elsewhere.
  const r = seedOn(A, wsA);
  db.prepare("UPDATE content_locations SET owned = 0, role = 'draining' WHERE content_id = ?").run(r.cid);
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned) VALUES (?, 'asset', ?, 'st/elsewhere-r', 'primary', 'ready', 1)`).run(r.cid, B);

  const out = await migrate.drain(orgId);
  assert.equal(mem(A).ops('delete').length, 0, 'nothing on A was deleted');
  assert.ok(mem(A).objects.has(x.key), 'the shared key survives');
  assert.ok(mem(A).objects.has(r.key), 'the reference import survives');
  assert.ok(out.kept_referenced >= 1);
  assert.ok(out.kept_not_owned >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_locations WHERE content_id = ? AND role = ?').get(r.cid, 'draining').n, 1, 'the reference location stays');
});

test('drain removes an owned, unshared draining copy — and never the last good copy', async () => {
  const s = seedOn(A, wsA);
  await migrateTo(B);
  migrate.commit(orgId, B);
  const lonely = seedOn(A, wsA);
  db.prepare("UPDATE content_locations SET role = 'draining' WHERE content_id = ?").run(lonely.cid);   // no primary anywhere
  const out = await migrate.drain(orgId);
  assert.ok(!mem(A).objects.has(s.key), 'the drained copy is gone');
  assert.ok(mem(A).objects.has(lonely.key), 'a draining copy with no primary elsewhere is kept');
  assert.ok(out.kept_no_primary >= 1);
  assert.deepEqual(locs(s.cid).map((x) => x.storage_profile_id), [B]);
  assert.deepEqual((await streamText(s.cid)).body, s.bytes);
});

test('a restart mid-copy resumes from the cursor and does not flip or delete anything', async () => {
  const first = seedOn(A, wsA);
  const second = seedOn(A, wsA);
  const [lo] = [first.cid, second.cid].sort();
  const mid = id();
  db.prepare(`INSERT INTO storage_migrations (id, org_id, target_profile_id, previous_profile_id, state, cursor, total) VALUES (?, ?, ?, ?, 'copying', ?, 2)`).run(mid, orgId, B, A, lo);
  migrate.startBackground();
  const m = await migrate._settle(mid);
  migrate.stopAll();
  assert.equal(m.state, 'ready_to_commit');
  const notCopied = lo;  // at or before the cursor: already "done" by the previous run
  assert.equal(locs(notCopied).filter((x) => x.storage_profile_id === B).length, 0, 'rows at/before the cursor are not redone');
  for (const cid of [first.cid, second.cid]) assert.equal(row(cid).storage_profile_id, A, 'no primary was flipped');
  assert.equal(mem(A).ops('delete').length, 0);
  migrate.abort(orgId, B);
});

test('local -> bucket: the implicit local location becomes explicit, then a verified replica is added', async () => {
  db.prepare('UPDATE organizations SET storage_profile_id = NULL WHERE id = ?').run(orgId);
  const bytes = crypto.randomBytes(256);
  const name = `${id()}.mp4`;
  fs.writeFileSync(path.join(config.contentDir, name), bytes);
  const cid = id();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?,?,?,?,?,?,?)`).run(cid, userId, wsA, 'old.mp4', name, 'video/mp4', bytes.length);
  await migrateTo(B);
  const l = locs(cid);
  assert.deepEqual(l.map((x) => [x.storage_profile_id, x.role]), [[null, 'primary'], [B, 'replica']]);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(row(cid).byte_digest, digest, 'a row with no digest gets the one computed while copying');
  assert.ok(l[1].object_key.endsWith(`${digest}.mp4`));
  migrate.commit(orgId, B);
  await migrate.drain(orgId);
  assert.ok(!fs.existsSync(path.join(config.contentDir, name)), 'the local copy is drained once the bucket is primary');
  assert.deepEqual((await streamText(cid)).body, bytes);
});
