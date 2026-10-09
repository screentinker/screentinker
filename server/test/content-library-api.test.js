'use strict';

// The Content Library page's server side (lib/content-library.js, routes/content.js): the paged
// envelope with a real total, usage, "Unused" meaning NOTHING references the item, the scope and
// status filters, the counts beside the navigation, batch tags, and the destination folder for
// items that have no bytes.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-library-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');

const UUID = () => crypto.randomUUID();
const USER = 'u-lib';
const WS = 'ws-lib';
let server, base;

function call(method, pathname, body) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (r) => { let o = ''; r.on('data', (c) => (o += c)); r.on('end', () => resolve({ status: r.statusCode, json: o ? JSON.parse(o) : null })); });
    req.on('error', reject);
    req.end(data || undefined);
  });
}
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);

function mk(name, { mime = 'image/png', created = 1_800_000_000, extra = {} } = {}) {
  const id = UUID();
  const cols = { id, filename: name, mime_type: mime, filepath: '', workspace_id: WS, created_at: created, ...extra };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO content (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
  return id;
}
function playlist(name, ids, { smart = false } = {}) {
  const pl = UUID();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, smart_rules) VALUES (?, ?, ?, ?, 'draft', ?)").run(pl, USER, WS, name, smart ? '{"all":[]}' : null);
  if (!smart) ids.forEach((id, i) => db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, ?)').run(pl, id, i));
  else db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(ids.map((id) => ({ content_id: id }))), pl);
  return pl;
}

before(async () => {
  fs.mkdirSync(require('../config').contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-lib', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, 'org-lib', 'WS')").run(WS);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-lib-other', 'org-lib', 'Other')").run();
  db.prepare("INSERT INTO content_folders (id, name, user_id, workspace_id) VALUES ('f-lib', 'Campaigns', ?, ?)").run(USER, WS);
  db.prepare("INSERT INTO content_folders (id, name, user_id, workspace_id) VALUES ('f-lib-other', 'Theirs', ?, 'ws-lib-other')").run(USER);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = WS; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/content', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  for (const t of ['playlist_items', 'playlists', 'video_walls', 'canva_links']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM widgets WHERE workspace_id = ?").run(WS);
  db.prepare("UPDATE devices SET default_content_id = NULL").run();
  db.prepare('DELETE FROM content WHERE workspace_id = ?').run(WS);
});

after(() => new Promise((r) => server.close(r)));

test('without envelope the list is still a bare array (the picker and getAllContent read it)', async () => {
  mk('a.png');
  const r = await get('/content');
  assert.ok(Array.isArray(r.json));
  assert.equal(r.json[0].draft_json !== undefined, true, 'legacy rows are untouched');
});

test('envelope: a page plus the real total, and equal sort keys keep one order across pages', async () => {
  // Five items uploaded in the same second: created_at alone cannot order them.
  const ids = [1, 2, 3, 4, 5].map((n) => mk(`same-${n}.png`));
  const p1 = await get('/content?envelope=1&limit=2&offset=0&sort=date_desc');
  const p2 = await get('/content?envelope=1&limit=2&offset=2&sort=date_desc');
  const p3 = await get('/content?envelope=1&limit=2&offset=4&sort=date_desc');
  assert.equal(p1.json.total, 5);
  const seen = [...p1.json.items, ...p2.json.items, ...p3.json.items].map((c) => c.id);
  assert.deepEqual(seen, [...ids].sort(), 'tie-break on id, every item exactly once');
  assert.equal(p1.json.items[0].draft_json, undefined, 'the draft blob does not go to the page');
  assert.equal(typeof p1.json.items[0].has_draft, 'boolean');
});

