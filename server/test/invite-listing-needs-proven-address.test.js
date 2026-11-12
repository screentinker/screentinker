'use strict';

/*
 * AN INVITE IS LISTED ONLY TO SOMEONE WHO HAS PROVED THE ADDRESS IS THEIRS.
 *
 * GET /api/auth/my-invites hands a signed-in account the ids of the pending invites addressed to
 * its email, and an id is all accept-invite needs. It listed them to any account marked
 * email_verified. But an account an ADMIN creates is marked verified too (so it does not carry a
 * banner nobody can clear), and the admin chose its password. So any workspace admin could create
 * an account for someone else's address, sign in to it, and collect that person's invites to other
 * organizations.
 *
 * "Verified" (no banner) and "proved by the owner" are different facts, so they are stored apart.
 * An admin-created account is the first without the second until its owner uses a link mailed to
 * the address (the password reset or the verification email). Nothing changes for anyone else.
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

const PW = 'Passw0rd123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA_DIR = path.join(os.tmpdir(), 'st-inviteproof-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let proc, db, BASE, company, other;

const call = async (method, p, tok, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const mail = (who) => `${who}-${crypto.randomBytes(4).toString('hex')}@example.com`;
async function register(email) {
  const r = await call('POST', '/api/auth/register', null, { email, password: PW, name: 'N' });
  assert.ok(r.body && r.body.token, JSON.stringify(r.body));
  return { jwt: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id, email };
}
const login = async (email, password = PW) => (await call('POST', '/api/auth/login', null, { email, password })).body;
function invite(ws, email, by) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, expires_at)
              VALUES (?, ?, ?, 'workspace_admin', ?, strftime('%s','now') + 86400)`).run(id, ws, email, by);
  return id;
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  // Registration is rate limited per address, so the cast is made once: the platform admin (first
  // account), the company that sends invites, and an unrelated workspace admin.
  await register(mail('platform'));
  company = await register(mail('company'));
  other = await register(mail('other'));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('someone who signed up themselves still sees and accepts their invites', async () => {
  const guestMail = mail('guest');
  const id = invite(company.ws, guestMail, company.id);
  const guest = await register(guestMail);
  const list = await call('GET', '/api/auth/my-invites', guest.jwt);
  assert.deepEqual(list.body.invites.map((i) => i.id), [id]);
  assert.equal((await call('POST', '/api/auth/accept-invite/' + id, guest.jwt)).status, 200);
});

test('an account an admin created for an address is not shown that address\'s invites', async () => {
  const target = mail('person');
  const id = invite(company.ws, target, company.id);

  const made = await call('POST', '/api/admin/users', other.jwt, { email: target, password: PW, workspaceId: other.ws, role: 'workspace_viewer' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const session = await login(target);
  assert.ok(session.token, 'the admin-chosen password signs in: ' + JSON.stringify(session));

  const list = await call('GET', '/api/auth/my-invites', session.token);
  assert.deepEqual(list.body.invites, [], 'the invite id must not be handed to an account whose owner never proved the address');
  const members = db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(company.ws, made.body.id).n;
  assert.equal(members, 0);
  assert.ok(db.prepare('SELECT 1 FROM workspace_invites WHERE id = ?').get(id), 'and the invite is still there for its real owner');
});

test('an admin-created account still works, with no verification banner', async () => {
  const m = mail('staff');
  const made = await call('POST', '/api/admin/users', other.jwt, { email: m, password: PW, workspaceId: other.ws, role: 'workspace_editor' });
  assert.equal(made.status, 201);
  const session = await login(m);
  assert.ok(session.token);
  const me = await call('GET', '/api/auth/me', session.token);
  assert.equal(me.status, 200);
  assert.notEqual(me.body.email_verified, 0, 'no "confirm your email" banner (#292)');
});

test('once the owner uses a link mailed to the address, the account is theirs and sees its invites', async () => {
  const target = mail('person');
  const made = await call('POST', '/api/admin/users', other.jwt, { email: target, password: PW, workspaceId: other.ws, role: 'workspace_viewer' });
  const id = invite(company.ws, target, company.id);

  // The real owner asks for a password reset; the link goes to their mailbox. (The token is stored
  // hashed, so the test plants one it knows, exactly as lib/passwordReset.issue would.)
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("UPDATE users SET password_reset_hash = ?, password_reset_expires = strftime('%s','now') + 3600 WHERE id = ?")
    .run(crypto.createHash('sha256').update(token).digest('hex'), made.body.id);
  const reset = await call('POST', '/api/auth/reset-password', null, { token, password: 'TheirOwnPassw0rd' });
  assert.ok(reset.status < 300, JSON.stringify(reset.body));

  const session = await login(target, 'TheirOwnPassw0rd');
  const list = await call('GET', '/api/auth/my-invites', session.token);
  assert.deepEqual(list.body.invites.map((i) => i.id), [id]);
});
