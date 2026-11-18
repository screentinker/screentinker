'use strict';

/*
 * SHELL, INSTALL_APK AND SET_SERVER_URL ARE FOR A WORKSPACE'S ADMINS (GHSA finding A).
 *
 * They were write-tier: every workspace_editor could run `sh -c` as the player app, install any
 * APK from a URL, repoint the screen at another server, and open the interactive PTY. The players
 * assume the server stops non-admins ("Gated to admins server-side"), so nothing else did.
 *
 * The invariant, per door (they all reach the screen through lib/device-command.js deliverCommand):
 *   - dashboard:device-command      editor refused (ADMIN_ONLY_COMMAND), workspace admin allowed
 *   - POST /api/devices/:id/command editor 403 ADMIN_ONLY_COMMAND, workspace admin allowed
 *   - POST /api/groups/:id/command  the editor's send is refused per screen, not delivered
 *   - an API token                  judged by its OWNER's membership, whatever its scope
 *   - dashboard:pty-open            editor 'forbidden'; the admin gets past the gate
 *   - everyday commands             unchanged for an editor
 *   - system callers (no actor)     unchanged
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

const PW = 'Passw0rd123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN_ONLY = [['shell', { cmd: 'id' }], ['install_apk', { url: 'https://example.com/x.apk' }],
  ['set_server_url', { url: 'https://elsewhere.example.com' }],
  // 3.2.4: reach past the player into the panel or the customer's network.
  ['http_request', { url: 'https://example.com/' }], ['kiosk_unlock', {}], ['unblock_uninstall', {}],
  ['status_bar', { visible: true }], ['set_time', { time: Date.now() }], ['update', {}]];

let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-adminonly-' + crypto.randomBytes(4).toString('hex'));
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

async function member(role) {
  const m = await register(role.replace('workspace_', ''));
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(U.owner.wsId, m.userId, role);
  const sw = await jfetch('/api/auth/switch-workspace', H(m.jwt, { workspace_id: U.owner.wsId }));
  assert.equal(sw.status, 200, 'switched into the shared workspace: ' + JSON.stringify(sw.body));
  return { ...m, jwt: sw.body.token || m.jwt };
}

/* An offline Pi that declares every admin-only capability, so only the role can refuse. */
function device() {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, platform, capabilities, created_at)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'pi', 'Linux/Debian 12', ?, strftime('%s','now'))`)
    .run(id, U.owner.wsId, U.owner.userId, crypto.randomBytes(32).toString('hex'),
      JSON.stringify(['system.shell', 'system.pty', 'system.install_apk', 'remote.set_server_url', 'system.reboot', 'audio.volume',
        'net.http_request', 'system.kiosk', 'system.device_owner', 'system.time', 'system.self_update']));
  return id;
}

function dashboard(jwt) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/dashboard', { transports: ['websocket'], reconnection: false, auth: { token: jwt } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const ask = (s, event, data) => new Promise((resolve) => {
  s.timeout(4000).emit(event, data, (err, ack) => resolve(err ? { timedOut: true } : ack));
});

async function mintToken(who) {
  const r = await jfetch('/api/tokens', H(U[who].jwt, { name: who + '-full', scope: 'full' }));
  assert.equal(r.status, 201, 'minted: ' + JSON.stringify(r.body));
  return r.body.token;
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
  U.owner = await register('owner');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  U.admin = await member('workspace_admin');
  U.editor = await member('workspace_editor');
  // Precondition: the workspace admin under test holds no platform or org role, so it is the
  // workspace_admin membership alone that lets it through.
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(U.admin.userId).role, 'user');
  assert.equal(db.prepare(`SELECT 1 FROM organization_members om JOIN workspaces w ON w.organization_id = om.organization_id
                           WHERE w.id = ? AND om.user_id = ?`).get(U.owner.wsId, U.admin.userId), undefined);
});

after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('REST: an editor is refused shell, install_apk and set_server_url; a workspace admin is not', async () => {
  const id = device();
  for (const [type, payload] of ADMIN_ONLY) {
    const ed = await jfetch(`/api/devices/${id}/command`, H(U.editor.jwt, { type, payload }));
    assert.equal(ed.status, 403, `${type} for an editor: ${JSON.stringify(ed.body)}`);
    assert.equal(ed.body.code, 'ADMIN_ONLY_COMMAND');
    const ad = await jfetch(`/api/devices/${id}/command`, H(U.admin.jwt, { type, payload }));
    assert.equal(ad.status, 200, `${type} for a workspace admin: ${JSON.stringify(ad.body)}`);
    assert.ok(['queued', 'offline'].includes(ad.body.status), 'went to the queue: the screen is offline');
  }
  // Everyday commands are untouched for an editor.
  const r = await jfetch(`/api/devices/${id}/command`, H(U.editor.jwt, { type: 'reboot' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('socket: dashboard:device-command refuses an editor and lets a workspace admin through', async () => {
  const id = device();
  const ed = await dashboard(U.editor.jwt);
  const ad = await dashboard(U.admin.jwt);
  try {
    for (const [type, payload] of ADMIN_ONLY) {
      const a = await ask(ed, 'dashboard:device-command', { device_id: id, type, payload });
      assert.ok(a && !a.timedOut, 'answered');
      assert.deepEqual([a.delivered, a.reason, a.code], [false, 'forbidden', 'ADMIN_ONLY_COMMAND'], `${type}: ${JSON.stringify(a)}`);
      const b = await ask(ad, 'dashboard:device-command', { device_id: id, type, payload });
      assert.ok(b && !b.timedOut, 'answered');
      assert.equal(b.reason, 'offline', `${type} for an admin reaches the queue: ${JSON.stringify(b)}`);
    }
    const v = await ask(ed, 'dashboard:device-command', { device_id: id, type: 'set_volume', payload: { level: 5 } });
    assert.equal(v.reason, 'offline', 'an editor still sends everyday commands: ' + JSON.stringify(v));
  } finally { ed.close(); ad.close(); }
});

test('group command: an editor\'s shell is refused for every screen, not delivered', async () => {
  const gid = crypto.randomUUID();
  db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)').run(gid, U.owner.userId, U.owner.wsId, 'G');
  const a = device(), b = device();
  for (const d of [a, b]) db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(gid, d);
  const ed = await jfetch(`/api/groups/${gid}/command`, H(U.editor.jwt, { type: 'shell', payload: { cmd: 'id' } }));
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.refused, 2, JSON.stringify(ed.body));
  for (const r of ed.body.results) assert.equal(r.code, 'ADMIN_ONLY_COMMAND');
  const ad = await jfetch(`/api/groups/${gid}/command`, H(U.admin.jwt, { type: 'shell', payload: { cmd: 'id' } }));
  assert.equal(ad.status, 200, JSON.stringify(ad.body));
  assert.equal(ad.body.refused, undefined, 'none refused for the workspace admin: ' + JSON.stringify(ad.body));
});

test('an API token is judged by its owner\'s membership, whatever its scope', async () => {
  const id = device();
  const edTok = await mintToken('editor');
  const adTok = await mintToken('admin');
  const ed = await jfetch(`/api/devices/${id}/command`, H(edTok, { type: 'shell', payload: { cmd: 'id' } }));
  assert.equal(ed.status, 403, 'a full token minted by an editor: ' + JSON.stringify(ed.body));
  assert.equal(ed.body.code, 'ADMIN_ONLY_COMMAND');
  const ad = await jfetch(`/api/devices/${id}/command`, H(adTok, { type: 'shell', payload: { cmd: 'id' } }));
  assert.equal(ad.status, 200, 'a full token minted by a workspace admin: ' + JSON.stringify(ad.body));
});

test('PTY: an editor cannot open a terminal; a workspace admin passes the gate', async () => {
  const id = device();
  const ed = await dashboard(U.editor.jwt);
  const ad = await dashboard(U.admin.jwt);
  try {
    const a = await ask(ed, 'dashboard:pty-open', { device_id: id });
    assert.deepEqual(a, { ok: false, error: 'forbidden' });
    const b = await ask(ad, 'dashboard:pty-open', { device_id: id });
    assert.equal(b.ok, false);
    assert.notEqual(b.error, 'forbidden', 'the admin is refused only for the screen being offline: ' + JSON.stringify(b));
  } finally { ed.close(); ad.close(); }
});
