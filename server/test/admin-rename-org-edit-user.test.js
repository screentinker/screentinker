'use strict';

/*
 * Platform admins can rename an organization and correct a user's name or sign-in email.
 *
 * Asked for by a self-hoster: a user had lost the mailbox their account was on, and there was no way
 * to move it, nor to rename an organization at all.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-admin-edit-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-edit';

const { db } = require('../db/database');
const admin = require('../routes/admin');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-admin', 'admin@example.com', 'Admin', 'platform_admin')").run();
db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-plain', 'plain@example.com', 'Plain', 'user')").run();
db.prepare("INSERT INTO users (id, email, name, role, auth_provider) VALUES ('u-local', 'old@example.com', 'Lost Mailbox', 'user', 'local')").run();
db.prepare("INSERT INTO users (id, email, name, role, auth_provider) VALUES ('u-sso', 'sso@example.com', 'SSO', 'user', 'google')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Acme Typo', 'u-plain')").run();

let server;
let actor = 'u-admin';
async function call(method, url, body) {
  if (!server) {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(actor);
      req.user = { id: u.id, role: u.role };
      next();
    });
    app.use('/api/admin', admin);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
after(() => { if (server) server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const orgName = () => db.prepare("SELECT name FROM organizations WHERE id = 'org-a'").get().name;
const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const lastLog = (action) => db.prepare('SELECT details FROM activity_log WHERE action = ? ORDER BY rowid DESC LIMIT 1').get(action);

test('a platform admin renames an organization, and it is logged', async () => {
  actor = 'u-admin';
  const r = await call('PATCH', '/api/admin/orgs/org-a', { name: '  Acme Ltd  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Acme Ltd');
  assert.equal(orgName(), 'Acme Ltd');
  assert.match(lastLog('admin_rename_org').details, /"Acme Typo" -> "Acme Ltd"/);
});

test('org names are validated like creation, and unknown orgs are 404', async () => {
  actor = 'u-admin';
  assert.equal((await call('PATCH', '/api/admin/orgs/org-a', { name: '   ' })).status, 400);
  assert.equal((await call('PATCH', '/api/admin/orgs/org-a', { name: 'x'.repeat(121) })).status, 400);
  assert.equal((await call('PATCH', '/api/admin/orgs/nope', { name: 'X' })).status, 404);
  assert.equal(orgName(), 'Acme Ltd');
});

test('only platform admins can rename orgs or edit users', async () => {
  actor = 'u-plain';
  assert.equal((await call('PATCH', '/api/admin/orgs/org-a', { name: 'Mine now' })).status, 403);
  assert.equal((await call('PATCH', '/api/admin/users/u-local', { email: 'grab@example.com' })).status, 403);
  assert.equal(orgName(), 'Acme Ltd');
  assert.equal(user('u-local').email, 'old@example.com');
});

test('moving a password account to a new email cancels links sent to the old mailbox', async () => {
  actor = 'u-admin';
  db.prepare(`UPDATE users SET password_reset_hash = 'h', password_reset_expires = 9999999999,
      email_verify_hash = 'v', email_verify_expires = 9999999999, email_verified = 0 WHERE id = 'u-local'`).run();
  const r = await call('PATCH', '/api/admin/users/u-local', { name: 'Found Mailbox', email: ' New@Example.com ' });
  assert.equal(r.status, 200);
  const u = user('u-local');
  assert.equal(u.email, 'new@example.com');
  assert.equal(u.name, 'Found Mailbox');
  assert.equal(u.password_reset_hash, null, 'a reset link sent to the old address no longer works');
  assert.equal(u.email_verify_hash, null);
  assert.equal(u.email_verified, 1, 'no "confirm your email" banner for an address an admin chose');
  assert.equal(u.email_proven, 0, 'but the mailbox is not proven, so invites to it are not listed yet');
  assert.match(lastLog('admin_edit_user').details, /email old@example.com -> new@example.com/);
});

test('an email already in use, or an invalid one, is refused', async () => {
  actor = 'u-admin';
  const taken = await call('PATCH', '/api/admin/users/u-local', { email: 'PLAIN@example.com' });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, 'EMAIL_TAKEN');
  assert.equal((await call('PATCH', '/api/admin/users/u-local', { email: 'not an email' })).status, 400);
  assert.equal((await call('PATCH', '/api/admin/users/u-local', { name: '' })).status, 400);
  assert.equal(user('u-local').email, 'new@example.com');
});

test('an SSO account keeps the email its identity provider gives it, but its name can be corrected', async () => {
  actor = 'u-admin';
  const r = await call('PATCH', '/api/admin/users/u-sso', { email: 'other@example.com' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'EMAIL_MANAGED_BY_PROVIDER');
  assert.equal(user('u-sso').email, 'sso@example.com');
  const named = await call('PATCH', '/api/admin/users/u-sso', { name: 'Single Sign-On' });
  assert.equal(named.status, 200);
  assert.equal(user('u-sso').name, 'Single Sign-On');
});

test('no change is a no-op, not a log entry', async () => {
  actor = 'u-admin';
  const before = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'admin_edit_user'").get().n;
  const r = await call('PATCH', '/api/admin/users/u-local', { name: 'Found Mailbox', email: 'NEW@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'admin_edit_user'").get().n, before);
});

test('the dashboard offers New group, rename and edit, and language sits beside the theme', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', p), 'utf8');
  const dash = read('views/dashboard.js');
  assert.match(dash, /canWrite\(\) \? `<button class="btn btn-secondary" id="createGroupBtn">/, 'a standalone New group button for anyone who can edit');
  assert.match(dash, /querySelector\('#createGroupBtn'\)\?\.addEventListener\('click'/);
  const adminView = read('views/admin.js');
  assert.match(adminView, /data-rename-org=/);
  assert.match(adminView, /isPlatformAdmin\(currentUser\) \? `<button class="btn btn-secondary btn-sm" data-edit-user=/);
  const settings = read('views/settings.js');
  const appearance = settings.indexOf('id="appearanceCard"');
  const language = settings.indexOf('id="languageCard"');
  const account = settings.indexOf("t('settings.account')");
  assert.ok(appearance > 0 && language > appearance && language < account, 'language comes right after appearance, before account');
  assert.equal((settings.match(/id="langSelect"/g) || []).length, 1, 'one language picker, not two');
});
