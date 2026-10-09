'use strict';

/*
 * View-only display access (lib/view-access.js, routes/view.js), against a real server.
 *
 * What it must hold:
 *   - off by default, per display; only workspace admins can turn it on;
 *   - the share token reaches ONE display's read-only page and payload and nothing else — never a
 *     device token, an API token, a session or an enrolment key;
 *   - regenerating revokes the old link at once; turning access off ends every open viewer;
 *   - the network door opens only from an allowed range, judged on the TCP peer (a spoofed
 *     X-Forwarded-For is not believed without VIEW_TRUSTED_PROXIES);
 *   - a viewer is never a display: no row, no count, no list entry;
 *   - the old ways — pairing, /player, the #313 enrolment key — are untouched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db, JWT, WS;
const DATA_DIR = path.join(os.tmpdir(), 'st-view-int-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-view-int-' + crypto.randomBytes(4).toString('hex') + '.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => String(crypto.randomInt(100000, 1000000));

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  // SELF_HOSTED with VIEW_ONLY_ENABLED unset: the self-hosted default (on) is what is under test.
  const env = { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' };
  delete env.VIEW_ONLY_ENABLED; delete env.VIEW_TRUSTED_PROXIES;
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'test12345', name: 'Admin' }) });
  JWT = (await r.json()).token;
  const { Database } = require('../db/sqlite-driver');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  WS = db.prepare('SELECT id FROM workspaces LIMIT 1').get().id;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const authed = (jwt, method, url, body) => fetch(BASE + url, {
  method, headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json', 'X-Workspace-Id': WS },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const as = (method, url, body) => authed(JWT, method, url, body);
const deviceCount = () => db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;

function provision(code) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => resolve(null), 5000);
  });
}
// A display without the pairing dance (the dashboard's "web player" create) — /api/provision is
// limited to 5 a minute, which this file would otherwise trip.
async function display(name) {
  const r = await as('POST', '/api/devices/web-player', { name });
  assert.equal(r.status, 201, 'precondition: a display exists');
  const body = await r.json();
  return { id: body.device.id };
}
async function pairedDisplay(name) {
  const code = rnd();
  const dev = await provision(code);
  const r = await as('POST', '/api/provision/pair', { pairing_code: code, name });
  assert.equal(r.status, 200, 'precondition: the display pairs the ordinary way');
  return dev;
}
function register(payload) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.close(); } catch { /* */ } resolve(v); };
    sock.on('connect', () => sock.emit('device:register', { ...payload, device_info: { app_version: 'test' } }));
    sock.on('device:registered', (d) => finish({ registered: true, device_id: d.device_id }));
    sock.on('device:auth-error', (e) => finish({ registered: false, error: e && (e.error || e.reason) }));
    sock.on('device:unpaired', (e) => finish({ registered: false, error: 'unpaired:' + (e && e.reason) }));
    setTimeout(() => finish({ registered: false, timedOut: true }), 5000);
  });
}
const tokenOf = (state) => state.share_url.split('/view/')[1];
const payloadOf = (token, q = '') => fetch(`${BASE}/api/view/t/${token}/payload${q}`);

test('off by default: a new display has no view, and nothing answers for it', async () => {
  const dev = await display('Lobby');
  const s = await (await as('GET', `/api/devices/${dev.id}/view`)).json();
  assert.equal(s.available, true, 'self-hosted default: the feature exists on this instance');
  assert.equal(s.enabled, false, 'but is off for the display');
  assert.equal(s.share_url, null, 'and there is no link until someone turns it on');
  assert.equal(db.prepare('SELECT view_enabled FROM devices WHERE id = ?').get(dev.id).view_enabled, 0);
  assert.equal((await fetch(`${BASE}/view/screen/${dev.id}`)).status, 404, 'the network door does not exist');
  assert.equal((await fetch(`${BASE}/api/view/d/${dev.id}/payload`)).status, 404);
  assert.equal((await payloadOf(crypto.randomBytes(32).toString('base64url'))).status, 404, 'a guessed token is nothing');
});

