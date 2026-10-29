'use strict';

/*
 * A burst of the same edit by the same person folds into one revision (lib/revisions.js
 * canCoalesce). Clicking a playlist item's duration spinner from 10 to 20 used to write ten
 * revisions, which with REVISION_KEEP retention pushed real history out. The folded revision must
 * still name who did it and hold the final state, and nothing a release, a review or another
 * person refers to may be rewritten.
 */

process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-revcoal-' + process.pid + '-' + Date.now());
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { db } = require('../db/database');
const revisions = require('../lib/revisions');

const alice = { userId: 'u-alice', kind: 'user', label: 'alice@x' };
const bob = { userId: 'u-bob', kind: 'user', label: 'bob@x' };
const rec = (id, state, opts = {}) => revisions.record(db, { type: 'playlist', id, workspaceId: 'ws', actor: alice, summary: 'Edited item', state, ...opts });
const rows = (id) => db.prepare("SELECT * FROM revisions WHERE resource_type = 'playlist' AND resource_id = ? ORDER BY rev_no").all(id);
const fresh = () => 'pl-' + crypto.randomBytes(4).toString('hex');

test('ten quick edits by one person are one revision holding the last state', () => {
  const id = fresh();
  for (let d = 10; d <= 20; d++) rec(id, { duration: d });
  const r = rows(id);
  assert.equal(r.length, 1);
  assert.equal(JSON.parse(r[0].state).duration, 20);
  assert.equal(r[0].actor_user_id, 'u-alice');
  assert.equal(r[0].summary, 'Edited item');
});

test('a different person, a different kind of edit, or a different actor kind starts a new revision', () => {
  const id = fresh();
  rec(id, { d: 1 });
  rec(id, { d: 2 }, { actor: bob });
  rec(id, { d: 3 }, { actor: bob, summary: 'Renamed' });
  rec(id, { d: 4 }, { actor: { ...bob, kind: 'api_token' }, summary: 'Renamed' });
  assert.equal(rows(id).length, 4);
});

test('a published revision is never rewritten', () => {
  const id = fresh();
  rec(id, { d: 1 }, { publishedAt: Math.floor(Date.now() / 1000) });
  rec(id, { d: 2 });
  const r = rows(id);
  assert.equal(r.length, 2);
  assert.equal(JSON.parse(r[0].state).d, 1);
});

test('the window is fixed from created_at, so a long session still lands as several versions', () => {
  const id = fresh();
  rec(id, { d: 1 });
  db.prepare("UPDATE revisions SET created_at = created_at - 600 WHERE resource_id = ?").run(id);
  rec(id, { d: 2 });
  assert.equal(rows(id).length, 2);
});

test('a revision a submission points at is left alone', () => {
  const id = fresh();
  const first = rec(id, { d: 1 });
  db.prepare("INSERT INTO submissions (id, workspace_id, resource_type, resource_id, revision_id, state_hash, submitted_by, submitted_at, updated_at) VALUES (?, 'ws', 'playlist', ?, ?, ?, 'u-alice', strftime('%s','now'), strftime('%s','now'))")
    .run('sub-' + id, id, first.id, first.state_hash);
  rec(id, { d: 2 });
  assert.equal(rows(id).length, 2);
});

test('an identical save still records nothing', () => {
  const id = fresh();
  rec(id, { d: 1 });
  rec(id, { d: 1 });
  assert.equal(rows(id).length, 1);
});
