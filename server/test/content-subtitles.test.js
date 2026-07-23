'use strict';

// #216 subtitle/caption support. Two risky paths:
//   1. the 4 new content fields reach the player via buildSnapshotItems (enumerated query).
//   2. POST /:id/subtitle stores the .vtt and records subtitle_url + subtitle_lang.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-subs-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const { publishPlaylist } = require('../routes/playlists');

const uid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');
const USER = 'u-subs';

let server, base;

before(async () => {
  fs.mkdirSync(require('../config').contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');

  // Platform-admin stub + platform-template content (workspace_id NULL) so checkContentWrite
  // grants access without standing up full workspace membership — this test is about the
  // subtitle endpoint mechanics, not tenancy (covered elsewhere).
  const app = express();
  app.use((req, _res, next) => { req.workspaceId = 'ws-subs'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('published snapshot carries caption + subtitle fields to the player', () => {
  const c = uid('cap');
  db.prepare(`INSERT INTO content (id, filename, mime_type, captions_enabled, captions_lang, subtitle_url, subtitle_lang)
              VALUES (?, ?, 'video/youtube', 1, 'es', 'sub.vtt', 'fr')`).run(c, c);
  const pl = uid('pl');
  db.prepare("INSERT INTO playlists (id, user_id, name, status) VALUES (?, ?, 'P', 'draft')").run(pl, USER);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(pl, c);

  publishPlaylist(pl);
  const item = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl).published_snapshot)[0];
  assert.equal(item.captions_enabled, 1);
  assert.equal(item.captions_lang, 'es');
  assert.equal(item.subtitle_url, 'sub.vtt');
  assert.equal(item.subtitle_lang, 'fr');
});

test('POST /:id/subtitle stores the .vtt and records url + lang', async () => {
  const c = uid('vid');
  db.prepare("INSERT INTO content (id, filename, mime_type, filepath) VALUES (?, ?, 'video/mp4', 'v.mp4')").run(c, c);

  const boundary = '----st' + crypto.randomBytes(6).toString('hex');
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="subtitle_lang"\r\n\r\nfr\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="subtitle"; filename="cap.vtt"\r\nContent-Type: text/vtt\r\n\r\n`),
    Buffer.from(vtt), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/${c}/subtitle`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (r) => { let o = ''; r.on('data', (d) => (o += d)); r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(o) })); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(res.status, 200);
  assert.match(res.json.subtitle_url, /\.vtt$/);
  assert.equal(res.json.subtitle_lang, 'fr');
  // The file physically exists in the content dir and holds the cue text.
  const onDisk = path.join(require('../config').contentDir, res.json.subtitle_url);
  assert.ok(fs.existsSync(onDisk));
  assert.match(fs.readFileSync(onDisk, 'utf8'), /WEBVTT/);
});

test('a non-.vtt upload to /:id/subtitle is rejected', async () => {
  const c = uid('vid2');
  db.prepare("INSERT INTO content (id, filename, mime_type, filepath) VALUES (?, ?, 'video/mp4', 'v.mp4')").run(c, c);
  const boundary = '----st' + crypto.randomBytes(6).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="subtitle"; filename="notsub.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('nope'), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/${c}/subtitle`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (r) => { r.on('data', () => {}); r.on('end', () => resolve(r.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.notEqual(status, 200); // multer fileFilter rejects the .txt
});
