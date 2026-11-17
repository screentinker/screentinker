'use strict';

// GHSA-rvxj (D follow-up): the account export was downloaded with ?token=<session JWT>, so a full
// session landed in proxy logs and browser history. The page now asks for a single-use, 60-second
// ticket with its Authorization header and downloads with ?ticket=. ?token= no longer authenticates.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, proc, TOKEN;
const DATA_DIR = path.join(os.tmpdir(), 'st-export-ticket-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    body: JSON.stringify({ email: 'exp@ticket.local', password: 'export-password-1', name: 'exp' }) })).json();
  TOKEN = reg.token;
  assert.ok(TOKEN, 'registered');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } try { fs.rmSync(LOG, { force: true }); } catch { /* */ } });

const ticket = () => fetch(BASE + '/api/status/export-ticket', { method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: '{}' });

test('?token= no longer authenticates the export', async () => {
  const r = await fetch(`${BASE}/api/status/export?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(r.status, 401);
});

test('a ticket needs a session header', async () => {
  const r = await fetch(BASE + '/api/status/export-ticket', { method: 'POST' });
  assert.equal(r.status, 401);
});

test('a ticket downloads once, is not the session token, and a made-up one is refused', async () => {
  const t = await ticket();
  assert.equal(t.status, 200);
  const { ticket: tk, expires_in } = await t.json();
  assert.ok(tk && tk !== TOKEN && !TOKEN.includes(tk));
  assert.equal(expires_in, 60);
  const first = await fetch(`${BASE}/api/status/export?ticket=${encodeURIComponent(tk)}`);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).format, 'screentinker-export-v2');
  const again = await fetch(`${BASE}/api/status/export?ticket=${encodeURIComponent(tk)}`);
  assert.equal(again.status, 401, 'single-use');
  const bogus = await fetch(`${BASE}/api/status/export?ticket=made-up`);
  assert.equal(bogus.status, 401);
});
