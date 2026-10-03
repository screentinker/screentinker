'use strict';

// Audit F22: deleting content that was ever submitted for approval. submissions.revision_id is
// NOT NULL REFERENCES revisions(id) with NO ACTION, so the route's `DELETE FROM revisions` threw
// "FOREIGN KEY constraint failed" inside a try/catch(_){} that also held the .history removal:
// the route answered success while the revision + submission rows and the retained media bytes
// stayed forever (revision-retention keeps any revision a submission names). Both delete routes.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delhist-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const revisions = require('../lib/revisions');
const retention = require('../lib/revision-retention');

const USER = 'u-delhist';
let server, base;

function call(method, pathname, body) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, {
      method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (r) => { let o = ''; r.on('data', (c) => (o += c)); r.on('end', () => resolve({ status: r.statusCode, json: o ? JSON.parse(o) : null })); });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

// A content item that went through approval and had its media replaced (so a retained copy sits
// under .history/<id>/ and a revision names it).
function approvedItem() {
  const id = crypto.randomUUID();
  const file = `${id}.mp4`;
  fs.writeFileSync(path.join(config.contentDir, file), 'live bytes');
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, 'ws-dh', ?, ?, 'video/mp4')").run(id, USER, file, file);
  const hdir = path.join(revisions.historyDir(), id);
  fs.mkdirSync(hdir, { recursive: true });
  fs.writeFileSync(path.join(hdir, 'r1__old.mp4'), 'old bytes');
  const rev = revisions.record(db, { type: 'content', id, workspaceId: 'ws-dh', actor: { userId: USER }, summary: 'Replaced file', state: { filepath: file }, fileRef: path.join(revisions.HISTORY_DIR, id, 'r1__old.mp4') });
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO submissions (id, workspace_id, resource_type, resource_id, revision_id, state_hash, submitted_at, updated_at, status) VALUES (?, 'ws-dh', 'content', ?, ?, ?, ?, ?, 'approved')")
    .run(crypto.randomUUID(), id, rev.id, rev.state_hash, now, now);
  return { id, hdir };
}
function assertHistoryGone({ id, hdir }) {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revisions WHERE resource_type = 'content' AND resource_id = ?").get(id).n, 0, 'revisions deleted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM submissions WHERE resource_type = 'content' AND resource_id = ?").get(id).n, 0, 'submissions deleted');
  assert.equal(fs.existsSync(hdir), false, 'retained .history bytes removed');
}

before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-dh', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-dh', 'org-dh', 'WS')").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 'ws-dh'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/content', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('F22: DELETE /content/:id of an approved item removes its submissions, revisions and .history', async () => {
  const item = approvedItem();
  const res = await call('DELETE', `/content/${item.id}`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM content WHERE id = ?').get(item.id), undefined);
  assertHistoryGone(item);
  // and nothing is left for the daily prune to be keeping alive
  assert.equal(retention.prune(db).files_kept, 0);
});

test('F22: POST /content/batch/delete does the same', async () => {
  const a = approvedItem(), b = approvedItem();
  const res = await call('POST', '/content/batch/delete', { ids: [a.id, b.id] });
  assert.equal(res.status, 200);
  assertHistoryGone(a); assertHistoryGone(b);
});
