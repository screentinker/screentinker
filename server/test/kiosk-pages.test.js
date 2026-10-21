'use strict';

// Kiosk pages, found while filming the kiosk user guide:
//   - "Open URL" called window.open(), which never works inside the player's sandboxed frames;
//   - saving a page notified no screen, so a screen already showing it kept the old version;
//   - deleting a page left its "Kiosk: ..." widget in playlists, showing "Page not found";
//   - a kiosk item was meant to stay up until skipped but got the 10 s default.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const vm = require('vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-kiosk-pages-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const kiosk = require('../routes/kiosk');
const devicesPlaying = require('../lib/devices-playing');
const commandQueue = require('../lib/command-queue');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-k', 'kiosk@test', 'K', 'platform_admin')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-k', 'K', 'u-k')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-k', 'org-k', 'K')").run();

// The fan-out itself is lib/devices-playing.js (tested on its own); here only that the save asks it,
// for the right widgets, and pushes to what it answers.
const pushed = [];
const asked = [];
devicesPlaying.devicesPlayingWidget = (id) => { asked.push(id); return [`dev-of-${id}`]; };
commandQueue.queueOrEmitPlaylistUpdate = (_ns, deviceId) => { pushed.push(deviceId); };

let server;
async function call(method, url, body) {
  if (!server) {
    const express = require('express');
    const app = express();
    app.set('io', { of: () => ({}) });
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u-k', role: 'platform_admin' }; req.workspaceId = 'ws-k'; next(); });
    app.use('/api/kiosk', kiosk);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}
after(() => { if (server) server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function newPage(name, config) {
  const r = await call('POST', '/api/kiosk', { name, config });
  assert.equal(r.status, 201);
  return r.json;
}
function widget(id, url, type = 'webpage') {
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, updated_at) VALUES (?, 'u-k', 'ws-k', ?, ?, ?, 1000)")
    .run(id, type, `Kiosk: ${id}`, JSON.stringify({ url }));
}
const revOf = (id) => db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(id)?.updated_at;

/* ---------------------------------------------------------------- Open URL */

test('Open URL opens the address inside the page, under a Back bar, never with window.open', async () => {
  const page = await newPage('Lobby', { title: 'Hi', buttons: [{ label: 'Site', action: 'url', url: 'https://example.com/menu' }] });
  const html = (await call('GET', `/api/kiosk/${page.id}/render`)).text;
  assert.doesNotMatch(html, /window\.open\(url/);
  assert.match(html, /<iframe id="siteFrame" sandbox="allow-scripts" referrerpolicy="no-referrer"><\/iframe>/,
    'the site frame is sandboxed like the page itself: scripts only, no same-origin, no popups');
  assert.match(html, /data-action="url" data-url="https:\/\/example\.com\/menu"/);
  assert.match(html, /if \(action === 'url' && url\) openSite\(url\);/);
  // English when the page was saved before the labels existed.
  assert.match(html, /id="siteBack">&#8592; Back<\/button>/);
  assert.match(html, /does not allow being shown inside another page/);
});

test("the Back bar uses the editor's words, escaped", async () => {
  const page = await newPage('Lobby DE', { siteBackLabel: 'Zurück <b>', siteHint: 'Leer? "Nicht erlaubt"', buttons: [] });
  const html = (await call('GET', `/api/kiosk/${page.id}/render`)).text;
  assert.match(html, /id="siteBack">&#8592; Zurück &lt;b&gt;<\/button>/);
  assert.match(html, /<span class="site-hint">Leer\? &quot;Nicht erlaubt&quot;<\/span>/);
});

test('only http(s) addresses open; a bare host name gets https://', async () => {
  const page = await newPage('Lobby URL', { buttons: [] });
  const html = (await call('GET', `/api/kiosk/${page.id}/render`)).text;
  const src = /function siteUrl\(raw\) \{[\s\S]*?\n {4}\}\n/.exec(html);
  assert.ok(src, 'siteUrl is in the rendered page');
  const sandbox = { window: { location: { href: `http://screen.test/api/kiosk/${page.id}/render` } }, URL, String };
  vm.runInNewContext(src[0] + ';this.siteUrl = siteUrl;', sandbox);
  const { siteUrl } = sandbox;
  assert.equal(siteUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(siteUrl('http://example.com'), 'http://example.com/');
  assert.equal(siteUrl('www.example.com/menu'), 'https://www.example.com/menu');
  assert.equal(siteUrl('/api/kiosk/other/render'), 'http://screen.test/api/kiosk/other/render');
  assert.equal(siteUrl('javascript:alert(1)'), null);
  assert.equal(siteUrl(' JavaScript:alert(1)'), null);
  assert.equal(siteUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(siteUrl(''), 'http://screen.test/api/kiosk/' + page.id + '/render', 'empty never reaches openSite: the click handler checks url first');
});

/* ---------------------------------------------------------------- Save reaches screens */

test('saving a page re-revs the widgets that show it and pushes to their screens', async () => {
  const page = await newPage('Menu', { title: 'Old', buttons: [] });
  widget('w-rel', `/api/kiosk/${page.id}/render`);
  widget('w-abs', `https://old-host.example/api/kiosk/${page.id}/render`);
  widget('w-other', '/api/kiosk/00000000-0000-0000-0000-000000000000/render');
  widget('w-text', `/api/kiosk/${page.id}/render`, 'text');
  pushed.length = 0; asked.length = 0;

  const r = await call('PUT', `/api/kiosk/${page.id}`, { config: { title: 'New', buttons: [] } });
  assert.equal(r.status, 200);
  assert.ok(revOf('w-rel') > 1000 && revOf('w-abs') > 1000, 'both URL shapes are found and re-revved');
  assert.equal(revOf('w-other'), 1000, 'a widget showing another page is left alone');
  assert.equal(revOf('w-text'), 1000, 'only webpage widgets frame a page');
  assert.deepEqual(asked.sort(), ['w-abs', 'w-rel']);
  assert.deepEqual(pushed.sort(), ['dev-of-w-abs', 'dev-of-w-rel']);

  // Two saves in the same second still move the rev, or the second edit would not reach the screen.
  const before = revOf('w-rel');
  await call('PUT', `/api/kiosk/${page.id}`, { config: { title: 'Newer', buttons: [] } });
  assert.ok(revOf('w-rel') > before);
});

test('a rename alone pushes nothing (the screen shows the config, not the name)', async () => {
  const page = await newPage('Rename me', { buttons: [] });
  widget('w-ren', `/api/kiosk/${page.id}/render`);
  pushed.length = 0;
  await call('PUT', `/api/kiosk/${page.id}`, { name: 'Renamed' });
  assert.equal(revOf('w-ren'), 1000);
  assert.deepEqual(pushed, []);
});

/* ---------------------------------------------------------------- Delete */

test('deleting a page still in a playlist is refused and names the playlist', async () => {
  const page = await newPage('In use', { buttons: [] });
  widget('w-used', `/api/kiosk/${page.id}/render`);
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('pl-lobby', 'u-k', 'ws-k', 'Lobby screen')").run();
  db.prepare("INSERT INTO playlist_items (playlist_id, widget_id, sort_order, duration_sec) VALUES ('pl-lobby', 'w-used', 0, 10)").run();

  const r = await call('DELETE', `/api/kiosk/${page.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'KIOSK_PAGE_IN_USE');
  assert.deepEqual(r.json.used_by, ['Lobby screen']);
  assert.ok(db.prepare('SELECT 1 FROM kiosk_pages WHERE id = ?').get(page.id), 'the page is still there');
  assert.ok(revOf('w-used'), 'and so is its widget');
});

test('a page only in what a playlist PUBLISHED is in use too', async () => {
  const page = await newPage('Published', { buttons: [] });
  widget('w-pub', `/api/kiosk/${page.id}/render`);
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, published_snapshot) VALUES ('pl-pub', 'u-k', 'ws-k', 'Live one', ?)")
    .run(JSON.stringify([{ widget_id: 'w-pub', duration_sec: 10 }]));
  const r = await call('DELETE', `/api/kiosk/${page.id}`);
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.used_by, ['Live one']);
});

test('a page nothing plays is deleted together with its widgets, and only its own', async () => {
  const page = await newPage('Unused', { buttons: [] });
  widget('w-gone-1', `/api/kiosk/${page.id}/render`);
  widget('w-gone-2', `http://localhost:3001/api/kiosk/${page.id}/render`);
  widget('w-keep', '/api/kiosk/11111111-1111-1111-1111-111111111111/render');
  const r = await call('DELETE', `/api/kiosk/${page.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.removed_widgets, 2);
  assert.equal(db.prepare('SELECT 1 FROM kiosk_pages WHERE id = ?').get(page.id), undefined);
  assert.equal(revOf('w-gone-1'), undefined);
  assert.equal(revOf('w-gone-2'), undefined);
  assert.equal(revOf('w-keep'), 1000);
});

test('a page with no widget at all deletes as before', async () => {
  const page = await newPage('Plain', { buttons: [] });
  const r = await call('DELETE', `/api/kiosk/${page.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.removed_widgets, 0);
});

/* ---------------------------------------------------------------- Stay up until skipped */

test('a kiosk item is added with the longest dwell the server keeps, not 0 (which becomes 10 s)', () => {
  const { resolveItemDuration, MAX_CONTENT_DURATION } = require('../lib/item-duration');
  // Why 0 was wrong: for a widget the server stores the default, as it must (players self-loop on 0).
  assert.equal(resolveItemDuration(0, null), 10);
  const picker = fs.readFileSync(path.join(__dirname, '../../frontend/js/components/content-picker.js'), 'utf8');
  const dwell = Number(/export const KIOSK_DWELL_SEC = (\d+);/.exec(picker)?.[1]);
  assert.equal(dwell, MAX_CONTENT_DURATION, 'the stay-up dwell is the 12 h ceiling');
  assert.equal(resolveItemDuration(dwell, null), dwell, 'and the server keeps it');
  assert.match(picker, /kiosk: true, duration_sec: KIOSK_DWELL_SEC/);
  const detail = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/device-detail.js'), 'utf8');
  assert.doesNotMatch(detail, /item\.kiosk\) return \{ \.\.\.base, duration_sec: 0/);
  const playlists = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/playlists.js'), 'utf8');
  assert.match(playlists, /add: \(item\) => api\.addPlaylistItem\(playlistId, toNewItem\(item\)\)/,
    'the playlist editor sends it too (it used to send no duration: 10 s)');
});
