'use strict';

/*
 * The resumable-upload sweeper, as a unit.
 *
 * ⚠️ IT DELETES BY ROW, NEVER BY GLOB, and that is the whole point of testing it separately. A
 * pattern like `incoming/*.part` looks equivalent and is not: it also matches the file an in-flight
 * upload is appending to right now. This project has twice deleted more than it meant to with a
 * widened prune pattern, and an abandoned-upload cleaner is exactly the shape that invites one.
 *
 * Orphan part files with NO row are counted and LEFT. A file without a row means something failed
 * in a way nobody predicted; quietly deleting the evidence is how it stays unpredicted.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Before the require, so the lib and this test share one database.
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sweep-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const uploadSession = require('../lib/upload-session');

const WS = 'ws-sweep';
const USER = 'user-sweep';

function sessionWith(bytes, ageSeconds = 0) {
  const s = uploadSession.create({ workspaceId: WS, userId: USER, filename: 'f.bin', declaredSize: 1024 * 1024 });
  uploadSession.append(s, 0, Buffer.alloc(bytes, 1));
  if (ageSeconds) {
    const { db } = require('../db/database');
    db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - ageSeconds, s.id);
  }
  return uploadSession.get(s.id, WS);
}

test('an idle session is collected and its bytes go with it', () => {
  const stale = sessionWith(4096, 60 * 60 * 48);
  const partFile = uploadSession.partPath(stale);
  assert.ok(fs.existsSync(partFile));

  const out = uploadSession.sweep();
  assert.ok(out.swept >= 1);
  assert.equal(fs.existsSync(partFile), false, 'the disk must be reclaimed, not just the row');
  assert.equal(uploadSession.get(stale.id, WS), null);
});

test('⚠️ an upload still in progress SURVIVES the sweeper', () => {
  // The failure a glob would cause: collecting the file someone is actively uploading into.
  const fresh = sessionWith(4096, 0);
  uploadSession.sweep();
  assert.ok(uploadSession.get(fresh.id, WS), 'a recently-touched session must not be collected');
  assert.ok(fs.existsSync(uploadSession.partPath(fresh)));
});

test('appending refreshes the clock, so a SLOW upload is never collected mid-flight', () => {
  /*
   * The case that matters for the customer this feature was built for: a 500MB file over a 4 Mbps
   * link takes about seventeen minutes. If idleness were measured from session CREATE rather than
   * from the last chunk, a long upload would be swept out from under someone who was never idle.
   */
  const slow = sessionWith(4096, 60 * 60 * 48);      // looks abandoned...
  uploadSession.append(uploadSession.get(slow.id, WS), 4096, Buffer.alloc(1024, 2));   // ...but a chunk just landed
  uploadSession.sweep();
  assert.ok(uploadSession.get(slow.id, WS), 'the append must have refreshed updated_at');
});

test('orphan part files are REPORTED, never deleted', () => {
  const orphan = path.join(uploadSession.incomingDir(), 'orphan-no-row.part');
  fs.mkdirSync(uploadSession.incomingDir(), { recursive: true });
  fs.writeFileSync(orphan, 'x');

  const out = uploadSession.sweep();
  assert.ok(out.orphans >= 1, 'it must notice');
  assert.ok(fs.existsSync(orphan), 'and must NOT delete something it cannot explain');
});

test('sweeping an empty world is a no-op, not a crash', () => {
  const out = uploadSession.sweep({ ttlMs: 1, now: 0 });
  assert.equal(typeof out.swept, 'number');
  assert.equal(typeof out.orphans, 'number');
});

test('the part directory is NOT the publicly served content directory', () => {
  /*
   * ⚠️ /uploads/content is served statically. A partial file there would be reachable from the
   * dashboard's own origin before upload-sniff had read a byte of it — an unvalidated,
   * caller-influenced file on a trusted origin.
   */
  const config = require('../config');
  assert.notEqual(path.resolve(uploadSession.incomingDir()), path.resolve(config.contentDir));
  assert.ok(!path.resolve(uploadSession.incomingDir()).startsWith(path.resolve(config.contentDir) + path.sep));
});
