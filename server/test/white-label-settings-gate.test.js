'use strict';

// The White Label / Branding section of Settings sat inside the platform-admin block, so on hosted
// an Enterprise customer's own workspace admins never saw it, although the server lets them save
// it (routes/white-label.js, requireWorkspaceAdmin). And its Enterprise check looked only at the
// signed-in admin's own plan, while the plan is paid for by the organization's owner. These pin
// both: who gets the section, and that /me says which plan the organization is on.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');

const SETTINGS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'settings.js'), 'utf8');

test('the branding section is gated on workspace admin, not on platform admin', () => {
  const at = SETTINGS.indexOf('id="whiteLabelSection"');
  assert.ok(at > 0, 'the section exists');
  // The nearest template gate opened before the section must be canBrandWorkspace.
  const before = SETTINGS.slice(0, at);
  const gate = before.lastIndexOf('? `');
  assert.match(before.slice(before.lastIndexOf('${', gate), gate), /canBrandWorkspace/,
    'whiteLabelSection must sit in a ${canBrandWorkspace ? ...} block, not the platform-admin one');
  assert.match(SETTINGS, /const canBrandWorkspace = isSuperAdmin \|\| \(!!user\.current_workspace_id/);
  for (const role of ["'org_owner'", "'org_admin'", "'workspace_admin'"]) {
    assert.ok(SETTINGS.match(/const canBrandWorkspace[\s\S]*?;\n/)[0].includes(role), `${role} may brand its workspace`);
  }
  assert.match(SETTINGS, /if \(canBrandWorkspace\) loadWhiteLabel\(\);/);
});

test('the Enterprise check also accepts the organization owner\'s plan', () => {
  const load = SETTINGS.slice(SETTINGS.indexOf('async function loadWhiteLabel()'));
  assert.match(load.slice(0, 1500), /current_organization\?\.owner_plan_id === 'enterprise'/);
});

let PORT, BASE, proc, db, WS, MEMBER_JWT;
const DATA_DIR = path.join(os.tmpdir(), 'st-wl-gate-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const register = async (email) => (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'test12345', name: email.split('@')[0] }) })).json());

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  const env = { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' };
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  await register('owner@test.local');                 // platform admin, owns the first org (enterprise)
  const member = await register('member@test.local');
  MEMBER_JWT = member.token;
  const { Database } = require('../db/sqlite-driver');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const owner = db.prepare("SELECT id FROM users WHERE email = 'owner@test.local'").get().id;
  WS = db.prepare('SELECT w.id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE o.owner_user_id = ? LIMIT 1').get(owner).id;
  // The member is on a plan of their own that has no white-label, and admins the owner's workspace.
  db.prepare("UPDATE users SET plan_id = 'free' WHERE id = ?").run(member.user.id);
  db.prepare("UPDATE users SET plan_id = 'enterprise' WHERE id = ?").run(owner);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(WS, member.user.id);
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { db.close(); } catch { /* */ } });

const asMember = (url, init = {}) => fetch(BASE + url, { ...init,
  headers: { Authorization: 'Bearer ' + MEMBER_JWT, 'x-workspace-id': WS, 'Content-Type': 'application/json', ...(init.headers || {}) } });

test('/me tells a workspace admin which plan their organization is on', async () => {
  const me = await (await asMember('/api/auth/me')).json();
  assert.equal(me.current_workspace_id, WS);
  assert.equal(me.current_workspace_role, 'workspace_admin');
  assert.equal(me.plan_id, 'free', 'their own plan is not the one that counts');
  assert.equal(me.current_organization.owner_plan_id, 'enterprise');
});

test('that admin can save the workspace brand, but not a custom domain', async () => {
  const ok = await asMember('/api/white-label', { method: 'POST', body: JSON.stringify({ brand_name: 'Harbour Café Screens' }) });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT brand_name FROM white_labels WHERE workspace_id = ?').get(WS).brand_name, 'Harbour Café Screens');
  const domain = await asMember('/api/white-label', { method: 'POST', body: JSON.stringify({ custom_domain: 'signage.example.com' }) });
  assert.equal(domain.status, 403, 'custom domains stay platform-admin only');
});