test('sorts the table headers use, ascending and descending, all whitelisted', async () => {
  mk('b.mp4', { mime: 'video/mp4', extra: { duration_sec: 30, width: 1920, height: 1080 } });
  mk('a.mp4', { mime: 'video/mp4', extra: { duration_sec: 15, width: 3840, height: 2160 } });
  mk('c.png', {});
  const names = async (s) => (await get(`/content?envelope=1&sort=${s}`)).json.items.map((c) => c.filename);
  assert.deepEqual(await names('name'), ['a.mp4', 'b.mp4', 'c.png']);
  assert.deepEqual(await names('name_desc'), ['c.png', 'b.mp4', 'a.mp4']);
  assert.deepEqual(await names('duration'), ['a.mp4', 'b.mp4', 'c.png'], 'no duration sorts last');
  assert.deepEqual(await names('duration_desc'), ['b.mp4', 'a.mp4', 'c.png']);
  assert.deepEqual(await names('dims_desc'), ['a.mp4', 'b.mp4', 'c.png']);
  assert.equal((await get('/content?envelope=1&sort=filename;DROP TABLE content')).status, 200, 'an unknown sort falls back');
});

test('usage: playlists counted once each, smart playlists by their published copy', async () => {
  const a = mk('a.png');
  const b = mk('b.png');
  playlist('Main entrance', [a, a]);
  playlist('Retail floor', [a]);
  playlist('Smart one', [a], { smart: true });
  const items = (await get('/content?envelope=1&sort=name')).json.items;
  assert.deepEqual(items.map((c) => [c.filename, c.usage.playlists, c.usage.in_use]), [['a.png', 3, true], ['b.png', 0, false]]);
  const d = (await get(`/content/${a}/usage`)).json;
  assert.deepEqual(d.playlists.map((p) => p.name), ['Main entrance', 'Retail floor', 'Smart one']);
  assert.equal(d.playlists.find((p) => p.name === 'Smart one').smart, true);
  assert.equal((await get(`/content/${b}/usage`)).json.in_use, false);
});

test('"Unused" means nothing references it: a wall, a widget, a screen default all count', async () => {
  const wall = mk('wall.png');
  const widget = mk('widget.png');
  const dflt = mk('default.png');
  const free = mk('free.png');
  db.prepare("INSERT INTO video_walls (id, user_id, name, content_id, workspace_id) VALUES (?, ?, 'W', ?, ?)").run(UUID(), USER, wall, WS);
  db.prepare("INSERT INTO widgets (id, user_id, widget_type, name, config, workspace_id) VALUES (?, ?, 'directory-board', 'D', ?, ?)")
    .run(UUID(), USER, JSON.stringify({ background: `/api/content/${widget}/file` }), WS);
  const dev = UUID();
  db.prepare("INSERT INTO devices (id, name, workspace_id, default_content_id) VALUES (?, 'Screen', ?, ?)").run(dev, WS, dflt);
  const unused = (await get('/content?envelope=1&scope=unused')).json;
  assert.deepEqual(unused.items.map((c) => c.filename), ['free.png']);
  assert.equal(unused.total, 1);
  const used = (await get('/content?envelope=1&usage=used&sort=name')).json.items.map((c) => c.filename);
  assert.deepEqual(used, ['default.png', 'wall.png', 'widget.png']);
  const w = (await get(`/content/${wall}/usage`)).json;
  assert.equal(w.playlists.length, 0);
  assert.equal(w.elsewhere.walls, 1);
  assert.equal(w.in_use, true, 'no playlist, but on air: never "Unused"');
  assert.equal((await get(`/content/${free}/usage`)).json.in_use, false);
  db.prepare('DELETE FROM devices WHERE id = ?').run(dev);
});

test('the navigation counts match the lists they label', async () => {
  const now = Math.floor(Date.now() / 1000);
  const fresh = mk('fresh.png', { created: now - 3600 });
  mk('old.png', { created: now - 30 * 86400 });
  mk('gone.png', { created: now - 3600, extra: { expires_at: now - 60 } });
  playlist('P', [fresh]);
  const s = (await get('/content/library-summary')).json;
  const total = async (q) => (await get(`/content?envelope=1&${q}`)).json.total;
  assert.equal(s.all, await total(''));
  assert.equal(s.recent, await total('scope=recent'));
  assert.equal(s.unused, await total('scope=unused'));
  assert.deepEqual([s.all, s.recent, s.unused], [2, 1, 1], 'expired is outside every count, as it is outside the default list');
});

