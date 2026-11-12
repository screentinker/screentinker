'use strict';

/*
 * WHO MAY READ A SCREEN'S CREDENTIALS.
 *
 * Four columns on a device row are credentials rather than settings:
 *
 *   settings_pin      unlocks the on-device settings menu
 *   trigger_secret    lets a LAN datagram change what the screen shows
 *   local_api_secret  lets a LAN request reload, blank or re-volume the screen
 *   enrol_key         lets the holder register AS the screen
 *
 * Each turns a read into control of the screen, so each belongs to the people who may already
 * control it: workspace admins and editors, on the device detail page. A read-only member
 * (workspace_viewer) is refused every write to a screen; these four must not hand the same power
 * back through a read. And a broadcast to "everyone in the workspace" reaches read-only members
 * too, so no broadcast carries them at all (the list endpoint has always dropped them).
 *
 * The invariant, per path a device row leaves the server by:
 *   - GET /api/devices/:id        admin and editor keep all four, a viewer gets none
 *   - dashboard:device-added      none of the four, for every listener, on every emit site
 *   - POST /api/provision/pair    the person pairing still gets the PIN (unchanged)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');

const CREDS = ['settings_pin', 'trigger_secret', 'local_api_secret', 'enrol_key'];
const PW = 'Passw0rd123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-devcreds-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const U = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const H = (tok, body) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function register(name) {
  const email = name + crypto.randomBytes(4).toString('hex') + '@example.com';
  const reg = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, name }) });
  assert.ok(reg.body && reg.body.token, 'registered: ' + JSON.stringify(reg.body));
  return { jwt: reg.body.token, userId: reg.body.user.id, wsId: reg.body.current_workspace_id };
}

/** A member of the admin's workspace with the given role, signed in to that workspace. */
async function member(role) {
  const m = await register(role.replace('workspace_', ''));
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(U.admin.wsId, m.userId, role);
  const sw = await jfetch('/api/auth/switch-workspace', H(m.jwt, { workspace_id: U.admin.wsId }));
  assert.equal(sw.status, 200, 'switched into the shared workspace: ' + JSON.stringify(sw.body));
  return { ...m, jwt: sw.body.token || m.jwt };
}

function claimedDevice() {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, created_at,
                                   settings_pin, trigger_secret, local_api_secret, enrol_key)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'apk', strftime('%s','now'), '424242', ?, ?, ?)`)
    .run(id, U.admin.wsId, U.admin.userId, crypto.randomBytes(32).toString('hex'),
      'trig-' + crypto.randomBytes(8).toString('hex'), 'lapi-' + crypto.randomBytes(8).toString('hex'),
      crypto.randomBytes(20).toString('hex'));
  return id;
}

function unclaimedDevice() {
  const id = crypto.randomUUID();
  const code = String(100000 + crypto.randomInt(900000));
  const now = Math.floor(Date.now() / 1000);
  // A screen that was reset and re-registered can still carry these from its last life.
  db.prepare(`INSERT INTO devices (id, pairing_code, status, app_version, created_at, last_heartbeat,
                                   trigger_secret, local_api_secret, enrol_key)
              VALUES (?, ?, 'provisioning', '1.1.0-web', ?, ?, ?, ?, ?)`)
    .run(id, code, now, now, 'trig-old', 'lapi-old', crypto.randomBytes(20).toString('hex'));
  return { id, code };
}

function dashboardSocket(jwt) {
  return new Promise((resolve, reject) => {
    const events = [];
    const s = ioClient(BASE + '/dashboard', { transports: ['websocket'], reconnection: false, auth: { token: jwt } });
    s.on('dashboard:device-added', (p) => events.push(p));
    s.on('connect', () => resolve({ s, events }));
    s.on('connect_error', reject);
  });
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  U.admin = await register('admin');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  U.editor = await member('workspace_editor');
  U.viewer = await member('workspace_viewer');
});

after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('the people who run a screen still read its credentials on the detail page', async () => {
  const id = claimedDevice();
  for (const who of ['admin', 'editor']) {
    const r = await jfetch('/api/devices/' + id, H(U[who].jwt));
    assert.equal(r.status, 200, who + ': ' + JSON.stringify(r.body));
    for (const k of CREDS) assert.ok(r.body[k], `${who} keeps ${k}: the detail page is the only place it exists`);
    assert.equal(r.body.device_token, undefined, 'the device token never leaves, for anyone');
  }
});

test('a read-only member can open a screen but gets none of its credentials', async () => {
  const id = claimedDevice();
  const r = await jfetch('/api/devices/' + id, H(U.viewer.jwt));
  assert.equal(r.status, 200, 'a viewer may still look at the screen: ' + JSON.stringify(r.body));
  assert.equal(r.body.name, 'Lobby', 'and still gets a usable device');
  for (const k of CREDS) assert.equal(r.body[k], undefined, `a read-only member must not receive ${k}`);
});

test('pairing tells the workspace about the screen without its credentials', async () => {
  const watcher = await dashboardSocket(U.viewer.jwt);
  try {
    const d = unclaimedDevice();
    const r = await jfetch('/api/provision/pair', H(U.admin.jwt, { pairing_code: d.code, name: 'Paired' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.settings_pin, 'the person pairing still gets the PIN to write on the panel');
    assert.equal(r.body.device_token, undefined);
    for (let i = 0; i < 40 && !watcher.events.some((e) => e && e.id === d.id); i++) await sleep(50);
    const seen = watcher.events.find((e) => e && e.id === d.id);
    assert.ok(seen, 'the workspace was told about the new screen');
    assert.equal(seen.device_token, undefined);
    for (const k of CREDS) assert.equal(seen[k], undefined, `the broadcast must not carry ${k}`);
  } finally { watcher.s.close(); }
});

test('every broadcast of a device row goes through the list sanitiser', () => {
  // The same row leaves from five places. Each was written separately and three of them forgot.
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['server.js', 'routes/devices.js', 'ws/deviceSocket.js']) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (!line.includes("'dashboard:device-added'") || line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      // The payload is built on this line or the next; it must be the list-sanitised copy.
      const stmt = line + (lines[i + 1] || '');
      assert.ok(/stripDeviceSecretsForList|ForBroadcast/.test(stmt),
        `${f}:${i + 1} broadcasts a device row that did not pass through stripDeviceSecretsForList`);
    });
  }
});
