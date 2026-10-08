'use strict';

/*
 * CAP emergency feeds end to end, in process: the routes, the live-alert rules, scopes, and what a
 * screen's payload actually becomes.
 *
 * What has to hold:
 *   - only a workspace admin changes feeds (an editor is refused); members can read them
 *   - an alert takes a screen in scope over with the generated card (a widget item), or with the
 *     feed's playlist when it has one; a screen out of scope is untouched
 *   - filters: minimum severity, event names, area terms (text or geocode)
 *   - an Update supersedes and a Cancel ends what they reference; an alert leaving the feed ends
 *   - ⚠️ a feed that cannot be fetched keeps its alerts until their own expiry
 *   - expiry ends an alert with nobody polling
 *   - the card escapes third-party text; the card widget is hidden from the library and locked
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-cap-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-cap';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const setupDeviceSocket = require('../ws/deviceSocket');
const feeds = require('../lib/cap/feeds');

const O = 'o-cap', WS = 'ws-cap', OTHER = 'ws-cap-2';
const ADMIN = 'u-cap-admin', EDITOR = 'u-cap-ed', PL = 'pl-cap-own', ALERT_PL = 'pl-cap-alert', G = 'g-cap';
const D_IN = 'd-cap-in', D_GROUP = 'd-cap-grp', D_OUT = 'd-cap-out';
let build, server, base;
let NOW = Date.parse('2026-10-07T19:10:00Z') / 1000;
let feedBody = '';
let feedDown = false;

const capDoc = ({ id = 'a1', type = 'Alert', severity = 'Extreme', event = 'Tornado Warning', area = 'Waukesha, WI', geocode = 'WIC133',
  headline = 'Tornado Warning', expires = '2026-10-07T20:00:00Z', refs = '' } = {}) => `
  <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>nws</sender>
  <sent>2026-10-07T19:00:00Z</sent><status>Actual</status><msgType>${type}</msgType>${refs ? `<references>${refs}</references>` : ''}
  <info><language>en-US</language><event>${event}</event><urgency>Immediate</urgency><severity>${severity}</severity>
  <certainty>Observed</certainty><effective>2026-10-07T19:00:00Z</effective><expires>${expires}</expires>
  <headline>${headline}</headline><instruction>Take cover now.</instruction>
  <area><areaDesc>${area}</areaDesc><geocode><valueName>UGC</valueName><value>${geocode}</value></geocode></area></info></alert>`;
const atom = (...docs) => `<feed xmlns="http://www.w3.org/2005/Atom">${docs.map((d) => `<entry><id>x</id>${d}</entry>`).join('')}</feed>`;

before(async () => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  for (const [id, email] of [[ADMIN, 'capadmin@t.local'], [EDITOR, 'caped@t.local']]) {
    db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, 'x', 'user')").run(id, email);
  }
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', ADMIN);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, O, 'WS', OTHER, O, 'Other');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_editor')").run(WS, ADMIN, WS, EDITOR);
  const item = { content_id: null, widget_id: null, filename: 'x.png', mime_type: 'image/png', filepath: 'x.png', duration_sec: 10, sort_order: 0 };
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES (?, ?, ?, 'Own', 'published', ?), (?, ?, ?, 'Shelter', 'published', ?)")
    .run(PL, ADMIN, WS, JSON.stringify([{ ...item, filename: 'own.png' }]), ALERT_PL, ADMIN, WS, JSON.stringify([{ ...item, filename: 'shelter.png' }]));
  for (const id of [D_IN, D_GROUP, D_OUT]) {
    db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES (?, ?, ?, ?, ?, ?, 'device')")
      .run(id, ADMIN, WS, id, crypto.randomUUID().slice(0, 6), PL);
  }
  db.prepare('INSERT INTO device_groups (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)').run(G, 'Lobby', ADMIN, WS);
  db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(G, D_GROUP);

  feeds._setClock(() => NOW);
  feeds._setFetcher(async () => { if (feedDown) throw new Error('connect ETIMEDOUT'); return { text: feedBody, contentType: 'application/xml', status: 200 }; });

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/cap-feeds', requireAuth, resolveTenancy, require('../routes/cap-feeds'));
  app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } feeds._setFetcher(null); feeds._setClock(null); });

const tokenOf = (u) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), WS);
async function api(method, p, body, who = ADMIN) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const shows = (deviceId) => build(deviceId).assignments.map((a) => a.widget_type === 'cap_alert' ? 'CARD' : a.filename);
async function poll(feedId) { return feeds.pollFeed(db, db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(feedId)); }

let F;

test('an editor cannot create a feed; an admin can, scoped to the whole workspace by default', async () => {
  feedBody = capDoc();
  let r = await api('POST', '/api/cap-feeds', { name: 'NWS Wisconsin', url: 'https://api.weather.gov/alerts/active.atom?area=WI' }, EDITOR);
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CAP_ADMIN_REQUIRED');
  r = await api('POST', '/api/cap-feeds', { name: 'NWS Wisconsin', url: 'ftp://nope' });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/cap-feeds', { name: 'NWS Wisconsin', url: 'https://api.weather.gov/alerts/active.atom?area=WI', min_severity: 'Severe' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  F = r.body.id;
  assert.deepEqual(r.body.scopes, [{ scope_kind: 'workspace', scope_id: WS }]);
  const list = await api('GET', '/api/cap-feeds', null, EDITOR);
  assert.equal(list.status, 200); assert.equal(list.body.length, 1, 'members can read feeds');
});

test('a live alert puts the card on every screen in scope; filters decide what counts', async () => {
  await poll(F);
  assert.deepEqual(shows(D_IN), ['CARD']);
  assert.deepEqual(shows(D_GROUP), ['CARD']);
  const p = build(D_IN);
  assert.equal(p.default_content, null, 'no standby image under an alert');
  assert.equal(p.power_schedule ?? null, null, 'the screen stays on through its power schedule');

  // Severity floor above the alert: nothing shows.
  let r = await api('PUT', `/api/cap-feeds/${F}`, { min_severity: 'Extreme' });
  assert.equal(r.status, 200); assert.equal(r.body.live_count, 1);
  feedBody = capDoc({ severity: 'Moderate' }); await poll(F);
  assert.deepEqual(shows(D_IN), ['own.png'], 'a Moderate alert under an Extreme floor');

  // Event filter and area filter.
  feedBody = capDoc(); await poll(F);
  r = await api('PUT', `/api/cap-feeds/${F}`, { min_severity: 'Minor', events: 'Flood Warning' });
  assert.equal(r.body.live_count, 0);
  r = await api('PUT', `/api/cap-feeds/${F}`, { events: [], area_match: 'Dane' });
  assert.equal(r.body.live_count, 0);
  r = await api('PUT', `/api/cap-feeds/${F}`, { area_match: 'wic133' });
  assert.equal(r.body.live_count, 1, 'an area term matches a geocode too');
  r = await api('PUT', `/api/cap-feeds/${F}`, { area_match: 'waukesha' });
  assert.equal(r.body.live_count, 1, 'or the area text, case-insensitive');
  assert.deepEqual(shows(D_IN), ['CARD']);
});

test('the card, and only the card, carries interrupt: true — on a solo, group and wall screen alike', () => {
  /*
   * QA: the card showed only after the current item finished (every player's #157 deferral, up to
   * 60 s). interrupt:true is the "show this now" flag the players switch on (docs/emergency-alerts.md).
   */
  assert.equal(feeds.cardItem({ widget_id: 'w', name: 'n' }).interrupt, true);
  const WALL = 'wall-cap', D_WALL = 'd-cap-wall', D_WALL2 = 'd-cap-wall2';
  for (const id of [D_WALL, D_WALL2]) {
    db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES (?, ?, ?, ?, ?, ?, 'device')")
      .run(id, ADMIN, WS, id, crypto.randomUUID().slice(0, 6), PL);
  }
  db.prepare('INSERT INTO video_walls (id, user_id, workspace_id, name, leader_device_id) VALUES (?, ?, ?, ?, ?)').run(WALL, ADMIN, WS, 'Atrium', D_WALL);
  db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 0, 0), (?, ?, 1, 0)').run(WALL, D_WALL, WALL, D_WALL2);
  db.prepare('UPDATE devices SET wall_id = ? WHERE id IN (?, ?)').run(WALL, D_WALL, D_WALL2);
  try {
    for (const d of [D_IN, D_GROUP, D_WALL, D_WALL2]) {
      const p = build(d);
      assert.deepEqual(p.assignments.map((a) => [a.widget_type, a.interrupt]), [['cap_alert', true]], d);
    }
    assert.ok(build(D_WALL).wall_config && build(D_WALL2).wall_config, 'still wall payloads');
    // A stray flag in a stored snapshot never reaches a screen: nothing but the card carries it.
    const snap = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(PL).published_snapshot;
    db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(JSON.parse(snap).map((a) => ({ ...a, interrupt: true }))), PL);
    db.prepare('UPDATE cap_feeds SET enabled = 0 WHERE id = ?').run(F);
    try {
      const p = build(D_IN);
      assert.deepEqual(p.assignments.map((a) => a.filename), ['own.png']);
      assert.equal('interrupt' in p.assignments[0], false, 'stripped from an ordinary item');
    } finally {
      db.prepare('UPDATE cap_feeds SET enabled = 1 WHERE id = ?').run(F);
      db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(snap, PL);
    }
  } finally {
    db.prepare('UPDATE devices SET wall_id = NULL WHERE id IN (?, ?)').run(D_WALL, D_WALL2);
    db.prepare('DELETE FROM video_wall_devices WHERE wall_id = ?').run(WALL);
    db.prepare('DELETE FROM video_walls WHERE id = ?').run(WALL);
    db.prepare('DELETE FROM devices WHERE id IN (?, ?)').run(D_WALL, D_WALL2);
  }
});

