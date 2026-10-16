'use strict';

// 3.0: single sign-on for the ScreenTinker Manager app (routes/auth.js APP_REDIRECT / app-exchange).
// The browser runs the login; the app gets the session by swapping a single-use code AND the
// PKCE-style verifier it kept to itself. Pinned here:
//   - the start route carries ?app_challenge into the signed transaction (and ignores junk);
//   - the code is single use, expires, and is useless without the matching verifier;
//   - the swap returns a working session for the right account.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ssoapp-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.OIDC_PROVIDERS = 'testidp';
process.env.OIDC_TESTIDP_ISSUER = 'https://idp.example.com';
process.env.OIDC_TESTIDP_CLIENT_ID = 'st-test';
process.env.OIDC_TESTIDP_NAME = 'Test IdP';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const oidc = require('../lib/oidc');

let server, base;
before(async () => {
  oidc._setTransport(async (u) => ({ ok: true, status: 200, json: async () => ({
    issuer: 'https://idp.example.com', authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/jwks' }) }));
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
after(() => { oidc._setTransport(null); return new Promise((r) => server.close(r)); });

const b64 = (buf) => Buffer.from(buf).toString('base64url');
function pair() {
  const verifier = b64(crypto.randomBytes(32));
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
function user() {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, auth_provider, plan_id, email_verified) VALUES (?, ?, 'testidp', 'free', 1)").run(id, `u${id.slice(0, 6)}@x.test`);
  return db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
}
/** What completeFederatedLogin stores for the app: a hashed single-use code. */
function issue(challenge, { ttl = 120, u = user() } = {}) {
  const code = b64(crypto.randomBytes(32));
  db.prepare('INSERT INTO app_sso_codes (code_hash, token, workspace_id, challenge, expires_at) VALUES (?, ?, NULL, ?, ?)')
    .run(crypto.createHash('sha256').update(code).digest('hex'), generateToken(u, null), challenge, Math.floor(Date.now() / 1000) + ttl);
  return { code, u };
}
const swap = (code, verifier) => fetch(`${base}/sso/app-exchange`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }),
});

test('the start route carries the app challenge in the signed transaction', async () => {
  const { challenge } = pair();
  const res = await fetch(`${base}/oidc/testidp/start?app_challenge=${challenge}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^https:\/\/idp\.example\.com\/authorize\?/);
  const tx = /st_oidc_tx=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  assert.equal(jwt.verify(decodeURIComponent(tx), config.jwtSecret, { algorithms: ['HS256'] }).app, challenge);

  const junk = await fetch(`${base}/oidc/testidp/start?app_challenge=not-a-challenge`, { redirect: 'manual' });
  const tx2 = /st_oidc_tx=([^;]+)/.exec(junk.headers.get('set-cookie'))[1];
  assert.equal(jwt.verify(decodeURIComponent(tx2), config.jwtSecret, { algorithms: ['HS256'] }).app, undefined,
    'a malformed challenge is ignored, so the login ends the ordinary (web) way');
});

test('the right verifier swaps the code for a working session, once', async () => {
  const { verifier, challenge } = pair();
  const { code, u } = issue(challenge);
  const res = await swap(code, verifier);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.email, u.email);
  assert.equal(body.user.password_hash, undefined, 'only the public user shape leaves the server');
  const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200, 'the token is a real session');
  assert.equal((await swap(code, verifier)).status, 401, 'a code works once');
});

test('an intercepted code is useless without the verifier, and is burned by the attempt', async () => {
  const { verifier, challenge } = pair();
  const { code } = issue(challenge);
  assert.equal((await swap(code, pair().verifier)).status, 401, 'someone else\'s verifier is refused');
  assert.equal((await swap(code, verifier)).status, 401, 'and the code is gone even for the real app (single use)');
});

test('expired codes and malformed requests are refused', async () => {
  const { verifier, challenge } = pair();
  const { code } = issue(challenge, { ttl: -5 });
  assert.equal((await swap(code, verifier)).status, 401);
  assert.equal((await swap('x', 'short')).status, 400);
  assert.equal((await fetch(`${base}/sso/app-exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('in app mode the login ends at the app link with a code, never the token', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.match(src, /const APP_REDIRECT = 'screentinker-manager:\/\/sso';/);
  assert.match(src, /if \(forApp\) \{[\s\S]{0,200}backToManagerApp\(res, \{ code: issueAppCode\(/,
    'the app hand-off sends a code; the session token stays on the server until the swap');
});

test('an account deactivated between the provider callback and the swap gets no token (app-exchange and claim)', async () => {
  const deactivate = (u) => db.prepare("UPDATE users SET disabled_at = strftime('%s','now') WHERE id = ?").run(u.id);

  const { verifier, challenge } = pair();
  const { code, u } = issue(challenge);
  deactivate(u);
  const res = await swap(code, verifier);
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.code, 'account_disabled');
  assert.equal(body.token, undefined, 'no session leaves the server');
  assert.equal((await swap(code, verifier)).status, 401, 'the code is still spent');

  const v = user();
  const claim = jwt.sign({ typ: 'sso-claim', tok: generateToken(v, null), wsp: null }, config.jwtSecret, { algorithm: 'HS256', expiresIn: 60 });
  deactivate(v);
  const c = await fetch(`${base}/sso/claim`, { method: 'POST', headers: { Cookie: `st_sso_claim=${claim}` } });
  const cb = await c.json();
  assert.equal(c.status, 403);
  assert.equal(cb.code, 'account_disabled');
  assert.equal(cb.token, undefined);
  assert.match(c.headers.get('set-cookie') || '', /st_sso_claim=;/, 'the claim cookie is cleared');

  // Active, the same claim shape completes: the refusal is the deactivation, nothing else.
  const w = user();
  const ok = jwt.sign({ typ: 'sso-claim', tok: generateToken(w, null), wsp: null }, config.jwtSecret, { algorithm: 'HS256', expiresIn: 60 });
  const r = await fetch(`${base}/sso/claim`, { method: 'POST', headers: { Cookie: `st_sso_claim=${ok}` } });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).token);
});
