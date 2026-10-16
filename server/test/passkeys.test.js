'use strict';

// 3.0 passkeys, end to end: boots the real server with APP_URL pinned and drives every route with a
// software authenticator that produces real ES256 signatures (helpers/soft-authenticator.js).
// The dangerous paths are the point: replayed challenges, wrong origin / RP, somebody else's
// credential, tenancy, the rate limit, and an organization that requires single sign-on.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const otplib = require('otplib');
const { freePort } = require('./helpers/free-port');
const { SoftAuthenticator } = require('./helpers/soft-authenticator');

const PHONE_LIMITS = otplib.createGuardrails({ MIN_SECRET_BYTES: 10 });
const totpCode = (secret) => otplib.generateSync({ secret, guardrails: PHONE_LIMITS });

let PORT, BASE, ORIGIN, proc, sqlite;
const DATA_DIR = path.join(os.tmpdir(), 'st-passkeys-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-passkeys-' + crypto.randomBytes(4).toString('hex') + '.log');

// Every request comes from its own address (loopback is a trusted proxy, so X-Forwarded-For is
// believed): the per-IP limits are not what these tests are about, except the one that says so.
const randomIp = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
async function jfetch(p, opts = {}, ip = randomIp()) {
  const res = await fetch(BASE + p, { ...opts, headers: { 'X-Forwarded-For': ip, ...(opts.headers || {}) } });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const patch = (tok, obj) => ({ method: 'PATCH', ...auth(tok), body: JSON.stringify(obj || {}) });
const del = (tok) => ({ method: 'DELETE', ...auth(tok) });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  // The relying party is APP_URL, never the Host the request arrived with — the tests reach the
  // server on 127.0.0.1 and still get localhost as the RP, which is the whole point.
  ORIGIN = `http://localhost:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', APP_URL: ORIGIN, PUBLIC_HOSTS: '' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  // The first account is the platform admin; make it now so every other account is an ordinary user.
  admin = await newUser();
});
after(() => {
  try { sqlite && sqlite.close(); } catch { /* ignore */ }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
});

const PW = 'Passw0rd123';
let admin;
async function newUser() {
  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const r = await jfetch('/api/auth/register', post(null, { email, password: PW }));
  assert.ok(r.body && r.body.token, 'registered: ' + JSON.stringify(r.body));
  return { email, token: r.body.token, id: r.body.user.id };
}

async function register(user, authn, { name = 'Laptop', code, createOpts = {} } = {}) {
  authn = authn || new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
  const o = await jfetch('/api/auth/passkeys/register/options', post(user.token, { password: PW, code }));
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const { cred, response } = authn.create(o.body.options, createOpts);
  const v = await jfetch('/api/auth/passkeys/register/verify', post(user.token, { challenge_id: o.body.challenge_id, response, name }));
  return { authn, cred, verify: v, options: o.body.options };
}

async function loginOptions() {
  const o = await jfetch('/api/auth/passkeys/login/options', post(null, {}));
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return o.body;
}

test('the login page is told passkeys work here, and at which address', async () => {
  const c = await jfetch('/api/auth/config');
  assert.deepEqual(c.body.passkeys, { enabled: true, origin: ORIGIN });
});

test('registration needs the account password again, and the RP is APP_URL — not the Host header', async () => {
  const u = await newUser();
  const bad = await jfetch('/api/auth/passkeys/register/options', post(u.token, { password: 'wrong-password' }));
  assert.equal(bad.status, 403, 'a session alone cannot plant a passkey');
  const none = await jfetch('/api/auth/passkeys/register/options', post(u.token, {}));
  assert.equal(none.status, 403);

  // A forged Host must not move the relying party.
  const o = await jfetch('/api/auth/passkeys/register/options', {
    method: 'POST', headers: { ...auth(u.token).headers, Host: 'evil.example' }, body: JSON.stringify({ password: PW }),
  });
  assert.equal(o.status, 200);
  assert.equal(o.body.options.rp.id, 'localhost');
  assert.equal(o.body.options.authenticatorSelection.userVerification, 'required');
  assert.equal(o.body.options.authenticatorSelection.residentKey, 'required');
  assert.ok(!o.body.options.user.id.includes(u.id), 'the user handle is not our user id');

  const { verify } = await register(u);
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.passkey.name, 'Laptop');
  const list = await jfetch('/api/auth/passkeys', auth(u.token));
  assert.equal(list.body.available, true);
  assert.equal(list.body.passkeys.length, 1);
  assert.equal(list.body.passkeys[0].last_used_at, null);
  assert.equal(list.body.passkeys[0].public_key, undefined, 'no key material in the list');
  assert.equal(list.body.passkeys[0].user_handle, undefined);
  const audit = sqlite.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'auth:passkey_added'").get(u.id).n;
  assert.equal(audit, 1, 'adding a passkey is audited');
  // Adding does NOT end the session (see routes/passkeys.js).
  assert.equal((await jfetch('/api/auth/me', auth(u.token))).status, 200);
});

test('registration from another origin, or for another RP, is refused', async () => {
  const u = await newUser();
  for (const createOpts of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }]) {
    const { verify } = await register(u, null, { createOpts });
    assert.equal(verify.status, 400, `refused: ${JSON.stringify(createOpts)}`);
  }
  assert.equal((await jfetch('/api/auth/passkeys', auth(u.token))).body.passkeys.length, 0);
});

test('a registration challenge is single-use and belongs to the account that asked for it', async () => {
  const a = await newUser(); const b = await newUser();
  const authn = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
  const o = await jfetch('/api/auth/passkeys/register/options', post(a.token, { password: PW }));
  const { response } = authn.create(o.body.options);
  // B presents A's challenge: refused, and the attempt spends it.
  const stolen = await jfetch('/api/auth/passkeys/register/verify', post(b.token, { challenge_id: o.body.challenge_id, response }));
  assert.equal(stolen.status, 400);
  const late = await jfetch('/api/auth/passkeys/register/verify', post(a.token, { challenge_id: o.body.challenge_id, response }));
  assert.equal(late.status, 400, 'a challenge is gone after one attempt, whoever made it');
});

test('sign in with a passkey: discoverable, no email typed; the session works and last-used is stamped', async () => {
  const u = await newUser();
  const { authn } = await register(u);
  const o = await loginOptions();
  assert.deepEqual(o.options.allowCredentials || [], [], 'nothing about accounts is sent before sign-in');
  assert.equal(o.options.userVerification, 'required');
  const v = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: authn.get(o.options) }));
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.via_passkey, true);
  assert.equal(v.body.user.id, u.id);
  assert.equal(v.body.user.password_hash, undefined);
  assert.equal((await jfetch('/api/auth/me', auth(v.body.token))).status, 200);
  const list = await jfetch('/api/auth/passkeys', auth(v.body.token));
  assert.ok(list.body.passkeys[0].last_used_at > 0);
  const n = sqlite.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'auth:passkey_login'").get(u.id).n;
  assert.equal(n, 1, 'passkey sign-in is audited');
});

test('a used login challenge cannot be replayed, and a captured response is worthless against a new one', async () => {
  const u = await newUser();
  const { authn } = await register(u);
  const o = await loginOptions();
  const resp = authn.get(o.options);
  assert.equal((await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: resp }))).status, 200);
  const replay = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: resp }));
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'challenge_expired');
  const o2 = await loginOptions();
  const swapped = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o2.challenge_id, response: resp }));
  assert.equal(swapped.status, 401, 'a response signed over another challenge');
});

test('wrong origin, wrong RP, missing user verification and a forged user handle are all refused', async () => {
  const u = await newUser(); const other = await newUser();
  const { authn, cred } = await register(u);
  const otherReg = await register(other);
  const cases = [
    { origin: 'https://evil.example' },
    { origin: `http://localhost:${PORT + 1}` },
    { rpId: 'evil.example' },
    { uv: false },
    { type: 'webauthn.create' },
    { userHandle: otherReg.cred.userHandle },
    { userHandle: null },
  ];
  for (const c of cases) {
    const o = await loginOptions();
    const r = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: authn.get(o.options, cred, c) }));
    assert.equal(r.status, 401, `refused: ${JSON.stringify(c)}`);
    assert.equal(r.body.token, undefined);
  }
  // And a signature by the wrong key under a real credential id.
  const o = await loginOptions();
  const forged = authn.get(o.options, { ...cred, privateKey: otherReg.cred.privateKey });
  assert.equal((await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: forged }))).status, 401);
});

