'use strict';

/*
 * The Platform area and the organization-wide member list, against a real server process.
 *
 *   GET /api/admin/overview                        — platform admins only; counts, never names
 *   GET /api/workspaces/:id/organization-members   — org owners/admins and platform staff only;
 *                                                    only ever the workspace's own organization
 *
 * Two organizations. Org A has an owner, a second workspace, a workspace admin and an editor in
 * different workspaces; org B has its own owner. Every assertion states the safe behaviour.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-platform-'));
const DATA_DIR = path.join(TMP, 'data');
let BASE;
let proc;
let sqlite;
const U = {};
let wsA2;

async function api(who, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who && who.token) headers.Authorization = `Bearer ${who.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.DISABLE_REGISTRATION;
  Object.assign(env, { DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', JWT_SECRET: 'plat-' + crypto.randomBytes(8).toString('hex') });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));

  let n = 0;
  const reg = async (email, createOrg) => {
    const r = await api(null, 'POST', '/api/auth/register', { email, password: 'Passw0rd123!', createOrg }, { 'X-Forwarded-For': `192.0.2.${++n}` });
    assert.equal(r.status, 201, `register ${email}: ${r.text}`);
    return { token: r.json.token, id: r.json.user.id, ws: r.json.current_workspace_id, email };
  };
  U.admin = await reg('admin@plat.local', true);         // first user: platform_admin
  U.ownerA = await reg('owner-a@plat.local', true);
  U.ownerB = await reg('owner-b@plat.local', true);
  U.wsAdminA = await reg('wsadmin-a@plat.local', false);
  U.editorA2 = await reg('editor-a2@plat.local', false);
  U.operator = await reg('operator@plat.local', false);

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  sqlite.pragma('busy_timeout = 5000');
  const orgA = sqlite.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(U.ownerA.ws).organization_id;
  wsA2 = 'ws-a2-' + crypto.randomBytes(4).toString('hex');
  sqlite.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(wsA2, orgA, 'A Second Site');
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(U.ownerA.ws, U.wsAdminA.id);
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(wsA2, U.editorA2.id);
  sqlite.prepare("UPDATE users SET role = 'platform_operator' WHERE id = ?").run(U.operator.id);
});

after(() => {
  try { if (proc) proc.kill('SIGKILL'); } catch { /* */ }
  try { if (sqlite) sqlite.close(); } catch { /* */ }
  if (!process.env.KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }
});

test('overview: platform admin only, and counts rather than people', async () => {
  const r = await api(U.admin, 'GET', '/api/admin/overview');
  assert.equal(r.status, 200, r.text);
  for (const k of ['users', 'organizations', 'workspaces', 'devices', 'devices_online', 'paying_accounts', 'trialing', 'sso_only_requests', 'plugin_submissions', 'version']) {
    assert.ok(k in r.json, `overview has ${k}`);
  }
  assert.equal(r.json.users, 6);
  assert.ok(r.json.organizations >= 3);
  assert.doesNotMatch(r.text, /@plat\.local/, 'no email addresses in the overview');
  for (const who of [U.ownerA, U.wsAdminA, U.operator]) {
    assert.equal((await api(who, 'GET', '/api/admin/overview')).status, 403, 'owner-level page: not for org owners, workspace admins or operators');
  }
});

test('organization members: an org owner sees the whole org, with each person\'s workspace access', async () => {
  const r = await api(U.ownerA, 'GET', `/api/workspaces/${U.ownerA.ws}/organization-members`);
  assert.equal(r.status, 200, r.text);
  const emails = r.json.members.map((m) => m.email).sort();
  assert.deepEqual(emails, ['editor-a2@plat.local', 'owner-a@plat.local', 'wsadmin-a@plat.local']);
  assert.equal(r.json.members[0].org_role, 'org_owner', 'owners first');
  const editor = r.json.members.find((m) => m.email === 'editor-a2@plat.local');
  assert.deepEqual(editor.workspaces.map((w) => [w.name, w.role]), [['A Second Site', 'workspace_editor']]);
  assert.equal(r.json.workspaces.length, 2);
  assert.doesNotMatch(r.text, /owner-b@|admin@plat/, 'nobody from another organization');
});

