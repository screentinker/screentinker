'use strict';

// GHSA-rvxj 12.1: PUT /api/auth/me checks current_password before setting a new one. It had no
// lockout, so whoever held a stolen session could guess the password without limit and then change
// it. Failures now feed the same per-account lockout as login and account deletion
// (lib/login-lockout.js), checked before bcrypt: once locked, even the right password is refused.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');
const { MAX_FAILS } = require('../lib/login-lockout');

let PORT, BASE, proc, TOKEN;
const DATA_DIR = path.join(os.tmpdir(), 'st-me-lock-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'right-password-123';

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'me@lock.local', password: PASSWORD, name: 'me' }) })).json();
  TOKEN = reg.token;
  assert.ok(TOKEN, 'registered');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const changePassword = (current) => fetch(BASE + '/api/auth/me', { method: 'PUT',
  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ current_password: current, password: 'attacker-chosen-456' }) });

test('a wrong current password is refused as before', async () => {
  assert.equal((await changePassword('guess-0')).status, 401);
});

test('after repeated wrong guesses even the right current password is refused, and nothing changes', async () => {
  for (let i = 1; i < MAX_FAILS; i++) assert.equal((await changePassword(`guess-${i}`)).status, 401);
  const r = await changePassword(PASSWORD);
  assert.equal(r.status, 429, 'locked: the right password does not get through');
  // The password is still the original one: signing in with the "new" one fails (the account is
  // also locked for login, as it is the same lockout, so the attacker's password is never proven).
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'me@lock.local', password: 'attacker-chosen-456' }) });
  assert.notEqual(login.status, 200);
});