test('a counter that goes backwards is refused and audited (cloned authenticator)', async () => {
  const u = await newUser();
  const { authn, cred } = await register(u);
  let o = await loginOptions();
  assert.equal((await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: authn.get(o.options, cred, { counter: 10 }) }))).status, 200);
  o = await loginOptions();
  const r = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: authn.get(o.options, cred, { counter: 5 }) }));
  assert.equal(r.status, 401);
  const n = sqlite.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'auth:passkey_counter_regression'").get(u.id).n;
  assert.equal(n, 1);
});

test('passkeys are per account: no one lists, renames or deletes anyone else\'s', async () => {
  const a = await newUser(); const b = await newUser();
  await register(a);
  const aList = (await jfetch('/api/auth/passkeys', auth(a.token))).body.passkeys;
  const id = aList[0].id;
  assert.deepEqual((await jfetch('/api/auth/passkeys', auth(b.token))).body.passkeys, []);
  assert.equal((await jfetch('/api/auth/passkeys/' + id, patch(b.token, { name: 'mine now' }))).status, 404);
  assert.equal((await jfetch('/api/auth/passkeys/' + id, del(b.token))).status, 404);
  assert.equal((await jfetch('/api/auth/me', auth(b.token))).status, 200, 'a refused delete bumps nothing');
  const still = (await jfetch('/api/auth/passkeys', auth(a.token))).body.passkeys;
  assert.equal(still.length, 1);
  assert.equal(still[0].name, 'Laptop');
  // Unauthenticated: nothing.
  assert.equal((await jfetch('/api/auth/passkeys')).status, 401);
});

