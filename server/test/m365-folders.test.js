'use strict';

/*
 * Microsoft 365 app + SharePoint/OneDrive folder sync (lib/m365.js, lib/cloud-folders.js,
 * routes/m365.js), against a mock tenant: token endpoint, Graph, and the file download host.
 *
 * What has to hold:
 *   - the client secret is stored encrypted and never comes back from the API; only org admins
 *     see or change the app
 *   - one token is fetched and reused until it is near expiry or the app changes
 *   - a sync adds images/videos as normal library items (Office files are skipped and counted),
 *     keeps a playlist of them in name order, and publishes it
 *   - a file changed upstream REPLACES its item: same id, new bytes, revision bumped
 *   - a file removed upstream leaves the playlist, and the library too unless something else uses it
 *   - a download link to a private address, or a Graph nextLink off graph.microsoft.com, is refused
 *   - a file over the server's size limit is skipped up front, not downloaded
 *   - only org owners/admins add a folder; editors sync existing ones
 *   - an incomplete listing (over the media cap) removes nothing; Office files do not count to the cap
 *   - a sync that loses its lease stops, and never clears the new holder's lease
 *   - a folder whose workspace is gone, or whose creator can no longer write there, is paused
 *   - content a video wall, a screen's default or an assignment uses is kept, not deleted
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-m365-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const m365 = require('../lib/m365');
const folders = require('../lib/cloud-folders');

/* ── tiny valid PNGs, so the real sniffer and thumbnailer accept them ───────────────────── */
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

/* ── the mock tenant ───────────────────────────────────────────────────────────────────── */
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'Q~super.secret.value.123';
const SHARE = 'https://contoso.sharepoint.com/:f:/s/Lobby/EabcSharedFolderLink';
const DRIVE = 'b!drive1';
const FOLDER = 'folder1';
let tokenCalls = 0;
let files;            // remote id -> { name, bytes, tag, mime, size? , downloadUrl? }
let nextLinkOverride = null;

