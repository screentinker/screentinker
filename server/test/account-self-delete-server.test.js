'use strict';

/*
 * Self-service account deletion against a REAL server.js (its limiter, CSP and static routes), plus
 * the guards on what the published pages and locales say. The route's rules are covered in depth,
 * in process, by account-self-delete.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-acctdel-srv-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-acctdel-srv-' + crypto.randomBytes(4).toString('hex') + '.log');
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

const jfetch = async (p, { method = 'GET', token, body, ip = '198.51.100.7' } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json, headers: res.headers };
};
const register = async (email, ip) => {
  const r = await jfetch('/api/auth/register', { method: 'POST', ip, body: { email, password: 'Passw0rd123!', name: email.split('@')[0] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', STRIPE_SECRET_KEY: '' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  // The first account on a fresh self-hosted server is its platform admin; every later one is not.
  await register('admin@acct.test', '198.51.100.1');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('end to end: sign up, delete the account, and the session it had is dead', async () => {
  const token = await register('leaver@acct.test', '198.51.100.2');
  const info = await jfetch('/api/auth/me/deletion', { token });
  assert.equal(info.status, 200);
  assert.equal(info.body.reauth.method, 'password');
  assert.equal(info.body.blocked, null);
  assert.equal(info.body.owned_organizations.length, 1, 'the org a signup gets');

  const r = await jfetch('/api/auth/me', { method: 'DELETE', token, body: { confirm: 'leaver@acct.test', password: 'Passw0rd123!' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.organizations_deleted, 1);
  assert.equal((await jfetch('/api/auth/me', { token })).status, 401);
  const login = await jfetch('/api/auth/login', { method: 'POST', body: { email: 'leaver@acct.test', password: 'Passw0rd123!' } });
  assert.equal(login.status, 401, 'cannot sign in again');
  assert.ok(!fs.readFileSync(LOG, 'utf8').includes('AUDIT-DROP'), 'the request audit did not try to log a deleted user');
});

test('the first platform admin on a self-hosted server is told why they cannot leave', async () => {
  const login = await jfetch('/api/auth/login', { method: 'POST', body: { email: 'admin@acct.test', password: 'Passw0rd123!' } });
  const r = await jfetch('/api/auth/me', { method: 'DELETE', token: login.body.token, body: { confirm: 'admin@acct.test', password: 'Passw0rd123!' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'last_platform_admin');
});

test('DELETE /api/auth/me is rate-limited (5 a minute per IP); GET /api/auth/me is not', async () => {
  const ip = '203.0.113.50';
  const token = await register('limited@acct.test', ip);
  const codes = [];
  for (let i = 0; i < 7; i++) {
    codes.push((await jfetch('/api/auth/me', { method: 'DELETE', token, ip, body: { confirm: 'limited@acct.test', password: 'wrong-' + i } })).status);
  }
  assert.deepEqual(codes.slice(0, 5), [403, 403, 403, 403, 403]);
  assert.deepEqual(codes.slice(5), [429, 429]);
  // Every page load asks GET /me: it must not share, or be blocked by, the deletion bucket.
  for (let i = 0; i < 8; i++) assert.equal((await jfetch('/api/auth/me', { token, ip })).status, 200);
});

test('/delete-account is served as HTML under the dashboard CSP, like the other static pages', async () => {
  for (const p of ['/delete-account', '/delete-account/', '/account-deleted']) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /^text\/html/, p);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/, `${p} carries the dashboard CSP`);
    assert.match(csp, /frame-ancestors 'self'/, p);
    assert.equal(res.headers.get('cache-control'), 'no-cache', p);
    const html = await res.text();
    assert.ok(!/<script/i.test(html), `${p} needs no script (and the CSP would block an inline one)`);
  }
  const page = await (await fetch(BASE + '/delete-account')).text();
  assert.match(page, /href="\/app#\/settings\?section=delete-account"/, 'links to the card in the dashboard');
  assert.match(page, /support@screentinker\.com/, 'a way in for people who cannot sign in');
  assert.match(page, /Manager app/);
  assert.match(page, /14 days/);
  // The privacy page alongside it, for comparison: same policy.
  const priv = await fetch(BASE + '/legal/privacy.html');
  assert.equal(priv.headers.get('content-security-policy'), (await fetch(BASE + '/delete-account')).headers.get('content-security-policy'));
});

test('privacy.html says where deletion is, what it covers, the backup window, and links /delete-account', () => {
  const html = fs.readFileSync(path.join(FRONTEND, 'legal', 'privacy.html'), 'utf8');
  const line = (html.match(/<li><strong>Deletion:<\/strong>[^\n]*<\/li>/) || [''])[0];
  assert.ok(line, 'the Deletion line exists');
  assert.match(line, /Delete my account/);
  assert.match(line, /Manager app/);
  assert.match(line, /backups/);
  assert.match(line, /href="\/delete-account"/);
  // The old claim ("all data removed within 30 days") contradicted the backup schedule.
  assert.ok(!/all data removed within 30 days/.test(html));
});

test('account_delete.* strings exist in all ten locales, with the same placeholders', () => {
  const dir = path.join(FRONTEND, 'js', 'i18n');
  const read = (l) => {
    const src = fs.readFileSync(path.join(dir, `${l}.js`), 'utf8');
    const out = {};
    for (const m of src.matchAll(/^\s*'(account_delete\.[a-z_]+)'\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gm)) out[m[1]] = m[2];
    return out;
  };
  const en = read('en');
  assert.ok(Object.keys(en).length >= 25);
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const l of ['de', 'es', 'fr', 'hi', 'it', 'ja', 'nl', 'pt', 'zh']) {
    const loc = read(l);
    assert.deepEqual(Object.keys(loc).sort(), Object.keys(en).sort(), `${l}.js has the same account_delete keys as en`);
    for (const k of Object.keys(en)) assert.equal(ph(loc[k]), ph(en[k]), `${l} ${k} placeholders`);
  }
});