test('rename is cleaned; delete ends every other session and hands this one a fresh token', async () => {
  const u = await newUser();
  const { authn } = await register(u);
  const id = (await jfetch('/api/auth/passkeys', auth(u.token))).body.passkeys[0].id;
  assert.equal((await jfetch('/api/auth/passkeys/' + id, patch(u.token, { name: '  Phone‮\u0007 ' + 'x'.repeat(100) }))).status, 200);
  const renamed = (await jfetch('/api/auth/passkeys', auth(u.token))).body.passkeys[0].name;
  assert.ok(renamed.startsWith('Phone x'), renamed);
  assert.ok(renamed.length <= 64);
  assert.ok(!/[‮\u0007]/.test(renamed));

  // A second session (the "stolen laptop") made with the passkey itself.
  const o = await loginOptions();
  const laptop = (await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: authn.get(o.options) }))).body.token;
  const d = await jfetch('/api/auth/passkeys/' + id, del(u.token));
  assert.equal(d.status, 200);
  assert.ok(d.body.token);
  assert.equal((await jfetch('/api/auth/me', auth(laptop))).status, 401, 'the other session is over');
  assert.equal((await jfetch('/api/auth/me', auth(u.token))).status, 401, 'so is the old token of this one');
  assert.equal((await jfetch('/api/auth/me', auth(d.body.token))).status, 200, 'this tab carries on');
  // And the deleted passkey no longer signs in.
  const o2 = await loginOptions();
  assert.equal((await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o2.challenge_id, response: authn.get(o2.options) }))).status, 401);
});

