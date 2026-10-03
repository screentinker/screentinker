'use strict';

/*
 * ⚠️ WHO ELSE IS USING THESE BYTES?
 *
 * For most of this product's life the question never had to be asked: every upload minted its own
 * uuid filename, so one row meant one file and a delete could safely unlink what it pointed at.
 * Mesh-received content is stored under the sha256 of its bytes, so the same file legitimately
 * backs one row per workspace — and the old assumption became a data-loss path. Deleting one
 * customer's copy of a shared asset unlinked the bytes out from under every other workspace
 * holding it, and every panel that had not already cached the file 404s.
 *
 * The naming scheme introduced the hazard, so the naming scheme owes the fix.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-refcount-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const { unlinkIfUnreferenced, REFCOUNTED_COLUMNS } = require('../lib/content-files');

const id = () => crypto.randomUUID();
let wsA, wsB, userId;

before(() => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `r-${userId}@e.com`, 'R', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  wsA = id(); wsB = id();
  for (const [w, n] of [[wsA, 'A'], [wsB, 'B']]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
                VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, org, n);
  }
  fs.mkdirSync(config.contentDir, { recursive: true });
});

function mkRow(ws, filepath, extra = {}) {
  const rid = id();
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size,
                                   thumbnail_path,subtitle_url,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))`)
    .run(rid, userId, ws, 'Clip.mp4', filepath, 'video/mp4', 10,
         extra.thumbnail_path || null, extra.subtitle_url || null);
  return rid;
}

const touch = (name) => {
  const p = path.join(config.contentDir, name);
  fs.writeFileSync(p, 'bytes');
  return p;
};

test('a file only one row points at is removed, as it always was', () => {
  const name = `${'a'.repeat(64)}.mp4`;
  const p = touch(name);
  const only = mkRow(wsA, name);
  const r = unlinkIfUnreferenced(name, only, 'filepath');
  assert.equal(r.unlinked, true);
  assert.equal(fs.existsSync(p), false);
});

test('⚠️ a file another WORKSPACE still points at survives the delete', () => {
  const name = `${'b'.repeat(64)}.mp4`;
  const p = touch(name);
  const mine = mkRow(wsA, name);
  mkRow(wsB, name);                       // the other customer's row on the same bytes

  const r = unlinkIfUnreferenced(name, mine, 'filepath');
  assert.equal(r.unlinked, false);
  assert.equal(r.reason, 'still referenced');
  assert.equal(fs.existsSync(p), true, "deleting one customer's copy must not empty another's screen");
});

test('⚠️ the last remaining reference DOES free the bytes — this is not a leak', () => {
  const name = `${'c'.repeat(64)}.mp4`;
  const p = touch(name);
  const first = mkRow(wsA, name);
  const second = mkRow(wsB, name);

  assert.equal(unlinkIfUnreferenced(name, first, 'filepath').unlinked, false);
  db.prepare('DELETE FROM content WHERE id = ?').run(first);
  assert.equal(unlinkIfUnreferenced(name, second, 'filepath').unlinked, true);
  assert.equal(fs.existsSync(p), false, 'refcounting must not turn into never collecting');
});

test('⚠️ thumbnails are shared too — their name is DERIVED from the filepath', () => {
  // Worse than the file itself: two rows share a thumbnail even when only one records a
  // thumbnail_path of its own, because the name is computed rather than stored.
  const thumb = `thumb_${'d'.repeat(64)}.jpg`;
  const p = touch(thumb);
  const mine = mkRow(wsA, `${'d'.repeat(64)}.mp4`, { thumbnail_path: thumb });
  mkRow(wsB, `${'d'.repeat(64)}.mp4`, { thumbnail_path: thumb });

  assert.equal(unlinkIfUnreferenced(thumb, mine, 'thumbnail_path').unlinked, false);
  assert.equal(fs.existsSync(p), true);
});

test('a stored path with directory parts still matches a bare basename reference', () => {
  const name = `${'e'.repeat(64)}.mp4`;
  const p = touch(name);
  const mine = mkRow(wsA, name);
  mkRow(wsB, `content/${name}`);          // a legacy row storing a relative path
  assert.equal(unlinkIfUnreferenced(name, mine, 'filepath').unlinked, false,
    'the comparison must be on the basename, or a legacy row is invisible to the count');
  assert.equal(fs.existsSync(p), true);
});

test('the column name can never be caller data', () => {
  assert.deepEqual(REFCOUNTED_COLUMNS, ['filepath', 'thumbnail_path', 'subtitle_url']);
  assert.throws(() => unlinkIfUnreferenced('x.mp4', id(), 'filepath = 1 OR 1'), /refusing to refcount/);
});

test('a missing file and an empty reference are both quietly fine', () => {
  assert.equal(unlinkIfUnreferenced(null, id(), 'filepath').unlinked, false);
  assert.equal(unlinkIfUnreferenced('', id(), 'filepath').unlinked, false);
  assert.equal(unlinkIfUnreferenced('not-on-disk.mp4', id(), 'filepath').reason, 'already gone');
});
