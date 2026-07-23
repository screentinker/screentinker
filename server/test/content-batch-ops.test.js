'use strict';

// #213 batch operations. POST /content/batch/delete and /batch/move. The atomic
// validate-all-first contract and the shared snapshot-scrub path are the parts worth guarding.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-batch-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const { publishPlaylist } = require('../routes/playlists');

const UUID = () => crypto.randomUUID();
const USER = 'u-batch';
let server, base;

function post(pathname, body) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (r) => { let o = ''; r.on('data', (c) => (o += c)); r.on('end', () => resolve({ status: r.statusCode, json: o ? JSON.parse(o) : null })); });
    req.on('error', reject);
    req.end(data);
  });
}

function mkContent(id, { filepath = '', workspace = 'ws-batch' } = {}) {
  db.prepare('INSERT INTO content (id, filename, mime_type, filepath, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, id + '.mp4', 'video/mp4', filepath, workspace);
}

before(async () => {
  fs.mkdirSync(require('../config').contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-batch', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-batch', 'org-batch', 'WS')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-other', 'org-batch', 'Other')").run();
  db.prepare("INSERT INTO content_folders (id, name, user_id, workspace_id) VALUES ('f-batch', 'Folder', 'u-batch', 'ws-batch')").run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 'ws-batch'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/content', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('batch delete removes all rows, their files, and scrubs published snapshots', async () => {
  const a = UUID(), b = UUID();
  // give `a` a real file on disk to prove it's removed
  const fp = a + '.mp4';
  fs.writeFileSync(path.join(require('../config').contentDir, fp), 'x');
  mkContent(a, { filepath: fp });
  mkContent(b);

  // a published playlist carrying both -> must be scrubbed of both
  const pl = UUID();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?, ?, 'ws-batch', 'P', 'draft')").run(pl, USER);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(pl, a);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 1)').run(pl, b);
  publishPlaylist(pl);
  assert.equal(JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get(pl).published_snapshot).length, 2);

  const res = await post('/content/batch/delete', { ids: [a, b] });
  assert.equal(res.status, 200);
  assert.equal(res.json.deleted, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content WHERE id IN (?,?)').get(a, b).n, 0);
  assert.ok(!fs.existsSync(path.join(require('../config').contentDir, fp)), 'file removed from disk');
  assert.equal(JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get(pl).published_snapshot).length, 0);
});

test('batch delete is atomic: one bad id rejects the whole batch, nothing deleted', async () => {
  const a = UUID();
  mkContent(a);
  const res = await post('/content/batch/delete', { ids: [a, UUID() /* not found */] });
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content WHERE id=?').get(a).n, 1, 'valid row survived the rejected batch');
});

test('batch delete rejects a malformed id (LIKE-injection guard)', async () => {
  const res = await post('/content/batch/delete', { ids: ['not-a-uuid'] });
  assert.equal(res.status, 400);
});

test('batch move reassigns folder for all ids', async () => {
  const a = UUID(), b = UUID();
  mkContent(a); mkContent(b);
  const res = await post('/content/batch/move', { ids: [a, b], folder_id: 'f-batch' });
  assert.equal(res.status, 200);
  assert.equal(res.json.moved, 2);
  for (const id of [a, b]) assert.equal(db.prepare('SELECT folder_id FROM content WHERE id=?').get(id).folder_id, 'f-batch');
  // move back to root
  const res2 = await post('/content/batch/move', { ids: [a, b], folder_id: null });
  assert.equal(res2.status, 200);
  assert.equal(db.prepare('SELECT folder_id FROM content WHERE id=?').get(a).folder_id, null);
});

test('batch move to a folder in another workspace is refused', async () => {
  const a = UUID();
  mkContent(a);
  db.prepare("INSERT INTO content_folders (id, name, user_id, workspace_id) VALUES ('f-other', 'Other', 'u-batch', 'ws-other')").run();
  const res = await post('/content/batch/move', { ids: [a], folder_id: 'f-other' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT folder_id FROM content WHERE id=?').get(a).folder_id, null, 'not moved');
});

test('empty / oversized batches are rejected', async () => {
  assert.equal((await post('/content/batch/delete', { ids: [] })).status, 400);
  assert.equal((await post('/content/batch/move', { ids: [], folder_id: null })).status, 400);
});
