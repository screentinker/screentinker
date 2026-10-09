'use strict';

/*
 * Meeting-room displays (lib/rooms): the logic, in-process, against a real database file and a fake
 * Microsoft Graph / Google Calendar (test/helpers/room-calendar-mock.js) behind global.fetch.
 *
 *   - free/busy: back-to-back and overlapping meetings, all-day blocks, a meeting ending NOW, free
 *     ("showAs: free") events, and day boundaries across DST and far-off zones
 *   - adapters: Graph mapping and token caching; the Google JWT's claims, signature and the fixed
 *     token endpoint (never the key's own token_uri); ICS recurrences, CLASS:PRIVATE and TRANSP
 *   - privacy applied before anything leaves the server
 *   - book now: refused when busy, clamped to the next meeting, refused when the gap is too short;
 *     end early: panel meetings shortened, others only with the org rule (and then declined)
 *   - check-in and auto-release — only while a screen that could check in shows the room; Google
 *     releases decline, never delete, and never touch a meeting the room organises
 *   - paging: Graph @odata.nextLink and Google nextPageToken, capped, on fixed hosts only
 *   - a workspace admin may point a room only at a calendar the connection lists
 *   - the cache, backoff, and last-good copy on upstream errors
 *   - the panel capability: bound to widget, device AND the device's token
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-unit-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ROOMS_MS_LOGIN_BASE = 'http://mock/ms';
process.env.ROOMS_GRAPH_BASE = 'http://mock/graph';
process.env.ROOMS_GOOGLE_TOKEN_URL = 'http://mock/google/token';
process.env.ROOMS_GOOGLE_CALENDAR_BASE = 'http://mock/gcal';
process.env.ROOMS_GOOGLE_DIRECTORY_BASE = 'http://mock/gdir';

const { createMock, GOOD_SECRET } = require('./helpers/room-calendar-mock');
let mock = createMock();
const realFetch = global.fetch;
global.fetch = (...a) => mock.fetch(...a);

const { db } = require('../db/database');
const secretbox = require('../lib/secretbox');
const fb = require('../lib/rooms/freebusy');
const graph = require('../lib/rooms/graph');
const google = require('../lib/rooms/google');
const ics = require('../lib/rooms/ics');
const svc = require('../lib/rooms/service');

const MIN = 60000;
// A fixed, timezone-neutral "now": Thursday 2026-10-08 10:07:30 UTC.
const NOW = Date.parse('2026-10-08T10:07:30Z');
let now = NOW;
svc._setClock(() => now);

const ORG = 'org-rooms', WS = 'ws-rooms', USER = 'u-rooms';
let CONN_M, CONN_G, ROOM_M, ROOM_G;

function googleKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { type: 'service_account', client_email: 'rooms@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://evil.example/token' };
}
const KEY = googleKey();

before(() => {
  db.prepare("INSERT INTO users (id, email) VALUES (?, 'rooms@test')").run(USER);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Acme', ?)").run(ORG, USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'HQ')").run(WS, ORG);
  CONN_M = crypto.randomUUID();
  db.prepare(`INSERT INTO room_connections (id, organization_id, kind, name, tenant_id, client_id, secret_enc)
    VALUES (?, ?, 'm365', 'M365', 'acme.onmicrosoft.com', 'app-id', ?)`).run(CONN_M, ORG, secretbox.encrypt(GOOD_SECRET));
  CONN_G = crypto.randomUUID();
  db.prepare(`INSERT INTO room_connections (id, organization_id, kind, name, client_id, secret_enc, subject)
    VALUES (?, ?, 'google', 'Google', ?, ?, 'admin@acme.test')`).run(CONN_G, ORG, KEY.client_email, secretbox.encrypt(KEY.private_key));
  ROOM_M = crypto.randomUUID();
  db.prepare(`INSERT INTO rooms (id, workspace_id, name, source, connection_id, calendar_id, timezone) VALUES (?, ?, 'Boardroom', 'm365', ?, 'boardroom@acme.test', 'Europe/London')`).run(ROOM_M, WS, CONN_M);
  ROOM_G = crypto.randomUUID();
  db.prepare(`INSERT INTO rooms (id, workspace_id, name, source, connection_id, calendar_id, timezone) VALUES (?, ?, 'Room 1', 'google', ?, 'c_room1@resource.calendar.google.com', 'America/New_York')`).run(ROOM_G, WS, CONN_G);
});

beforeEach(() => {
  mock = createMock();
  now = NOW;
  svc._reset();
  db.prepare('UPDATE rooms SET cache_json = NULL, cache_at = NULL, last_error = NULL, error_count = 0, next_poll_at = NULL, details = \'private_hidden\', allow_booking = 1').run();
  db.prepare('DELETE FROM room_bookings').run();
  db.prepare('DELETE FROM room_checkins').run();
  db.prepare('DELETE FROM room_panel_presence').run();
  db.prepare('UPDATE organizations SET room_end_any = 0, room_release_min = 0 WHERE id = ?').run(ORG);
});

after(() => {
  global.fetch = realFetch;
  try { db.close(); } catch { /* */ }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const room = (id) => db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);

/*
 * A screen showing a room: a device, a room-display widget for that room, and the page's "seen"
 * report. Defaults to an online Android panel declaring room.panel; pass overrides for the others.
 */
