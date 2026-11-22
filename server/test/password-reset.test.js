'use strict';

// Self-service password reset. Until now the only ways back into an account were an admin
// setting your password for you, or shell access to run scripts/reset-admin.js — so a
// self-hosted operator who forgot their password had no path at all.
//
// The security-relevant properties, each pinned below:
//
//  - NO ENUMERATION. The request endpoint answers identically whether or not the address
//    exists, and whether or not it is an SSO account with no password to reset.
//  - NO MFA BYPASS. Completing a reset does NOT issue a session. The user logs in
//    afterwards, so a TOTP-enabled account still has to pass its second factor. A reset
//    that returned a token would be a way to turn "I read one email" into a full session
//    without the second factor.
//  - SINGLE USE, SHORT LIVED. The token is stored only as a hash, works once, and expires.
//  - LOCAL ACCOUNTS ONLY. SSO identities have no local password.
//  - IT ACTUALLY UNBLOCKS YOU. A reset clears the per-account login lockout, otherwise
//    someone who locked themselves out by guessing would reset and still be locked out.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-pwreset-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-pwreset-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
const NEW_PW = 'BrandNewPw456';
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const post = (obj) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const forgot = (email) => jfetch('/api/auth/forgot-password', post({ email }));
const reset = (token, password) => jfetch('/api/auth/reset-password', post({ token, password }));
const login = (email, password) => jfetch('/api/auth/login', post({ email, password }));

// The emailed token is only ever stored as a hash, so a test reads the plaintext the way
// the user would: it cannot. Instead we mint through the same lib the route uses.
const issueTokenFor = (userId) => require('../lib/passwordReset').issue(userId);

async function register(email) {
  const r = await jfetch('/api/auth/register', post({ email, password: PW }));
  return r.body;
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  process.env.DATA_DIR = DATA_DIR; // so the lib below opens the same DB the server uses
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  S.admin = await register('admin' + crypto.randomBytes(4).toString('hex') + '@x.local');
  S.email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  S.user = await register(S.email);
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

// ---------------------------------------------------------------------------
// Enumeration resistance
// ---------------------------------------------------------------------------
test('the request endpoint cannot be used to discover which addresses exist', async () => {
  const real = await forgot(S.email);
  const fake = await forgot('definitely-not-a-user-' + crypto.randomBytes(4).toString('hex') + '@x.local');
  assert.equal(real.status, fake.status, 'status must match for real and unknown addresses');
  assert.deepEqual(real.body, fake.body, 'body must match for real and unknown addresses');
  assert.equal(real.status, 200);
});

test('a malformed address is answered the same way, not validated into an oracle', async () => {
  const bad = await forgot('not-an-email');
  const real = await forgot(S.email);
  assert.equal(bad.status, real.status);
  assert.deepEqual(bad.body, real.body);
});

// ---------------------------------------------------------------------------
// The reset itself
// ---------------------------------------------------------------------------
test('a valid token sets a new password, and the old one stops working', async () => {
  const token = issueTokenFor(S.user.user.id);
  const r = await reset(token, NEW_PW);
  assert.equal(r.status, 200, `reset should succeed, got ${JSON.stringify(r.body)}`);

  assert.equal((await login(S.email, PW)).status, 401, 'the OLD password must stop working');
  const ok = await login(S.email, NEW_PW);
  assert.equal(ok.status, 200, 'the NEW password works');
  assert.ok(ok.body.token, 'and yields a session on normal login');
});

test('a token works exactly once', async () => {
  const token = issueTokenFor(S.user.user.id);
  assert.equal((await reset(token, 'FirstUse12345')).status, 200);
  assert.equal((await reset(token, 'SecondUse12345')).status, 400, 'replay must fail');
  assert.equal((await login(S.email, 'SecondUse12345')).status, 401, 'and must not have changed the password');
});

test('redeeming a reset link verifies the address (the token was mailed to it), still with no session', async () => {
  db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(S.user.user.id);
  const r = await reset(issueTokenFor(S.user.user.id), 'VerifiedByReset1');
  assert.equal(r.status, 200);
  assert.ok(!r.body || !r.body.token, 'a reset still hands out no session');
  assert.equal(db.prepare('SELECT email_verified FROM users WHERE id = ?').get(S.user.user.id).email_verified, 1);
});

test('an unknown or expired token is refused', async () => {
  assert.equal((await reset(crypto.randomBytes(32).toString('hex'), NEW_PW)).status, 400, 'unknown token');
  assert.equal((await reset('', NEW_PW)).status, 400, 'empty token');

  const token = issueTokenFor(S.user.user.id);
  db.prepare('UPDATE users SET password_reset_expires = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 60, S.user.user.id);
  assert.equal((await reset(token, NEW_PW)).status, 400, 'expired token');
});

test('the new password must meet the same minimum as registration', async () => {
  const token = issueTokenFor(S.user.user.id);
  const r = await reset(token, 'short');
  assert.equal(r.status, 400, 'a too-short password is refused');
  assert.match(r.body.error, /8/, 'and says why');
});

// ---------------------------------------------------------------------------
// The properties that keep this from becoming a bypass
// ---------------------------------------------------------------------------
test('completing a reset does NOT hand out a session (so TOTP is still enforced)', async () => {
  const token = issueTokenFor(S.user.user.id);
  const r = await reset(token, 'AnotherPw7890');
  assert.equal(r.status, 200);
  assert.equal(r.body.token, undefined, 'a reset must never return a session token');
  assert.equal(r.body.user, undefined, 'nor a user object');
});

test('a reset clears the per-account login lockout', async () => {
  // Drive this over HTTP, not against the lib: the lockout Map lives in the SERVER
  // process, so touching it in the test process would prove nothing.
  //
  // Each attempt carries a different X-Forwarded-For so the per-IP limiter (10/min) gives
  // a fresh bucket every time while the per-ACCOUNT counter still accumulates — which is
  // precisely the distributed case the account lockout exists for.
  const lockout = require('../lib/login-lockout');
  const email = 'lock' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const u = await register(email);

  const failFrom = (i) => jfetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  });
  for (let i = 1; i <= lockout.MAX_FAILS; i++) {
    const r = await failFrom(i);
    assert.equal(r.status, 401, `failure ${i} must reach the handler, not the IP limiter`);
  }

  // Locked: even the CORRECT password is refused, with the same generic body.
  const blocked = await jfetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.200' },
    body: JSON.stringify({ email, password: PW }),
  });
  assert.equal(blocked.status, 401, 'the account is locked before the reset');

  assert.equal((await reset(issueTokenFor(u.user.id), 'UnlockedPw123')).status, 200);

  const after = await jfetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.201' },
    body: JSON.stringify({ email, password: 'UnlockedPw123' }),
  });
  assert.equal(after.status, 200, 'resetting a password must let you back in');
  assert.ok(after.body.token);
});

test('an SSO account has no local password to reset', async () => {
  const ssoEmail = 'sso' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash, auth_provider, plan_id) VALUES (?,?,NULL,'google','free')")
    .run(id, ssoEmail);
  const r = await forgot(ssoEmail);
  assert.equal(r.status, 200, 'still answered identically — no oracle');
  const row = db.prepare('SELECT password_reset_hash FROM users WHERE id = ?').get(id);
  assert.equal(row.password_reset_hash, null, 'but no reset token is minted for an SSO identity');
});
