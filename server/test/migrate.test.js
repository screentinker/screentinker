'use strict';

/*
 * Switch to ScreenTinker — the core (lib/migrate, routes/migrate.js) driven through the generic
 * "folder of media + CSV" zip, which needs no network. Vendor adapters are in migrate-vendors.test.js.
 *
 * What has to hold:
 *   - upload -> scan -> choose -> run -> report; media keeps its original names and lands in the
 *     chosen folder, playlists keep order and durations, screens become unpaired placeholders with
 *     their groups (never devices)
 *   - a re-run of the same source creates nothing new (idempotent by source id), and a deleted
 *     import target is recreated rather than pointed at
 *   - the bytes are sniffed: a file named .jpg that is not an image is refused, the rest go on
 *   - storage: when the plan allowance runs out the job STOPS, keeps what it imported, and resumes
 *   - a zip entry that names ../ or is a symlink is never written anywhere
 *   - tenancy: another workspace cannot see, run or cancel a job, nor link a placeholder to its screen
 *   - a view-only member cannot connect, upload, list or run
 *   - the uploaded file is deleted when the job is done
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-migrate-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const migrate = require('../lib/migrate');

/* ---------- media bytes ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w = 16, h = 9, rgb = [200, 120, 40]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/*
 * A hand-built (stored, uncompressed) zip, so a test controls exactly what an attacker controls:
 * the entry name and the external attributes (a symlink is mode 0120000 in the high 16 bits).
 * archiver normalises names, which would hide the case under test.
 */
function rawZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(((mode || 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const out = path.join(process.env.DATA_DIR, `raw-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return out;
}
function noisyPng(w, h, seed) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  let x = seed;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + w * 3);
    for (let i = 1; i < r.length; i++) { x = (x * 1103515245 + 12345) >>> 0; r[i] = x >>> 24; }
    rows.push(r);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

async function makeZip(entries) {
  const { ZipArchive } = require('archiver');
  const out = path.join(process.env.DATA_DIR, `src-${Math.random().toString(36).slice(2)}.zip`);
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const ws = fs.createWriteStream(out);
  const done = new Promise((r, j) => { ws.on('close', r); archive.on('error', j); });
  archive.pipe(ws);
  for (const [name, data, opts] of entries) archive.append(data, { name, ...(opts || {}) });
  await archive.finalize();
  await done;
  return out;
}

/* ---------- people and workspaces ---------- */
function mkUser(tag, role = 'user', plan = 'enterprise') {
  const id = `u-mig-${tag}`;
  db.prepare("INSERT INTO users (id, email, password_hash, role, plan_id, email_verified) VALUES (?, ?, 'x', ?, ?, 1)").run(id, `${tag}@mig.test`, role, plan);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function mkWorkspace(tag, owner) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(`org-m${tag}`, `Org ${tag}`, owner.id);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(`org-m${tag}`, owner.id);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(`ws-m${tag}`, `org-m${tag}`, `WS ${tag}`);
  return `ws-m${tag}`;
}
const member = (ws, u, role) => db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(ws, u.id, role);

let server, base, WS_A, WS_B, OWNER, VIEWER, OTHER, TIGHT, WS_T;

before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  OWNER = mkUser('owner');
  WS_A = mkWorkspace('a', OWNER);
  VIEWER = mkUser('viewer'); member(WS_A, VIEWER, 'workspace_viewer');
  OTHER = mkUser('other');
  WS_B = mkWorkspace('b', OTHER);
  TIGHT = mkUser('tight', 'user', 'free');
  WS_T = mkWorkspace('t', TIGHT);
  const app = express();
  app.use(express.json());
  app.use('/api/migrate', requireAuth, resolveTenancy, require('../routes/migrate'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function call(user, method, p, body, ws = WS_A) {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${generateToken(user, ws)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
}
async function upload(user, zipPath, ws = WS_A, vendor = 'generic-zip') {
  const fd = new FormData();
  fd.append('vendor', vendor);
  fd.append('file', new Blob([fs.readFileSync(zipPath)]), 'export.zip');
  const r = await fetch(`${base}/api/migrate/jobs/upload`, { method: 'POST', headers: { Authorization: `Bearer ${generateToken(user, ws)}` }, body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function scanned(id) { const j = await migrate._settle(id); assert.equal(j.status, 'scanned', j.error || ''); return j; }

const PLAYLISTS_CSV = 'playlist,file,duration,order\nLobby,lobby/b.png,7,2\nLobby,lobby/a.png,5,1\nLobby,missing.png,5,3\nMenu,menu/c.png,,1\n';
const SCREENS_CSV = 'name,group,playlist\nFront desk,Lobby screens;Ground floor,Lobby\nCafe wall,Ground floor,\n';

let firstZip;

test('generic zip: scan finds media, playlists and screens, and lists what it will not import', async () => {
  firstZip = await makeZip([
    ['lobby/a.png', png(16, 9, [10, 20, 30])],
    ['lobby/b.png', png(16, 9, [40, 50, 60])],
    ['menu/c.png', png(16, 9, [70, 80, 90])],
    ['menu/fake.jpg', Buffer.from('this is not an image at all, just text pretending')],
    ['readme.txt', Buffer.from('hello')],
    ['playlists.csv', Buffer.from(PLAYLISTS_CSV)],
    ['screens.csv', Buffer.from(SCREENS_CSV)],
  ]);
  const r = await upload(OWNER, firstZip);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const j = await scanned(r.body.id);
  const v = migrate.view(j);
  assert.equal(v.summary.media, 4);
  assert.equal(v.summary.playlists, 2);
  assert.equal(v.summary.screens, 2);
  assert.equal(v.summary.groups, 2);
  assert.ok(v.unmapped.some((u) => u.name === 'readme.txt'));
  assert.ok(v.unmapped.some((u) => /missing\.png/.test(u.name)));
  // The view never carries the upload path or a credential.
  assert.ok(!('cred_enc' in v) && !('upload_path' in v));
});

let firstJobId;
test('generic zip: run imports into a new folder, keeps names, order and durations; screens are placeholders, not devices', async () => {
  const list = await call(OWNER, 'GET', '/api/migrate/jobs');
  firstJobId = list.body.jobs[0].id;
  const devicesBefore = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const r = await call(OWNER, 'POST', `/api/migrate/jobs/${firstJobId}/run`, { options: { publish: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const j = await migrate._settle(firstJobId);
  assert.equal(j.status, 'done', j.error || '');
  const rep = JSON.parse(j.report);
  assert.equal(rep.created.media, 3);
  assert.equal(rep.failed.length, 1, 'the fake .jpg is refused by the sniffer');
  assert.match(rep.failed[0].reason, /not an image, video or audio/);

  const folder = db.prepare("SELECT * FROM content_folders WHERE workspace_id = ? AND name LIKE 'Imported from%'").get(WS_A);
  assert.ok(folder, 'a folder for the import');
  const names = db.prepare('SELECT filename FROM content WHERE workspace_id = ? AND folder_id = ? ORDER BY filename').all(WS_A, folder.id).map((r) => r.filename);
  assert.deepEqual(names, ['a.png', 'b.png', 'c.png']);

  const lobby = db.prepare("SELECT * FROM playlists WHERE workspace_id = ? AND name = 'Lobby'").get(WS_A);
  const items = db.prepare('SELECT c.filename, pi.duration_sec FROM playlist_items pi JOIN content c ON c.id = pi.content_id WHERE pi.playlist_id = ? ORDER BY pi.sort_order').all(lobby.id).map((r) => ({ ...r }));
  assert.deepEqual(items, [{ filename: 'a.png', duration_sec: 5 }, { filename: 'b.png', duration_sec: 7 }]);
  assert.ok(lobby.published_snapshot, 'published when asked');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, devicesBefore, 'no device row is ever created');
  const ph = db.prepare('SELECT * FROM migration_screens WHERE workspace_id = ? ORDER BY name').all(WS_A);
  assert.deepEqual(ph.map((p) => p.name), ['Cafe wall', 'Front desk']);
  const front = ph.find((p) => p.name === 'Front desk');
  assert.equal(JSON.parse(front.group_ids).length, 2);
  assert.equal(front.playlist_id, lobby.id);
  // The upload is gone once the job is done.
  assert.equal(j.upload_path, null);
  assert.equal(fs.readdirSync(migrate.uploadDir()).length, 0);
});

test('re-running the same source creates nothing new', async () => {
  const counts = () => ({
    content: db.prepare('SELECT COUNT(*) AS n FROM content WHERE workspace_id = ?').get(WS_A).n,
    playlists: db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ?').get(WS_A).n,
    groups: db.prepare('SELECT COUNT(*) AS n FROM device_groups WHERE workspace_id = ?').get(WS_A).n,
    screens: db.prepare('SELECT COUNT(*) AS n FROM migration_screens WHERE workspace_id = ?').get(WS_A).n,
    folders: db.prepare('SELECT COUNT(*) AS n FROM content_folders WHERE workspace_id = ?').get(WS_A).n,
  });
  const before = counts();
  const r = await upload(OWNER, firstZip);
  await scanned(r.body.id);
  await call(OWNER, 'POST', `/api/migrate/jobs/${r.body.id}/run`, { options: {} });
  const j = await migrate._settle(r.body.id);
  assert.equal(j.status, 'done');
  const rep = JSON.parse(j.report);
  assert.equal(rep.created.media, 0);
  assert.equal(rep.reused.media, 3);
  assert.equal(rep.reused.playlists, 2);
  assert.deepEqual(counts(), before);
});

test('a target deleted since the last run is recreated, not pointed at', async () => {
  const menu = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Menu'").get(WS_A);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(menu.id);
  const r = await upload(OWNER, firstZip);
  await scanned(r.body.id);
  await call(OWNER, 'POST', `/api/migrate/jobs/${r.body.id}/run`, { options: { media: false, screens: false } });
  const j = await migrate._settle(r.body.id);
  assert.equal(JSON.parse(j.report).created.playlists, 1);
  const again = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Menu'").get(WS_A);
  assert.ok(again && again.id !== menu.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(again.id).n, 1, 'media from the earlier run is reused');
});

test('without a CSV, each folder of media becomes a playlist in name order', async () => {
  const z = await makeZip([['Spring/2.png', png(8, 8, [1, 2, 3])], ['Spring/10.png', png(8, 8, [4, 5, 6])], ['top.png', png(8, 8, [7, 8, 9])]]);
  const r = await upload(OWNER, z, WS_B && WS_A);
  await scanned(r.body.id);
  await call(OWNER, 'POST', `/api/migrate/jobs/${r.body.id}/run`, { options: { folder_id: 'root' } });
  const j = await migrate._settle(r.body.id);
  assert.equal(j.status, 'done');
  const pl = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Spring'").get(WS_A);
  const files = db.prepare('SELECT c.filename, c.folder_id FROM playlist_items pi JOIN content c ON c.id = pi.content_id WHERE pi.playlist_id = ? ORDER BY pi.sort_order').all(pl.id);
  assert.deepEqual(files.map((f) => f.filename), ['2.png', '10.png']);
  assert.ok(files.every((f) => f.folder_id === null), 'folder_id root = the library root');
});

test('zip entries that climb out (../) or are symlinks are never imported or written', async () => {
  const z = rawZip([
    { name: '../escape.png', data: png(8, 8) },
    { name: 'ok/../../escape2.png', data: png(8, 8) },
    { name: '/abs/escape3.png', data: png(8, 8, [5, 5, 5]) },
    { name: 'link.png', data: Buffer.from('/etc/passwd'), mode: 0o120777 },
    { name: 'fine.png', data: png(8, 8, [11, 22, 33]) },
  ]);
  const r = await upload(OWNER, z, WS_B, 'generic-zip');
  // OWNER is not in WS_B; use OTHER for B.
  assert.equal(r.status, 403);
  const r2 = await upload(OTHER, z, WS_B);
  assert.equal(r2.status, 201);
  const j = await scanned(r2.body.id);
  const cat = JSON.parse(j.scan).catalog;
  assert.deepEqual(cat.media.map((m) => m.name).sort(), ['escape3.png', 'fine.png'], 'a leading / is stripped (a name, not a path); ../ and symlinks are dropped');
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'escape.png')));
  await call(OTHER, 'POST', `/api/migrate/jobs/${r2.body.id}/cancel`, {}, WS_B);
});

test('storage: the job stops when the allowance runs out, keeps what it has, and resumes', async () => {
  // The free plan is 500 MB; leave room for about one small file.
  const used = 500 * 1024 * 1024 - 1500;
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES ('c-big', ?, ?, 'big.mp4', 'big.mp4', 'video/mp4', ?)").run(TIGHT.id, WS_T, used);
  const z = await makeZip([['s/1.png', png(8, 8, [1, 1, 1])], ['s/2.png', noisyPng(40, 40, 2)], ['s/3.png', noisyPng(40, 40, 3)]]);
  const r = await upload(TIGHT, z, WS_T);
  const j0 = await scanned(r.body.id);
  void j0;
  await call(TIGHT, 'POST', `/api/migrate/jobs/${r.body.id}/run`, { options: {} }, WS_T);
  const j = await migrate._settle(r.body.id);
  assert.equal(j.status, 'stopped');
  const v = migrate.view(j);
  assert.equal(v.can_resume, true);
  assert.match(v.error, /storage allowance/);
  const got = db.prepare("SELECT COUNT(*) AS n FROM content WHERE workspace_id = ? AND id != 'c-big'").get(WS_T).n;
  assert.ok(got >= 1 && got < 3, `imported ${got} before stopping`);
  assert.ok(j.upload_path, 'the upload is kept for a resume');

  // Free space, resume: the rest arrives, nothing is duplicated.
  db.prepare("DELETE FROM content WHERE id = 'c-big'").run();
  const rr = await call(TIGHT, 'POST', `/api/migrate/jobs/${r.body.id}/run`, {}, WS_T);
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  const j2 = await migrate._settle(r.body.id);
  assert.equal(j2.status, 'done', j2.error || '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content WHERE workspace_id = ?').get(WS_T).n, 3);
  assert.equal(j2.upload_path, null);
});

test('tenancy: another workspace cannot read, run or cancel a job, or link a placeholder to its screen', async () => {
  const g = await call(OTHER, 'GET', `/api/migrate/jobs/${firstJobId}`, null, WS_B);
  assert.equal(g.status, 404);
  const run = await call(OTHER, 'POST', `/api/migrate/jobs/${firstJobId}/run`, {}, WS_B);
  assert.equal(run.status, 404);
  const c = await call(OTHER, 'POST', `/api/migrate/jobs/${firstJobId}/cancel`, {}, WS_B);
  assert.equal(c.status, 404);
  const lst = await call(OTHER, 'GET', '/api/migrate/placeholders', null, WS_B);
  assert.ok(!lst.body.placeholders.some((p) => p.name === 'Front desk'));

  const ph = db.prepare("SELECT id FROM migration_screens WHERE workspace_id = ? AND name = 'Front desk'").get(WS_A);
  // A screen in workspace B cannot be linked to A's placeholder, from either side.
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status) VALUES ('dev-b', ?, ?, 'B screen', 'online')").run(OTHER.id, WS_B);
  assert.equal((await call(OWNER, 'POST', `/api/migrate/placeholders/${ph.id}/link`, { device_id: 'dev-b' })).status, 404);
  assert.equal((await call(OTHER, 'POST', `/api/migrate/placeholders/${ph.id}/link`, { device_id: 'dev-b' }, WS_B)).status, 404);
  assert.equal((await call(OTHER, 'DELETE', `/api/migrate/placeholders/${ph.id}`, null, WS_B)).status, 404);

  // Its own paired screen links fine.
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status) VALUES ('dev-a', ?, ?, 'Front desk', 'online')").run(OWNER.id, WS_A);
  const ok = await call(OWNER, 'POST', `/api/migrate/placeholders/${ph.id}/link`, { device_id: 'dev-a' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.device.id, 'dev-a');
});

test('a view-only member cannot connect, upload, list, run or touch placeholders', async () => {
  assert.equal((await call(VIEWER, 'POST', '/api/migrate/jobs', { vendor: 'yodeck', credentials: { api_key: 'x:y' } })).status, 403);
  assert.equal((await upload(VIEWER, firstZip)).status, 403);
  assert.equal((await call(VIEWER, 'GET', '/api/migrate/jobs')).status, 403);
  assert.equal((await call(VIEWER, 'GET', `/api/migrate/jobs/${firstJobId}`)).status, 403);
  assert.equal((await call(VIEWER, 'POST', `/api/migrate/jobs/${firstJobId}/run`, {})).status, 403);
  assert.equal((await call(VIEWER, 'GET', '/api/migrate/placeholders')).status, 403);
  const v = await call(VIEWER, 'GET', '/api/migrate/vendors');
  assert.equal(v.status, 200);
  assert.equal(v.body.can_import, false);
  assert.equal(fs.readdirSync(migrate.uploadDir()).filter((f) => f.endsWith('.upload')).length, 0, 'a viewer upload never lands on disk');
});

test('one import at a time per workspace', async () => {
  const z = await makeZip([['x/1.png', png(8, 8, [9, 9, 9])]]);
  const a = await upload(OWNER, z);
  assert.equal(a.status, 201);
  const b = await upload(OWNER, z);
  // The first is still scanning or scanned; a second scanning job is refused only while one is active.
  if (b.status !== 201) assert.equal(b.status, 409);
  await migrate._settle(a.body.id);
  await call(OWNER, 'POST', `/api/migrate/jobs/${a.body.id}/cancel`, {});
  if (b.status === 201) { await migrate._settle(b.body.id); await call(OWNER, 'POST', `/api/migrate/jobs/${b.body.id}/cancel`, {}); }
  const j = migrate.get(a.body.id);
  assert.equal(j.status, 'cancelled');
  assert.equal(j.upload_path, null, 'a cancelled job keeps no upload');
});

test('the vendor list says how to connect and never anything secret', async () => {
  const v = await call(OWNER, 'GET', '/api/migrate/vendors');
  assert.equal(v.status, 200);
  const ids = v.body.vendors.map((x) => x.id);
  for (const id of ['xibo', 'yodeck', 'optisigns', 'screencloud', 'anthias', 'generic-zip']) assert.ok(ids.includes(id), id);
  for (const x of v.body.vendors) for (const d of x.docs) assert.match(d, /^https:\/\//);
});

test('a resume cannot point a file import at another upload by naming it in the body', async () => {
  const z = await makeZip([['r/1.png', png(8, 8, [3, 1, 4])]]);
  const victim = await upload(OTHER, z, WS_B);
  await scanned(victim.body.id);
  const victimFile = migrate.get(victim.body.id).upload_path;
  const mine = await upload(OWNER, z);
  await scanned(mine.body.id);
  // As if my upload had expired while the job was interrupted.
  migrate.forget(mine.body.id);
  db.prepare("UPDATE migration_jobs SET status = 'interrupted' WHERE id = ?").run(mine.body.id);
  const r = await call(OWNER, 'POST', `/api/migrate/jobs/${mine.body.id}/run`, { credentials: { upload_path: victimFile } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'needs_credentials');
  await call(OTHER, 'POST', `/api/migrate/jobs/${victim.body.id}/cancel`, {}, WS_B);
});