test('with TOTP on: adding a passkey needs the code too, and a passkey can stand in for the code', async () => {
  const u = await newUser();
  // Registered BEFORE TOTP is on (password only), so the test needs no second TOTP window: the code
  // used to enable TOTP is spent by the replay guard for the rest of its 30 seconds.
  const reg = await register(u);
  assert.equal(reg.verify.status, 200);
  const s = await jfetch('/api/auth/totp/setup', post(u.token, {}));
  const e = await jfetch('/api/auth/totp/enable', post(u.token, { code: totpCode(s.body.secret) }));
  u.token = e.body.token;
  const noCode = await jfetch('/api/auth/passkeys/register/options', post(u.token, { password: PW }));
  assert.equal(noCode.status, 403, 'password + session must not mint a passkey that skips TOTP');
  assert.equal(noCode.body.code, 'reauth_code_required');
  const badCode = await jfetch('/api/auth/passkeys/register/options', post(u.token, { password: PW, code: '000000' }));
  assert.equal(badCode.status, 403);

  const login = await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }));
  assert.equal(login.body.mfa_required, true);
  assert.equal(login.body.passkey, true, 'the second step may offer the passkey');
  const mo = await jfetch('/api/auth/passkeys/mfa/options', post(null, { mfa_token: login.body.mfa_token }));
  assert.equal(mo.status, 200);
  assert.deepEqual(mo.body.options.allowCredentials.map((c) => c.id), [reg.cred.id.toString('base64url')]);
  const mv = await jfetch('/api/auth/passkeys/mfa/verify', post(null, {
    mfa_token: login.body.mfa_token, challenge_id: mo.body.challenge_id, response: reg.authn.get(mo.body.options),
  }));
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal(mv.body.user.id, u.id);
  assert.equal((await jfetch('/api/auth/me', auth(mv.body.token))).status, 200);

  // Without a password-earned mfa_token there is nothing to ask for.
  assert.equal((await jfetch('/api/auth/passkeys/mfa/options', post(null, { mfa_token: mv.body.token }))).status, 401,
    'a session token is not an mfa token');
});

test('as a second factor, ANOTHER account\'s passkey is refused even with a perfect signature', async () => {
  const victim = await newUser();
  await register(victim);   // so the victim's second step really does offer a passkey challenge
  const s = await jfetch('/api/auth/totp/setup', post(victim.token, {}));
  await jfetch('/api/auth/totp/enable', post(victim.token, { code: totpCode(s.body.secret) }));
  const attacker = await newUser();
  const { authn, cred } = await register(attacker);
  // The attacker knows the victim's password, and signs the victim's own second-factor challenge
  // with the attacker's passkey: valid signature, valid challenge, wrong account.
  const login = await jfetch('/api/auth/login', post(null, { email: victim.email, password: PW }));
  assert.equal(login.body.mfa_required, true);
  assert.equal(login.body.passkey, true);
  const mo = await jfetch('/api/auth/passkeys/mfa/options', post(null, { mfa_token: login.body.mfa_token }));
  assert.equal(mo.status, 200);
  const r = await jfetch('/api/auth/passkeys/mfa/verify', post(null, {
    mfa_token: login.body.mfa_token, challenge_id: mo.body.challenge_id, response: authn.get(mo.body.options, cred),
  }));
  assert.equal(r.status, 401);
  assert.equal(r.body.token, undefined);
  // A login (discoverable) challenge is not a second-factor challenge either.
  const lo = await loginOptions();
  const r2 = await jfetch('/api/auth/passkeys/mfa/verify', post(null, {
    mfa_token: login.body.mfa_token, challenge_id: lo.challenge_id, response: authn.get(lo.options, cred),
  }));
  assert.equal(r2.status, 401);
});

test('an organization that requires single sign-on: passkey sign-in and registration are refused', async () => {
  const u = await newUser();
  const { authn } = await register(u);
  // Make u a member of an SSO-only organization (membership, not domain — the bypass shape).
  const orgId = crypto.randomUUID(); const wsId = crypto.randomUUID();
  sqlite.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, sso_only) VALUES (?, 'Strict', ?, 'free', 1)").run(orgId, admin.id);
  sqlite.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)").run(wsId, orgId, admin.id);
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(wsId, u.id);

  const o = await loginOptions();
  const r = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o.challenge_id, response: authn.get(o.options) }));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'sso_required');
  assert.equal(r.body.token, undefined);
  const ro = await jfetch('/api/auth/passkeys/register/options', post(u.token, { password: PW }));
  assert.equal(ro.status, 403);
  const list = await jfetch('/api/auth/passkeys', auth(u.token));
  assert.equal(list.body.eligible, false);

  // The platform admin keeps the break-glass, exactly as with a password.
  const adminReg = await register(admin);
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(wsId, admin.id);
  const o2 = await loginOptions();
  const ra = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o2.challenge_id, response: adminReg.authn.get(o2.options) }));
  assert.equal(ra.status, 200);
  sqlite.prepare('UPDATE organizations SET sso_only = 0 WHERE id = ?').run(orgId);
});

