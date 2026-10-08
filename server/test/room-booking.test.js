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
 *   - check-in and auto-release; the cache, backoff, and last-good copy on upstream errors
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
  db.prepare('UPDATE organizations SET room_end_any = 0, room_release_min = 0 WHERE id = ?').run(ORG);
});

after(() => {
  global.fetch = realFetch;
  try { db.close(); } catch { /* */ }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const room = (id) => db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
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
  assert.equal(await svc.sweepReleases(), 0);
  mock.state.graph['boardroom@acme.test'] = [];
  now = NOW;
  const b = await svc.book(room(ROOM_M), 'dev-1', 60);
  now = NOW + 30 * MIN;
  await svc.panelState(room(ROOM_M));
  assert.equal(await svc.sweepReleases(), 0);
  assert.ok(!mock.state.requests.some((r) => r.path.includes(`${b.event_id}/decline`)));
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
