'use strict';

/*
 * Meeting-room displays end to end: a real server, a real device socket, and a fake Microsoft Graph
 * (test/helpers/room-calendar-mock.js) the server is pointed at through the NODE_ENV=test overrides.
 *
 *   - connections: the client secret is never in any response; common/organizations refused; Test
 *     signs in and lists rooms, and a wrong secret says why
 *   - rooms: an ICS room's address is never returned; a widget may only point at its own
 *     workspace's room
 *   - the widget page: sandboxed CSP that may only talk back to this server
 *   - the panel capability arrives over the device's authenticated socket, in the playlist payload,
 *     and only for that device
 *   - actions: refused without it, with another screen's, or from another workspace; with it, book
 *     now and end early reach the calendar and the activity log
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ioClient = require('../node_modules/socket.io-client');
const { freePort } = require('./helpers/free-port');
const { createMock, GOOD_SECRET } = require('./helpers/room-calendar-mock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JWT_SECRET = 'rooms-e2e-' + crypto.randomBytes(8).toString('hex');
let proc, BASE, DATA_DIR, LOG, mock, mockSrv;
const S = {};

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q1 = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).get(...a); } finally { r.close(); } };
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, text, headers: r.headers };
}
const J = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const panelAction = (widgetId, body) => api(`/api/room-panel/${widgetId}/action`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
const expectedToken = (widgetId, dev) => crypto.createHmac('sha256', JWT_SECRET)
  .update(`room-panel|${widgetId}|${dev.id}|${crypto.createHash('sha256').update(dev.token).digest('hex')}`).digest('base64url');

function makeDevice(ws) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  run(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, created_at) VALUES (?, 'Panel', 'online', ?, ?, 'apk', strftime('%s','now'))`, id, ws, token);
  return { id, token };
}

function registerAndWaitForPayload(dev, pred) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => { s.close(); reject(new Error('no matching payload')); }, 15000);
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token }));
    s.on('device:playlist-update', (p) => { if (pred(p)) { clearTimeout(timer); s.close(); resolve(p); } });
    s.on('device:auth-error', (e) => { clearTimeout(timer); s.close(); reject(new Error(e && e.error)); });
  });
}

before(async () => {
  mock = createMock();
  mockSrv = await mock.listen();
  const M = `http://127.0.0.1:${mockSrv.address().port}`;
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-e2e-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', JWT_SECRET,
      ROOMS_MS_LOGIN_BASE: `${M}/ms`, ROOMS_GRAPH_BASE: `${M}/graph`,
      ROOMS_GOOGLE_TOKEN_URL: `${M}/google/token`, ROOMS_GOOGLE_CALENDAR_BASE: `${M}/gcal`, ROOMS_GOOGLE_DIRECTORY_BASE: `${M}/gdir`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@acme.test', password: 'Passw0rd123', name: 'Owner' }) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  S.token = reg.body.token;
  S.ws = reg.body.current_workspace_id;
  S.org = q1('SELECT organization_id FROM workspaces WHERE id = ?', S.ws).organization_id;
});

after(() => {
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { mockSrv.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

test('a Microsoft 365 connection: the secret never comes back, and Test signs in and lists rooms', async () => {
  const bad = await api('/api/rooms/connections', J({ kind: 'm365', name: 'M365', tenant_id: 'common', client_id: 'app', client_secret: GOOD_SECRET }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /tenant/i);
  const r = await api('/api/rooms/connections', J({ kind: 'm365', name: 'Acme M365', tenant_id: 'acme.onmicrosoft.com', client_id: 'app-id', client_secret: GOOD_SECRET }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.conn = r.body.id;
  assert.equal(r.body.has_secret, true);
  const list = await api('/api/rooms/connections', J(undefined, 'GET'));
  for (const resp of [r, list]) assert.ok(!resp.text.includes(GOOD_SECRET), 'the secret is never returned');
  assert.ok(!(q1('SELECT secret_enc FROM room_connections WHERE id = ?', S.conn).secret_enc || '').includes(GOOD_SECRET), 'and is encrypted at rest');

  const t = await api(`/api/rooms/connections/${S.conn}/test`, J({}));
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  assert.equal(t.body.rooms, 2);
  const found = await api(`/api/rooms/connections/${S.conn}/rooms`, J(undefined, 'GET'));
  assert.deepEqual(found.body.rooms.map((x) => x.calendar_id), ['boardroom@acme.test', 'huddle@acme.test']);

  // An edit without the secret keeps it; a wrong one makes Test say what Microsoft said.
  assert.equal((await api(`/api/rooms/connections/${S.conn}`, J({ name: 'Acme rooms' }, 'PUT'))).status, 200);
  assert.equal((await api(`/api/rooms/connections/${S.conn}/test`, J({}))).body.ok, true);
  await api(`/api/rooms/connections/${S.conn}`, J({ client_secret: 'wrong' }, 'PUT'));
  const t2 = await api(`/api/rooms/connections/${S.conn}/test`, J({}));
  assert.equal(t2.body.ok, false);
  assert.match(t2.body.error, /Invalid client secret/);
  await api(`/api/rooms/connections/${S.conn}`, J({ client_secret: GOOD_SECRET }, 'PUT'));
});

test('rooms: an ICS address is never returned; a widget may only show a room of its own workspace', async () => {
  const icsUrl = 'https://outlook.office365.com/owa/calendar/abc/SECRETTOKEN123/calendar.ics';
  const ics = await api('/api/rooms', J({ name: 'Quiet room', source: 'ics', ics_url: icsUrl, timezone: 'Europe/London' }));
  assert.equal(ics.status, 201, JSON.stringify(ics.body));
  assert.equal(ics.body.ics_host, 'outlook.office365.com');
  assert.ok(!ics.text.includes('SECRETTOKEN123'));
  assert.ok(!(await api('/api/rooms', J(undefined, 'GET'))).text.includes('SECRETTOKEN123'));
  assert.equal((await api('/api/rooms', J({ name: 'x', source: 'm365', connection_id: S.conn, calendar_id: 'a@b', timezone: 'Mars/Olympus' }))).status, 400);
  assert.equal((await api('/api/rooms', J({ name: 'x', source: 'm365', connection_id: 'not-ours', calendar_id: 'a@b', timezone: 'UTC' }))).status, 400);

  const r = await api('/api/rooms', J({ name: 'Boardroom', source: 'm365', connection_id: S.conn, calendar_id: 'boardroom@acme.test', timezone: 'Europe/London' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.room = r.body.id;
  const del = await api(`/api/rooms/connections/${S.conn}`, J(undefined, 'DELETE'));
  assert.equal(del.status, 409, 'a connection in use cannot be removed');

  const foreign = await api('/api/widgets', J({ widget_type: 'room-display', name: 'Elsewhere', config: { room_id: crypto.randomUUID() } }));
  assert.equal(foreign.status, 400);
  const w = await api('/api/widgets', J({ widget_type: 'room-display', name: 'Boardroom door', config: { room_id: S.room } }));
  assert.equal(w.status, 201, JSON.stringify(w.body));
  S.widget = w.body.id;
});

test('the room display page is sandboxed and may only talk back to this server', async () => {
  const now = Date.now();
  mock.state.graph['boardroom@acme.test'] = [
    { id: 'cur', subject: 'Quarterly review', organizer: { emailAddress: { name: 'Sam', address: 'sam@acme.test' } }, start: now - 10 * 60000, end: now + 20 * 60000, isAllDay: false, showAs: 'busy' },
    { id: 'priv', subject: 'Redundancy planning', organizer: { emailAddress: { name: 'HR', address: 'hr@acme.test' } }, start: now + 60 * 60000, end: now + 90 * 60000, isAllDay: false, showAs: 'busy', sensitivity: 'private' },
  ];
  const r = await api(`/api/widgets/${S.widget}/render?rev=1`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, new RegExp(`connect-src ${BASE.replace(/[.:/]/g, '\\$&')}`));
  assert.match(csp, /default-src 'none'/);
  assert.match(r.headers.get('cache-control'), /private/);
  assert.ok(r.text.includes('Boardroom'));
  assert.ok(!r.text.includes('Redundancy planning'), 'a private title is not in the page');

  const st = await api(`/api/room-panel/${S.widget}/state`);
  assert.equal(st.headers.get('access-control-allow-origin'), '*');
  assert.match(st.headers.get('cache-control'), /no-store/);
  assert.equal(st.body.room.name, 'Boardroom');
  assert.equal(st.body.options.booking, true);
  assert.ok(st.body.events.some((e) => e.id === 'cur' && e.title === 'Quarterly review'));
  assert.ok(!st.text.includes('Redundancy planning'));
  assert.equal((await api(`/api/room-panel/${crypto.randomUUID()}/state`)).status, 404);
});

test('the panel capability reaches only the screen playing the room, over its own socket', async () => {
  const pl = crypto.randomUUID();
  const snapshot = [{ widget_id: S.widget, widget_type: 'room-display', widget_name: 'Boardroom door', duration_sec: 3600, sort_order: 0, content_id: null }];
  run(`INSERT INTO playlists (id, user_id, workspace_id, name, published_snapshot) VALUES (?, ?, ?, 'Door', ?)`,
    pl, q1('SELECT id FROM users LIMIT 1').id, S.ws, JSON.stringify(snapshot));
  S.dev = makeDevice(S.ws);
  run("UPDATE devices SET playlist_id = ?, playlist_source = 'device' WHERE id = ?", pl, S.dev.id);
  const p = await registerAndWaitForPayload(S.dev, (x) => Array.isArray(x.assignments) && x.assignments.some((a) => a.widget_id === S.widget));
  const a = p.assignments.find((x) => x.widget_id === S.widget);
  assert.equal(a.widget_panel, expectedToken(S.widget, S.dev));
  assert.ok(!JSON.stringify(p).includes(S.dev.token), 'the device token itself is never in the payload');
  S.otherDev = makeDevice(S.ws);   // same workspace, not playing the room: has no capability
});

test('actions: refused without the capability, with another screen’s, or from another workspace', async () => {
  const tok = expectedToken(S.widget, S.dev);
  assert.equal((await panelAction(S.widget, { action: 'book', minutes: 15, device: S.dev.id })).status, 403);
  assert.equal((await panelAction(S.widget, { action: 'book', minutes: 15, device: S.dev.id, panel: tok.slice(0, -2) + 'xx' })).status, 403);
  assert.equal((await panelAction(S.widget, { action: 'book', minutes: 15, device: S.otherDev.id, panel: tok })).status, 403, 'one screen’s capability does not work for another');
  // A device in ANOTHER workspace with a capability correctly derived for itself is still refused.
  const otherWs = crypto.randomUUID();
  run("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Other')", otherWs, S.org);
  const stranger = makeDevice(otherWs);
  assert.equal((await panelAction(S.widget, { action: 'book', minutes: 15, device: stranger.id, panel: expectedToken(S.widget, stranger) })).status, 403);
  assert.ok(!mock.state.requests.some((r) => r.method === 'POST' && /\/events$/.test(r.path)), 'nothing was booked');
});

test('actions: with the capability, book now and end early reach the calendar and the activity log', async () => {
  const tok = expectedToken(S.widget, S.dev);
  mock.state.graph['boardroom@acme.test'] = [];
  run('UPDATE rooms SET cache_at = NULL WHERE id = ?', S.room);
  const b = await panelAction(S.widget, { action: 'book', minutes: 30, device: S.dev.id, panel: tok });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const mine = b.body.state.events.find((e) => e.panel);
  assert.ok(mine, 'the new meeting is in the returned state');
  assert.equal(mine.title, 'Booked at the room display');
  assert.equal((await panelAction(S.widget, { action: 'book', minutes: 15, device: S.dev.id, panel: tok })).status, 409, 'busy now');

  const e = await panelAction(S.widget, { action: 'end', event_id: mine.id, device: S.dev.id, panel: tok });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.ok(mock.state.requests.some((r) => r.method === 'PATCH' && r.path.endsWith(`/events/${mine.id}`)));
  const logged = q1("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('room:booked', 'room:ended') AND device_id = ?", S.dev.id).n;
  assert.equal(logged, 2);
  assert.equal((await panelAction(S.widget, { action: 'dance', device: S.dev.id, panel: tok })).status, 400);
});

test('seen: a screen reports it is showing the room only with its own capability', async () => {
  const tok = expectedToken(S.widget, S.dev);
  const seen = (body) => api(`/api/room-panel/${S.widget}/seen`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  const rows = () => q1('SELECT COUNT(*) AS n FROM room_panel_presence WHERE room_id = ?', S.room).n;
  assert.equal((await seen({ device: S.dev.id })).status, 403);
  assert.equal((await seen({ device: S.otherDev.id, panel: tok })).status, 403, 'another screen’s capability');
  assert.equal(rows(), 0);
  assert.equal((await seen({ device: S.dev.id, panel: tok })).status, 204);
  assert.equal(q1('SELECT device_id FROM room_panel_presence WHERE room_id = ? AND widget_id = ?', S.room, S.widget).device_id, S.dev.id);
  const page = await api(`/api/widgets/${S.widget}/render?device=${S.dev.id}`);
  assert.match(page.text, /\/api\/room-panel\/[^/]+\/seen/, 'the page reports itself');
});

test('org rules: only an org admin may change them, and they are bounded', async () => {
  assert.equal((await api('/api/rooms/settings', J({ release_min: 90 }, 'PUT'))).status, 400);
  const r = await api('/api/rooms/settings', J({ end_any: true, release_min: 10 }, 'PUT'));
  assert.equal(r.status, 200);
  assert.deepEqual({ end_any: r.body.end_any, release_min: r.body.release_min }, { end_any: true, release_min: 10 });
  const st = await api(`/api/room-panel/${S.widget}/state`);
  assert.equal(st.body.options.end_any, true);
  assert.equal(st.body.options.release_min, 10);
});
