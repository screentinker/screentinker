'use strict';

// last_login must be stamped by EVERY path that hands a user a session, not just /login.
//
// The bug this pins: POST /api/auth/register issues a session immediately (self-hosted, and hosted
// when verification is off) but never stamped last_login, so a user who signed up and kept using
// that session read as "never logged in" for ever. On the hosted instance that was 132 of 349
// accounts, 43 of them actively publishing playlists. The column feeds admin views and was about to
// be used to select accounts for DELETION, so an under-report here deletes live customers.
//
// Also pinned: a signup must NOT fabricate an `auth:login_success` activity row (it is not a
// login), and switching workspace must NOT re-stamp (the user already had the session).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-lastlogin-' + crypto.randomBytes(4).toString('hex'));
let proc, db;

const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const authPost = (t, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

const PW = 'Passw0rd123';
const rowFor = (email) => db.prepare('SELECT id, last_login FROM users WHERE email = ?').get(email);
const loginRows = (id) => db.prepare("SELECT COUNT(*) n FROM activity_log WHERE user_id = ? AND action = 'auth:login_success'").get(id).n;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-lastlogin.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('REGRESSION: signing up stamps last_login (the account is holding a live session)', async () => {
  const email = 'sig' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const res = await (await fetch(BASE + '/api/auth/register', jsonPost({ email, password: PW }))).json();
  assert.ok(res.token, 'signup returned a session token');

  const u = rowFor(email);
  assert.ok(u, 'user row exists');
  assert.notEqual(u.last_login, null, 'last_login must be set: this account was handed a session');
  assert.ok(Number.isInteger(u.last_login), 'stamped as epoch seconds');
  const skew = Math.abs(Math.floor(Date.now() / 1000) - u.last_login);
  assert.ok(skew < 120, `stamp is current (was ${skew}s off)`);
});

test('a signup does NOT fabricate an auth:login_success event (it is not a login)', async () => {
  const email = 'noev' + crypto.randomBytes(4).toString('hex') + '@x.local';
  await fetch(BASE + '/api/auth/register', jsonPost({ email, password: PW }));
  assert.equal(loginRows(rowFor(email).id), 0, 'no login_success row from a signup');
});

test('logging in still stamps, and DOES record login_success', async () => {
  const email = 'log' + crypto.randomBytes(4).toString('hex') + '@x.local';
  await fetch(BASE + '/api/auth/register', jsonPost({ email, password: PW }));
  const id = rowFor(email).id;

  // Force a distinguishable earlier value so we can prove the login moved it.
  db.prepare('UPDATE users SET last_login = 1000 WHERE id = ?').run(id);
  const r = await fetch(BASE + '/api/auth/login', jsonPost({ email, password: PW }));
  assert.equal(r.status, 200, 'login succeeded');

  assert.ok(rowFor(email).last_login > 1000, 'login re-stamped last_login');
  assert.equal(loginRows(id), 1, 'login recorded exactly one login_success');
});

test('a failed login does not stamp', async () => {
  const email = 'bad' + crypto.randomBytes(4).toString('hex') + '@x.local';
  await fetch(BASE + '/api/auth/register', jsonPost({ email, password: PW }));
  const id = rowFor(email).id;
  db.prepare('UPDATE users SET last_login = 1000 WHERE id = ?').run(id);

  const r = await fetch(BASE + '/api/auth/login', jsonPost({ email, password: 'wrong-password-here' }));
  assert.notEqual(r.status, 200, 'bad password rejected');
  assert.equal(rowFor(email).last_login, 1000, 'last_login untouched by a failed login');
});

test('switching workspace does not re-stamp (already authenticated, not a new session)', async () => {
  const email = 'ws' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const token = (await (await fetch(BASE + '/api/auth/register', jsonPost({ email, password: PW }))).json()).token;
  const id = rowFor(email).id;
  const ws = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1').get(id);
  if (!ws) return;   // org-less signup on this config; nothing to switch to

  db.prepare('UPDATE users SET last_login = 1000 WHERE id = ?').run(id);
  await fetch(BASE + '/api/auth/switch-workspace', authPost(token, { workspace_id: ws.workspace_id }));
  assert.equal(rowFor(email).last_login, 1000, 'workspace switch is not a login');
});
