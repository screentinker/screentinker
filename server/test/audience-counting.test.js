'use strict';

/*
 * Audience counting (lib/audience.js, routes/audience.js). Counts only, opt-in, off by default.
 * What is pinned here:
 *   - nothing is counted, sent or stored unless the ORG allows it AND the screen (or a group it is
 *     in) is enabled, and only an org owner/admin can do either — a device cannot enable itself
 *   - the ingest path takes a fixed set of bounded integers and refuses a record with ANY other
 *     field (an image, a face, an embedding, a name) or any value that is not a bounded integer
 *   - a resent batch is stored once; every well-formed id is acked so the player's queue drains
 *   - counts cannot be attributed to another workspace's content
 *   - the report aggregates by item / screen / playlist / hour / day beside proof-of-play
 *   - buckets age out by the org's own retention
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-audience-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const deviceSocket = require('../ws/deviceSocket');
const audience = require('../lib/audience');
const commandQueue = require('../lib/command-queue');
// The real device namespace (as server.js sets it up), so a settings change really re-sends payloads.
const { Server } = require('socket.io');
const ioServer = http.createServer();
const io = new Server(ioServer);
deviceSocket(io);

const NOW = Math.floor(Date.now() / 1000);
const MIN = Math.floor(NOW / 60) * 60 - 120;   // a finished minute bucket

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-own', 'own@test', 'Owner', 'user'), ('u-ed', 'ed@test', 'Editor', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'A', 'u-own'), ('org-b', 'B', 'u-own')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'A'), ('ws-b', 'org-b', 'B'), ('ws-hq', 'org-a', 'Head office')").run();
db.prepare("INSERT INTO devices (id, name, status, workspace_id, created_at, capabilities) VALUES ('dev-a', 'Lobby', 'online', 'ws-a', 0, '[\"audience.camera\"]'), ('dev-a2', 'Till', 'online', 'ws-a', 0, NULL), ('dev-b', 'Other', 'online', 'ws-b', 0, NULL)").run();
db.prepare("INSERT INTO content (id, filename, mime_type, workspace_id) VALUES ('c-a', 'promo.jpg', 'image/jpeg', 'ws-a'), ('c-b', 'theirs.jpg', 'image/jpeg', 'ws-b'), ('c-hq', 'brand.jpg', 'image/jpeg', 'ws-hq')").run();
db.prepare("INSERT INTO widgets (id, widget_type, name, config, workspace_id) VALUES ('w-a', 'clock', 'Clock', '{}', 'ws-a')").run();
db.prepare("INSERT INTO playlists (id, name, workspace_id, user_id) VALUES ('pl-a', 'Morning', 'ws-a', 'u-own')").run();
db.prepare("INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES ('g-a', 'u-own', 'ws-a', 'Front')").run();
db.prepare("INSERT INTO device_group_members (device_id, group_id) VALUES ('dev-a2', 'g-a')").run();

const bucket = (id, extra = {}) => ({
  id, start: MIN, seconds: 60, item_kind: 'content', item_id: 'c-a', playlist_id: 'pl-a',
  present_max: 3, present_avg_x100: 150, arrivals: 5, impressions: 4, dwell: [1, 2, 1, 0, 0, 0], ...extra,
});
function send(deviceId, buckets) {
  const replies = [];
  const r = deviceSocket.applyPlayerEvent('audience', deviceId, { device_id: deviceId, buckets },
    { reply: (event, payload) => replies.push({ event, payload }), session: {} });
  assert.equal(r.ok, true);
  assert.equal(replies[0].event, 'device:audience-ack');
  return replies[0].payload;
}
const stored = (dev) => db.prepare('SELECT * FROM audience_buckets WHERE device_id = ? ORDER BY bucket_start, item_id').all(dev);

/* ------------------------------ HTTP harness ------------------------------ */
let server;
after(() => { if (server) server.close(); io.close(); ioServer.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
async function call(method, p, { as = 'owner', ws = 'ws-a', org = 'org-a', body } = {}) {
  if (!server) {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const who = req.headers['x-as'];
      req.user = { id: who === 'editor' ? 'u-ed' : 'u-own' };
      req.orgRole = who === 'owner' ? 'org_owner' : null;
      req.workspaceRole = who === 'editor' ? 'workspace_editor' : (who === 'owner' ? 'workspace_admin' : null);
      req.workspaceId = req.headers['x-ws'] || null;
      req.organizationId = req.headers['x-org'] || null;
      next();
    });
    app.set('io', io);
    app.use('/api/audience', require('../routes/audience'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/audience${p}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-as': as, ...(ws ? { 'x-ws': ws } : {}), ...(org ? { 'x-org': org } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

/* ------------------------------ tests ------------------------------ */

test('OFF BY DEFAULT: no config in the payload, and counts from the screen are thrown away', () => {
  assert.equal(audience.payloadConfig('dev-a'), null);
  assert.equal(deviceSocket.buildPlaylistPayload('dev-a').audience, null, 'the player is told OFF');
  const ack = send('dev-a', [bucket('m1')]);
  assert.deepEqual(ack, { ids: ['m1'], written: 0 }, 'acked so the queue drains, but nothing stored');
  assert.equal(stored('dev-a').length, 0);
});

test('only an org owner/admin can allow it or switch a screen on; a screen needs the org switch first', async () => {
  let r = await call('PUT', '/devices/dev-a', { body: { enabled: true } });
  assert.equal(r.status, 409, 'the org must allow it first');
  assert.equal(r.body.code, 'not_allowed');

  r = await call('PUT', '/settings', { as: 'editor', body: { allowed: true } });
  assert.equal(r.status, 403, 'a workspace editor cannot');
  r = await call('PUT', '/settings', { body: { allowed: 'yes' } });
  assert.equal(r.status, 400);
  r = await call('PUT', '/settings', { body: { fps: 30 } });
  assert.equal(r.status, 400, 'fps is bounded');
  r = await call('PUT', '/settings', { body: { allowed: true, fps: 3, retention_days: 30 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.allowed, true);
  assert.equal(r.body.show_indicator, true, 'the on-screen indicator defaults ON');

  assert.equal(audience.payloadConfig('dev-a'), null, 'allowed is not the same as on: the screen is still off');
  r = await call('PUT', '/devices/dev-a', { as: 'editor', body: { enabled: true } });
  assert.equal(r.status, 403);
  r = await call('PUT', '/devices/dev-b', { body: { enabled: true } });
  assert.equal(r.status, 404, "another organization's screen does not exist here");
  commandQueue._resetForTests && commandQueue._resetForTests();
  r = await call('PUT', '/devices/dev-a', { body: { enabled: true } });
  assert.equal(r.status, 200);
  assert.equal(commandQueue.getQueueDepth('dev-a'), 1, 'the (offline) screen has a payload re-send waiting for it');
  assert.deepEqual(deviceSocket.buildPlaylistPayload('dev-a').audience, { enabled: true, fps: 3, min_dwell_ms: 1000, bucket_sec: 60, show_indicator: true });

  // Through a GROUP.
  assert.equal(audience.payloadConfig('dev-a2'), null);
  r = await call('PUT', '/groups/g-a', { body: { enabled: true } });
  assert.equal(r.status, 200);
  assert.ok(audience.payloadConfig('dev-a2'), 'a member of an enabled group counts');
  const log = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'audience_%'").all().map((x) => x.action);
  assert.ok(log.includes('audience_settings_updated') && log.includes('audience_enabled'), 'every switch is audited');
});

test('a resent batch is stored once, and attribution stays in the workspace', () => {
  let ack = send('dev-a', [bucket('m1'), bucket('m2', { item_kind: 'widget', item_id: 'w-a', playlist_id: undefined })]);
  assert.deepEqual(ack, { ids: ['m1', 'm2'], written: 2 });
  ack = send('dev-a', [bucket('m1'), bucket('m2', { item_kind: 'widget', item_id: 'w-a', playlist_id: undefined })]);
  assert.equal(ack.written, 0, 'the lost-ack resend is not counted twice');
  ack = send('dev-a', [bucket('m3', { start: MIN - 60, item_id: 'c-b', playlist_id: 'pl-zz' })]);
  assert.equal(ack.written, 1);
  const r = stored('dev-a').find((x) => x.bucket_start === MIN - 60);
  assert.equal(r.item_kind, 'none', "another workspace's content id is not kept");
  assert.equal(r.playlist_id, null);
  assert.equal(r.arrivals, 5, 'the counts themselves are still the screen\'s');
  // Head office (corporate) or an automation override puts ANOTHER workspace of the same org on screen.
  ack = send('dev-a', [bucket('m4', { start: MIN - 120, item_id: 'c-hq' })]);
  assert.equal(ack.written, 1);
  const hq = stored('dev-a').find((x) => x.bucket_start === MIN - 120);
  assert.equal(hq.item_kind, 'content');
  assert.equal(hq.item_id, 'c-hq', 'same organization: kept');
});

test('PRIVACY: a record with ANY field beyond the counts, or any non-integer, is refused whole', () => {
  const bad = [
    bucket('x1', { start: MIN - 600, image: 'data:image/jpeg;base64,/9j/4AAQ' }),
    bucket('x2', { start: MIN - 660, face: { x: 1, y: 2 } }),
    bucket('x3', { start: MIN - 720, embedding: [0.1, 0.2] }),
    bucket('x4', { start: MIN - 780, person_id: 'abc' }),
    bucket('x5', { start: MIN - 840, arrivals: '5' }),
    bucket('x6', { start: MIN - 900, arrivals: 2.5 }),
    bucket('x7', { start: MIN - 960, present_max: 100000 }),
    bucket('x8', { start: MIN - 1020, impressions: 9, arrivals: 3 }),
    bucket('x9', { start: MIN - 1080, dwell: [1, 2, 3] }),
    bucket('x10', { start: MIN - 1140, dwell: [1, 2, 3, 4, 5, 'x'] }),
    bucket('x11', { start: NOW + 3600 }),
    bucket('x12', { start: MIN - 40 * 86400 }),
    bucket('x13', { start: MIN + 7 }),
    bucket('x14', { start: MIN - 1200, present_avg_x100: 900, present_max: 2 }),
    bucket('x15', { start: MIN - 1260, item_kind: 'person' }),
    { id: 'x16' },
  ];
  const ack = send('dev-a', bad);
  assert.equal(ack.written, 0);
  assert.equal(ack.ids.length, bad.length, 'every well-formed id is acked so the queue cannot wedge');
  const cols = db.prepare("SELECT name, type FROM pragma_table_info('audience_buckets')").all();
  const text = cols.filter((c) => /TEXT|BLOB/i.test(c.type)).map((c) => c.name).sort();
  assert.deepEqual(text, ['device_id', 'item_id', 'item_kind', 'playlist_id', 'workspace_id'],
    'the table has no column that could hold an image, a face or a person');
});

test('the report: by item with plays beside it, by screen, playlist, hour and day; CSV export', async () => {
  db.prepare("INSERT INTO play_logs (device_id, content_id, workspace_id, started_at) VALUES ('dev-a', 'c-a', 'ws-a', ?), ('dev-a', 'c-a', 'ws-a', ?)").run(MIN, MIN + 10);
  const r = await call('GET', `/report?start=${MIN - 86400}&end=${NOW}&tz=0`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.overall.arrivals, 20);
  assert.equal(r.body.overall.impressions, 16);
  assert.equal(r.body.overall.peak_present, 3);
  const promo = r.body.by_item.find((i) => i.item_id === 'c-a');
  assert.equal(promo.item_name, 'promo.jpg');
  assert.equal(promo.plays, 2);
  assert.equal(promo.impressions_per_play, 2);
  assert.ok(promo.avg_dwell_sec > 1 && promo.avg_dwell_sec < 10);
  assert.equal(r.body.by_item.find((i) => i.item_kind === 'widget').item_name, 'Clock');
  assert.equal(r.body.by_device[0].device_name, 'Lobby');
  assert.equal(r.body.by_playlist[0].playlist_name, 'Morning');
  assert.equal(r.body.by_hour.length, 24);
  assert.equal(r.body.by_hour.reduce((n, h) => n + h.impressions, 0), 16);
  assert.equal(r.body.by_day.reduce((n, d) => n + d.arrivals, 0), 20);

  const other = await call('GET', `/report?start=${MIN - 86400}&end=${NOW}`, { ws: 'ws-b', org: 'org-b' });
  assert.equal(other.body.overall.arrivals, 0, 'workspace B sees none of A');

  const csv = await call('GET', `/export.csv?start=${MIN - 86400}&end=${NOW}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.body.trim().split('\n');
  assert.equal(lines.length, 5, 'header + four minutes');
  assert.match(lines[0], /^minute_utc,bucket_sec,device_id/);

  assert.equal((await call('GET', '/report?start=nope')).status, 400);
});

test('formula injection in a name is neutralised in the CSV', () => {
  const csv = audience.toCsv([{ bucket_start: MIN, bucket_sec: 60, device_id: 'd', device_name: '=HYPERLINK("x")', item_kind: 'none',
    item_id: null, item_name: null, playlist_id: null, present_max: 0, present_avg_x100: 0, arrivals: 0, impressions: 0, d0: 0, d1: 0, d2: 0, d3: 0, d4: 0, d5: 0 }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});

test('switching the org OFF stops every screen, and its counts are refused from then on', async () => {
  const r = await call('PUT', '/settings', { body: { allowed: false } });
  assert.equal(r.status, 200);
  assert.equal(audience.payloadConfig('dev-a'), null);
  assert.equal(audience.payloadConfig('dev-a2'), null);
  const ack = send('dev-a', [bucket('late', { start: MIN - 1800 })]);
  assert.equal(ack.written, 0);
});

test('retention: buckets older than the org retention are purged; others are kept', () => {
  db.prepare(`INSERT INTO audience_buckets (device_id, workspace_id, bucket_start, bucket_sec, item_kind, item_id, present_max, present_avg_x100, arrivals, impressions, d0, d1, d2, d3, d4, d5)
    VALUES ('dev-a', 'ws-a', ?, 60, 'none', '', 1, 100, 1, 1, 1, 0, 0, 0, 0, 0), ('dev-b', 'ws-b', ?, 60, 'none', '', 1, 100, 1, 1, 1, 0, 0, 0, 0, 0)`)
    .run(NOW - 31 * 86400 - (NOW % 60), NOW - 31 * 86400 - (NOW % 60));
  const before = db.prepare('SELECT COUNT(*) AS n FROM audience_buckets').get().n;
  const gone = audience.purgeExpired();
  assert.equal(gone, 1, 'org A keeps 30 days, so its 31-day-old bucket goes; org B keeps the 90-day default');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audience_buckets').get().n, before - 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audience_buckets WHERE device_id = 'dev-b'").get().n, 1);
});

test('the capability is understood, and the event is relayable like every other report', () => {
  const caps = require('../lib/player-capabilities');
  assert.deepEqual(caps.parseDeclared(['audience.camera']), ['audience.camera']);
  assert.ok(deviceSocket.PLAYER_EVENT_KINDS.includes('audience'));
});
