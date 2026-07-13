'use strict';

// #146 BILLING — endpoint authz + route isolation. Booted server + JWT + DB access.
// Asserts: admin can GET /api/billing/usage (200), non-admin 403 / anon 401, and billing
// is NOT present on the public /api/status (it lives on a SEPARATE route).

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
const DATA_DIR = path.join(os.tmpdir(), 'st-billing-ep-' + crypto.randomBytes(4).toString('hex'));
let proc, db;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-billing-ep.log'), 'w');
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

const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (tok) => (tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});

test('admin can GET /api/billing/usage; returns a current-month report', async () => {
  const email = 'bad' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const tok = (await (await fetch(BASE + '/api/auth/register', reg({ email, password: 'Passw0rd123' }))).json()).token;
  db.prepare("UPDATE users SET role = 'platform_admin' WHERE email = ?").run(email);

  const r = await fetch(BASE + '/api/billing/usage', auth(tok));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.match(b.month, /^\d{4}-\d{2}$/, 'current month by default');
  assert.equal(typeof b.billable_screens, 'number');
  assert.equal(typeof b.provisioned_screens, 'number');
  assert.equal(typeof b.cost_usd, 'number');
  assert.ok(Array.isArray(b.daily), 'daily breakdown present');
  assert.equal(b.is_final, false, 'current month is not final');

  // a specific month is accepted; a bad month is 400
  assert.equal((await fetch(BASE + '/api/billing/usage?month=2025-02', auth(tok))).status, 200);
  assert.equal((await fetch(BASE + '/api/billing/usage?month=2025-13', auth(tok))).status, 400);
});

test('non-admin gets 403, anonymous gets 401', async () => {
  const email = 'bu' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const tok = (await (await fetch(BASE + '/api/auth/register', reg({ email, password: 'Passw0rd123' }))).json()).token;
  assert.equal((await fetch(BASE + '/api/billing/usage', auth(tok))).status, 403, 'non-admin denied');
  assert.equal((await fetch(BASE + '/api/billing/usage')).status, 401, 'anon denied');
});

test('billing is NOT on public /api/status (separate route; no revenue data leaks)', async () => {
  const b = await (await fetch(BASE + '/api/status')).json();
  assert.equal(typeof b.devices_connected, 'number', 'devices_connected stays public');
  for (const k of ['billing', 'billable_screens', 'cost_usd', 'rate_usd', 'provisioned_screens']) {
    assert.equal(k in b, false, `/api/status must not expose ${k}`);
    if (b.debug) assert.equal(k in b.debug, false, `/api/status.debug must not expose ${k}`);
  }
});