test('the card escapes third-party text, and its widget is hidden from the library and locked', async () => {
  feedBody = capDoc({ headline: '&lt;img src=x onerror=alert(1)&gt; Tornado' }); await poll(F);
  const wid = db.prepare('SELECT widget_id FROM cap_feeds WHERE id = ?').get(F).widget_id;
  const html = await (await fetch(`${base}/api/widgets/${wid}/render`, { headers: { Authorization: `Bearer ${tokenOf(ADMIN)}` } })).text();
  assert.ok(html.includes('TORNADO WARNING') || html.includes('Tornado Warning'));
  assert.ok(!html.includes('<img src=x'), 'markup from the feed is never live on the card');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; Tornado'));
  const lib = await api('GET', '/api/widgets');
  assert.ok(!lib.body.some((w) => w.id === wid), 'not a library widget');
  const edit = await api('PUT', `/api/widgets/${wid}`, { name: 'x' });
  assert.equal(edit.status, 409); assert.equal(edit.body.code, 'CAP_CARD');
});

test('scope: a group-scoped feed reaches the group only; screens that leave the scope get their playlist back', async () => {
  let r = await api('PUT', `/api/cap-feeds/${F}`, { scopes: [{ scope_kind: 'group', scope_id: G }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.screens_in_scope, 1);
  assert.deepEqual(shows(D_GROUP), ['CARD']);
  assert.deepEqual(shows(D_IN), ['own.png']);
  r = await api('PUT', `/api/cap-feeds/${F}`, { scopes: [{ scope_kind: 'device', scope_id: D_IN }] });
  assert.deepEqual(shows(D_IN), ['CARD']);
  assert.deepEqual(shows(D_GROUP), ['own.png']);
  r = await api('PUT', `/api/cap-feeds/${F}`, { scopes: [{ scope_kind: 'device', scope_id: 'not-mine' }] });
  assert.equal(r.status, 400);
  await api('PUT', `/api/cap-feeds/${F}`, { scopes: [{ scope_kind: 'workspace' }] });
});

test('a feed with a playlist plays it instead of the card (and the card if that playlist is empty)', async () => {
  let r = await api('PUT', `/api/cap-feeds/${F}`, { playlist_id: ALERT_PL });
  assert.equal(r.status, 200);
  assert.deepEqual(shows(D_IN), ['shelter.png']);
  db.prepare("UPDATE playlists SET published_snapshot = '[]' WHERE id = ?").run(ALERT_PL);
  assert.deepEqual(shows(D_IN), ['CARD'], 'an alert must never show nothing');
  r = await api('PUT', `/api/cap-feeds/${F}`, { playlist_id: 'pl-elsewhere' });
  assert.equal(r.status, 400);
  await api('PUT', `/api/cap-feeds/${F}`, { playlist_id: null });
});

test('Update supersedes and Cancel ends what they reference', async () => {
  feedBody = atom(capDoc({ id: 'a1' }), capDoc({ id: 'a2', type: 'Update', refs: 'nws,a1,2026-10-07T19:00:00Z', headline: 'Updated' }));
  await poll(F);
  let live = feeds.liveAlerts(db, db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(F));
  assert.deepEqual(live.map((a) => a.identifier), ['a2']);
  feedBody = atom(capDoc({ id: 'a2' }), capDoc({ id: 'a3', type: 'Cancel', refs: 'nws,a2,2026-10-07T19:00:00Z' }));
  await poll(F);
  live = feeds.liveAlerts(db, db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(F));
  assert.deepEqual(live, []);
  assert.deepEqual(shows(D_IN), ['own.png']);
});

test('⚠️ a feed that cannot be fetched keeps its alerts; expiry still ends them', async () => {
  feedBody = capDoc({ id: 'b1', expires: '2026-10-07T19:30:00Z' });
  await poll(F);
  assert.deepEqual(shows(D_IN), ['CARD']);
  feedDown = true;
  const r = await poll(F);
  assert.equal(r.ok, false);
  assert.match(db.prepare('SELECT last_error FROM cap_feeds WHERE id = ?').get(F).last_error, /could not be reached/);
  assert.deepEqual(shows(D_IN), ['CARD'], 'still shown while the feed is down');
  NOW = Date.parse('2026-10-07T19:31:00Z') / 1000;
  feeds.tick(db);
  assert.deepEqual(shows(D_IN), ['own.png'], 'gone at its own expiry, with no poll');
  feedDown = false;
});

test('an alert that leaves the feed ends; disabling or deleting the feed ends everything', async () => {
  NOW = Date.parse('2026-10-07T19:10:00Z') / 1000;
  feedBody = capDoc({ id: 'c1' }); await poll(F);
  assert.deepEqual(shows(D_IN), ['CARD']);
  feedBody = atom(); await poll(F);
  assert.deepEqual(shows(D_IN), ['own.png'], 'no longer in the feed');
  feedBody = capDoc({ id: 'c2' }); await poll(F);
  await api('PUT', `/api/cap-feeds/${F}`, { enabled: false });
  assert.deepEqual(shows(D_IN), ['own.png']);
  await api('PUT', `/api/cap-feeds/${F}`, { enabled: true });
  assert.deepEqual(shows(D_IN), ['CARD']);
  const wid = db.prepare('SELECT widget_id FROM cap_feeds WHERE id = ?').get(F).widget_id;
  const r = await api('DELETE', `/api/cap-feeds/${F}`);
  assert.equal(r.status, 200);
  assert.deepEqual(shows(D_IN), ['own.png']);
  assert.equal(db.prepare('SELECT 1 FROM widgets WHERE id = ?').get(wid), undefined, 'the card widget goes with the feed');
});

test('the test endpoint reports what a feed would show, without saving anything', async () => {
  feedBody = atom(capDoc({ id: 't1' }), capDoc({ id: 't2', severity: 'Minor' }));
  const before = db.prepare('SELECT COUNT(*) n FROM cap_feeds').get().n;
  const r = await api('POST', '/api/cap-feeds/test', { url: 'https://example.org/feed', min_severity: 'Severe' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 2);
  assert.equal(r.body.would_show, 1);
  assert.equal(r.body.alerts[0].matches && r.body.alerts[0].live, true, 'what would show is listed first');

  // Counted over every alert, not just the 50 listed.
  feedBody = atom(...Array.from({ length: 60 }, (_, i) => capDoc({ id: `m${i}`, severity: i < 55 ? 'Minor' : 'Extreme' })));
  const many = await api('POST', '/api/cap-feeds/test', { url: 'https://example.org/feed', min_severity: 'Severe' });
  assert.equal(many.body.total, 60);
  assert.equal(many.body.would_show, 5);
  assert.equal(many.body.alerts.length, 50);
  assert.ok(many.body.alerts.slice(0, 5).every((a) => a.severity === 'Extreme'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cap_feeds').get().n, before);
  const ed = await api('POST', '/api/cap-feeds/test', { url: 'https://example.org/feed' }, EDITOR);
  assert.equal(ed.status, 403);
});