function resetFiles() {
  files = {
    a: { name: 'b-second.png', bytes: png(4, 3, [255, 0, 0]), tag: 'c1', mime: 'image/png' },
    b: { name: 'a-first.png', bytes: png(3, 4, [0, 0, 255]), tag: 'c1', mime: 'image/png' },
    p: { name: 'Lobby deck.pptx', bytes: Buffer.from('not media'), tag: 'c1', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function mockFetch(url, opts = {}) {
  const u = new URL(url);
  if (u.origin === 'https://login.microsoftonline.com') {
    assert.equal(u.pathname, `/${TENANT}/oauth2/v2.0/token`);
    const body = new URLSearchParams(opts.body);
    if (body.get('client_secret') !== SECRET) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
    tokenCalls++;
    return json(200, { access_token: `tok${tokenCalls}`, expires_in: 3599, token_type: 'Bearer' });
  }
  if (u.origin === 'https://graph.microsoft.com') {
    assert.match(opts.headers.Authorization, /^Bearer tok\d+$/);
    const p = decodeURIComponent(u.pathname);
    if (p === `/v1.0/shares/${m365.shareIdFor(SHARE)}/driveItem`) return json(200, { id: FOLDER, name: 'Lobby screens', folder: { childCount: 3 }, webUrl: 'https://contoso.sharepoint.com/sites/Lobby/Shared', parentReference: { driveId: DRIVE } });
    if (p === `/v1.0/drives/${DRIVE}/items/${FOLDER}/children`) {
      const value = Object.entries(files).map(([id, f]) => ({ id, name: f.name, size: f.size ?? f.bytes.length, cTag: f.tag, file: { mimeType: f.mime } }));
      value.push({ id: 'sub', name: 'Archive', folder: { childCount: 9 } });
      return json(200, { value, ...(nextLinkOverride ? { '@odata.nextLink': nextLinkOverride } : {}) });
    }
    const m = /^\/v1\.0\/drives\/[^/]+\/items\/([^/]+)$/.exec(p);
    if (m && files[m[1]]) return json(200, { id: m[1], name: files[m[1]].name, size: files[m[1]].bytes.length, '@microsoft.graph.downloadUrl': files[m[1]].downloadUrl || `https://contoso.sharepoint.com/_layouts/15/download.aspx?id=${m[1]}&tag=${files[m[1]].tag}` });
    return json(404, { error: { code: 'itemNotFound' } });
  }
  if (u.hostname === 'contoso.sharepoint.com' && u.pathname === '/_layouts/15/download.aspx') {
    const f = files[u.searchParams.get('id')];
    if (f.onDownload) f.onDownload();
    return new Response(f.bytes, { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
}

/* ── fixture ───────────────────────────────────────────────────────────────────────────── */
const O = 'o-m365', WS = 'ws-m365', ADMIN = 'u-m365-admin', EDITOR = 'u-m365-ed';
let server, base;
const tok = {};
const call = (who, method, p, body) => fetch(`${base}/api/m365${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, 'X-Workspace-Id': WS },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), raw: r }));

before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'm365admin@t.local', 'x', 'user'), (?, 'm365ed@t.local', 'x', 'user')").run(ADMIN, EDITOR);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Contoso', ADMIN);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(O, ADMIN);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'Lobby');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_editor')").run(WS, ADMIN, WS, EDITOR);
  for (const u of [ADMIN, EDITOR]) tok[u === ADMIN ? 'admin' : 'editor'] = generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(u), WS);
  resetFiles();
  m365._setFetch(mockFetch);
  const app = express();
  app.use(express.json());
  app.use('/api/m365', requireAuth, resolveTenancy, require('../routes/m365'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { m365._setFetch(null); try { server.close(); } catch { /* */ } });

test('the app: org admins only, secret encrypted at rest and never returned', async () => {
  assert.equal((await call('editor', 'PUT', '/app', { tenant_id: TENANT, client_id: CLIENT, client_secret: SECRET })).status, 403);
  assert.equal((await call('admin', 'PUT', '/app', { tenant_id: 'common', client_id: CLIENT, client_secret: SECRET })).status, 400, 'a multi-tenant endpoint is refused');
  assert.equal((await call('admin', 'PUT', '/app', { tenant_id: TENANT, client_id: 'not-a-guid', client_secret: SECRET })).status, 400);
  const r = await call('admin', 'PUT', '/app', { tenant_id: TENANT, client_id: CLIENT, client_secret: SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.has_client_secret, true);
  const row = db.prepare('SELECT client_secret_enc FROM org_m365_apps WHERE organization_id = ?').get(O);
  assert.ok(row.client_secret_enc && !row.client_secret_enc.includes(SECRET), 'stored encrypted');
  for (const who of ['admin', 'editor']) {
    const g = await call(who, 'GET', '/app');
    assert.ok(!JSON.stringify(g.body).includes(SECRET), `${who} never sees the secret`);
  }
  assert.deepEqual((await call('editor', 'GET', '/app')).body, { configured: true, can_manage: false }, 'a member learns only that it is set up');
  // A save without the secret keeps it.
  assert.equal((await call('admin', 'PUT', '/app', { tenant_id: TENANT, client_id: CLIENT })).body.has_client_secret, true);
  const t = await call('admin', 'POST', '/app/test');
  assert.deepEqual(t.body, { ok: true, error: null });
});

test('a wrong secret fails the test with Microsoft\'s reason, and no secret in it', async () => {
  await call('admin', 'PUT', '/app', { client_secret: 'Q~wrong.secret.value' });
  const t = await call('admin', 'POST', '/app/test');
  assert.equal(t.body.ok, false);
  assert.match(t.body.error, /AADSTS7000215/);
  assert.ok(!t.body.error.includes('wrong.secret'));
  await call('admin', 'PUT', '/app', { client_secret: SECRET });
});

test('one token, reused until the app changes', async () => {
  m365._setFetch(mockFetch);
  const before = tokenCalls;
  await m365.graphGet(O, `/shares/${m365.shareIdFor(SHARE)}/driveItem`);
  await m365.graphGet(O, `/shares/${m365.shareIdFor(SHARE)}/driveItem`);
  assert.equal(tokenCalls - before, 1);
  db.prepare('UPDATE org_m365_apps SET updated_at = updated_at + 5 WHERE organization_id = ?').run(O);
  await m365.graphGet(O, `/shares/${m365.shareIdFor(SHARE)}/driveItem`);
  assert.equal(tokenCalls - before, 2, 'an edited app gets a fresh token');
});

let folderId, playlistId;
const playlistNames = () => db.prepare(`SELECT c.filename FROM playlist_items pi JOIN content c ON c.id = pi.content_id
  WHERE pi.playlist_id = ? ORDER BY pi.sort_order`).all(playlistId).map((r) => r.filename);

test('adding a folder syncs its media into the library and a published playlist, in name order', async () => {
  assert.equal((await call('editor', 'POST', '/folders', { share_url: SHARE })).status, 403, 'an editor cannot choose what is synced');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cloud_folders').get().n, 0);
  assert.equal((await call('admin', 'POST', '/folders', { share_url: 'https://evil.example/x' })).status, 400);
  const r = await call('admin', 'POST', '/folders', { share_url: SHARE, default_duration_sec: 12 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  folderId = r.body.id;
  assert.equal(r.body.name, 'Lobby screens', 'named after the folder');
  // The first sync runs in the background from the create; take part only once it is done.
  for (let i = 0; i < 100 && !db.prepare('SELECT last_sync_at FROM cloud_folders WHERE id = ?').get(folderId).last_sync_at; i++) await new Promise((res) => setTimeout(res, 50));
  const row = db.prepare('SELECT * FROM cloud_folders WHERE id = ?').get(folderId);
  const summary = JSON.parse(row.last_summary);
  assert.equal(row.last_status, 'ok', row.last_error || row.last_summary);
  assert.equal(summary.added, 2);
  assert.equal(summary.skipped_other, 1, 'the PowerPoint is counted, not synced');
  assert.equal(summary.playlist, 'published');
  playlistId = row.playlist_id;
  assert.deepEqual(playlistNames(), ['a-first.png', 'b-second.png']);
  assert.equal(db.prepare('SELECT duration_sec FROM playlist_items WHERE playlist_id = ? LIMIT 1').get(playlistId).duration_sec, 12);
  assert.ok(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId).published_snapshot, 'published');
  const list = await call('editor', 'GET', '/folders');
  assert.equal(list.body[0].file_count, 2);
});

test('a file changed upstream replaces its item: same id, new bytes, revision bumped', async () => {
  const map = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'a'").get(folderId);
  const beforeRow = db.prepare('SELECT * FROM content WHERE id = ?').get(map.content_id);
  files.a = { ...files.a, bytes: png(8, 6, [0, 255, 0]), tag: 'c2' };
  const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.updated, 1);
  assert.equal(r.body.summary.unchanged, 1);
  const afterRow = db.prepare('SELECT * FROM content WHERE id = ?').get(map.content_id);
  assert.ok(afterRow, 'same id');
  assert.ok(afterRow.updated_at > beforeRow.updated_at, 'revision bumped');
  assert.notEqual(afterRow.byte_digest, beforeRow.byte_digest, 'new bytes');
  assert.equal(afterRow.width, 8);
});

test('a file head office mandates is not rewritten by a sync its creator could not make', async () => {
  // The same rule as the Canva sync (lib/content-replace.js `writer`): a store editor's folder must
  // not change media that head office now plays in a corporate playlist.
  const map = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'a'").get(folderId);
  const before = db.prepare('SELECT updated_at, byte_digest FROM content WHERE id = ?').get(map.content_id);
  const owner = db.prepare('SELECT user_id FROM cloud_folders WHERE id = ?').get(folderId).user_id;
  db.prepare('UPDATE cloud_folders SET user_id = ? WHERE id = ?').run(EDITOR, folderId);
  db.prepare('UPDATE playlists SET corporate = 1 WHERE id = ?').run(playlistId);
  const prevA = files.a;
  files.a = { ...files.a, bytes: png(5, 5, [1, 2, 3]), tag: 'c-corp' };
  try {
    const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.summary.updated, 0, JSON.stringify(r.body.summary));
    assert.ok(r.body.summary.errors.some((e) => e.startsWith(files.a.name)), JSON.stringify(r.body.summary.errors));
    assert.deepEqual(db.prepare('SELECT updated_at, byte_digest FROM content WHERE id = ?').get(map.content_id), before, 'bytes untouched');
    // The org owner may author corporate media, so their folder still syncs the change.
    db.prepare('UPDATE cloud_folders SET user_id = ? WHERE id = ?').run(ADMIN, folderId);
    const ok = await call('admin', 'POST', `/folders/${folderId}/sync`);
    assert.equal(ok.body.summary.updated, 1, JSON.stringify(ok.body.summary));
  } finally {
    db.prepare('UPDATE playlists SET corporate = 0 WHERE id = ?').run(playlistId);
    db.prepare('UPDATE cloud_folders SET user_id = ? WHERE id = ?').run(owner, folderId);
    files.a = { ...prevA, tag: 'c-corp' };   // stay in step with what is now synced
  }
});

test('a file removed upstream leaves the playlist and the library; one used elsewhere is kept', async () => {
  const bId = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'b'").get(folderId).content_id;
  const aId = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'a'").get(folderId).content_id;
  // b is also in a hand-made playlist, so it must survive leaving the folder.
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('pl-hand', ?, ?, 'Hand made')").run(ADMIN, WS);
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES ('pl-hand', ?, 0)").run(bId);
  delete files.a; delete files.b;
  files.c = { name: 'c-third.png', bytes: png(2, 2, [9, 9, 9]), tag: 'c1', mime: 'image/png' };
  const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r.body.summary.removed, 2);
  assert.equal(r.body.summary.added, 1);
  assert.equal(r.body.summary.kept, 1);
  assert.deepEqual(playlistNames(), ['c-third.png']);
  assert.equal(db.prepare('SELECT id FROM content WHERE id = ?').get(aId), undefined, 'unused elsewhere: deleted');
  assert.ok(db.prepare('SELECT id FROM content WHERE id = ?').get(bId), 'used elsewhere: kept');
});

test('SSRF: a download link to a private address, or a nextLink off Graph, is refused', async () => {
  for (const u of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'http://contoso.sharepoint.com/x', 'https://169.254.169.254/latest']) {
    assert.throws(() => m365.checkDownloadUrl(u), (e) => e.code === 'ssrf_refused', u);
  }
  files.d = { name: 'd.png', bytes: png(2, 2, [1, 2, 3]), tag: 'c1', mime: 'image/png', downloadUrl: 'https://192.168.1.10/steal' };
  const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r.body.status, 'partial');
  assert.equal(r.body.summary.failed, 1);
  assert.match(r.body.summary.errors.join(' '), /private address/);
  delete files.d;

  nextLinkOverride = 'https://evil.example/v1.0/drives/x/children?page=2';
  const n = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(n.body.status, 'error');
  assert.match(n.body.error, /not on graph\.microsoft\.com/);
  nextLinkOverride = null;
});

test('a file over the server limit is skipped before it is downloaded', async () => {
  const cap = config.maxFileSize;
  config.maxFileSize = 1000;
  files.big = { name: 'huge.png', bytes: png(2, 2, [5, 5, 5]), tag: 'c1', mime: 'image/png', size: 5000 };
  try {
    const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
    assert.equal(r.body.summary.skipped_too_large, 1);
    assert.match(r.body.summary.errors.join(' '), /huge\.png: larger than this server accepts/);
    assert.equal(db.prepare("SELECT 1 x FROM cloud_folder_items WHERE remote_id = 'big'").get(), undefined);
  } finally { config.maxFileSize = cap; delete files.big; }
});

test('a listing over the media cap removes nothing; Office files do not count towards it', async () => {
  const cId = db.prepare("SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'c'").get(folderId).content_id;
  const keep = files;
  // 300 PowerPoints, then a new image, then the already-synced c.
  files = {};
  for (let i = 0; i < 300; i++) files[`p${i}`] = { name: `deck ${i}.pptx`, bytes: Buffer.from('x'), tag: 'c1', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  files.n0 = { name: 'n0-new.png', bytes: png(2, 2, [7, 7, 7]), tag: 'c1', mime: 'image/png' };
  files.c = keep.c;
  try {
    folders._setMaxFiles(1);
    const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.summary.listing_complete, false);
    assert.equal(r.body.summary.added, 1, 'the first media file is still synced');
    assert.equal(r.body.summary.removed, 0, 'c is past the cut-off, not gone');
    assert.match(r.body.summary.errors.join(' '), /nothing is removed/);
    assert.ok(db.prepare("SELECT 1 x FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'c'").get(folderId));
    assert.ok(db.prepare('SELECT id FROM content WHERE id = ?').get(cId), 'not retired');

    folders._setMaxFiles(2);
    const r2 = await call('editor', 'POST', `/folders/${folderId}/sync`);
    assert.equal(r2.body.summary.listing_complete, true, '300 Office files do not use up a cap of 2');
    assert.equal(r2.body.summary.skipped_other, 300);
    assert.equal(r2.body.summary.removed, 0);
    assert.equal(r2.body.summary.unchanged, 2);
  } finally {
    folders._setMaxFiles(500);
    files = keep;
  }
  // A complete listing again: n0 left the folder, so it goes.
  const r3 = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r3.body.summary.removed, 1);
  assert.deepEqual(playlistNames(), ['c-third.png']);
});

test('a sync that loses its lease stops, and leaves the new holder\'s lease alone', async () => {
  const OTHER = Math.floor(Date.now() / 1000) + 3600;
  // Held elsewhere: refused.
  db.prepare('UPDATE cloud_folders SET sync_lease_until = ? WHERE id = ?').run(OTHER, folderId);
  assert.equal((await call('editor', 'POST', `/folders/${folderId}/sync`)).status, 409);
  db.prepare('UPDATE cloud_folders SET sync_lease_until = NULL WHERE id = ?').run(folderId);

  const before = db.prepare('SELECT last_sync_at, last_summary FROM cloud_folders WHERE id = ?').get(folderId);
  // Mid-download, our lease "runs out" and another node takes the folder.
  files.e = { name: 'e.png', bytes: png(2, 2, [4, 4, 4]), tag: 'c1', mime: 'image/png',
    onDownload: () => db.prepare('UPDATE cloud_folders SET sync_lease_until = ? WHERE id = ?').run(OTHER, folderId) };
  files.f = { name: 'f.png', bytes: png(2, 2, [6, 6, 6]), tag: 'c1', mime: 'image/png' };
  try {
    const out = await folders.syncFolder(folderId, { trigger: 'manual' });
    assert.equal(out.status, 'error');
    assert.match(out.error, /another server took the folder over/);
    const row = db.prepare('SELECT sync_lease_until, last_sync_at, last_summary FROM cloud_folders WHERE id = ?').get(folderId);
    assert.equal(row.sync_lease_until, OTHER, 'the new holder\'s lease is not cleared');
    assert.equal(row.last_summary, before.last_summary, 'nor its outcome written over');
    assert.equal(db.prepare("SELECT 1 x FROM cloud_folder_items WHERE folder_id = ? AND remote_id = 'f'").get(folderId), undefined, 'it stopped at the next file');
  } finally {
    db.prepare('UPDATE cloud_folders SET sync_lease_until = NULL WHERE id = ?').run(folderId);
    delete files.e; delete files.f;
  }
  const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r.body.summary.removed, 1, 'e goes again on the next full sync');
  assert.deepEqual(playlistNames(), ['c-third.png']);
});

test('a folder whose workspace is gone, or whose creator can no longer write there, is paused', async () => {
  const mk = (id, ws, user) => db.prepare(`INSERT INTO cloud_folders (id, workspace_id, organization_id, user_id, name, share_url, drive_id, item_id, auto_playlist)
    VALUES (?, ?, ?, ?, 'x', ?, ?, ?, 0)`).run(id, ws, O, user, SHARE, DRIVE, FOLDER);
  const GONE = 'u-m365-gone';
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'm365gone@t.local', 'x', 'user')").run(GONE);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(WS, GONE);
  // A folder left behind by a workspace delete that did not cascade to it.
  db.exec('PRAGMA foreign_keys = OFF');
  try { mk('cf-orphan', 'ws-deleted', ADMIN); } finally { db.exec('PRAGMA foreign_keys = ON'); }
  mk('cf-viewer', WS, GONE);
  try {
    for (const [id, re] of [['cf-orphan', /workspace no longer exists/], ['cf-viewer', /can no longer edit this workspace/]]) {
      const out = await folders.syncFolder(id);
      assert.equal(out.status, 'error');
      assert.match(out.error, re);
      const row = db.prepare('SELECT enabled, last_error, sync_lease_until FROM cloud_folders WHERE id = ?').get(id);
      assert.equal(row.enabled, 0, `${id} paused`);
      assert.match(row.last_error, re);
      assert.equal(row.sync_lease_until, null);
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM cloud_folder_items WHERE folder_id IN ('cf-orphan','cf-viewer')").get().n, 0, 'nothing synced');
  } finally {
    db.prepare("DELETE FROM cloud_folders WHERE id IN ('cf-orphan','cf-viewer')").run();
    db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(GONE);
  }
});

test('content a video wall, a screen default or an assignment uses is kept when its file leaves', async () => {
  const uses = [
    ['w', (cid) => db.prepare("INSERT INTO video_walls (id, user_id, workspace_id, name, content_id) VALUES ('vw-m365', ?, ?, 'Wall', ?)").run(ADMIN, WS, cid)],
    ['d', (cid) => db.prepare("INSERT INTO devices (id, user_id, workspace_id, default_content_id) VALUES ('dev-m365', ?, ?, ?)").run(ADMIN, WS, cid)],
    ['s', (cid) => db.prepare("INSERT INTO assignments (device_id, content_id) VALUES ('dev-m365', ?)").run(cid)],
  ];
  for (const [id] of uses) files[id] = { name: `${id}-used.png`, bytes: png(2, 2, [id.charCodeAt(0), 1, 1]), tag: 'c1', mime: 'image/png' };
  const r = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r.body.summary.added, 3, JSON.stringify(r.body));
  const ids = {};
  for (const [id, use] of uses) { ids[id] = db.prepare('SELECT content_id FROM cloud_folder_items WHERE folder_id = ? AND remote_id = ?').get(folderId, id).content_id; use(ids[id]); }
  for (const [id] of uses) delete files[id];
  const r2 = await call('editor', 'POST', `/folders/${folderId}/sync`);
  assert.equal(r2.body.summary.removed, 3);
  assert.equal(r2.body.summary.kept, 3);
  for (const [id] of uses) assert.ok(db.prepare('SELECT id FROM content WHERE id = ?').get(ids[id]), `${id}: kept`);
  assert.deepEqual(playlistNames(), ['c-third.png']);
});

test('removing the sync keeps the library items and the playlist', async () => {
  const r = await call('editor', 'DELETE', `/folders/${folderId}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cloud_folders').get().n, 0);
  assert.deepEqual(playlistNames(), ['c-third.png']);
});
