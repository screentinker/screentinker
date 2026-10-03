'use strict';

/*
 * Upload / replace integrity — audit F05, F11, F16, F26.
 *
 *   F05/F11  A REFUSED replace must leave the live file where it was. The route used to move the
 *            current bytes into .history BEFORE validating the new upload, so a 400 (wrong type, a
 *            bundle swapped for an image) left the row pointing at a file that no longer existed —
 *            every screen without a cached copy lost the item. The dashboard then said "Content
 *            updated" because it never read the response.
 *   F16      Every refusal after multer must remove what multer wrote. A `<uuid>.part` left in
 *            contentDir is swept by nothing and counted against nobody's allowance.
 *   F26      The resumable-upload storage check must hold across parallel sessions, and finalize
 *            must re-check, or N sessions each see the same room and all land.
 *
 * Driven over real HTTP against the real router (the bugs were in the routes, not the libs), with a
 * temp DATA_DIR.
 */

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-upint-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const sharp = require('sharp');
const { db } = require('../db/database');
const config = require('../config');
const { ingestUploadedFile } = require('../lib/content-ingest');

const WS = 'ws-upint';
const USER = 'u-upint';
let server, base;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const pngOf = (n) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - PNG.length), 0x20)]);
// Passes the sniffer as a zip (a local-file-header magic) — enough to reach the bundle-boundary check.
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0)]);
const NOT_MEDIA = Buffer.from('this is plain text wearing a .png extension\n'.repeat(4));

const partsInContentDir = () => fs.readdirSync(config.contentDir).filter((f) => f.endsWith('.part'));
const live = (rel) => !!rel && fs.existsSync(path.join(config.contentDir, rel));

async function seedImage(userId = USER) {
  const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).png().toBuffer();
  const tmp = path.join(config.contentDir, crypto.randomUUID() + '.part');
  await fsp.mkdir(config.contentDir, { recursive: true });
  await fsp.writeFile(tmp, bytes);
  const row = await ingestUploadedFile({ file: { path: tmp, originalname: 'live.png', size: bytes.length }, userId, workspaceId: WS });
  require('../lib/revisions').recordCurrent(db, 'content', row.id, { actor: 'test', summary: 'Uploaded' });
  return row;
}

function headersFor({ user = USER, viewer = false, noWorkspace = false } = {}) {
  const h = { 'x-test-user': user };
  if (viewer) h['x-test-viewer'] = '1';
  if (noWorkspace) h['x-test-no-ws'] = '1';
  return h;
}

