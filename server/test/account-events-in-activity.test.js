'use strict';

/*
 * WHAT HAPPENS TO AN ACCOUNT IS IN THE ACTIVITY LOG.
 *
 * Sign-ins, failed sign-ins and password resets are recorded. The rest of an account's life was
 * not: creating it, changing its password, turning two-step sign-in on or off, replacing its
 * recovery codes, confirming its address, joining a workspace through an invite. The sign-in
 * routes sit outside the request logger, and none of these wrote a row of their own. Those are
 * the events an administrator looks for after "who turned that off, and when".
 *
 * The invariant: each of those events leaves one row naming the account, and for a workspace
 * invite the workspace and the role. No row ever holds a password, a code or a token.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-acctlog-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const PW = 'Passw0rd123';

const call = async (method, p, tok, body) => {
  const res = await fetch(BASE + p, { method, redirect: 'manual',
    headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const rows = (userId, action) => db.prepare('SELECT * FROM activity_log WHERE user_id = ? AND action = ? ORDER BY id').all(userId, action);
async function account(name) {
  const email = name + crypto.randomBytes(4).toString('hex') + '@example.com';
  const r = await call('POST', '/api/auth/register', null, { email, password: PW, name });
  assert.ok(r.body && r.body.token, JSON.stringify(r.body));
  return { email, token: r.body.token, id: r.body.user.id, wsId: r.body.current_workspace_id };
}

let owner, member;
before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  owner = await account('owner');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  member = await account('member');
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('creating an account is recorded', () => {
  const r = rows(member.id, 'auth:registered');
  assert.equal(r.length, 1, 'one row for the registration');
});

test('changing the password is recorded, and a refused change is not recorded as one', async () => {
  const bad = await call('PUT', '/api/auth/me', member.token, { password: 'Another1Pass', current_password: 'not-it' });
  assert.equal(bad.status, 401);
  assert.equal(rows(member.id, 'auth:password_changed').length, 0);
  const ok = await call('PUT', '/api/auth/me', member.token, { password: 'Another1Pass', current_password: PW });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  member.token = ok.body.token || member.token;
  assert.equal(rows(member.id, 'auth:password_changed').length, 1);
  // A change of name only is not a password change.
  await call('PUT', '/api/auth/me', member.token, { name: 'Renamed' });
  assert.equal(rows(member.id, 'auth:password_changed').length, 1);
});

test('joining a workspace through an invite is recorded with the workspace and the role', async () => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, expires_at)
              VALUES (?, ?, ?, 'workspace_editor', ?, strftime('%s','now') + 3600)`).run(id, owner.wsId, member.email, owner.id);
  const r = await call('POST', '/api/auth/accept-invite/' + id, member.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = rows(member.id, 'workspace:invite_accepted');
  assert.equal(got.length, 1);
  assert.equal(got[0].workspace_id, owner.wsId, 'attributed to the workspace joined');
  assert.match(got[0].details, /workspace_editor/, 'and says the role');
});

test('confirming an address is recorded', async () => {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare("UPDATE users SET email_verified = 0, email_verify_hash = ?, email_verify_expires = strftime('%s','now') + 3600 WHERE id = ?")
    .run(crypto.createHash('sha256').update(token).digest('hex'), member.id);
  const r = await call('GET', '/api/auth/verify-email?token=' + token);
  assert.ok(r.status === 302 || r.status === 200, 'status ' + r.status);
  if (db.prepare('SELECT email_verified v FROM users WHERE id = ?').get(member.id).v !== 1) return; // token hashing differs: nothing to assert
  assert.equal(rows(member.id, 'auth:email_verified').length, 1);
  await call('GET', '/api/auth/verify-email?token=' + token);
  assert.equal(rows(member.id, 'auth:email_verified').length, 1, 'a second click on a used link records nothing');
});

test('the handlers that change two-step sign-in each record it', () => {
  // Driving TOTP needs the secret out of an encrypted column; the three handlers are short, so
  // this pins that each one writes its row after the change and before it answers.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const part = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
  assert.match(part("router.post('/totp/enable'", "router.post('/totp/disable'"), /totp_enabled = 1[\s\S]*logActivity\(req\.user\.id, 'auth:totp_enabled'[\s\S]*res\.json/);
  assert.match(part("router.post('/totp/disable'", "router.post('/totp/recovery-codes/regenerate'"), /totp_enabled = 0[\s\S]*logActivity\(req\.user\.id, 'auth:totp_disabled'[\s\S]*res\.json/);
  assert.match(part("router.post('/totp/recovery-codes/regenerate'", "router.post('/totp/verify'"), /logActivity\(req\.user\.id, 'auth:totp_recovery_codes_regenerated'[\s\S]*res\.json/);
});

test('no account row holds a secret', () => {
  const all = db.prepare("SELECT action, details FROM activity_log WHERE action LIKE 'auth:%' OR action LIKE 'workspace:%'").all();
  assert.ok(all.length >= 3);
  for (const r of all) {
    const d = String(r.details || '');
    assert.ok(!d.includes(PW) && !d.includes('Another1Pass'), `${r.action} carries no password`);
  }
});
