'use strict';

// The whole-server export filled prod's disk (2026-10-20): 4.7 GB of bundle plus 4.5 GB of
// per-organization zips it never removed, on a 75 GB disk already 76% full. The database could no
// longer checkpoint, and the job hung as 'running' with a file still open. A 15-minute sweep then
// flipped it back to 'queued', so the next restart would have started it all over again.
//
// Pinned here: a write error stops the writer instead of hanging it; the export refuses up front when
// it will not fit with a reserve to spare; per-organization zips never pile up; a crashed job is
// failed, not requeued; and its leftovers are removed.

process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-instance-export-disk-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-instance-export-disk';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db/database');
const exporter = require('../lib/trust/export');
const instanceExport = require('../lib/trust/instance-export');

after(() => { try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) { /* */ } });

const PLAT = 'u-ied-plat';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?, 'plat@ied.local', '$2a$10$HASHHASH', 'platform_admin', 'Plat')").run(PLAT);
for (const [o, ws] of [['org-ied-a', 'ws-ied-a'], ['org-ied-b', 'ws-ied-b'], ['org-ied-c', 'ws-ied-c']]) {
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(o, o, PLAT);
  db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(ws, o, ws);
  const cid = crypto.randomUUID();
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(path.join(config.contentDir, `${cid}.bin`), crypto.randomBytes(64 * 1024));
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,'clip.bin',?,'application/octet-stream',?)")
    .run(cid, PLAT, ws, `${cid}.bin`, 64 * 1024);
}
const jobs = () => db.prepare('SELECT * FROM instance_exports ORDER BY created_at, rowid').all();
const clearJobs = () => db.prepare('DELETE FROM instance_exports').run();
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: still waiting after ${ms} ms (hung)`)), ms))]);

test('⚠️ a write error stops the writer: buildZip rejects instead of hanging', async () => {
  // An output that cannot be opened errors at once, like a disk that is full. The writer below never
  // finishes by itself, which is what an archive stalled on back-pressure looks like.
  const bad = path.join(process.env.DATA_DIR, 'no-such-dir', 'x.zip');
  await assert.rejects(
    withTimeout(exporter.buildZip(bad, () => new Promise(() => {})), 5000, 'buildZip'),
    (e) => !/hung/.test(e.message),
    'the output error ends the build');
});

test('⚠️ an export that will not fit is refused up front with 507, and nothing is queued', () => {
  clearJobs();
  const big = crypto.randomUUID();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES (?,?,'ws-ied-a','huge.mp4','huge.mp4','video/mp4',?)")
    .run(big, PLAT, 1024 ** 5);   // a petabyte: more than any test machine has
  try {
    assert.throws(() => instanceExport.request(db, PLAT, {}), (e) => e.status === 507 && e.code === 'disk_space' && /must stay free/.test(e.message));
    assert.equal(jobs().length, 0, 'no job row');
  } finally {
    db.prepare('DELETE FROM content WHERE id = ?').run(big);
  }
});

test('the estimate counts every organization\'s files plus the largest one again', () => {
  const est = instanceExport.estimateBytes(db);
  const files = 3 * 64 * 1024, largest = 64 * 1024;
  assert.equal(est, Math.ceil((files + largest) * 1.1) + 64 * 1024 ** 2);
});

test('an export completes, and leaves only the bundle: no per-organization zip is kept', async () => {
  clearJobs();
  const seen = new Set();
  const dir = exporter.exportsDir();
  fs.mkdirSync(dir, { recursive: true });
  // Watch the folder while it runs: never more than one per-organization zip beside the bundle.
  let maxTmp = 0;
  const poll = setInterval(() => {
    try {
      const tmp = fs.readdirSync(dir).filter((n) => /^instance-[0-9a-f-]{36}-.+\.zip$/.test(n));
      tmp.forEach((n) => seen.add(n));
      maxTmp = Math.max(maxTmp, tmp.length);
    } catch (_) { /* */ }
  }, 1);
  try {
    const id = instanceExport.request(db, PLAT, {});
    await withTimeout(instanceExport.runQueue(db), 30000, 'export');
    const job = db.prepare('SELECT * FROM instance_exports WHERE id = ?').get(id);
    assert.equal(job.status, 'ready', job.error || '');
    assert.deepEqual(fs.readdirSync(dir).sort(), [job.file_name], 'only the bundle is left');
    assert.ok(maxTmp <= 1, `at most one organization zip at a time (saw ${maxTmp})`);
    assert.equal(JSON.parse(job.manifest).organizations, db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n);
  } finally { clearInterval(poll); }
});

test('⚠️ the sweep never puts a running job back in the queue', () => {
  clearJobs();
  db.prepare("INSERT INTO instance_exports (id, user_id, status, started_at) VALUES ('11111111-1111-4111-8111-111111111111', ?, 'running', strftime('%s','now'))").run(PLAT);
  instanceExport.sweep(db);
  assert.equal(jobs()[0].status, 'running');
});

test('⚠️ a job a restart interrupted is failed, not requeued, and its files are removed', () => {
  clearJobs();
  const dead = '22222222-2222-4222-8222-222222222222', ready = '33333333-3333-4333-8333-333333333333';
  db.prepare("INSERT INTO instance_exports (id, user_id, status, started_at) VALUES (?, ?, 'running', strftime('%s','now'))").run(dead, PLAT);
  db.prepare("INSERT INTO instance_exports (id, user_id, status, file_name, expires_at) VALUES (?, ?, 'ready', ?, strftime('%s','now') + 3600)").run(ready, PLAT, `instance-${ready}.zip`);
  const dir = exporter.exportsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [`instance-${dead}.zip`, `instance-${dead}-org-ied-a.zip`, `instance-${ready}.zip`, 'unrelated.zip']) fs.writeFileSync(path.join(dir, n), 'x');
  instanceExport.start(db);
  const byId = Object.fromEntries(jobs().map((j) => [j.id, j]));
  assert.equal(byId[dead].status, 'failed');
  assert.match(byId[dead].error, /interrupted by a restart/);
  assert.equal(byId[ready].status, 'ready');
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes(`instance-${ready}.zip`), 'a ready bundle is kept');
  assert.ok(left.includes('unrelated.zip'), 'files that are not ours are kept');
  assert.ok(!left.some((n) => n.startsWith(`instance-${dead}`)), 'the dead job\'s bundle and organization zips are removed');
});
