'use strict';

// A support session's upload transferred every byte and then died at the INSERT.
//
// content.user_id is `TEXT REFERENCES users(id)` and a support session has no users row, so
// binding `support:<jti>` raised `FOREIGN KEY constraint failed` — at the very END of ingest,
// after the bytes were received, the file moved into contentDir and the thumbnail rendered. A
// 47 MB upload on a 2 Mbps link transferred for three minutes and then vanished, leaving the
// media and its thumbnail orphaned on disk with no row pointing at them. The dashboard could only
// say the upload failed. Observed on a customer instance on 2026-09-28:
//
//   Resumable finalize error: SqliteError: FOREIGN KEY constraint failed
//       at ingestUploadedFile (server/lib/content-ingest.js:171)
//
// Two things are pinned here: that the foreign key is actually ENFORCED on this connection (if it
// were not, this whole class of bug would be invisible and the fix untestable), and that a
// support-owned row is written with a NULL owner instead.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-supfk-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { isSupportUserId } = require('../lib/support-access');
const { ingestUploadedFile } = require('../lib/content-ingest');
const fs = require('node:fs');

const ORG = 'org-supfk';
const OWNER = 'user-supfk';
const WS = 'ws-supfk';
const SUPPORT_ID = 'support:' + crypto.randomBytes(16).toString('hex');

before(() => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'o@t.local', 'x', 'admin')").run(OWNER);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG, 'T', OWNER);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, ORG, 'T');
});

const insertContent = (userId) => db.prepare(
  'INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(crypto.randomUUID(), userId, WS, 'v.mp4', 'v.mp4', 'video/mp4', 1234);

test('isSupportUserId recognises a minted support id and nothing else', () => {
  assert.equal(isSupportUserId(SUPPORT_ID), true);
  assert.equal(isSupportUserId(OWNER), false);
  assert.equal(isSupportUserId(crypto.randomUUID()), false);
  assert.equal(isSupportUserId(null), false);
  assert.equal(isSupportUserId(undefined), false);
  assert.equal(isSupportUserId(''), false);
});

test('the content.user_id foreign key IS enforced on this connection', () => {
  // If this ever stops throwing, the bug it guards became silent rather than fixed.
  assert.throws(() => insertContent(SUPPORT_ID), /FOREIGN KEY constraint failed/);
});

test('a NULL owner is accepted, which is what a support upload stores', () => {
  assert.doesNotThrow(() => insertContent(null));
  const row = db.prepare('SELECT user_id, workspace_id FROM content WHERE user_id IS NULL').get();
  assert.equal(row.user_id, null);
  assert.equal(row.workspace_id, WS, 'tenancy still comes from workspace_id');
});

test('a real account is still recorded as the owner', () => {
  assert.doesNotThrow(() => insertContent(OWNER));
  assert.ok(db.prepare('SELECT 1 FROM content WHERE user_id = ?').get(OWNER));
});

test('support bytes do not count against the customer storage allowance', () => {
  // getUserStorageMB sums by user_id, so a NULL owner is excluded by construction.
  const mine = db.prepare('SELECT COALESCE(SUM(file_size),0) AS t FROM content WHERE user_id = ?').get(OWNER).t;
  const orphan = db.prepare('SELECT COALESCE(SUM(file_size),0) AS t FROM content WHERE user_id IS NULL').get().t;
  assert.ok(orphan > 0, 'the support row exists');
  assert.equal(mine, 1234, 'and is not in the account total');
});

/*
 * A real PNG, because ingest SNIFFS the bytes and refuses anything it does not recognise — a
 * buffer of zeroes would be rejected at finalize and this would pass for the wrong reason.
 * (Same fixture shape as resumable-uploads.test.js.)
 */
function pngFile(name) {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const tmp = path.join(os.tmpdir(), 'st-supfk-' + crypto.randomBytes(6).toString('hex') + '.upload');
  fs.writeFileSync(tmp, bytes);
  return { path: tmp, originalname: name, size: bytes.length, mimetype: 'image/png' };
}

// THE REGRESSION ITSELF, through the real call site rather than a hand-written INSERT: binding the
// support id here is what raised `FOREIGN KEY constraint failed` at the end of a finished upload.
test('ingestUploadedFile accepts a support session and records no owner', async () => {
  const row = await ingestUploadedFile({ file: pngFile('support.png'), userId: SUPPORT_ID, workspaceId: WS });
  const id = row && row.id ? row.id : db.prepare("SELECT id FROM content WHERE filename = 'support.png'").get().id;
  const saved = db.prepare('SELECT user_id, workspace_id, filename FROM content WHERE id = ?').get(id);
  assert.equal(saved.user_id, null, 'a support upload has no owning account');
  assert.equal(saved.workspace_id, WS, 'but it does belong to the workspace');
  assert.equal(saved.filename, 'support.png');
});

test('ingestUploadedFile still records a real account as the owner', async () => {
  await ingestUploadedFile({ file: pngFile('owned.png'), userId: OWNER, workspaceId: WS });
  const saved = db.prepare("SELECT user_id FROM content WHERE filename = 'owned.png'").get();
  assert.equal(saved.user_id, OWNER);
});
