'use strict';

// 3.0 account changes on routes/auth.js:
//   - token_version: a password change/reset or 2FA change ends every OTHER session; the caller gets
//     a fresh token; a 2.x token (no tv claim) keeps working until the first bump.
//   - GET /me carries the account summary the app shell needs (trial, plan, self_hosted, ui_mode,
//     onboarded_at, subscription_status); PUT /me stores ui_mode / onboarded narrowly.
//   - self-hosted signups after the first are not put on a trial clock (SELF_HOSTED_SIGNUP_PLAN).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-v3acct-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');

let server, base;
const PW = 'Passw0rd123';

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
after(() => new Promise((r) => server.close(r)));

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function makeUser(extra = {}) {
  const id = crypto.randomUUID();
  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  db.prepare("INSERT INTO users (id, email, password_hash, auth_provider, plan_id, email_verified) VALUES (?,?,?,'local','free',1)")
    .run(id, email, bcrypt.hashSync(PW, 4));
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, id);
  return db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
}

test('a password change ends other sessions, keeps this one via a fresh token', async () => {
  const u = makeUser();
  const tabA = generateToken(u, null);
  const tabB = generateToken(u, null);
  assert.equal((await call('GET', '/me', { token: tabB })).status, 200);

  const r = await call('PUT', '/me', { token: tabA, body: { current_password: PW, password: 'N3w-password-1' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'the caller is handed a fresh token');

  assert.equal((await call('GET', '/me', { token: tabB })).status, 401, 'the other session is over');
  assert.equal((await call('GET', '/me', { token: tabA })).status, 401, 'so is the token that made the change');
  assert.equal((await call('GET', '/me', { token: r.body.token })).status, 200, 'the fresh token works');
});

test('a 2.x token (no tv claim) keeps working until the first bump, then stops', async () => {
  const u = makeUser();
  const legacy = jwt.sign({ id: u.id, email: u.email, role: 'user', current_workspace_id: null }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '1h' });
  assert.equal((await call('GET', '/me', { token: legacy })).status, 200);
  const r = await call('POST', '/sessions/revoke-others', { token: legacy });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/me', { token: legacy })).status, 401);
  assert.equal((await call('GET', '/me', { token: r.body.token })).status, 200);
});

test('GET /me carries the account summary; PUT /me stores ui_mode and onboarded narrowly', async () => {
  const u = makeUser();
  const tok = generateToken(u, null);
  let me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.self_hosted, true);
  assert.equal(me.ui_mode, 'simple', 'an account created after the 3.0 migration starts simple');
  assert.equal(me.onboarded_at, null);
  assert.ok(me.trial && typeof me.trial.active === 'boolean');
  assert.ok('subscription_status' in me, 'the past-due banner needs this field');
  assert.equal(me.token_version, undefined, 'internal column does not leak');

  await call('PUT', '/me', { token: tok, body: { ui_mode: 'advanced', onboarded: true } });
  me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.ui_mode, 'advanced');
  assert.ok(me.onboarded_at > 0);

  await call('PUT', '/me', { token: tok, body: { ui_mode: '<script>' } });
  assert.equal((await call('GET', '/me', { token: tok })).body.ui_mode, 'advanced', 'unknown values are ignored');
});

test('PUT /me stores language and theme on the account; GET /me reads them back', async () => {
  const u = makeUser();
  const tok = generateToken(u, null);
  let me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.language, null, 'nothing chosen yet: the browser decides');
  assert.equal(me.theme, null);

  await call('PUT', '/me', { token: tok, body: { language: 'da', theme: 'light' } });
  me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.language, 'da');
  assert.equal(me.theme, 'light');

  await call('PUT', '/me', { token: tok, body: { language: 'klingon', theme: '<script>' } });
  me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.language, 'da', 'unknown values are ignored');
  assert.equal(me.theme, 'light');

  await call('PUT', '/me', { token: tok, body: { name: 'Renamed' } });
  me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.language, 'da', 'an unrelated update leaves the choice alone');

  await call('PUT', '/me', { token: tok, body: { language: null, theme: '' } });
  me = (await call('GET', '/me', { token: tok })).body;
  assert.equal(me.language, null, 'null clears it');
  assert.equal(me.theme, null, 'empty clears it');
});

test('self-hosted: a later signup is enterprise with no trial clock', async () => {
  makeUser(); // not the first account
  const email = 'later' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const r = await call('POST', '/register', { body: { email, password: PW, name: 'Later' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = db.prepare('SELECT plan_id, trial_started, ui_mode FROM users WHERE email = ?').get(email);
  assert.equal(row.plan_id, 'enterprise');
  assert.equal(row.trial_started, null);
  assert.equal(row.ui_mode, 'simple');
});

test('self-hosted sponsor ask: fresh install waits 3 days; an upgraded install is asked at once', async () => {
  const u = makeUser();
  const tok = generateToken(u, null);
  db.prepare("DELETE FROM app_settings WHERE key = 'last_upgraded_at'").run();
  assert.equal((await call('GET', '/me', { token: tok })).body.sponsor_prompt, false, 'day one on a fresh install: no ask');
  db.prepare("UPDATE users SET created_at = strftime('%s','now') - 3*86400 - 60 WHERE id = ?").run(u.id);
  assert.equal((await call('GET', '/me', { token: tok })).body.sponsor_prompt, true, 'three days in: ask');
  db.prepare("UPDATE users SET created_at = strftime('%s','now') WHERE id = ?").run(u.id);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('last_upgraded_at', strftime('%s','now'), strftime('%s','now'))").run();
  assert.equal((await call('GET', '/me', { token: tok })).body.sponsor_prompt, true, 'upgraded install: ask straight away');
  config.hideSponsor = true;
  try { assert.equal((await call('GET', '/me', { token: tok })).body.sponsor_prompt, false, 'ST_HIDE_SPONSOR wins'); }
  finally { config.hideSponsor = false; }
});