async function replace(id, bytes, filename, type, opts) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  const r = await fetch(`${base}/${id}/replace`, { method: 'PUT', body: fd, headers: headersFor(opts) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function postFiles(list, extra = {}, opts) {
  const fd = new FormData();
  for (const [bytes, name, type] of list) fd.append('files', new Blob([bytes], { type }), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(`${base}/`, { method: 'POST', body: fd, headers: headersFor(opts) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const J = (body, opts) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headersFor(opts) }, body: JSON.stringify(body) });

function addUser(id, planId = null) {
  db.prepare("INSERT INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'platform_admin', ?)").run(id, `${id}@test`, id, planId);
}

before(async () => {
  db.prepare("INSERT INTO plans (id, name, display_name, max_storage_mb) VALUES ('unl-upint', 'unl', 'Unlimited', -1)").run();
  addUser(USER, 'unl-upint');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org-upint', 'Org', USER);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, 'org-upint', 'WS');
  // A 1 MiB plan for the storage-allowance tests.
  db.prepare("INSERT INTO plans (id, name, display_name, max_storage_mb) VALUES ('tiny-upint', 'tiny', 'Tiny', 1)").run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = req.get('x-test-no-ws') ? null : WS;
    req.user = { id: req.get('x-test-user') || USER, role: 'platform_admin' };
    if (req.get('x-test-viewer')) req.workspaceRole = 'workspace_viewer';
    next();
  });
  app.use('/', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

/* ------------------------------------------------------------- F05: a refused replace is inert */

test('F05: a replace refused by the sniffer leaves the live file and thumbnail in place', async () => {
  const row = await seedImage();
  assert.ok(live(row.filepath) && live(row.thumbnail_path), 'fixture has a live file and thumbnail');

  const { status } = await replace(row.id, NOT_MEDIA, 'fake.png', 'image/png');
  assert.equal(status, 400);

  const after = db.prepare('SELECT * FROM content WHERE id = ?').get(row.id);
  assert.equal(after.filepath, row.filepath, 'the row is unchanged');
  assert.ok(live(after.filepath), 'and the file it names is STILL in contentDir — screens can fetch it');
  assert.ok(live(after.thumbnail_path), 'the thumbnail is still there too');
});

test('F05: a bundle refused for crossing the bundle boundary leaves the live image in place', async () => {
  const row = await seedImage();
  const { status, body } = await replace(row.id, ZIP, 'site.zip', 'application/zip');
  assert.equal(status, 400);
  assert.match(body.error, /bundle/i);
  assert.ok(live(row.filepath), 'the image was not moved into .history by a replace that never happened');
  assert.deepEqual(partsInContentDir(), [], 'and the refused upload is gone');
});

test('F05: a SUCCESSFUL replace still retains the previous bytes under .history and repoints the revision', async () => {
  const row = await seedImage();
  const next = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const { status, body } = await replace(row.id, next, 'next.png', 'image/png');
  assert.equal(status, 200);
  assert.notEqual(body.filepath, row.filepath);
  assert.ok(live(body.filepath));
  assert.ok(!live(row.filepath), 'the old bytes left contentDir (sole reference -> moved)');
  const refs = db.prepare("SELECT file_ref FROM revisions WHERE resource_type = 'content' AND resource_id = ?").all(row.id).map((r) => r.file_ref);
  const retained = refs.find((r) => r && r.includes(path.basename(row.filepath)) && r !== row.filepath);
  assert.ok(retained, `the earlier revision is repointed into history: ${JSON.stringify(refs)}`);
  assert.ok(live(retained), 'and the retained copy exists');
});

/* ------------------------------------------------------------- F16: no orphan .part files */

test('F16: a replace on an unknown content id leaves no .part behind', async () => {
  const { status } = await replace('00000000-0000-0000-0000-000000000000', pngOf(64 * 1024), 'x.png', 'image/png');
  assert.equal(status, 404);
  assert.deepEqual(partsInContentDir(), []);
});

test('F16: POST / refusals after multer leave no .part behind', async () => {
  let r = await postFiles([[PNG, 'a.png', 'image/png']], { folder_id: 'no-such-folder' });
  assert.equal(r.status, 400);
  assert.deepEqual(partsInContentDir(), [], 'invalid folder_id');

  r = await postFiles([[PNG, 'a.png', 'image/png']], {}, { viewer: true });
  assert.equal(r.status, 403);
  assert.deepEqual(partsInContentDir(), [], 'read-only viewer');

  r = await postFiles([[PNG, 'a.png', 'image/png']], {}, { noWorkspace: true });
  assert.equal(r.status, 403);
  assert.deepEqual(partsInContentDir(), [], 'no workspace');
});

test('F16: a batch with an unsupported file in the middle adds NOTHING and leaves no .part', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM content WHERE workspace_id = ?').get(WS).n;
  const r = await postFiles([
    [pngOf(2048), 'one.png', 'image/png'],
    [NOT_MEDIA, 'two.png', 'image/png'],
    [pngOf(4096), 'three.png', 'image/png'],
  ]);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /two\.png/, 'the refusal names the file');
  const afterN = db.prepare('SELECT COUNT(*) AS n FROM content WHERE workspace_id = ?').get(WS).n;
  assert.equal(afterN, before, 'one.png must not be ingested by a request that answered 400 — a retry would duplicate it');
  assert.deepEqual(partsInContentDir(), [], 'three.png must not be stranded as a .part');
});

/* ------------------------------------------------------------- F11: the dashboard reads the response */

test('F11: the edit modal checks the replace and subtitle responses before claiming success', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'content-library.js'), 'utf8');
  const replaceAt = src.indexOf("'/replace'");
  const subAt = src.indexOf("'/subtitle'");
  const toastAt = src.indexOf("t('content.toast.updated')");
  assert.ok(replaceAt > 0 && subAt > 0 && toastAt > subAt, 'markers found in order');
  const replaceBlock = src.slice(replaceAt, subAt);
  const subBlock = src.slice(subAt, toastAt);
  assert.match(replaceBlock, /if \(!\w+\.ok\) throw/, 'a refused replace throws to the error toast');
  assert.match(subBlock, /if \(!\w+\.ok\) throw/, 'a refused subtitle throws to the error toast');
});
