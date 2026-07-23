'use strict';

// #212 multi-file upload. POST /api/content now accepts N files under the `files` field
// (one request instead of N), while still accepting the legacy single `file` field.
// Exercises the real router + multer over HTTP.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-multiup-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');

// A minimal valid PNG (8-byte signature + padding) — enough to pass the mime filter.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]);

let server, base;
const USER = 'u-multiup';

// Build a multipart/form-data body from field parts. Each file part: {field, filename, data}.
function multipart(fileParts) {
  const boundary = '----st' + crypto.randomBytes(8).toString('hex');
  const chunks = [];
  for (const f of fileParts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
      `Content-Type: image/png\r\n\r\n`));
    chunks.push(f.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

function post(fileParts) {
  const { body, boundary } = multipart(fileParts);
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  // The fresh DATA_DIR has no uploads/content dir (the real app creates it at boot);
  // multer's diskStorage would ENOENT without it.
  fs.mkdirSync(require('../config').contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');
  // content.workspace_id -> workspaces.id -> organizations.id are real FKs, so seed the chain.
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-multiup', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-multiup', 'org-multiup', 'WS')").run();
  const app = express();
  app.use((req, _res, next) => { req.workspaceId = 'ws-multiup'; req.user = { id: USER, role: 'admin' }; next(); });
  app.use('/', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('multiple files under `files` create one content row each and return an array', async () => {
  const r = await post([
    { field: 'files', filename: 'a.png', data: PNG },
    { field: 'files', filename: 'b.png', data: PNG },
    { field: 'files', filename: 'c.png', data: PNG },
  ]);
  assert.equal(r.status, 201);
  assert.ok(Array.isArray(r.json), 'batch upload returns an array');
  assert.equal(r.json.length, 3);
  const rows = db.prepare("SELECT filename FROM content WHERE workspace_id = 'ws-multiup'").all().map((x) => x.filename);
  for (const n of ['a.png', 'b.png', 'c.png']) assert.ok(rows.includes(n), `${n} was ingested`);
});

test('legacy single `file` field still returns a single content object', async () => {
  const r = await post([{ field: 'file', filename: 'legacy.png', data: PNG }]);
  assert.equal(r.status, 201);
  assert.ok(!Array.isArray(r.json), 'single legacy upload returns an object, not an array');
  assert.equal(r.json.filename, 'legacy.png');
});

test('a single file under `files` also returns a single object (shape parity)', async () => {
  const r = await post([{ field: 'files', filename: 'one.png', data: PNG }]);
  assert.equal(r.status, 201);
  assert.ok(!Array.isArray(r.json));
  assert.equal(r.json.filename, 'one.png');
});

test('no files -> 400', async () => {
  const r = await post([]);
  assert.equal(r.status, 400);
});