test('an admin turns it on: the link serves the player in viewer mode and a read-only payload', async () => {
  const dev = await pairedDisplay('Reception');
  const before = deviceCount();
  const r = await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.enabled, true);
  assert.match(s.share_url, /\/view\/[A-Za-z0-9_-]{43}$/);
  const token = tokenOf(s);

  const page = await fetch(`${BASE}/view/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer', 'the token in the URL must not leak as a Referer');
  const html = await page.text();
  assert.match(html, /__playerConfig\.viewer = \{"payload_url":"\/api\/view\/t\//, 'the player boots as a viewer');
  assert.match(html, /debugReporting = false/, 'a viewer never reports');
  assert.match(html, /defineProperty\(window,"localStorage"/, 'and keeps its storage in memory, away from a real player in the same browser');

  const legacy = await fetch(`${BASE}/view/${token}?legacy=1`);
  assert.equal(legacy.status, 200, 'the ES5 build is offered to old browsers, as for screens');
  assert.match(await legacy.text(), /__playerConfig\.viewer/);

  const p = await payloadOf(token);
  assert.equal(p.status, 200);
  const body = await p.json();
  assert.ok(body.rev && body.server_ms && body.payload, 'rev, server clock and the content');
  for (const k of ['trigger_config', 'local_api', 'power_schedule', 'endpoints', 'triggers', 'wall_config', 'group_sync', 'audience']) {
    assert.equal(k in body.payload, false, `${k} is not for a viewer`);
  }
  const again = await (await payloadOf(token, `?rev=${body.rev}`)).json();
  assert.equal(again.unchanged, true, 'an unchanged display answers without the body');
  assert.equal('payload' in again, false);

  assert.equal(deviceCount(), before, 'a viewer is never a display row');
  const list = await (await as('GET', '/api/devices')).json();
  const rows = Array.isArray(list) ? list : (list.devices || []);
  assert.equal(rows.filter((d) => d.name === 'Reception').length, 1, 'and never a second entry in the displays list');
  for (const d of rows) { assert.equal('view_token_hash' in d, false); assert.equal('view_token_enc' in d, false); }
  const detail = await (await as('GET', `/api/devices/${dev.id}`)).json();
  assert.equal('view_token_hash' in detail || 'view_token_enc' in detail, false, 'the device record never carries the link');
});

test('the token is scoped: not a device token, not an API token, not an enrolment key, not another display', async () => {
  const dev = await display('Scoped');
  const other = await display('Other');
  const s = await (await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true })).json();
  const token = tokenOf(s);

  const asDevice = await register({ device_id: dev.id, device_token: token });
  assert.equal(asDevice.registered, false, 'it does not authenticate as the screen');
  const asKey = await register({ enrol_key: token });
  assert.equal(asKey.registered, false, 'nor as an enrolment key');

  const bearer = (method, url, body) => fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  for (const [m, u, b] of [
    ['GET', `/api/devices/${dev.id}`],
    ['GET', '/api/devices'],
    ['PUT', `/api/devices/${dev.id}`, { name: 'pwned' }],
    ['POST', `/api/devices/${dev.id}/command`, { type: 'reboot' }],
    ['GET', `/api/devices/${dev.id}/preview-payload`],
    ['GET', `/api/devices/${dev.id}/view`],
    ['POST', `/api/devices/${dev.id}/view/regenerate`],
  ]) {
    const r = await bearer(m, u, b);
    assert.ok(r.status === 401 || r.status === 403, `${m} ${u} answered ${r.status} to a view token`);
  }
  const shot = await fetch(`${BASE}/api/devices/${dev.id}/screenshot?token=${token}`);
  assert.ok(shot.status === 401 || shot.status === 403, 'no screenshots');
  assert.equal(db.prepare('SELECT name FROM devices WHERE id = ?').get(dev.id).name, 'Scoped', 'nothing was written');

  // The payload is the display the token names, whatever else the request says.
  const body = await (await payloadOf(token)).json();
  assert.ok(body.payload);
  assert.equal((await fetch(`${BASE}/api/view/d/${other.id}/payload`)).status, 404, 'another display is not reachable');

  // A dashboard socket refuses it too.
  const ok = await new Promise((resolve) => {
    const sock = ioClient(`${BASE}/dashboard`, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token } });
    sock.on('connect', () => { sock.close(); resolve(true); });
    sock.on('connect_error', () => { sock.close(); resolve(false); });
    setTimeout(() => { sock.close(); resolve(false); }, 3000);
  });
  assert.equal(ok, false, 'not a dashboard session');
});

test('regenerating revokes the old link immediately', async () => {
  const dev = await display('Regen');
  const s1 = await (await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true })).json();
  const old = tokenOf(s1);
  assert.equal((await payloadOf(old)).status, 200);
  const s2 = await (await as('POST', `/api/devices/${dev.id}/view/regenerate`)).json();
  const fresh = tokenOf(s2);
  assert.notEqual(fresh, old);
  assert.equal((await payloadOf(old)).status, 404, 'an open viewer on the old link goes dark on its next poll');
  assert.equal((await fetch(`${BASE}/view/${old}`)).status, 404);
  assert.equal((await payloadOf(fresh)).status, 200);
  const log = db.prepare("SELECT action FROM activity_log WHERE device_id = ? AND action LIKE 'view:%' ORDER BY id").all(dev.id).map((r) => r.action);
  assert.deepEqual(log, ['view:enabled', 'view:link_created', 'view:link_regenerated'], 'create, regenerate are in the activity log');
});

test('turning it off ends every viewer; turning it back on keeps the same link', async () => {
  const dev = await display('Toggle');
  const token = tokenOf(await (await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true })).json());
  await as('PUT', `/api/devices/${dev.id}/view`, { enabled: false });
  const off = await payloadOf(token);
  assert.equal(off.status, 404);
  assert.equal((await off.json()).available, false);
  const again = await (await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true })).json();
  assert.equal(tokenOf(again), token, 'off/on is a pause, not a new link — regenerate is the explicit revoke');
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE device_id = ? AND action = 'view:disabled'").get(dev.id), 'the toggle is logged');
});

test('networks: validated, and allow/deny judged on the real peer, not X-Forwarded-For', async () => {
  const dev = await display('Lan');
  await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true });
  const bad = await as('PUT', `/api/devices/${dev.id}/view`, { cidrs: ['10.0.0.0/8', '10.0.0.0/33', 'banana', '0.0.0.0/0'] });
  assert.equal(bad.status, 400, 'bad ranges are refused, all at once');
  assert.deepEqual((await bad.json()).invalid, ['10.0.0.0/33', 'banana', '0.0.0.0/0']);

  const deny = await (await as('PUT', `/api/devices/${dev.id}/view`, { cidrs: '10.0.0.0/8\n192.168.0.0/16' })).json();
  assert.deepEqual(deny.cidrs, ['10.0.0.0/8', '192.168.0.0/16']);
  assert.match(deny.network_url, new RegExp(`/view/screen/${dev.id}$`));
  assert.equal((await fetch(`${BASE}/view/screen/${dev.id}`)).status, 403, 'this test runs from 127.0.0.1, outside both ranges');
  const spoof = await fetch(`${BASE}/api/view/d/${dev.id}/payload`, { headers: { 'X-Forwarded-For': '10.1.2.3' } });
  assert.equal(spoof.status, 403, 'a forwarded-for header from an untrusted peer is not believed');

  await as('PUT', `/api/devices/${dev.id}/view`, { cidrs: ['127.0.0.0/8'] });
  assert.equal((await fetch(`${BASE}/view/screen/${dev.id}`)).status, 200, 'inside the range: no token needed');
  assert.equal((await fetch(`${BASE}/api/view/d/${dev.id}/payload`)).status, 200);

  await as('PUT', `/api/devices/${dev.id}/view`, { enabled: false });
  assert.equal((await fetch(`${BASE}/api/view/d/${dev.id}/payload`)).status, 404, 'off means off for the network door too');
});

test('only workspace admins can change it — an editor and an API token cannot', async () => {
  const dev = await display('Admins');
  const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'editor@test.local', password: 'test12345', name: 'Ed' }) });
  const ed = await reg.json();
  assert.ok(ed.token, 'precondition: a second user');
  const edId = db.prepare("SELECT id FROM users WHERE email = 'editor@test.local'").get().id;
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(WS, edId);

  const put = await authed(ed.token, 'PUT', `/api/devices/${dev.id}/view`, { enabled: true });
  assert.equal(put.status, 403, 'an editor cannot turn it on');
  const regen = await authed(ed.token, 'POST', `/api/devices/${dev.id}/view/regenerate`);
  assert.equal(regen.status, 403);
  const peek = await (await authed(ed.token, 'GET', `/api/devices/${dev.id}/view`)).json();
  assert.equal(peek.can_admin, false);
  assert.equal('share_url' in peek, false, 'and is never shown the link');
  assert.equal(db.prepare('SELECT view_enabled FROM devices WHERE id = ?').get(dev.id).view_enabled, 0);

  const tok = await (await as('POST', '/api/tokens', { name: 'full', scope: 'full' })).json();
  const viaToken = await authed(tok.token, 'PUT', `/api/devices/${dev.id}/view`, { enabled: true });
  assert.equal(viaToken.status, 403, 'not through an API token, even a full one');
});

test('the old ways are untouched: /player is a screen, pairing and the enrolment key still work', async () => {
  const player = await (await fetch(`${BASE}/player`)).text();
  assert.doesNotMatch(player, /__playerConfig\.viewer = /, '/player never boots as a viewer');
  assert.doesNotMatch(player, /defineProperty\(window,"localStorage"/);
  assert.equal((await fetch(`${BASE}/player/legacy`)).status, 200);

  const dev = await pairedDisplay('Classic');
  await as('PUT', `/api/devices/${dev.id}/view`, { enabled: true });
  const key = (await (await as('POST', `/api/devices/${dev.id}/enrol-key`)).json()).enrol_key;
  const before = deviceCount();
  const viaKey = await register({ enrol_key: key });
  assert.equal(viaKey.device_id, dev.id, 'the vMix enrolment URL still IS the screen');
  const viaToken = await register({ device_id: dev.id, device_token: dev.token });
  assert.equal(viaToken.registered, true, 'and the paired screen still connects with its own token');
  assert.equal(deviceCount(), before);
});