test('status filter: ready, in review, needs attention, expired; nothing else is accepted', async () => {
  const now = Math.floor(Date.now() / 1000);
  mk('ready.png');
  mk('draft.png', { extra: { draft_json: '{"filepath":"x"}' } });
  const linked = mk('canva.png');
  mk('expired.png', { extra: { expires_at: now - 60 } });
  db.prepare("INSERT INTO canva_links (content_id, workspace_id, user_id, integration_key, design_id, pages, format, last_error) VALUES (?, ?, ?, 'k', 'd', '[1]', 'png', 'token revoked')").run(linked, WS, USER);
  const names = async (st) => (await get(`/content?envelope=1&status=${st}`)).json.items.map((c) => c.filename);
  assert.deepEqual(await names('ready'), ['ready.png']);
  assert.deepEqual(await names('review'), ['draft.png']);
  assert.deepEqual(await names('attention'), ['canva.png']);
  assert.deepEqual(await names('expired'), ['expired.png']);
  const proto = (await get('/content?envelope=1&status=constructor')).json;
  assert.equal(proto.total, 3, 'an inherited property name is not a status: the default live set');
  assert.equal((await get('/content?envelope=1&status=attention')).json.items[0].sync_problem, true);
});

test('type buckets: an HDMI input is not a video and a hold is not a web page', async () => {
  mk('clip.mp4', { mime: 'video/mp4' });
  mk('HDMI 1', { mime: 'video/hdmi-in', extra: { remote_url: 'hdmi://1' } });
  mk('Hold', { mime: 'application/x-st-hold', extra: { remote_url: 'hold://freeze' } });
  mk('page', { mime: 'image/jpeg', extra: { remote_url: 'https://example.test/a.jpg' } });
  const names = async (ty) => (await get(`/content?envelope=1&type=${ty}`)).json.items.map((c) => c.filename);
  assert.deepEqual(await names('video'), ['clip.mp4']);
  assert.deepEqual(await names('hdmi'), ['HDMI 1']);
  assert.deepEqual(await names('hold'), ['Hold']);
  assert.deepEqual(await names('web'), ['page']);
});

test('batch tags: add and remove across items, atomic, limits checked per item', async () => {
  const a = mk('a.png', { extra: { tags: '["lobby"]' } });
  const b = mk('b.png');
  let r = await post('/content/batch/tags', { ids: [a, b], add: ['Autumn', '#retail'], remove: ['lobby'] });
  assert.equal(r.status, 200);
  const tags = (id) => JSON.parse(db.prepare('SELECT tags FROM content WHERE id = ?').get(id).tags);
  assert.deepEqual(tags(a), ['autumn', 'retail']);
  assert.deepEqual(tags(b), ['autumn', 'retail']);
  r = await post('/content/batch/tags', { ids: [a, UUID()], add: ['x'] });
  assert.equal(r.status, 404);
  assert.deepEqual(tags(a), ['autumn', 'retail'], 'nothing applied when one id fails');
  assert.equal((await post('/content/batch/tags', { ids: [a] })).status, 400, 'nothing to do is refused');
  const full = mk('full.png', { extra: { tags: JSON.stringify(Array.from({ length: 32 }, (_, i) => 't' + i)) } });
  r = await post('/content/batch/tags', { ids: [b, full], add: ['one-more'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /full\.png/);
  assert.deepEqual(tags(b), ['autumn', 'retail'], 'the batch is all or nothing');
});

test('destination: a hold or live stream lands in the chosen folder, never another workspace’s', async () => {
  let r = await post('/content/hold', { mode: 'freeze', folder_id: 'f-lib' });
  assert.equal(r.status, 201);
  assert.equal(r.json.folder_id, 'f-lib');
  r = await post('/content/hls', { url: 'http://192.168.1.5/live.m3u8', name: 'Cam', folder_id: 'f-lib' });
  assert.equal(r.json.folder_id, 'f-lib');
  r = await post('/content/hls', { url: 'hdmi://1', name: 'HDMI', folder_id: 'f-lib-other' });
  assert.equal(r.status, 400);
  r = await post('/content/hold', { mode: 'blank' });
  assert.equal(r.json.folder_id, null, 'no destination: the root');
});
