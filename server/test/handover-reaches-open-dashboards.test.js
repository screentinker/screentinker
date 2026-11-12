'use strict';

/*
 * A HAND-OVER NEEDS NO NEW SIGN-IN, AND OPEN DASHBOARDS SHOW IT AT ONCE.
 *
 * A session token carries who someone is, never their role in an organization: that is read from
 * the database on every request, so the new owner can act as owner on their very next request and
 * the old owner is held to admin on theirs. What an open dashboard holds is its own copy of the
 * role (the owner-only controls it shows), so both people's dashboards are told to re-read it.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-handover-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const register = async (n) => (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: n + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: n }) })).json());
const call = (tok, m, p, body) => fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
const dashboard = (token) => new Promise((resolve, reject) => {
  const s = ioClient(BASE + '/dashboard', { transports: ['websocket'], reconnection: false, auth: { token } });
  s.got = 0; s.on('dashboard:access-changed', () => { s.got++; });
  s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});

test('after a hand-over the same sessions act as the new roles, and both open dashboards are told', async () => {
  await register('first');                 // the first account on a fresh install is its platform admin, who may always hand over
  const a = await register('owner'), b = await register('next');
  const orgId = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(a.current_workspace_id).organization_id;
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(a.current_workspace_id, b.user.id);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_member')").run(orgId, b.user.id);
  const sa = await dashboard(a.token), sb = await dashboard(b.token);
  try {
    assert.equal((await call(b.token, 'POST', `/api/organizations/${orgId}/ownership`, { user_id: a.user.id })).status, 403, 'not the owner yet');
    const r = await call(a.token, 'POST', `/api/organizations/${orgId}/ownership`, { user_id: b.user.id, acknowledge_plan_change: true });
    assert.equal(r.status, 200, await r.text());
    for (let i = 0; i < 40 && !(sa.got && sb.got); i++) await sleep(50);
    assert.deepEqual([sa.got > 0, sb.got > 0], [true, true], 'both dashboards were told');
    // The same tokens, no new sign-in: the new owner can hand it on, the old one no longer can.
    assert.equal((await call(a.token, 'POST', `/api/organizations/${orgId}/ownership`, { user_id: a.user.id })).status, 403);
    const back = await call(b.token, 'POST', `/api/organizations/${orgId}/ownership`, { user_id: a.user.id, acknowledge_plan_change: true });
    assert.equal(back.status, 200, await back.text());
  } finally { sa.close(); sb.close(); }
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'app.js'), 'utf8');
  assert.match(app, /onSocket\('access-changed', \(\) => \{ if \(isAuthenticated\(\)\) refreshCurrentUser\(\)\.then/, 'the page re-reads who they are');
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'socket.js'), 'utf8'), /'dashboard:access-changed', \(\) => emit\('access-changed'/);
});