function showOn(roomId, { caps = ['playback.widget', 'room.panel'], status = 'online', clientType = 'apk', platform = null, ws = WS, widgetRoom = roomId } = {}) {
  const dev = crypto.randomUUID();
  const w = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, platform, capabilities)
    VALUES (?, 'Panel', ?, ?, ?, ?, ?, ?)`).run(dev, status, ws, crypto.randomBytes(8).toString('hex'), clientType, platform, caps == null ? null : JSON.stringify(caps));
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, 'room-display', 'Door', ?)")
    .run(w, USER, ws, JSON.stringify({ room_id: widgetRoom }));
  svc.recordPresence(room(roomId), w, dev);
  return { dev, w };
}
const ev = (id, startMin, endMin, extra = {}) => ({ id, start: NOW + startMin * MIN, end: NOW + endMin * MIN, ...extra });
const graphEvent = (id, startMin, endMin, extra = {}) => ({
  id, subject: `Meeting ${id}`, organizer: { emailAddress: { name: 'Sam Organiser', address: 'sam@acme.test' } },
  start: NOW + startMin * MIN, end: NOW + endMin * MIN, isAllDay: false, showAs: 'busy', sensitivity: 'normal', ...extra,
});

/* ================================ free/busy ================================ */

test('free/busy: free until the next meeting, then busy until a back-to-back run ends', () => {
  const evs = [ev('a', 23, 53), ev('b', 53, 83), ev('c', 120, 150)];
  let s = fb.computeRoomState(evs, NOW);
  assert.equal(s.busy, false);
  assert.equal(s.freeUntil, NOW + 23 * MIN);
  assert.equal(s.next.id, 'a');
  s = fb.computeRoomState(evs, NOW + 30 * MIN);
  assert.equal(s.busy, true);
  assert.equal(s.current.id, 'a');
  assert.equal(s.busyUntil, NOW + 83 * MIN, 'a meeting that starts as another ends keeps the room busy');
  assert.equal(s.next.id, 'b');
});

test('free/busy: a meeting is over AT its end time, and one starting then has begun', () => {
  const evs = [ev('a', -30, 0), ev('b', 0, 30)];
  const s = fb.computeRoomState(evs, NOW);
  assert.equal(s.current.id, 'b');
  assert.equal(fb.computeRoomState([ev('a', -30, 0)], NOW).busy, false);
});

test('free/busy: overlapping meetings show the most specific one, and the room is busy until both end', () => {
  const allDay = { id: 'block', start: NOW - 10 * 3600000, end: NOW + 14 * 3600000, allDay: true };
  const s = fb.computeRoomState([allDay, ev('m', -7, 23), ev('o', 10, 40)], NOW);
  assert.equal(s.current.id, 'm', 'a timed meeting inside an all-day block is the news');
  assert.equal(s.busyUntil, allDay.end);
  const s2 = fb.computeRoomState([ev('x', -20, 30), ev('y', -5, 10)], NOW);
  assert.equal(s2.current.id, 'y', 'the latest to have started');
  assert.equal(s2.busyUntil, NOW + 30 * MIN);
});

test('free/busy: free and cancelled events do not occupy the room; nonsense intervals are ignored', () => {
  const s = fb.computeRoomState([ev('f', -10, 50, { free: true }), ev('c', -10, 50, { cancelled: true }), ev('z', 10, 10), ev('n', 5, 2)], NOW);
  assert.equal(s.busy, false);
  assert.equal(s.next, null);
  assert.equal(s.freeUntil, null, 'free for the window');
});

test('day bounds follow the zone, including 23- and 25-hour DST days', () => {
  const b1 = fb.dayBounds('Europe/London', Date.parse('2026-03-29T12:00:00Z'));
  assert.equal(b1.end - b1.start, 23 * 3600000);
  const b2 = fb.dayBounds('Europe/London', Date.parse('2026-10-25T12:00:00Z'));
  assert.equal(b2.end - b2.start, 25 * 3600000);
  assert.equal(new Date(fb.dayBounds('America/New_York', Date.parse('2026-10-08T03:00:00Z')).start).toISOString(), '2026-10-07T04:00:00.000Z');
  assert.equal(new Date(fb.dayBounds('Pacific/Kiritimati', Date.parse('2026-10-08T12:00:00Z')).start).toISOString(), '2026-10-08T10:00:00.000Z');
});

/* ================================ adapters ================================ */

test('Graph: events are read from the room mailbox in UTC and mapped; the token is cached', async () => {
  mock.state.graph['boardroom@acme.test'] = [
    graphEvent('1', 23, 53),
    graphEvent('2', 60, 90, { showAs: 'free' }),
    graphEvent('3', 100, 130, { sensitivity: 'private' }),
    graphEvent('4', 140, 150, { responseStatus: { response: 'declined' } }),
    graphEvent('5', 160, 170, { isCancelled: true }),
  ];
  const conn = svc.connectionFor(CONN_M, ORG);
  const list = await graph.events(conn, 'boardroom@acme.test', NOW - 3600000, NOW + 86400000);
  assert.deepEqual(list.map((e) => e.id), ['1', '2', '3', '4']);
  assert.equal(list[0].start, NOW + 23 * MIN);
  assert.equal(list[0].organiser, 'Sam Organiser');
  assert.equal(list[1].free, true);
  assert.equal(list[2].private, true);
  assert.equal(list[3].free, true, 'a meeting the room declined no longer occupies it');
  const view = mock.state.requests.find((r) => /calendarView/.test(r.path));
  assert.match(view.auth, /^Bearer ms-acme\.onmicrosoft\.com-/);
  await graph.events(conn, 'boardroom@acme.test', NOW, NOW + 1);
  assert.equal(mock.state.requests.filter((r) => /oauth2/.test(r.path)).length, 1, 'one token for both calls');
});

test('Graph: the multi-tenant aliases are refused, and a bad secret surfaces Microsoft’s own reason', async () => {
  assert.equal(graph.validTenant('common'), false);
  assert.equal(graph.validTenant('organizations'), false);
  assert.equal(graph.validTenant('00000000-0000-0000-0000-000000000000'), true);
  assert.equal(graph.validTenant('acme.onmicrosoft.com'), true);
  const conn = { ...svc.connectionFor(CONN_M, ORG), secret: 'wrong', updated_at: 'x' };
  await assert.rejects(graph.test(conn), /Invalid client secret/);
});

test('Google: the JWT is RS256, carries the right claims, and goes to the FIXED token endpoint', async () => {
  const conn = svc.connectionFor(CONN_G, ORG);
  await google.events(conn, 'c_room1@resource.calendar.google.com', NOW, NOW + 3600000, 'America/New_York');
  assert.equal(mock.state.assertions.length, 1);
  const { header, claims, jwt } = mock.state.assertions[0];
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.iss, KEY.client_email);
  assert.equal(claims.sub, 'admin@acme.test');
  assert.equal(claims.scope, google.SCOPE_RW);
  assert.equal(claims.aud, 'http://mock/google/token', 'the key’s own token_uri is never used');
  assert.equal(claims.exp - claims.iat, 3600);
  const [h, c, sig] = jwt.split('.');
  const pub = crypto.createPublicKey(KEY.private_key);
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(pub, Buffer.from(sig, 'base64url')));
  assert.ok(!mock.state.requests.some((r) => /evil\.example/.test(r.path)));
});

test('Google: a read-only connection asks for the read-only scope, and parseKey refuses non-keys', async () => {
  const conn = { ...svc.connectionFor(CONN_G, ORG), read_only: 1, updated_at: 'ro' };
  await google.events(conn, 'x@y', NOW, NOW + 1, 'UTC');
  assert.equal(mock.state.assertions[0].claims.scope, google.SCOPE_RO);
  assert.match(google.parseKey('{"type":"authorized_user"}').error, /service account/);
  assert.match(google.parseKey('nope').error, /not a service account/);
  assert.equal(google.parseKey(JSON.stringify(KEY)).client_email, KEY.client_email);
});

test('Google: an all-day date is midnight in the ROOM’s zone; transparent and declined events are free', () => {
  const e = google.mapEvent({ id: 'a', summary: 'Offsite', start: { date: '2026-10-08' }, end: { date: '2026-10-09' } }, 'cal', 'America/New_York');
  assert.equal(new Date(e.start).toISOString(), '2026-10-08T04:00:00.000Z');
  assert.equal(e.allDay, true);
  assert.equal(google.mapEvent({ id: 'b', start: { dateTime: '2026-10-08T10:00:00Z' }, end: { dateTime: '2026-10-08T11:00:00Z' }, transparency: 'transparent' }, 'cal', 'UTC').free, true);
  assert.equal(google.mapEvent({ id: 'c', start: { dateTime: '2026-10-08T10:00:00Z' }, end: { dateTime: '2026-10-08T11:00:00Z' }, attendees: [{ email: 'cal', resource: true, responseStatus: 'declined' }] }, 'cal', 'UTC').free, true);
  assert.equal(google.mapEvent({ id: 'd', status: 'cancelled' }, 'cal', 'UTC'), null);
  assert.equal(google.mapEvent({ id: 'e', visibility: 'private', start: { dateTime: '2026-10-08T10:00:00Z' }, end: { dateTime: '2026-10-08T11:00:00Z' } }, 'cal', 'UTC').private, true);
});

test('ICS: recurrences expand, CLASS:PRIVATE is private, TRANSP:TRANSPARENT is free', async () => {
  // Tomorrow, so the resolver's "drop what is already over" filter cannot race a run near midnight UTC.
  const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  ics._setFetcher(async () => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:daily-1', `DTSTART:${today}T120000Z`, `DTEND:${today}T123000Z`, 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Stand-up', 'ORGANIZER;CN="Pat Lead":mailto:pat@acme.test', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:secret-1', `DTSTART:${today}T130000Z`, `DTEND:${today}T133000Z`, 'SUMMARY:Board pay review', 'CLASS:PRIVATE', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:hold-1', `DTSTART:${today}T140000Z`, `DTEND:${today}T143000Z`, 'SUMMARY:Tentative hold', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
  try {
    const list = await ics.events('https://cal.example/room.ics', 'UTC');
    const daily = list.filter((e) => e.title === 'Stand-up');
    assert.ok(daily.length >= 2, 'occurrences in the two-day window');
    assert.notEqual(daily[0].id, daily[1].id, 'each occurrence has its own id');
    assert.equal(daily[0].organiser, 'Pat Lead');
    assert.equal(list.find((e) => e.title === 'Board pay review').private, true);
    assert.equal(list.find((e) => e.title === 'Tentative hold').free, true);
  } finally { ics._setFetcher(null); }
});

/* ================================ privacy ================================ */

test('privacy: a private meeting’s title and organiser never leave the server; "hidden" hides every one', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('pub', -7, 23), graphEvent('priv', 40, 70, { subject: 'Redundancy planning', sensitivity: 'private' })];
  let st = await svc.panelState(room(ROOM_M));
  const text = JSON.stringify(st);
  assert.ok(!text.includes('Redundancy planning'));
  assert.equal(st.events.find((e) => e.id === 'priv').title, null);
  assert.equal(st.events.find((e) => e.id === 'priv').organiser, null);
  assert.equal(st.events.find((e) => e.id === 'pub').title, 'Meeting pub');
  db.prepare("UPDATE rooms SET details = 'hidden' WHERE id = ?").run(ROOM_M);
  st = await svc.panelState(room(ROOM_M));
  assert.ok(!JSON.stringify(st).includes('Meeting pub'));
  assert.ok(!JSON.stringify(st).includes('Sam Organiser'));
  db.prepare("UPDATE rooms SET details = 'shown' WHERE id = ?").run(ROOM_M);
  st = await svc.panelState(room(ROOM_M));
  assert.equal(st.events.find((e) => e.id === 'priv').title, 'Redundancy planning');
});

/* ================================ booking ================================ */

test('book now: creates a meeting in the room from this minute, clamped to the next meeting', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('next', 23, 53)];
  const r = await svc.book(room(ROOM_M), 'dev-1', 60);
  assert.equal(r.start, Date.parse('2026-10-08T10:07:00Z'), 'from the start of this minute');
  assert.equal(r.end, NOW + 23 * MIN, 'never into the next meeting');
  const created = mock.state.requests.find((x) => x.method === 'POST' && /\/events$/.test(x.path));
  assert.equal(created.body.subject, svc.PANEL_TITLE);
  const st = await svc.panelState(room(ROOM_M));
  const mine = st.events.find((e) => e.id === r.event_id);
  assert.equal(mine.panel, true);
  assert.equal(mine.checked_in, true, 'someone was standing at the panel');
});

test('book now: refused while busy, and when the next meeting is under five minutes away', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('now', -7, 23)];
  await assert.rejects(svc.book(room(ROOM_M), 'dev-1', 15), (e) => e.code === 'busy');
  mock.state.graph['boardroom@acme.test'] = [graphEvent('soon', 3, 30)];
  await assert.rejects(svc.book(room(ROOM_M), 'dev-1', 15), (e) => e.code === 'too-short');
  await assert.rejects(svc.book(room(ROOM_M), 'dev-1', 45), (e) => e.code === 'bad-minutes');
  assert.ok(!mock.state.requests.some((x) => x.method === 'POST' && /\/events$/.test(x.path)), 'nothing was created');
});

test('book now: the check is against a FRESH copy, so a meeting booked elsewhere a moment ago wins', async () => {
  mock.state.graph['boardroom@acme.test'] = [];
  await svc.panelState(room(ROOM_M));                 // cache: free
  mock.state.graph['boardroom@acme.test'] = [graphEvent('just-booked', -1, 30)];
  await assert.rejects(svc.book(room(ROOM_M), 'dev-1', 15), (e) => e.code === 'busy');
});

test('book now: two taps at once create ONE meeting', async () => {
  mock.state.graph['boardroom@acme.test'] = [];
  const results = await Promise.allSettled([svc.book(room(ROOM_M), 'dev-1', 30), svc.book(room(ROOM_M), 'dev-2', 30)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'busy');
});

test('book now: refused for a read-only room, a room with booking off, and an ICS room', async () => {
  db.prepare('UPDATE rooms SET allow_booking = 0 WHERE id = ?').run(ROOM_M);
  await assert.rejects(svc.book(room(ROOM_M), 'd', 15), (e) => e.code === 'booking-off');
  db.prepare('UPDATE rooms SET allow_booking = 1 WHERE id = ?').run(ROOM_M);
  db.prepare('UPDATE room_connections SET read_only = 1 WHERE id = ?').run(CONN_M);
  try { await assert.rejects(svc.book(room(ROOM_M), 'd', 15), (e) => e.code === 'booking-off'); }
  finally { db.prepare('UPDATE room_connections SET read_only = 0 WHERE id = ?').run(CONN_M); }
  await assert.rejects(svc.book({ ...room(ROOM_M), source: 'ics' }, 'd', 15), (e) => e.code === 'read-only');
});

test('book now on Google: created on the resource calendar', async () => {
  const r = await svc.book(room(ROOM_G), 'dev-1', 15);
  const list = mock.state.google['c_room1@resource.calendar.google.com'];
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r.event_id);
  assert.equal(Date.parse(list[0].end.dateTime) - Date.parse(list[0].start.dateTime), 15 * MIN);
});

/* ================================ ending ================================ */

test('end early: a meeting booked at the panel is shortened to end now', async () => {
  mock.state.graph['boardroom@acme.test'] = [];
  const b = await svc.book(room(ROOM_M), 'dev-1', 60);
  now = NOW + 12 * MIN;
  await svc.endMeeting(room(ROOM_M), 'dev-1', b.event_id);
  const e = mock.state.graph['boardroom@acme.test'].find((x) => x.id === b.event_id);
  assert.equal(e.end, Date.parse('2026-10-08T10:19:00Z'));
  assert.equal((await svc.panelState(room(ROOM_M))).events.filter((x) => x.end > now).length, 0);
});

test('end early: someone else’s meeting is refused, unless the org allows it — then the room declines it', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('theirs', -7, 23)];
  await assert.rejects(svc.endMeeting(room(ROOM_M), 'dev-1', 'theirs'), (e) => e.code === 'not-panel');
  assert.ok(!mock.state.requests.some((r) => /decline/.test(r.path)));
  db.prepare('UPDATE organizations SET room_end_any = 1 WHERE id = ?').run(ORG);
  await svc.endMeeting(room(ROOM_M), 'dev-1', 'theirs');
  const dec = mock.state.requests.find((r) => /\/events\/theirs\/decline$/.test(r.path));
  assert.equal(dec.body.sendResponse, true, 'the organiser is told');
  const st = await svc.panelState(room(ROOM_M));
  assert.ok(!st.events.some((e) => e.id === 'theirs'));
});

// Reported from a ThinkSmart View: Book, then End a few seconds later, and the panel kept saying
// "In use" for up to a minute. The calendar needs the meeting to end after it starts, so it keeps a
// one-minute stub; the panel must not show that stub as the room being in use.
test('end early: a meeting ended the minute it was booked frees the panel at once', async () => {
  mock.state.graph['boardroom@acme.test'] = [];
  const b = await svc.book(room(ROOM_M), 'dev-1', 30);
  now = NOW + 15 * 1000;
  await svc.endMeeting(room(ROOM_M), 'dev-1', b.event_id);
  const e = mock.state.graph['boardroom@acme.test'].find((x) => x.id === b.event_id);
  assert.equal(e.end, Date.parse('2026-10-08T10:08:00Z'), 'the calendar keeps a one-minute meeting');
  const st = await svc.panelState(room(ROOM_M));
  assert.equal(fb.computeRoomState(st.events, now).busy, false, 'the panel shows the room free now');
  await assert.rejects(svc.endMeeting(room(ROOM_M), 'dev-1', b.event_id), (x) => x.code === 'not-current', 'a second tap ends nothing');
  const again = await svc.book(room(ROOM_M), 'dev-1', 15);
  assert.ok(again.event_id && again.event_id !== b.event_id, 'and the room can be booked again straight away');
});

// Exchange can answer a calendarView with the meeting as it was for a few seconds after a change.
// That copy was cached as fresh for a minute, so the panel showed the old state until it expired.
test('end early and book now: a calendar that is a moment behind does not undo what the panel just did', async () => {
  mock.state.graph['boardroom@acme.test'] = [];
  const lag = () => {
    const inner = mock.fetch;
    let snapshot = null;
    mock.fetch = async (url, opts) => {
      if (/calendarView/.test(String(url)) && snapshot) {
        const live = mock.state.graph['boardroom@acme.test'];
        mock.state.graph['boardroom@acme.test'] = snapshot;
        try { return await inner(url, opts); } finally { mock.state.graph['boardroom@acme.test'] = live; }
      }
      return inner(url, opts);
    };
    return { freeze() { snapshot = JSON.parse(JSON.stringify(mock.state.graph['boardroom@acme.test'])); }, thaw() { snapshot = null; mock.fetch = inner; } };
  };
  const l = lag();
  l.freeze();                                       // every read now returns the calendar as it is here: empty
  const b = await svc.book(room(ROOM_M), 'dev-1', 60);
  let st = await svc.panelState(room(ROOM_M));
  assert.equal(fb.computeRoomState(st.events, now).busy, true, 'the booking shows although the calendar has not caught up');
  l.thaw();
  now = NOW + 12 * MIN;
  await svc.panelState(room(ROOM_M));               // cache refreshed: the booking is there
  l.freeze();                                       // ... and stays there in every read after the end
  await svc.endMeeting(room(ROOM_M), 'dev-1', b.event_id);
  st = await svc.panelState(room(ROOM_M));
  assert.equal(fb.computeRoomState(st.events, now).busy, false, 'the end shows although the calendar has not caught up');
  l.thaw();
});

test('cache: a forced read after a change never joins a read that began before it', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('a', -7, 23)];
  const inner = mock.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = false;
  mock.fetch = async (url, opts) => {
    if (/calendarView/.test(String(url)) && !held) { held = true; const r = await inner(url, opts); await gate; return r; }
    return inner(url, opts);
  };
  const early = svc.getDay(ROOM_M);                 // a panel's poll, on its way with the old calendar
  await new Promise((r) => setImmediate(r));
  mock.state.graph['boardroom@acme.test'][0].end = NOW;   // the change lands upstream
  const forced = svc.getDay(ROOM_M, { force: true });
  release();
  assert.equal((await early).events[0].end, NOW + 23 * MIN, 'the poll got what it asked for');
  assert.equal((await forced).events[0].end, NOW, 'the forced read saw the change');
  mock.fetch = inner;
});

test('end early: only the meeting actually in progress', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('later', 30, 60)];
  db.prepare('UPDATE organizations SET room_end_any = 1 WHERE id = ?').run(ORG);
  await assert.rejects(svc.endMeeting(room(ROOM_M), 'dev-1', 'later'), (e) => e.code === 'not-current');
});

/* ================================ check-in and release ================================ */

test('auto-release: off by default; on, it releases only an unattended meeting, once, and only near its deadline', async () => {
  mock.state.graph['boardroom@acme.test'] = [
    graphEvent('nobody', -7, 53),        // started 7 min ago
    graphEvent('present', -7, 53),       // checked in
    graphEvent('old', -120, 60),         // started 2 h ago: never released this late
    graphEvent('allday', -600, 800, { isAllDay: true }),
  ];
  await svc.panelState(room(ROOM_M));
  showOn(ROOM_M);
  assert.equal(await svc.sweepReleases(), 0, 'off: nothing happens');
  db.prepare('UPDATE organizations SET room_release_min = 5 WHERE id = ?').run(ORG);
  await svc.checkIn(room(ROOM_M), 'dev-1', 'present');
  assert.equal(await svc.sweepReleases(), 1);
  const declined = mock.state.requests.filter((r) => /decline$/.test(r.path)).map((r) => r.path);
  assert.deepEqual(declined, ['/graph/users/boardroom@acme.test/events/nobody/decline']);
  assert.equal(await svc.sweepReleases(), 0, 'not twice');
  const st = await svc.panelState(room(ROOM_M));
  assert.ok(!st.events.some((e) => e.id === 'nobody'), 'a released meeting leaves the panel');
  assert.equal(st.options.release_min, 5);
});

test('auto-release: never a meeting booked at the panel, and not before the deadline', async () => {
  db.prepare('UPDATE organizations SET room_release_min = 10 WHERE id = ?').run(ORG);
  mock.state.graph['boardroom@acme.test'] = [graphEvent('early', -7, 53)];   // 7 < 10 minutes
  await svc.panelState(room(ROOM_M));
  showOn(ROOM_M);
  assert.equal(await svc.sweepReleases(), 0);
  mock.state.graph['boardroom@acme.test'] = [];
  now = NOW;
  const b = await svc.book(room(ROOM_M), 'dev-1', 60);
  now = NOW + 30 * MIN;
  await svc.panelState(room(ROOM_M));
  assert.equal(await svc.sweepReleases(), 0);
  assert.ok(!mock.state.requests.some((r) => r.path.includes(`${b.event_id}/decline`)));
});

test('auto-release: never while no screen that could check in is showing the room', async () => {
  db.prepare('UPDATE organizations SET room_release_min = 5 WHERE id = ?').run(ORG);
  mock.state.graph['boardroom@acme.test'] = [graphEvent('nobody', -7, 53)];
  await svc.panelState(room(ROOM_M));
  const declines = () => mock.state.requests.filter((r) => /decline$/.test(r.path)).length;

  assert.equal(await svc.sweepReleases(), 0, 'on no screen at all');
  // A read-only player: a Tizen TV that declares what it can do, without room.panel.
  showOn(ROOM_M, { caps: ['playback.widget'], clientType: 'wgt', platform: 'tizen' });
  // An old player that declares nothing falls back to a baseline, and no baseline has room.panel.
  showOn(ROOM_M, { caps: null, clientType: 'apk' });
  assert.equal(await svc.sweepReleases(), 0, 'on read-only and pre-room-display players only');
  showOn(ROOM_M, { status: 'offline' });
  assert.equal(await svc.sweepReleases(), 0, 'a capable panel that is offline');
  showOn(ROOM_M, { widgetRoom: ROOM_G });
  assert.equal(await svc.sweepReleases(), 0, 'a panel whose widget now shows another room');
  const otherWs = crypto.randomUUID();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Store')").run(otherWs, ORG);
  showOn(ROOM_M, { ws: otherWs });
  assert.equal(await svc.sweepReleases(), 0, 'a screen in another workspace (a head office widget on a store screen)');
  showOn(ROOM_M);
  now = NOW + 4 * MIN;
  assert.equal(await svc.sweepReleases(), 0, 'a capable panel last seen over three minutes ago');
  assert.equal(declines(), 0);

  now = NOW;
  showOn(ROOM_M);
  assert.equal(await svc.sweepReleases(), 1, 'an online panel that can check in is showing it');
  assert.equal(declines(), 1);
});

test('auto-release on Google: the room declines (never a DELETE), and a meeting the room organises is kept', async () => {
  db.prepare('UPDATE organizations SET room_release_min = 5 WHERE id = ?').run(ORG);
  const CAL = 'c_room1@resource.calendar.google.com';
  const at = (min) => ({ dateTime: new Date(NOW + min * MIN).toISOString() });
  mock.state.google[CAL] = [
    { id: 'theirs', summary: 'Standup', organizer: { email: 'sam@acme.test' }, start: at(-7), end: at(53),
      attendees: [{ email: 'sam@acme.test', responseStatus: 'accepted' }, { email: CAL, resource: true, self: true, responseStatus: 'accepted' }] },
    { id: 'ours', summary: 'Typed into the room', organizer: { email: CAL, self: true }, start: at(-7), end: at(53),
      attendees: [{ email: 'alex@acme.test', responseStatus: 'accepted' }] },
  ];
  await svc.panelState(room(ROOM_G));
  showOn(ROOM_G);
  assert.equal(await svc.sweepReleases(), 1, 'only the meeting someone else organised');
  assert.ok(!mock.state.requests.some((r) => r.method === 'DELETE'), 'nothing is deleted');
  const patch = mock.state.requests.find((r) => r.method === 'PATCH' && r.path.endsWith('/events/theirs'));
  assert.equal(patch.body.attendeesOmitted, true, 'only the room’s own response is sent');
  assert.deepEqual(patch.body.attendees.map((a) => [a.email, a.responseStatus]), [[CAL, 'declined']]);
  const theirs = mock.state.google[CAL].find((e) => e.id === 'theirs');
  assert.equal(theirs.attendees.find((a) => a.email === 'sam@acme.test').responseStatus, 'accepted', 'the others are untouched');
  const ours = mock.state.google[CAL].find((e) => e.id === 'ours');
  assert.ok(ours, 'the room’s own meeting still exists');
  assert.ok(!mock.state.requests.some((r) => r.method !== 'GET' && r.path.endsWith('/events/ours')));
  const before = mock.state.requests.length;
  now = NOW + MIN;
  showOn(ROOM_G);
  assert.equal(await svc.sweepReleases(), 0);
  assert.ok(!mock.state.requests.slice(before).some((r) => r.path.endsWith('/events/ours')), 'and is not tried again every minute');
});

test('end early on Google: a meeting the room organises is refused, not cancelled for everyone', async () => {
  db.prepare('UPDATE organizations SET room_end_any = 1 WHERE id = ?').run(ORG);
  const CAL = 'c_room1@resource.calendar.google.com';
  const at = (min) => ({ dateTime: new Date(NOW + min * MIN).toISOString() });
  mock.state.google[CAL] = [{ id: 'ours', summary: 'x', organizer: { email: CAL }, start: at(-7), end: at(53), attendees: [] }];
  await assert.rejects(svc.endMeeting(room(ROOM_G), 'dev-1', 'ours'), (e) => e instanceof svc.ActionError && e.code === 'room-organiser');
  assert.equal(mock.state.google[CAL].length, 1);
  assert.ok(!mock.state.requests.some((r) => r.method === 'DELETE' || r.method === 'PATCH'));
});

/* ================================ paging ================================ */

test('paging: Graph nextLink and Google nextPageToken are followed, and a nextLink off the Graph host is not', async () => {
  mock.state.pageSize = 2;
  mock.state.graph['boardroom@acme.test'] = [1, 2, 3, 4, 5].map((i) => graphEvent(`m${i}`, i * 10, i * 10 + 5));
  const conn = svc.connectionFor(CONN_M, ORG);
  assert.equal((await graph.events(conn, 'boardroom@acme.test', NOW - 3600000, NOW + 86400000)).length, 5);
  assert.equal((await graph.listRooms(conn)).length, 2);
  assert.equal(mock.state.requests.filter((r) => /places/.test(r.path)).length, 1, 'two rooms, page size two: one page');

  const CAL = 'c_room1@resource.calendar.google.com';
  mock.state.google[CAL] = [1, 2, 3, 4, 5].map((i) => ({ id: `g${i}`, start: { dateTime: new Date(NOW + i * 10 * MIN).toISOString() }, end: { dateTime: new Date(NOW + (i * 10 + 5) * MIN).toISOString() } }));
  const g = await google.events(svc.connectionFor(CONN_G, ORG), CAL, NOW - 3600000, NOW + 86400000, 'UTC');
  assert.deepEqual(g.map((e) => e.id), ['g1', 'g2', 'g3', 'g4', 'g5']);

  // A nextLink pointing anywhere else is a response trying to choose the host: not followed.
  const realHandle = mock.fetch;
  mock.fetch = async (url, opts) => {
    const r = await realHandle(url, opts);
    if (!/calendarView/.test(String(url))) return r;
    const body = await r.json();
    body['@odata.nextLink'] = 'http://evil.example/graph/next';
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const views = () => mock.state.requests.filter((r) => /calendarView/.test(r.path)).length;
  assert.equal(views(), 3, 'five events, two to a page');
  mock.state.pageSize = 0;
  const list = await graph.events(conn, 'boardroom@acme.test', NOW - 3600000, NOW + 86400000);
  assert.equal(list.length, 5);
  assert.equal(views(), 4, 'one more page, and no request for the foreign link');
  assert.ok(!mock.state.requests.some((r) => r.path === '/graph/next'), 'the foreign nextLink was never fetched');
});

/* ================================ who may choose a calendar ================================ */

test('a workspace admin may point a room only at a calendar the connection lists; an org admin may enter any', async () => {
  const http = require('node:http');
  const express = require('express');
  let role = { workspaceRole: 'workspace_admin', orgRole: null };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: USER }, organizationId: ORG, workspaceId: WS }, role); next(); });
  app.use('/api/rooms', require('../routes/rooms'));
  const srv = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: p, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
    });
    r.on('error', reject); r.end(data);
  });
  try {
    const mk = (calendar_id, connection_id = CONN_M) => call('POST', '/api/rooms', { name: 'R', source: connection_id === CONN_M ? 'm365' : 'google', connection_id, calendar_id, timezone: 'UTC' });
    const ceo = await mk('ceo@acme.test');
    assert.equal(ceo.status, 403, 'a mailbox that is not one of the connection’s rooms');
    assert.equal(ceo.body.code, 'calendar-not-listed');
    const ok = await mk('Huddle@acme.test');
    assert.equal(ok.status, 201, 'a listed room (case-insensitive)');
    assert.equal((await call('PUT', `/api/rooms/${ok.body.id}`, { calendar_id: 'ceo@acme.test' })).status, 403, 'nor moved to one later');
    assert.equal((await call('PUT', `/api/rooms/${ok.body.id}`, { name: 'Huddle' })).status, 200, 'a rename is not re-checked');

    // Listing fails (a Google connection without delegation cannot list): closed, not open.
    db.prepare('UPDATE room_connections SET subject = NULL WHERE id = ?').run(CONN_G);
    try {
      const g = await mk('c_room1@resource.calendar.google.com', CONN_G);
      assert.equal(g.status, 403);
      assert.match(g.body.error, /could not be listed/);
    } finally { db.prepare("UPDATE room_connections SET subject = 'admin@acme.test' WHERE id = ?").run(CONN_G); }

    role = { workspaceRole: null, orgRole: 'org_admin' };
    const any = await mk('ceo@acme.test');
    assert.equal(any.status, 201, 'an org admin may enter any calendar id');
    for (const id of [ok.body.id, any.body.id]) db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  } finally {
    srv.close();
  }
});

test('check-in: refused for a meeting that is over or more than ten minutes away', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('far', 30, 60), graphEvent('soon', 8, 30), graphEvent('done', -60, -1)];
  await assert.rejects(svc.checkIn(room(ROOM_M), 'd', 'far'), (e) => e.code === 'not-checkable');
  await assert.rejects(svc.checkIn(room(ROOM_M), 'd', 'done'), (e) => e.code === 'not-checkable');
  await svc.checkIn(room(ROOM_M), 'd', 'soon');
  assert.equal((await svc.panelState(room(ROOM_M))).events.find((e) => e.id === 'soon').checked_in, true);
});

/* ================================ cache ================================ */

test('cache: one upstream read a minute however often panels ask; errors keep the last good copy and back off', async () => {
  mock.state.graph['boardroom@acme.test'] = [graphEvent('a', 10, 40)];
  await svc.panelState(room(ROOM_M));
  await svc.panelState(room(ROOM_M));
  await svc.panelState(room(ROOM_M));
  const views = () => mock.state.requests.filter((r) => /calendarView/.test(r.path)).length;
  assert.equal(views(), 1);
  now = NOW + 61 * 1000;
  mock.state.failGraph = 5;
  const st = await svc.panelState(room(ROOM_M));
  assert.equal(st.stale, true);
  assert.equal(st.events[0].id, 'a', 'the last good copy, not nothing');
  assert.equal(views(), 2, 'one attempt, which failed');
  const r1 = room(ROOM_M);
  assert.equal(r1.error_count, 1);
  assert.ok(r1.next_poll_at - now >= 30 * 1000);
  const before = mock.state.requests.length;
  now += 5 * 1000;
  await svc.panelState(room(ROOM_M));
  assert.equal(mock.state.requests.length, before, 'backing off: no request at all');
  now += 60 * 1000;
  mock.state.failGraph = 0;
  const ok = await svc.panelState(room(ROOM_M));
  assert.equal(ok.stale, false);
  assert.equal(room(ROOM_M).error_count, 0);
});

test('a stored secret that no longer decrypts fails closed with a reason, not silently', async () => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO room_connections (id, organization_id, kind, name, tenant_id, client_id, secret_enc) VALUES (?, ?, 'm365', 'Broken', 'acme.test', 'x', 'not-a-box')`).run(id, ORG);
  assert.throws(() => svc.connectionFor(id, ORG), /could not be decrypted/);
});

/* ================================ panel capability ================================ */

test('panel capability: bound to the widget, the device and the device’s current token', () => {
  const dev = { id: 'dev-1', device_token: 'tok-a' };
  const t = svc.panelToken('w1', dev);
  assert.ok(svc.verifyPanelToken('w1', dev, t));
  assert.equal(svc.verifyPanelToken('w2', dev, t), false, 'another widget');
  assert.equal(svc.verifyPanelToken('w1', { id: 'dev-2', device_token: 'tok-a' }, t), false, 'another device');
  assert.equal(svc.verifyPanelToken('w1', { ...dev, device_token: 'tok-b' }, t), false, 're-paired');
  assert.equal(svc.verifyPanelToken('w1', { id: 'dev-1', device_token: null }, t), false, 'unpaired');
  assert.equal(svc.verifyPanelToken('w1', dev, undefined), false);
  assert.equal(svc.verifyPanelToken('w1', dev, t.slice(0, -1)), false);
  assert.ok(!t.includes('tok-a'));
});