test('organization members: a workspace admin (not an org admin) is refused', async () => {
  const r = await api(U.wsAdminA, 'GET', `/api/workspaces/${U.ownerA.ws}/organization-members`);
  assert.equal(r.status, 403);
  // …and still gets their own workspace list.
  assert.equal((await api(U.wsAdminA, 'GET', `/api/workspaces/${U.ownerA.ws}/members`)).status, 200);
});

test('organization members: another org\'s owner is refused, even by naming a workspace id', async () => {
  const r = await api(U.ownerB, 'GET', `/api/workspaces/${U.ownerA.ws}/organization-members`);
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.text, /@plat\.local/);
  const own = await api(U.ownerB, 'GET', `/api/workspaces/${U.ownerB.ws}/organization-members`);
  assert.deepEqual(own.json.members.map((m) => m.email), ['owner-b@plat.local']);
});

test('organization members: platform staff can look at any org; a missing workspace is 404', async () => {
  assert.equal((await api(U.admin, 'GET', `/api/workspaces/${U.ownerA.ws}/organization-members`)).status, 200);
  assert.equal((await api(U.operator, 'GET', `/api/workspaces/${wsA2}/organization-members`)).status, 200);
  assert.equal((await api(U.ownerA, 'GET', '/api/workspaces/nope/organization-members')).status, 404);
});

test('/me tells the page who may open the organization view, with the endpoint\'s own rule', async () => {
  const flag = async (who, wsId) => ((await api(who, 'GET', '/api/auth/me')).json.accessible_workspaces || []).find((w) => w.id === wsId)?.can_view_org_members;
  assert.equal(await flag(U.ownerA, U.ownerA.ws), true, 'org owner');
  assert.equal(await flag(U.wsAdminA, U.ownerA.ws), false, 'workspace admin');
  assert.equal(await flag(U.operator, U.ownerA.ws), true, 'platform staff');
  const me = (await api(U.ownerA, 'GET', '/api/auth/me')).json;
  assert.ok(me.accessible_workspaces.every((w) => !('org_role' in w)), 'org_role itself still stays server-side');
});

test('overview carries the activity and health numbers', async () => {
  const o = (await api(U.admin, 'GET', '/api/admin/overview')).json;
  for (const k of ['new_users_7d', 'inactive_30d', 'never_signed_in', 'unverified_emails', 'trials_ending_7d', 'accounts_no_screens', 'orgs_no_screens', 'screens_offline_24h', 'storage_bytes', 'stale_accounts_180d']) {
    assert.equal(typeof o[k], 'number', `${k} is a number`);
  }
  assert.equal(o.accounts_no_screens, 4, 'the four customer accounts; platform staff are not counted');
});

