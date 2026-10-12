'use strict';

/*
 * The Talk media routes carry the session itself (publish = the caller's mic
 * out of the screen's speaker, view = the screen's mic), so they need WRITE access, the same as
 * dashboard:talk-start. A read-only workspace_viewer used to get through on checkDeviceRead, and
 * the workspace broadcast publish said "any workspace member may talk".
 *
 * Against the real server. Talk is not configured here (no go2rtc), so a caller who passes the
 * access check gets 409 "not available"; a viewer must be stopped before that, with 403.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG;
const U = {};
let DEV;

const run = (sql, ...a) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function call(who, method, p, body, type = 'application/json') {
  const headers = { Authorization: `Bearer ${U[who].token}`, 'X-Workspace-Id': U.owner.ws };
  if (body !== undefined) headers['Content-Type'] = type;
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

async function register(name) {
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}-${Date.now()}@talk.test`, password: 'Passw0rd123', name }),
  });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  U[name] = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
}

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-talk-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  await register('owner');      // first user: platform admin, admin of their own workspace
  await register('editor');
  await register('viewer');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", U.owner.ws, U.editor.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", U.owner.ws, U.viewer.id);
  DEV = crypto.randomUUID();
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status) VALUES (?, ?, ?, 'Lobby', ?, 'offline')`,
    DEV, U.owner.id, U.owner.ws, crypto.randomUUID().slice(0, 6));
});

after(async () => {
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

test('⚠️ a workspace_viewer cannot publish into, or listen to, a device Talk session', async () => {
  for (const leg of ['publish', 'view']) {
    const r = await call('viewer', 'POST', `/api/devices/${DEV}/talk/${leg}`, SDP, 'application/sdp');
    assert.equal(r.status, 403, `${leg}: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.error), /read-only/i);
  }
});

test('an editor gets past the access check (409 only because Talk is not set up here)', async () => {
  for (const leg of ['publish', 'view']) {
    const r = await call('editor', 'POST', `/api/devices/${DEV}/talk/${leg}`, SDP, 'application/sdp');
    assert.equal(r.status, 409, `${leg}: ${JSON.stringify(r.body)}`);
  }
});

test('⚠️ a workspace_viewer cannot publish a workspace-wide broadcast; an editor can reach it', async () => {
  const v = await call('viewer', 'POST', `/api/workspaces/${U.owner.ws}/talk/publish`, SDP, 'application/sdp');
  assert.equal(v.status, 403, JSON.stringify(v.body));
  const e = await call('editor', 'POST', `/api/workspaces/${U.owner.ws}/talk/publish`, SDP, 'application/sdp');
  assert.equal(e.status, 409, JSON.stringify(e.body));
});

test('reading the Talk session info stays open to a viewer (nothing is carried by it)', async () => {
  const d = await call('viewer', 'GET', `/api/devices/${DEV}/talk`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const w = await call('viewer', 'GET', `/api/workspaces/${U.owner.ws}/talk`);
  assert.equal(w.status, 200, JSON.stringify(w.body));
});
