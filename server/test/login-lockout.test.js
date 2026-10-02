'use strict';

// Password login must be bounded per ACCOUNT, not only per IP. The IP limiter in server.js
// bounds one noisy source; it bounds nothing against a distributed one, and it is only as
// accurate as the deployment's proxy configuration.
//
// Two properties matter and are easy to get wrong:
//   - a locked account must answer EXACTLY like a wrong password, or the endpoint becomes
//     an account-existence oracle (a distinct 429 says "this account is real");
//   - a correct password must clear the counter immediately — including for accounts that
//     then go on to a TOTP or email-verification step, which return before issueSession.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-loginlock-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lockout = require('../lib/login-lockout');

// ---------------------------------------------------------------------------
// Unit: the counter itself (mirrors test/pair-lockout.test.js — unique key per
// test, because the Map is module-level)
// ---------------------------------------------------------------------------
const k = () => 'user-' + crypto.randomBytes(6).toString('hex');

test('an account is not locked until it crosses the threshold', () => {
  const key = k();
  for (let i = 0; i < lockout.MAX_FAILS - 1; i++) lockout.recordFailure(key);
  assert.equal(lockout.isLocked(key), false, `${lockout.MAX_FAILS - 1} failures must not lock`);
});

test('crossing the threshold locks the account for the full window', () => {
  const key = k();
  const t0 = 1_000_000;
  for (let i = 0; i < lockout.MAX_FAILS; i++) lockout.recordFailure(key, t0);
  assert.equal(lockout.isLocked(key, t0), true, 'locked at the threshold');
  assert.equal(lockout.isLocked(key, t0 + lockout.LOCKOUT_MS - 1), true, 'still locked inside the window');
  assert.equal(lockout.isLocked(key, t0 + lockout.LOCKOUT_MS + 1), false, 'released after the window');
});

test('a correct password clears the counter', () => {
  const key = k();
  for (let i = 0; i < lockout.MAX_FAILS - 1; i++) lockout.recordFailure(key);
  lockout.reset(key);
  for (let i = 0; i < lockout.MAX_FAILS - 1; i++) lockout.recordFailure(key);
  assert.equal(lockout.isLocked(key), false, 'reset gave the account its full budget back');
});

test('accounts are independent — one locked account does not lock another', () => {
  const a = k(), b = k();
  for (let i = 0; i < lockout.MAX_FAILS; i++) lockout.recordFailure(a);
  assert.equal(lockout.isLocked(a), true);
  assert.equal(lockout.isLocked(b), false, 'a different account is unaffected');
});

test('an unknown key is never locked', () => {
  assert.equal(lockout.isLocked(k()), false);
});

// ---------------------------------------------------------------------------
// Route: the lockout is wired into POST /api/auth/login, and is not an oracle
// ---------------------------------------------------------------------------
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const bcrypt = require('bcryptjs');

let server, base;
const PW = 'Passw0rd123';

function post(body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('route: a locked account is indistinguishable from a wrong password', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/', require('../routes/auth'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  const email = 'lock' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash, auth_provider, plan_id, email_verified) VALUES (?,?,?,'local','free',1)")
    .run(id, email, bcrypt.hashSync(PW, 10));

  // Baseline: what a wrong password looks like.
  const wrong = await post({ email, password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'Invalid email or password');

  // Drive it past the threshold.
  for (let i = 0; i < lockout.MAX_FAILS + 2; i++) await post({ email, password: 'nope' });
  assert.equal(lockout.isLocked(id), true, 'the account is locked after repeated failures');

  // The CORRECT password is now refused — and the response is byte-identical to a wrong
  // one, so an attacker learns nothing about whether the account exists or is locked.
  const locked = await post({ email, password: PW });
  assert.equal(locked.status, wrong.status, 'locked status must match the wrong-password status');
  assert.deepEqual(locked.body, wrong.body, 'locked body must match the wrong-password body exactly');

  // A non-existent account still answers the same way.
  const ghost = await post({ email: 'ghost' + crypto.randomBytes(4).toString('hex') + '@x.local', password: 'nope' });
  assert.equal(ghost.status, wrong.status);
  assert.deepEqual(ghost.body, wrong.body, 'unknown account is indistinguishable too');
});

test('route: a correct password clears the counter before any TOTP/verify step', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/', require('../routes/auth'));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => new Promise((r) => srv.close(r)));

  const email = 'clear' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash, auth_provider, plan_id, email_verified) VALUES (?,?,?,'local','free',1)")
    .run(id, email, bcrypt.hashSync(PW, 10));

  for (let i = 0; i < lockout.MAX_FAILS - 1; i++) await post({ email, password: 'nope' });
  const ok = await post({ email, password: PW });
  assert.equal(ok.status, 200, 'the correct password still logs in');
  assert.equal(lockout.isLocked(id), false);

  // Full budget restored: another MAX_FAILS-1 failures must still not lock.
  for (let i = 0; i < lockout.MAX_FAILS - 1; i++) await post({ email, password: 'nope' });
  assert.equal(lockout.isLocked(id), false, 'the successful login reset the counter');
});

// ---------------------------------------------------------------------------
// #472: the server console says the account is locked, without flooding
// ---------------------------------------------------------------------------
test('a lock is announced on the console with the time left and how to clear it', () => {
  const key = k();
  const t0 = 5_000_000;
  for (let i = 0; i < lockout.MAX_FAILS; i++) lockout.recordFailure(key, t0);
  const lines = [];
  assert.equal(lockout.warnLocked(key, 'admin@example.com', t0, (m) => lines.push(m)), true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /admin@example\.com is LOCKED for 15 more minute/);
  assert.match(lines[0], /password reset, or restart the server/);
});

test('repeat attempts during a lock log at most once a minute per account', () => {
  const key = k();
  const t0 = 9_000_000;
  for (let i = 0; i < lockout.MAX_FAILS; i++) lockout.recordFailure(key, t0);
  const lines = [];
  const log = (m) => lines.push(m);
  lockout.warnLocked(key, 'x', t0, log);
  for (let s = 1; s < 60; s++) lockout.warnLocked(key, 'x', t0 + s * 1000, log);
  assert.equal(lines.length, 1, 'no second line inside the minute');
  lockout.warnLocked(key, 'x', t0 + 60_000, log);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /14 more minute/);
});

test('minutesLeft is 0 once unlocked or reset', () => {
  const key = k();
  const t0 = 12_000_000;
  for (let i = 0; i < lockout.MAX_FAILS; i++) lockout.recordFailure(key, t0);
  assert.equal(lockout.minutesLeft(key, t0 + lockout.LOCKOUT_MS + 1), 0);
  lockout.reset(key);
  assert.equal(lockout.minutesLeft(key, t0), 0);
});
