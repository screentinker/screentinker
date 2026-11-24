'use strict';

/*
 * Google Drive folder sync (lib/gdrive.js, lib/cloud-folders.js provider 'google', routes/m365.js
 * /google/app), against a mock Google: the OAuth token endpoint (which checks the service account's
 * JWT signature), the Drive v3 API, and googleusercontent.com for a handed-off download.
 *
 * What has to hold:
 *   - the service account key is stored encrypted and never comes back; only org admins see or change it
 *   - the token request is a JWT signed by the pasted key, for drive.readonly, sent to Google's fixed host
 *   - only drive.google.com folder links are accepted; a file link is refused
 *   - a sync adds media (Google Docs/Sheets/Slides and other files are skipped and counted), keeps a
 *     playlist in name order, replaces a changed file in place (same id), and removes a deleted one
 *   - a download Drive hands off goes only to googleusercontent.com, without the token
 *   - a SharePoint folder in the same workspace still syncs through Microsoft (provider dispatch)
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-gdrive-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const gdrive = require('../lib/gdrive');
const folders = require('../lib/cloud-folders');

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/* ── the mock Google ───────────────────────────────────────────────────────────────────── */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA_EMAIL = 'screens@lobby-project.iam.gserviceaccount.com';
const KEY_JSON = JSON.stringify({ type: 'service_account', project_id: 'lobby-project', private_key_id: 'k1', private_key: PEM, client_email: SA_EMAIL, token_uri: 'https://evil.example/token' });
const FOLDER = '1AbCdEfGhIjKlMnOpQrStUv';
const LINK = `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`;
let tokenCalls = 0;
let files;
const seen = { authOnUsercontent: null };