test('cleanup: platform admin only, and a delete needs the typed confirmation naming the count', async () => {
  for (const who of [U.ownerA, U.operator]) {
    assert.equal((await api(who, 'GET', '/api/admin/cleanup/stale-accounts')).status, 403);
    assert.equal((await api(who, 'POST', '/api/admin/cleanup/stale-accounts', { ids: [U.ownerB.id], confirm: 'DELETE 1' })).status, 403);
  }
  const preview = await api(U.admin, 'GET', '/api/admin/cleanup/stale-accounts?days=180');
  assert.equal(preview.status, 200);
  assert.equal(preview.json.total, 0, 'every account here signed up minutes ago: nothing is stale');
  let r = await api(U.admin, 'POST', '/api/admin/cleanup/stale-accounts', { ids: [U.ownerB.id], days: 180 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /DELETE 1/);
  r = await api(U.admin, 'POST', '/api/admin/cleanup/stale-accounts', { ids: [U.ownerB.id, U.editorA2.id], days: 180, confirm: 'DELETE 1' });
  assert.equal(r.status, 400, 'the phrase must name the real count');
  // Correctly confirmed, but the server re-checks: a fresh account is not stale, so nothing is deleted.
  r = await api(U.admin, 'POST', '/api/admin/cleanup/stale-accounts', { ids: [U.ownerB.id], days: 180, confirm: 'DELETE 1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted.length, 0);
  assert.equal(r.json.skipped[0].id, U.ownerB.id);
  assert.equal((await api(U.ownerB, 'GET', '/api/auth/me')).status, 200, 'the account is untouched');
});


test('signing in cancels a pending deletion notice', async () => {
  sqlite.prepare('UPDATE users SET cleanup_warned_at = ?, cleanup_delete_after = ? WHERE id = ?').run(1000, 2000, U.ownerB.id);
  const r = await api(null, 'POST', '/api/auth/login', { email: 'owner-b@plat.local', password: 'Passw0rd123!' }, { 'X-Forwarded-For': '192.0.2.99' });
  assert.equal(r.status, 200, r.text);
  const row = sqlite.prepare('SELECT cleanup_warned_at, cleanup_delete_after FROM users WHERE id = ?').get(U.ownerB.id);
  assert.deepEqual(row, { cleanup_warned_at: null, cleanup_delete_after: null });
});

test('cleanup: notices need email, and deleting without notice has its own phrase', async () => {
  const r = await api(U.admin, 'POST', '/api/admin/cleanup/stale-accounts/warn', { ids: [U.ownerB.id], days: 180 });
  assert.equal(r.status, 503, 'no email transport in this test server');
  assert.match(r.json.error, /Email is not configured/);
  let d = await api(U.admin, 'POST', '/api/admin/cleanup/stale-accounts', { ids: [U.ownerB.id], days: 180, skip_notice: true, confirm: 'DELETE 1' });
  assert.equal(d.status, 400);
  assert.match(d.json.error, /DELETE 1 WITHOUT NOTICE/);
  d = await api(U.admin, 'POST', '/api/admin/cleanup/stale-accounts', { ids: [U.ownerB.id], days: 180, skip_notice: true, confirm: 'DELETE 1 WITHOUT NOTICE' });
  assert.equal(d.status, 200);
  assert.equal(d.json.deleted.length, 0, 'still re-checked: a fresh account is not stale');
  assert.equal((await api(U.admin, 'GET', '/api/admin/cleanup/stale-accounts')).json.email_configured, false);
});

test('attention details: platform admin only, and specific about what is wrong', async () => {
  sqlite.prepare("INSERT INTO devices (id, workspace_id, name, status, last_heartbeat) VALUES ('dev-att', ?, 'Lobby TV', 'offline', ?)")
    .run(wsA2, Math.floor(Date.now() / 1000) - 3 * 86400);
  assert.equal((await api(U.ownerA, 'GET', '/api/admin/overview/attention/offline')).status, 403);
  assert.equal((await api(U.operator, 'GET', '/api/admin/overview/attention/stale')).status, 403);
  assert.equal((await api(U.admin, 'GET', '/api/admin/overview/attention/nope')).status, 404);
  const off = await api(U.admin, 'GET', '/api/admin/overview/attention/offline');
  assert.equal(off.status, 200);
  const row = off.json.rows.find((r) => r.screen === 'Lobby TV');
  assert.ok(row, 'the offline screen is listed');
  assert.equal(row.workspace, 'A Second Site');
  const stale = await api(U.admin, 'GET', '/api/admin/overview/attention/stale');
  assert.deepEqual(Object.keys(stale.json.counts).sort(), ['not_warned', 'notice', 'ready']);
  for (const item of ['sso', 'plugins', 'orphans']) {
    assert.ok(Array.isArray((await api(U.admin, 'GET', `/api/admin/overview/attention/${item}`)).json.rows), `${item} lists rows`);
  }
  assert.ok('current' in (await api(U.admin, 'GET', '/api/admin/overview/attention/update')).json);
});
