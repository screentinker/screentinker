'use strict';

/*
 * Weather, clock and radar widgets that follow the screen they are on (lib/widget-location.js), and
 * the radar widget (lib/radar/widget.js).
 *
 * A weather widget showed the place typed into it, so one widget could not serve screens in two
 * cities and a screen moved in Device Info kept the old city. The screen's place is resolved on the
 * server from the ?device=<id> every player sends, and goes into the rev so a cached page reloads
 * when the screen moves, and only then.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-follow-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const wl = require('../lib/widget-location');
const radar = require('../lib/radar/widget');

const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const O = 'o-fs', WS = 'ws-fs', WS2 = 'ws-fs-other', U = 'u-fs';
const KENOSHA = 'dev-kenosha', BARE = 'dev-bare', OTHER = 'dev-other-tenant';
let server, base, token;

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'fs@t.local', 'x', 'user')").run(U);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'WS');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS2, O, 'Other');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(WS, U);
  const dev = db.prepare(`INSERT INTO devices (id, user_id, name, workspace_id, latitude, longitude, location_label, timezone, reported_timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  dev.run(KENOSHA, U, 'Lobby', WS, 42.58474, -87.82119, 'Kenosha, Wisconsin, United States', 'UTC', 'America/Chicago');
  dev.run(BARE, U, 'Unplaced', WS, null, null, null, 'UTC', null);
  dev.run(OTHER, U, 'Someone else', WS2, 51.5, -0.12, 'London, England, United Kingdom', 'Europe/London', null);
  token = generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(U), WS);
  const app = express();
  app.use(express.json());
  app.use('/api/widgets', (req, res, next) => (/\/render$/.test(req.path) ? next() : requireAuth(req, res, () => resolveTenancy(req, res, next))), require('../routes/widgets'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

const post = async (body) => {
  const r = await fetch(`${base}/api/widgets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Workspace-Id': WS }, body: JSON.stringify(body) });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
};
const page = (id, device) => fetch(`${base}/api/widgets/${id}/render?rev=1${device ? `&device=${device}` : ''}`);

/* ── the place ─────────────────────────────────────────────────────────────────────────────── */

test("the screen's place: rounded point, short label, and its own zone when the dashboard's is the UTC default", () => {
  assert.deepEqual(wl.screenPlace(db, KENOSHA, WS), { lat: 42.5847, lon: -87.8212, label: 'Kenosha, Wisconsin', timezone: 'America/Chicago' });
  assert.deepEqual(wl.screenPlace(db, BARE, WS), { lat: null, lon: null, label: '', timezone: 'UTC' });
  db.prepare("UPDATE devices SET timezone = 'America/Denver' WHERE id = ?").run(KENOSHA);
  try {
    assert.equal(wl.screenPlace(db, KENOSHA, WS).timezone, 'America/Denver', 'a zone somebody chose wins over the reported one');
  } finally { db.prepare("UPDATE devices SET timezone = 'UTC' WHERE id = ?").run(KENOSHA); }
});

test('a device in another workspace, an unknown one or junk is never read (the render route is public)', () => {
  assert.equal(wl.screenPlace(db, OTHER, WS), null);
  assert.equal(wl.screenPlace(db, 'nope', WS), null);
  assert.equal(wl.screenPlace(db, { id: KENOSHA }, WS), null);
  assert.equal(wl.screenPlace(db, 'x'.repeat(200), WS), null);
});

test('only a widget set to follow the screen changes; radar follows by default, weather and clock do not', () => {
  const place = wl.screenPlace(db, KENOSHA, WS);
  assert.equal(wl.followsScreen('weather', {}), false);
  assert.equal(wl.followsScreen('clock', {}), false);
  assert.equal(wl.followsScreen('radar', {}), true);
  assert.equal(wl.followsScreen('radar', { location_source: 'fixed' }), false);
  assert.equal(wl.followsScreen('rss', { location_source: 'screen' }), false);
  assert.deepEqual(wl.applyPlace('weather', { location: 'Paris' }, place), { location: 'Paris' });

  const w = wl.applyPlace('weather', { location: 'Paris', location_source: 'screen' }, place);
  assert.equal(w.location, 'Kenosha, Wisconsin');
  assert.equal(w.__place_query, '42.5847,-87.8212');
  assert.equal(wl.applyPlace('clock', { timezone: 'Asia/Tokyo', timezone_source: 'screen' }, place).timezone, 'America/Chicago');
  const r = wl.applyPlace('radar', {}, place);
  assert.equal(r.latitude, 42.5847);
  assert.equal(r.label, 'Kenosha, Wisconsin');

  // No place: the widget's own setting stands. A stored __place_query is never trusted.
  assert.equal(wl.applyPlace('weather', { location: 'Paris', location_source: 'screen', __place_query: 'evil' }, wl.screenPlace(db, BARE, WS)).__place_query, undefined);
});

test('the rev salt changes when the place does and only then; 0 when the widget does not follow', () => {
  const place = wl.screenPlace(db, KENOSHA, WS);
  const a = wl.revSalt('weather', { location_source: 'screen' }, place);
  assert.ok(a > 0 && a < 1e6);
  assert.equal(wl.revSalt('weather', { location_source: 'screen' }, { ...place }), a);
  assert.notEqual(wl.revSalt('weather', { location_source: 'screen' }, { ...place, lat: 42.6 }), a);
  assert.equal(wl.revSalt('weather', {}, place), 0);
  assert.equal(wl.revSalt('radar', {}, null), 0);
  assert.equal(wl.revSalt('radar', {}, wl.screenPlace(db, BARE, WS)), 0);
  assert.notEqual(wl.revSalt('clock', { timezone_source: 'screen' }, place), wl.revSalt('clock', { timezone_source: 'screen' }, { ...place, timezone: 'Asia/Tokyo' }));
});