function resetFiles() {
  files = {
    fileAAAAAAAAAA: { name: 'b-second.png', bytes: png(4, 3, [255, 0, 0]), md5: 'm1', mime: 'image/png' },
    fileBBBBBBBBBB: { name: 'a-first.png', bytes: png(3, 4, [0, 0, 255]), md5: 'm1', mime: 'image/png', handoff: true },
    docCCCCCCCCCCC: { name: 'Lobby deck', mime: 'application/vnd.google-apps.presentation' },
    pdfDDDDDDDDDDD: { name: 'menu.pdf', bytes: Buffer.from('%PDF'), md5: 'm1', mime: 'application/pdf' },
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function mockFetch(url, opts = {}) {
  const u = new URL(url);
  if (url === gdrive.TOKEN_URL) {
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = body.get('assertion').split('.');
    const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (!ok) return json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    assert.equal(claims.iss, SA_EMAIL);
    assert.equal(claims.aud, gdrive.TOKEN_URL);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
    tokenCalls++;
    return json(200, { access_token: `gtok${tokenCalls}`, expires_in: 3599, token_type: 'Bearer' });
  }
  if (u.origin === 'https://www.googleapis.com') {
    assert.match(opts.headers.Authorization, /^Bearer gtok\d+$/);
    if (u.pathname === `/drive/v3/files/${FOLDER}`) return json(200, { id: FOLDER, name: 'Lobby screens', mimeType: gdrive.FOLDER_MIME, webViewLink: `https://drive.google.com/drive/folders/${FOLDER}` });
    if (u.pathname === '/drive/v3/files/fileAAAAAAAAAA' && !u.searchParams.has('alt')) return json(200, { id: 'fileAAAAAAAAAA', name: 'b-second.png', mimeType: 'image/png' });
    if (u.pathname === '/drive/v3/files') {
      assert.equal(u.searchParams.get('q'), `'${FOLDER}' in parents and trashed = false`);
      const list = Object.entries(files).map(([id, f]) => ({ id, name: f.name, mimeType: f.mime, ...(f.bytes ? { size: String(f.bytes.length), md5Checksum: f.md5 } : {}) }));
      list.push({ id: 'subEEEEEEEEEEE', name: 'Archive', mimeType: gdrive.FOLDER_MIME });
      // Two pages, so paging is followed.
      const page = u.searchParams.get('pageToken');
      return page === 'p2' ? json(200, { files: list.slice(2) }) : json(200, { files: list.slice(0, 2), nextPageToken: 'p2' });
    }
    const m = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
    if (m && u.searchParams.get('alt') === 'media' && files[m[1]]) {
      const f = files[m[1]];
      if (f.handoff) return new Response(null, { status: 302, headers: { Location: f.handoffTo || `https://doc-0k-4s-docs.googleusercontent.com/docs/securesc/x/${m[1]}` } });
      return new Response(f.bytes, { status: 200 });
    }
    return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
  }
  if (u.hostname.endsWith('.googleusercontent.com')) {
    seen.authOnUsercontent = !!(opts.headers && opts.headers.Authorization);
    const id = u.pathname.split('/').pop();
    return new Response(files[id].bytes, { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
}

/* ── fixture ───────────────────────────────────────────────────────────────────────────── */
const O = 'o-gd', WS = 'ws-gd', ADMIN = 'u-gd-admin', EDITOR = 'u-gd-ed';
let server, base;
const tok = {};
const call = (who, method, p, body) => fetch(`${base}/api/m365${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, 'X-Workspace-Id': WS },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'gdadmin@t.local', 'x', 'user'), (?, 'gded@t.local', 'x', 'user')").run(ADMIN, EDITOR);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Lobby Co', ADMIN);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(O, ADMIN);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'Lobby');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_editor')").run(WS, ADMIN, WS, EDITOR);
  for (const u of [ADMIN, EDITOR]) tok[u === ADMIN ? 'admin' : 'editor'] = generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(u), WS);
  resetFiles();
  gdrive._setFetch(mockFetch);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/m365', requireAuth, resolveTenancy, require('../routes/m365'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { gdrive._setFetch(null); try { server.close(); } catch { /* */ } });

test('folder links: only Drive folder links, in their usual shapes', () => {
  for (const ok of [LINK, `https://drive.google.com/drive/u/1/folders/${FOLDER}`, `https://drive.google.com/open?id=${FOLDER}`]) {
    assert.equal(gdrive.folderIdFrom(ok), FOLDER, ok);
  }
  for (const bad of ['https://evil.example/drive/folders/' + FOLDER, 'http://drive.google.com/drive/folders/' + FOLDER,
    'https://docs.google.com/presentation/d/abc/edit', `https://drive.google.com/drive/folders/${FOLDER}'%20or%20'x`, 'not a url']) {
    assert.throws(() => gdrive.folderIdFrom(bad), /Drive folder link|Paste the folder/, bad);
  }
});

test('the service account: org admins only, key encrypted at rest and never returned', async () => {
  assert.equal((await call('editor', 'PUT', '/google/app', { service_account_json: KEY_JSON })).status, 403);
  assert.equal((await call('admin', 'PUT', '/google/app', { service_account_json: '{"type":"authorized_user"}' })).status, 400, 'not a service account key');
  const r = await call('admin', 'PUT', '/google/app', { service_account_json: KEY_JSON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.client_email, SA_EMAIL);
  assert.equal(r.body.has_private_key, true);
  const row = db.prepare('SELECT private_key_enc FROM org_google_drive WHERE organization_id = ?').get(O);
  assert.ok(row.private_key_enc && !row.private_key_enc.includes('PRIVATE KEY'), 'stored encrypted');
  for (const who of ['admin', 'editor']) assert.ok(!JSON.stringify((await call(who, 'GET', '/google/app')).body).includes('PRIVATE KEY'), `${who} never sees the key`);
  assert.deepEqual((await call('editor', 'GET', '/google/app')).body, { configured: true, can_manage: false });
  assert.equal((await call('admin', 'PUT', '/google/app', {})).body.has_private_key, true, 'a save without the key keeps it');
  assert.deepEqual((await call('admin', 'POST', '/google/app/test')).body, { ok: true, error: null }, 'a JWT signed by the key, accepted by Google');
});

test('one token, reused; a wrong key fails the test with Google\'s reason', async () => {
  gdrive.forgetToken(O);
  const before = tokenCalls;
  await gdrive.apiGet(O, `/files/${FOLDER}`);
  await gdrive.apiGet(O, `/files/${FOLDER}`);
  assert.equal(tokenCalls - before, 1);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await call('admin', 'PUT', '/google/app', { service_account_json: JSON.stringify({ type: 'service_account', private_key: other, client_email: SA_EMAIL }) });
  const t = await call('admin', 'POST', '/google/app/test');
  assert.equal(t.body.ok, false);
  assert.match(t.body.error, /Invalid JWT Signature/);
  await call('admin', 'PUT', '/google/app', { service_account_json: KEY_JSON });
});

let folderId, playlistId;
const playlistNames = () => db.prepare(`SELECT c.filename FROM playlist_items pi JOIN content c ON c.id = pi.content_id
  WHERE pi.playlist_id = ? ORDER BY pi.sort_order`).all(playlistId).map((r) => r.filename);
const waitSynced = async (id) => { for (let i = 0; i < 100 && !db.prepare('SELECT last_sync_at FROM cloud_folders WHERE id = ?').get(id).last_sync_at; i++) await new Promise((res) => setTimeout(res, 50)); };

test('adding a Drive folder syncs its media into the library and a published playlist', async () => {
  assert.equal((await call('editor', 'POST', '/folders', { provider: 'google', share_url: LINK })).status, 403);
  assert.equal((await call('admin', 'POST', '/folders', { provider: 'dropbox', share_url: LINK })).status, 400);
  assert.equal((await call('admin', 'POST', '/folders', { provider: 'google', share_url: 'https://contoso.sharepoint.com/:f:/s/x' })).status, 400);
  const fileLink = await call('admin', 'POST', '/folders', { provider: 'google', share_url: 'https://drive.google.com/drive/folders/fileAAAAAAAAAA' });
  assert.equal(fileLink.status, 400);
  assert.match(fileLink.body.error, /file, not a folder/);
  const r = await call('admin', 'POST', '/folders', { provider: 'google', share_url: LINK, default_duration_sec: 8 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  folderId = r.body.id;
  assert.equal(r.body.provider, 'google');
  assert.equal(r.body.name, 'Lobby screens');
  assert.equal(r.body.share_url, `https://drive.google.com/drive/folders/${FOLDER}`, 'stored in canonical form');
  await waitSynced(folderId);
  const row = db.prepare('SELECT * FROM cloud_folders WHERE id = ?').get(folderId);
  const s = JSON.parse(row.last_summary);
  assert.equal(row.last_status, 'ok', row.last_error || row.last_summary);
  assert.equal(s.added, 2);
  assert.equal(s.skipped_other, 2, 'the Google Slides deck and the PDF are counted, not synced');
  assert.equal(seen.authOnUsercontent, false, 'the handed-off download went without the token');
  playlistId = row.playlist_id;
  assert.deepEqual(playlistNames(), ['a-first.png', 'b-second.png']);
  assert.equal(db.prepare('SELECT duration_sec FROM playlist_items WHERE playlist_id = ? LIMIT 1').get(playlistId).duration_sec, 8);
});

test('a changed file replaces its item in place; a deleted one leaves', async () => {
  const before = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'fileAAAAAAAAAA'").get(folderId).content_id;
  files.fileAAAAAAAAAA = { ...files.fileAAAAAAAAAA, bytes: png(5, 5, [0, 255, 0]), md5: 'm2' };
  delete files.fileBBBBBBBBBB;
  const out = await folders.syncFolder(folderId, { trigger: 'manual' });
  assert.equal(out.status, 'ok', out.error);
  assert.equal(out.summary.updated, 1);
  assert.equal(out.summary.removed, 1);
  const after = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'fileAAAAAAAAAA'").get(folderId).content_id;
  assert.equal(after, before, 'same library item, new bytes');
  assert.deepEqual(playlistNames(), ['b-second.png']);
});

test('a hand-off to anywhere but googleusercontent.com is refused', async () => {
  files.fileFFFFFFFFFF = { name: 'c-third.png', bytes: png(2, 2, [9, 9, 9]), md5: 'm1', mime: 'image/png', handoff: true, handoffTo: 'https://127.0.0.1/steal' };
  const out = await folders.syncFolder(folderId, { trigger: 'manual' });
  assert.equal(out.summary.failed, 1);
  assert.match(out.summary.errors.join(' '), /googleusercontent/);
  delete files.fileFFFFFFFFFF;
  assert.throws(() => gdrive.checkDownloadUrl('https://evil.googleusercontent.com.example/x'), /googleusercontent/);
});

test('the engine still sends SharePoint folders to Microsoft', () => {
  assert.equal(folders.providerOf('m365'), require('../lib/m365'));
  assert.equal(folders.providerOf(undefined), require('../lib/m365'), 'rows from before providers default to Microsoft');
  assert.equal(folders.providerOf('google'), gdrive);
  assert.throws(() => folders.providerOf('dropbox'), /Unknown folder provider/);
});
