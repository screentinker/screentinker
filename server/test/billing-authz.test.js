'use strict';

// #146 Option C — billing:read scoped token authz. Booted server + JWT + DB access.
// Covers the DUAL PATH (token OR admin session, both directions), SCOPE ISOLATION (a
// billing token grants billing-read and nothing else), OWNER-ONLY minting, revocation,
// and a regression that ordinary token minting is unchanged.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-billauthz-' + crypto.randomBytes(4).toString('hex'));
let proc, db;

const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const jwtHdr = (t) => ({ headers: { Authorization: 'Bearer ' + t } });
const post = (t, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
async function register(email) {
  return (await (await fetch(BASE + '/api/auth/register', reg({ email, password: 'Passw0rd123' }))).json()).token;
}
const setRole = (email, role) => db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, email);

let adminJwt, userJwt, billingToken, billingTokenId, readToken;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-billauthz.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  const adminEmail = 'adm' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const userEmail = 'usr' + crypto.randomBytes(4).toString('hex') + '@x.local';
  adminJwt = await register(adminEmail);
  userJwt = await register(userEmail);
  setRole(adminEmail, 'platform_admin');   // role is read from DB per request

  // platform-admin mints a billing:read token; a normal user mints an ordinary read token.
  const minted = await (await fetch(BASE + '/api/tokens', post(adminJwt, { name: 'invoice-bot', scope: 'billing:read' }))).json();
  billingToken = minted.token; billingTokenId = minted.id;
  readToken = (await (await fetch(BASE + '/api/tokens', post(userJwt, { name: 'reader', scope: 'read' }))).json()).token;
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const S = (r) => r.status;

test('DUAL PATH positive: a billing:read token AND an admin session each read billing', async () => {
  assert.equal(S(await fetch(BASE + '/api/billing/usage', jwtHdr(billingToken))), 200, 'billing:read token can read billing');
  assert.equal(S(await fetch(BASE + '/api/billing/usage', jwtHdr(adminJwt))), 200, 'platform-admin session can read billing (not required to use a token)');
  // both return the real report shape
  const viaToken = await (await fetch(BASE + '/api/billing/usage', jwtHdr(billingToken))).json();
  assert.equal(typeof viaToken.billable_screens, 'number');
});

test('DUAL PATH negative: non-admin session and anonymous are refused', async () => {
  assert.equal(S(await fetch(BASE + '/api/billing/usage', jwtHdr(userJwt))), 403, 'ordinary user session denied');
  assert.equal(S(await fetch(BASE + '/api/billing/usage')), 401, 'anonymous denied');
});

test('SCOPE ISOLATION: a billing:read token grants billing-read and NOTHING else', async () => {
  // off the read/write/full ladder -> tokenScopeGate rejects it on a normal public router
  assert.equal(S(await fetch(BASE + '/api/devices', jwtHdr(billingToken))), 403, 'billing token cannot read devices');
  // and JWT-only routers reject any st_ token outright
  assert.equal(S(await fetch(BASE + '/api/admin/orgs', jwtHdr(billingToken))), 401, 'billing token cannot reach admin');
  // an ordinary read token can read devices (proves the 403 above is scope isolation, not a broken token)
  assert.equal(S(await fetch(BASE + '/api/devices', jwtHdr(readToken))), 200, 'ordinary read token still reads devices');
  // ...but the ordinary read token CANNOT read billing (isolation from the other side)
  assert.equal(S(await fetch(BASE + '/api/billing/usage', jwtHdr(readToken))), 403, 'read token cannot read billing');
});

test('MINTING is platform-admin only (owner-tier); ordinary admin and user cannot', async () => {
  // ordinary user
  assert.equal(S(await fetch(BASE + '/api/tokens', post(userJwt, { name: 'x', scope: 'billing:read' }))), 403, 'user cannot mint');
  // ordinary admin (ELEVATED but not PLATFORM) also cannot
  const aEmail = 'ord' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const aJwt = await register(aEmail); setRole(aEmail, 'admin');
  assert.equal(S(await fetch(BASE + '/api/tokens', post(aJwt, { name: 'x', scope: 'billing:read' }))), 403, 'ordinary admin cannot mint');
  // platform-admin can (already used in setup) — and an ordinary read token still mints fine (regression)
  assert.equal(S(await fetch(BASE + '/api/tokens', post(adminJwt, { name: 'ok', scope: 'billing:read' }))), 201, 'platform-admin can mint');
  assert.equal(S(await fetch(BASE + '/api/tokens', post(userJwt, { name: 'r', scope: 'read' }))), 201, 'ordinary token minting unchanged');
});

test('REVOCATION: a revoked billing:read token is refused', async () => {
  assert.equal(S(await fetch(BASE + '/api/billing/usage', jwtHdr(billingToken))), 200, 'valid before revoke');
  const del = await fetch(BASE + '/api/tokens/' + billingTokenId, { method: 'DELETE', ...jwtHdr(adminJwt) });
  assert.ok(del.status === 200 || del.status === 204, 'revoke succeeded');
  assert.equal(S(await fetch(BASE + '/api/billing/usage', jwtHdr(billingToken))), 401, 'revoked token refused');
});
