'use strict';

// #100 integration: boots the real server and drives the TOTP route flow end to end.
// /totp/verify completions use RECOVERY codes (deterministic) - the TOTP-code path +
// replay are covered in totp-unit.test.js (time-based codes are awkward over HTTP).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { authenticator } = require('otplib');

const PORT = 3979;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-totp-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-totp-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok, extra = {}) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...extra } });
const post = (tok, obj, extra) => ({ method: 'POST', ...auth(tok, extra), body: JSON.stringify(obj || {}) });

before(async () => {
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

const PW = 'Passw0rd123';
async function newUser() {
  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const r = await jfetch('/api/auth/register', post(null, { email, password: PW }));
  return { email, token: r.body.token };
}
async function enroll(token) {
  const s = await jfetch('/api/auth/totp/setup', post(token, {}));
  const e = await jfetch('/api/auth/totp/enable', post(token, { code: authenticator.generate(s.body.secret) }));
  return { secret: s.body.secret, recovery: e.body.recovery_codes };
}

test('enrollment: setup -> enable issues 10 recovery codes; status reflects it', async () => {
  const u = await newUser();
  const { recovery } = await enroll(u.token);
  assert.equal(recovery.length, 10);
  const st = await jfetch('/api/auth/totp/status', auth(u.token));
  assert.equal(st.body.enabled, true);
  assert.equal(st.body.recovery_codes_remaining, 10);
});

test('login with TOTP -> mfa_required (no full token); route-level bite: mfa_token 401s a protected route', async () => {
  const u = await newUser(); await enroll(u.token);
  const login = await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }));
  assert.equal(login.body.mfa_required, true);
  assert.ok(login.body.mfa_token, 'got an mfa_token');
  assert.equal(login.body.token, undefined, 'NO full session token before the TOTP step');
  const me = await jfetch('/api/auth/me', auth(login.body.mfa_token));
  assert.equal(me.status, 401, 'mfa_pending token must 401 a protected route');
});

test('/totp/verify completes login via recovery code; single-use; surfaces remaining', async () => {
  const u = await newUser(); const { recovery } = await enroll(u.token);
  const l1 = await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }));
  const v1 = await jfetch('/api/auth/totp/verify', post(null, { mfa_token: l1.body.mfa_token, code: recovery[0] }));
  assert.ok(v1.body.token, 'recovery code yields a full session token');
  assert.equal(v1.body.via_recovery, true);
  assert.equal(v1.body.recovery_codes_remaining, 9, 'one code consumed');
  // "secrets never in responses": the encrypted TOTP secret + replay counter must not leak
  assert.ok(!JSON.stringify(v1.body).includes('totp_secret_enc'), 'no encrypted TOTP secret in the response body');
  assert.equal(v1.body.user.totp_secret_enc, undefined, 'user object carries no totp_secret_enc');
  assert.equal(v1.body.user.totp_last_step, undefined, 'user object carries no totp_last_step');
  assert.equal((await jfetch('/api/auth/me', auth(v1.body.token))).status, 200, 'full token works');
  // reuse the SAME recovery code -> rejected (single-use)
  const l2 = await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }));
  const v2 = await jfetch('/api/auth/totp/verify', post(null, { mfa_token: l2.body.mfa_token, code: recovery[0] }));
  assert.equal(v2.status, 401, 'used recovery code is rejected');
});

test('API token BYPASSES TOTP: an st_ token works while the owner has TOTP enabled', async () => {
  const u = await newUser();
  await enroll(u.token);
  // the pre-existing session token (issued at register, before enroll) still works -
  // enabling TOTP does NOT invalidate it - so it can mint an API token:
  const t = await jfetch('/api/tokens', post(u.token, { name: 'ci', scope: 'read' }));
  const secret = Object.values(t.body || {}).find(v => typeof v === 'string' && v.startsWith('st_'));
  assert.ok(secret, 'got an st_ token (existing JWT still valid post-enroll)');
  const r = await jfetch('/api/devices', auth(secret));
  assert.equal(r.status, 200, 'st_ token reaches a protected route despite TOTP being on');
});

test('verify lockout: repeated bad codes -> 429 (per-user, atop the route rate-limit)', async () => {
  const u = await newUser(); await enroll(u.token);
  const mfa = (await jfetch('/api/auth/login', post(null, { email: u.email, password: PW }))).body.mfa_token;
  let last;
  for (let i = 0; i < 6; i++) {
    last = await jfetch('/api/auth/totp/verify', post(null, { mfa_token: mfa, code: '000000' }));
  }
  assert.equal(last.status, 429, 'locked out after repeated bad codes');
});