/* ── through the render route ──────────────────────────────────────────────────────────────── */

test('a weather widget following the screen renders that screen; another tenant\'s device falls back', async () => {
  const w = await post({ widget_type: 'weather', name: 'Weather', config: { location: 'Paris', location_source: 'screen' } });
  const here = await (await page(w.id, KENOSHA)).text();
  assert.ok(here.includes('Kenosha, Wisconsin'));
  assert.ok(here.includes('wttr.in/42.5847%2C-87.8212'), 'fetched by the screen\'s coordinates');
  for (const dev of [OTHER, BARE, null]) {
    const html = await (await page(w.id, dev)).text();
    assert.ok(html.includes('wttr.in/Paris'), `falls back to the widget's place for ${dev}`);
    assert.ok(!html.includes('London'));
  }
});

test('a clock following the screen shows the screen\'s zone', async () => {
  const w = await post({ widget_type: 'clock', name: 'Clock', config: { timezone: 'Asia/Tokyo', timezone_source: 'screen' } });
  assert.ok((await (await page(w.id, KENOSHA)).text()).includes('America/Chicago'));
  assert.ok((await (await page(w.id, null)).text()).includes('Asia/Tokyo'));
});

test('the radar page: centred on the screen, inline map, sources named in a tight CSP, sandboxed', async () => {
  const w = await post({ widget_type: 'radar', name: 'Radar', config: { zoom: 7 } });
  const r = await page(w.id, KENOSHA);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src https:\/\/api\.rainviewer\.com;/);
  assert.match(csp, /img-src https:\/\/tilecache\.rainviewer\.com http:\/\/127\.0\.0\.1:\d+ data:;/, 'no third-party map host by default');
  assert.match(csp, /sandbox allow-scripts$/);
  const html = await r.text();
  assert.ok(html.includes('var lat=42.5847,lon=-87.8212,zoom=7'));
  assert.ok(html.includes('Kenosha, Wisconsin'));
  assert.ok(html.includes('"Milwaukee"') && html.includes('"Chicago"'), 'the bundled map\'s cities around the screen are inlined');
  assert.ok(!html.includes('"Tokyo"'), 'and nothing from the other side of the world');
  assert.ok(html.length < 400 * 1024, `inline map stays small (${html.length} bytes)`);

  const none = await (await page(w.id, BARE)).text();
  assert.match(none, /Set this screen(&#39;|')s location in Device Info/);
});

test('radar settings are bounded and escaped; a custom tile URL must be a plain https template', () => {
  const n = radar.normalise({ zoom: 99, opacity: 5, basemap: 'neon', latitude: 200, longitude: 0 });
  assert.equal(n.zoom, 10);
  assert.equal(n.opacity, 1);
  assert.equal(n.basemap, 'dark');
  assert.equal(n.latitude, null, 'an impossible latitude is no location');

  const x = radar.render({ latitude: 1, longitude: 2, label: '</script><img src=x onerror=alert(1)>' }, { origin: 'http://s' }).html;
  assert.ok(!x.includes('<img src=x'));

  const own = radar.render({ latitude: 1, longitude: 2, tile_url: 'https://tiles.example.com/{z}/{x}/{y}.png?key=abc', tile_attribution: 'Example' }, { origin: 'http://s' });
  assert.match(own.csp, /img-src https:\/\/tilecache\.rainviewer\.com https:\/\/tiles\.example\.com http:\/\/s data:/);
  assert.ok(own.html.includes('tiles.example.com/{z}/{x}/{y}.png?key=abc'));
  for (const bad of ['http://tiles.example.com/{z}/{x}/{y}.png', 'javascript:alert(1)//{z}{x}{y}', 'https://a.example/{z}/{x}.png',
    'https://u:p@a.example/{z}/{x}/{y}', "https://a.example/{z}/{x}/{y}';alert(1)//"]) {
    const r = radar.render({ latitude: 1, longitude: 2, tile_url: bad }, { origin: 'http://s' });
    assert.ok(!r.csp.includes('a.example') && !r.csp.includes('tiles.example.com'), `refused: ${bad}`);
  }
});

test('the payload rev carries the place for a following widget, so moving the screen reloads it', async () => {
  const { __refreshWidgetRevs } = require('../ws/deviceSocket');
  const follow = await post({ widget_type: 'weather', name: 'W follow', config: { location_source: 'screen' } });
  const plain = await post({ widget_type: 'weather', name: 'W plain', config: { location: 'Paris' } });
  const revOf = (id, dev) => { const items = [{ widget_id: id }]; __refreshWidgetRevs(items, dev); return items[0].widget_rev; };
  const base1 = revOf(follow.id, null);
  const here = revOf(follow.id, KENOSHA);
  assert.notEqual(here, base1, 'the place is in the rev');
  assert.equal(revOf(follow.id, KENOSHA), here, 'stable while the screen stays put');
  assert.equal(revOf(plain.id, KENOSHA), revOf(plain.id, null), 'a widget with its own place is untouched');
  db.prepare('UPDATE devices SET latitude = 43.0389, longitude = -87.9065, location_label = ? WHERE id = ?').run('Milwaukee, Wisconsin', KENOSHA);
  try {
    assert.notEqual(revOf(follow.id, KENOSHA), here, 'moving the screen changes the rev');
  } finally {
    db.prepare('UPDATE devices SET latitude = 42.58474, longitude = -87.82119, location_label = ? WHERE id = ?').run('Kenosha, Wisconsin, United States', KENOSHA);
  }
});