test('an account its organization deactivated (SCIM) is refused a passkey sign-in, exactly as a password one', async () => {
  const u = await newUser();
  const { authn, cred } = await register(u);
  sqlite.prepare("UPDATE users SET disabled_at = strftime('%s','now') WHERE id = ?").run(u.id);

  const o = await loginOptions();
  const res = await fetch(BASE + '/api/auth/passkeys/login/verify', { ...post(null, { challenge_id: o.challenge_id, response: authn.get(o.options) }), headers: { ...auth(null).headers, 'X-Forwarded-For': randomIp() } });
  const body = await res.json();
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.equal(body.code, 'account_disabled');
  assert.equal(body.token, undefined, 'no session is issued');
  assert.equal(body.user, undefined);
  assert.equal(res.headers.get('set-cookie'), null, 'no session cookie either');
  // The password login gives the identical answer.
  const pw = await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }));
  assert.equal(pw.status, 403);
  assert.deepEqual(body, pw.body);
  const n = sqlite.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'auth:passkey_login'").get(u.id).n;
  assert.equal(n, 0, 'a refused sign-in is not audited as a login');

  // Reactivated, the same passkey signs in again.
  sqlite.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(u.id);
  const o2 = await loginOptions();
  const ok = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: o2.challenge_id, response: authn.get(o2.options, cred) }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.id, u.id);
  assert.ok(ok.body.token);
});

test('deactivated between the password and the passkey second factor: no session (same answer as /login)', async () => {
  const u = await newUser();
  const reg = await register(u);
  const s = await jfetch('/api/auth/totp/setup', post(u.token, {}));
  await jfetch('/api/auth/totp/enable', post(u.token, { code: totpCode(s.body.secret) }));
  const login = await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }));
  assert.equal(login.body.mfa_required, true);
  sqlite.prepare("UPDATE users SET disabled_at = strftime('%s','now') WHERE id = ?").run(u.id);

  const mo = await jfetch('/api/auth/passkeys/mfa/options', post(null, { mfa_token: login.body.mfa_token }));
  assert.equal(mo.status, 200);
  const mv = await jfetch('/api/auth/passkeys/mfa/verify', post(null, {
    mfa_token: login.body.mfa_token, challenge_id: mo.body.challenge_id, response: reg.authn.get(mo.body.options),
  }));
  assert.equal(mv.status, 403, JSON.stringify(mv.body));
  assert.equal(mv.body.code, 'account_disabled');
  assert.equal(mv.body.token, undefined, 'no session is issued');
  const n = sqlite.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'auth:passkey_login'").get(u.id).n;
  assert.equal(n, 0, 'a refused sign-in is not audited as a login');
  sqlite.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(u.id);
});

test('passkey sign-in is rate limited per IP', async () => {
  const ip = '10.99.99.99';
  let last; let n = 0;
  for (; n < 25; n++) {
    last = await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: 'nope', response: {} }), ip);
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.equal(n, 20, 'twenty attempts a minute, then 429');
  // A trailing slash is the same bucket, not a fresh one.
  assert.equal((await jfetch('/api/auth/passkeys/login/verify/', post(null, { challenge_id: 'nope', response: {} }), ip)).status, 429);
  // Somebody else is unaffected.
  assert.equal((await jfetch('/api/auth/passkeys/login/verify', post(null, { challenge_id: 'nope', response: {} }))).status, 401);
});
