'use strict';

/*
 * 3.0.1: a meeting-room guest (POST /api/share/join, no account) must not be handed the org's
 * long-lived TURN login. Against the REAL server with real Socket.IO devices:
 *
 *   - an org with its own ICE override (TURN with a fixed username/credential): the guest's join
 *     answer has STUN URLs only — no username/credential/credentialType, no turn:/turns: URL — on
 *     the main entry and on every leg; a mixed entry keeps just its stun: URLs
 *   - the signed-in member's start and the display's own start event still carry the full set
 *   - an org on the global TURN with GO2RTC_TURN_SECRET: the guest gets the TURN entry, with a
 *     short-lived TURN REST username ("<expiry>:screentinker") and an HMAC credential
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG;
const U = {};
const sockets = [];
const TURN_SECRET = 'guest-turn-secret-' + crypto.randomBytes(6).toString('hex');
const ORG_ICE = [
  { urls: 'stun:stun.org.example:3478' },
  { urls: ['turn:turn.org.example:3478?transport=udp', 'turns:turn.org.example:5349'], username: 'org-user', credential: 'org-long-lived-pass', credentialType: 'password' },
  { urls: ['stun:turn.org.example:3478', 'turn:turn.org.example:3478?transport=tcp'], username: 'org-user', credential: 'org-long-lived-pass' },
];

const dbRun = (fn) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return fn(r); } finally { r.close(); } };
const run = (sql, ...a) => dbRun((d) => d.prepare(sql).run(...a));
const get = (sql, ...a) => dbRun((d) => d.prepare(sql).get(...a));

async function call(who, method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) { headers.Authorization = `Bearer ${U[who].token}`; headers['X-Workspace-Id'] = U[who].ws; }
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

async function register(name) {
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}-${Date.now()}@guest-turn.test`, password: 'Passw0rd123', name }),
  });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  U[name] = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
}

function connectDevice(id, token) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(sock);
    sock.got = [];
    sock.onAny((ev, data) => sock.got.push({ ev, data }));
    const t = setTimeout(() => reject(new Error('register timeout ' + id)), 8000);
    sock.on('connect', () => sock.emit('device:register', { device_id: id, device_token: token, capabilities: ['playback.video', 'remote.screen_share'], device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => { clearTimeout(t); resolve(sock); });
    sock.on('device:auth-error', (e) => { clearTimeout(t); reject(new Error('auth ' + JSON.stringify(e))); });
  });
}
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(40);
  }
}
function wsClient(p) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(BASE.replace(/^http/, 'ws') + p);
    s.msgs = [];
    s.on('message', (d) => s.msgs.push(JSON.parse(d.toString())));
    s.closed = new Promise((r) => s.on('close', r));
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
}
const urlsOf = (e) => (Array.isArray(e.urls) ? e.urls : [e.urls]);

// Every ice_servers list in a guest's join answer: the main one and each leg's.
function allIceLists(body) {
  return [body.ice_servers, ...(body.legs || []).map((l) => l.ice_servers)];
}

async function addScreen(owner, name) {
  const id = crypto.randomUUID();
  const tok = 'devtok_' + crypto.randomBytes(12).toString('hex');
  run("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token) VALUES (?, ?, ?, ?, ?, 'offline', ?)",
    id, U[owner].id, U[owner].ws, name, crypto.randomUUID().slice(0, 6), tok);
  const sock = await connectDevice(id, tok);
  return { id, tok, sock };
}

async function guestJoin(owner, screen) {
  screen.sock.got.length = 0;
  const on = await call(owner, 'PUT', `/api/screen-share/devices/${screen.id}/guest`, { enabled: true });
  assert.deepEqual(on.body, { guest_enabled: true });
  const pushed = await waitFor(() => { const c = [...screen.sock.got].reverse().find((g) => g.ev === 'device:screenshare-code'); return c && c.data.code ? c : null; });
  const join = await call(null, 'POST', '/api/share/join', { code: pushed.data.code, name: 'Visitor' });
  assert.equal(join.status, 201, JSON.stringify(join.body));
  return join.body;
}

let ORG_SCREEN, GLOBAL_SCREEN;

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-guest-turn-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      GO2RTC_STUN_URLS: 'stun:stun.global.example:3478', GO2RTC_TURN_URL: 'turn:turn.global.example:3478',
      GO2RTC_TURN_SECRET: TURN_SECRET, GO2RTC_TURN_TTL: '3600',
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  await register('owner');   // an org with its own TURN
  await register('other');   // an org on the global (short-lived) TURN
  const org = get('SELECT organization_id FROM workspaces WHERE id = ?', U.owner.ws).organization_id;
  assert.ok(org);
  run('UPDATE organizations SET ice_servers = ? WHERE id = ?', JSON.stringify(ORG_ICE), org);
  ORG_SCREEN = await addScreen('owner', 'Boardroom');
  GLOBAL_SCREEN = await addScreen('other', 'Lobby');
});

after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('a member starting a share still gets the org TURN login, unchanged', async () => {
  const r = await call('owner', 'POST', `/api/screen-share/devices/${ORG_SCREEN.id}`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.ice_servers, ORG_ICE);
  assert.deepEqual(r.body.legs[0].ice_servers, ORG_ICE);
  const kick = await call('owner', 'DELETE', `/api/screen-share/devices/${ORG_SCREEN.id}`);
  assert.deepEqual(kick.body, { stopped: true });
});

test('a guest gets STUN only from an org TURN with a fixed login; the display keeps the full set', async () => {
  const body = await guestJoin('owner', ORG_SCREEN);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('org-long-lived-pass') && !raw.includes('org-user'), 'the org TURN login never reaches a guest');
  for (const list of allIceLists(body)) {
    assert.ok(Array.isArray(list) && list.length, 'the guest still gets STUN');
    for (const e of list) {
      for (const k of ['username', 'credential', 'credentialType']) assert.ok(!(k in e), `no ${k} in ${JSON.stringify(e)}`);
      for (const u of urlsOf(e)) assert.match(u, /^stuns?:/i, `no TURN URL without its login: ${u}`);
    }
    // The mixed entry keeps its stun: URL; the TURN-only entry is gone.
    assert.deepEqual(list, [{ urls: 'stun:stun.org.example:3478' }, { urls: 'stun:turn.org.example:3478' }]);
  }

  // The display it presents to is a member device: its start event carries the org's TURN as before.
  const sharer = await wsClient('/api/screen-share/ws');
  sharer.send(JSON.stringify({ type: 'auth', ticket: body.ticket }));
  const st = await waitFor(() => ORG_SCREEN.sock.got.find((g) => g.ev === 'device:screenshare-start' && g.data.session_id === body.session_id));
  assert.equal(st.data.guest, true);
  assert.deepEqual(st.data.ice_servers, ORG_ICE);
  sharer.close();
  await waitFor(() => ORG_SCREEN.sock.got.find((g) => g.ev === 'device:screenshare-stop'));
});

test('a guest on the global TURN with a secret gets short-lived TURN REST credentials', async () => {
  const body = await guestJoin('other', GLOBAL_SCREEN);
  assert.ok(!JSON.stringify(body).includes(TURN_SECRET), 'the secret never leaves the server');
  for (const list of allIceLists(body)) {
    assert.deepEqual(list[0], { urls: 'stun:stun.global.example:3478' });
    const turn = list.find((e) => urlsOf(e).some((u) => /^turns?:/i.test(u)));
    assert.ok(turn, 'the short-lived TURN is handed to the guest');
    const m = /^(\d+):screentinker$/.exec(turn.username);
    assert.ok(m, `HMAC-shaped TURN REST username: ${turn.username}`);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(Number(m[1]) > nowSec && Number(m[1]) <= nowSec + 3601, 'expires within the TTL');
    assert.equal(turn.credential, crypto.createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64'));
  }
});
