'use strict';

// Support access, end to end, in the shape it is used: TWO instances.
//
//   issuer   — ours. Holds SUPPORT_SIGNING_KEY_FILE, so POST /api/auth/support/generate exists.
//   customer — a self-hosted install. Same public key, no private key: /generate is a 404 there.
//
// The flow: the customer's admin mints a request code; we sign a token against it; the token is
// pasted into the customer's login page; the session that results is a platform_operator that
// can read the customer's workspaces but cannot touch owner powers; the customer's admin can see
// it and end it. Pinned here because every one of those is a security decision, and the two
// endpoints shipped for months with NO server behind them at all.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');

const kp = crypto.generateKeyPairSync('ed25519');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-support-e2e-'));
const PRIV_FILE = path.join(TMP, 'signing.pem');
fs.writeFileSync(PRIV_FILE, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const PUB_PEM = kp.publicKey.export({ type: 'spki', format: 'pem' });

const PW = 'Passw0rd123';
const jsonPost = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (t, method = 'GET', o) => ({ method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: o ? JSON.stringify(o) : undefined });

const servers = {};
async function boot(name, extraEnv) {
  const port = await freePort();
  const dataDir = path.join(TMP, name);
  const logFd = fs.openSync(path.join(TMP, `${name}.log`), 'w');
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', SUPPORT_PUBLIC_KEY: PUB_PEM, ...extraEnv },
    stdio: ['ignore', logFd, logFd],
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error(`${name} did not boot`);
  // First registered user is the platform_admin of that instance.
  const admin = await (await fetch(base + '/api/auth/register', jsonPost({ email: `admin@${name}.local`, password: PW }))).json();
  assert.ok(admin.token, `${name}: admin session`);
  servers[name] = { proc, base, admin: admin.token };
  return servers[name];
}

before(async () => {
  await Promise.all([
    boot('issuer', { SUPPORT_SIGNING_KEY_FILE: PRIV_FILE }),
    boot('customer', {}),
  ]);
});
after(() => { for (const s of Object.values(servers)) { try { s.proc.kill('SIGKILL'); } catch { /* */ } } });

let requestCode, supportToken, sessionToken, jti;

test('the customer admin mints a request code; the issuer signs a token against it', async () => {
  const c = servers.customer, i = servers.issuer;
  const req = await (await fetch(c.base + '/api/auth/support/request', auth(c.admin, 'POST', { note: 'panel shows black' }))).json();
  assert.match(req.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  requestCode = req.code;

  const status = await (await fetch(c.base + '/api/auth/support/status', auth(c.admin))).json();
  assert.equal(status.can_issue, false, 'a self-hosted install never sees the generator');
  assert.ok(status.requests.some((r) => r.code === requestCode));

  const istatus = await (await fetch(i.base + '/api/auth/support/status', auth(i.admin))).json();
  assert.equal(istatus.can_issue, true, 'the issuer does');

  const gen = await fetch(i.base + '/api/auth/support/generate', auth(i.admin, 'POST', { request_code: requestCode, org: 'Customer BV', hours: 2, reason: 'ticket 7' }));
  assert.equal(gen.status, 200);
  supportToken = (await gen.json()).token;
  assert.ok(supportToken.startsWith('STSUP1.'));
});

test('the customer instance cannot issue tokens: /generate does not exist there', async () => {
  const c = servers.customer;
  const r = await fetch(c.base + '/api/auth/support/generate', auth(c.admin, 'POST', { request_code: requestCode }));
  assert.equal(r.status, 404);
});

test('a token minted with NO request code from the customer is refused by the customer', async () => {
  const i = servers.issuer, c = servers.customer;
  const gen = await (await fetch(i.base + '/api/auth/support/generate', auth(i.admin, 'POST', { request_code: 'ABCD-EFGH-JKMN-PQRS', org: 'X' }))).json();
  const r = await fetch(c.base + '/api/auth/support', jsonPost({ token: gen.token }));
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /does not match an open support request/);
});

test('the token opens a bounded platform_operator session on the customer instance', async () => {
  const c = servers.customer;
  const r = await fetch(c.base + '/api/auth/support', jsonPost({ token: supportToken }));
  const rText = await r.text();
  assert.equal(r.status, 200, rText);
  const body = JSON.parse(rText);
  sessionToken = body.token;
  assert.equal(body.user.role, 'platform_operator');
  assert.equal(body.user.auth_provider, 'support');

  const me = await fetch(c.base + '/api/auth/me', auth(sessionToken));
  const meText = await me.text();
  assert.equal(me.status, 200, meText);
  const meBody = JSON.parse(meText);
  assert.equal(meBody.role, 'platform_operator');
  assert.equal(meBody.is_platform_admin, false, 'staff, not owner');
  assert.equal(meBody.acting_as, true, 'inside the customer workspace by act-as, not membership');
  assert.ok(Array.isArray(meBody.accessible_workspaces) && meBody.accessible_workspaces.length >= 1, 'sees the customer workspaces');
  assert.ok(meBody.accessible_workspaces.every((w) => w.can_admin === false), 'but administers none of them');

  // Something a support engineer actually needs: the device list.
  const devices = await fetch(c.base + '/api/devices', auth(sessionToken));
  assert.equal(devices.status, 200);

  const status = await (await fetch(c.base + '/api/auth/support/status', auth(c.admin))).json();
  assert.equal(status.grants.length, 1);
  jti = status.grants[0].jti;
  assert.equal(status.grants[0].org, 'Customer BV');
  assert.ok(status.grants[0].first_used_at, 'attributed');
  assert.equal(status.requests.some((q) => q.code === requestCode), false, 'the request is consumed');
});

test('the same token cannot be redeemed twice', async () => {
  const r = await fetch(servers.customer.base + '/api/auth/support', jsonPost({ token: supportToken }));
  assert.equal(r.status, 401);
});

test('a support session holds no owner powers', async () => {
  const c = servers.customer;
  // Owner-tier: user management. platform_operator is deliberately outside PLATFORM_ROLES.
  const users = await fetch(c.base + '/api/auth/users', auth(sessionToken));
  assert.equal(users.status, 403);
  // And it cannot mint or revoke support access itself.
  const req = await fetch(c.base + '/api/auth/support/request', auth(sessionToken, 'POST', {}));
  assert.equal(req.status, 403);
});

test('the customer sees the session in the activity log', async () => {
  const c = servers.customer;
  const r = await fetch(c.base + '/api/activity?limit=50', auth(c.admin));
  assert.equal(r.status, 200);
  const rows = await r.json();
  const list = Array.isArray(rows) ? rows : (rows.items || rows.activity || rows.logs || []);
  const actions = list.map((x) => x.action);
  assert.ok(actions.includes('support_request_created'), actions.join(','));
  assert.ok(actions.includes('support_login'), actions.join(','));
});

test('revoking from Settings ends the session on its next request', async () => {
  const c = servers.customer;
  const rev = await fetch(c.base + `/api/auth/support/grant/${jti}`, auth(c.admin, 'DELETE'));
  assert.equal((await rev.json()).revoked, 1);
  const me = await fetch(c.base + '/api/auth/me', auth(sessionToken));
  assert.equal(me.status, 401);
  const status = await (await fetch(c.base + '/api/auth/support/status', auth(c.admin))).json();
  assert.equal(status.grants.length, 0);
});

test('redemption is rate-limited per IP, and the admin routes are not caught by that limiter', async () => {
  const c = servers.customer;
  let last;
  for (let n = 0; n < 8; n++) last = await fetch(c.base + '/api/auth/support', jsonPost({ token: 'STSUP1.junk.junk' }));
  assert.equal(last.status, 429);
  const status = await fetch(c.base + '/api/auth/support/status', auth(c.admin));
  assert.equal(status.status, 200, 'admin status still answers');
});
