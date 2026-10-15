'use strict';

/*
 * Self-service account deletion: GET /api/auth/me/deletion and DELETE /api/auth/me
 * (routes/auth.js, lib/account-deletion.js).
 *
 * Against the REAL schema (db/database.js, foreign keys ON) and the real auth router, with Stripe
 * replaced by a double (lib/stripe-client __setForTests): no network. The rate limit, the public
 * /delete-account page and the end-to-end sign-in path run against a real server.js in
 * account-self-delete-server.test.js.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-acctdel-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-account-self-delete';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const otplib = require('otplib');

const { db } = require('../db/database');
const { generateToken, generateSupportSessionToken } = require('../middleware/auth');
const { apiTokenAuth, hashToken } = require('../middleware/apiToken');
const totp = require('../lib/totp');
const stripeClient = require('../lib/stripe-client');
const loginLockout = require('../lib/login-lockout');
const totpLockout = require('../lib/totp-lockout');

const PHONE_LIMITS = otplib.createGuardrails({ MIN_SECRET_BYTES: 10 });
const codeFor = (secret) => otplib.generateSync({ secret, guardrails: PHONE_LIMITS });
const PASSWORD = 'correct horse battery';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const now = () => Math.floor(Date.now() / 1000);

let server, BASE;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  // A token-authenticated probe, standing in for the public API routers.
  app.get('/probe/token', apiTokenAuth, (req, res) => res.json({ user: req.user.id }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); stripeClient.__setForTests(undefined); });

async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
}
const del = (token, body) => call('DELETE', '/api/auth/me', token, body);

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
let seq = 0;
function user({ role = 'user', provider = 'local', password = true, totpSecret = null, sub = null, customer = null } = {}) {
  const id = `u${++seq}-${crypto.randomBytes(3).toString('hex')}`;
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, totp_secret_enc, totp_enabled,
                stripe_subscription_id, stripe_customer_id, subscription_status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `${id}@t.test`, `Person ${seq}`, password ? HASH : null, provider, role,
      totpSecret ? totp.encryptSecret(totpSecret) : null, totpSecret ? 1 : 0, sub, customer, 'active', seq);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function soloOrg(owner) {
  const org = `org-${owner.id}`;
  const ws = `ws-${owner.id}`;
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(org, `Org of ${owner.id}`, owner.id);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(org, owner.id);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(ws, org, 'Default', owner.id);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(ws, owner.id);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'Lobby')").run(`dev-${owner.id}`, owner.id, ws);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, ?, 'a.png', ?, 'image/png')")
    .run(`c-${owner.id}`, owner.id, ws, `missing-${owner.id}.png`);
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'Main')").run(`pl-${owner.id}`, owner.id, ws);
  return { org, ws };
}
function apiToken(u, ws) {
  const raw = 'st_' + crypto.randomBytes(24).toString('base64url');
  db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, ?, 'ci', ?, ?, 'read')")
    .run(crypto.randomUUID(), hashToken(raw), raw.slice(0, 11), u.id, ws);
  return raw;
}
// A session as a sign-in mints it (auth_time = when they signed in), or an old one.
const session = (u, { signedInAgo = 30, ws = null } = {}) => generateToken(u, ws, { authTime: now() - signedInAgo });
const gone = (id) => !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);

let admin;
beforeEach(() => {
  stripeClient.__setForTests(null);   // a server without billing unless a test says otherwise
  loginLockout._resetForTests && loginLockout._resetForTests();
  totpLockout._resetForTests && totpLockout._resetForTests();
  if (!admin) admin = user({ role: 'platform_admin' });
});

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

test('a password account deletes itself, and its solo organization goes with it', async () => {
  const u = user();
  const { org, ws } = soloOrg(u);
  const info = await call('GET', '/api/auth/me/deletion', session(u));
  assert.equal(info.status, 200);
  assert.equal(info.body.reauth.method, 'password');
  assert.equal(info.body.blocked, null);
  assert.deepEqual(info.body.owned_organizations.map((o) => [o.id, o.shared, o.screens, o.content, o.playlists]), [[org, false, 1, 1, 1]]);

  const r = await del(session(u), { confirm: u.email.toUpperCase(), password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted, true);
  assert.equal(r.body.organizations_deleted, 1);

  assert.ok(gone(u.id), 'user row gone');
  for (const [sql, arg] of [
    ['SELECT 1 FROM organizations WHERE id = ?', org], ['SELECT 1 FROM workspaces WHERE id = ?', ws],
    ['SELECT 1 FROM devices WHERE workspace_id = ?', ws], ['SELECT 1 FROM content WHERE workspace_id = ?', ws],
    ['SELECT 1 FROM playlists WHERE workspace_id = ?', ws], ['SELECT 1 FROM organization_members WHERE user_id = ?', u.id],
    ['SELECT 1 FROM workspace_members WHERE user_id = ?', u.id],
  ]) assert.equal(db.prepare(sql).get(arg), undefined, sql);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');

  // The audit row: there, and without the email (personal data that was just deleted).
  const row = db.prepare("SELECT * FROM activity_log WHERE action = 'account_self_deleted' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, 'audited');
  assert.equal(row.user_id, null);
  assert.ok(row.details.includes(u.id));
  assert.ok(!row.details.includes(u.email), 'no email in the audit row');
});

test('a wrong password is refused with 403 (not 401) and nothing is deleted', async () => {
  const u = user();
  soloOrg(u);
  const r = await del(session(u), { confirm: u.email, password: 'nope-nope-nope' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'reauth_failed');
  assert.ok(!gone(u.id));
  assert.ok(db.prepare('SELECT 1 FROM organizations WHERE owner_user_id = ?').get(u.id));
});

test('the typed email must match', async () => {
  const u = user();
  const r = await del(session(u), { confirm: 'someone-else@t.test', password: PASSWORD });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'confirm_mismatch');
  assert.ok(!gone(u.id));
});

test('with two-factor on, the code is required; a TOTP code or a recovery code completes it', async () => {
  const secret = totp.generateSecret();
  const u = user({ totpSecret: secret });
  const info = await call('GET', '/api/auth/me/deletion', session(u));
  assert.equal(info.body.reauth.totp_required, true);

  let r = await del(session(u), { confirm: u.email, password: PASSWORD });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'reauth_code_required');
  r = await del(session(u), { confirm: u.email, password: PASSWORD, code: '000000' === codeFor(secret) ? '111111' : '000000' });
  assert.equal(r.status, 403);
  assert.ok(!gone(u.id), 'nothing deleted without the second factor');

  r = await del(session(u), { confirm: u.email, password: PASSWORD, code: codeFor(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(gone(u.id));

  // A recovery code works too (the authenticator may be the thing that was lost).
  const v = user({ totpSecret: totp.generateSecret() });
  const { plain, hashes } = totp.generateRecoveryCodes(2);
  for (const h of hashes) db.prepare('INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)').run(crypto.randomUUID(), v.id, h);
  r = await del(session(v), { confirm: v.email, password: PASSWORD, code: plain[0] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(gone(v.id));
});

test('an SSO-only account needs a sign-in from the last 10 minutes, not a password', async () => {
  const u = user({ provider: 'acme-oidc', password: false });
  soloOrg(u);
  // A session from yesterday (or a 2.x token with no auth_time at all) is not proof of presence.
  const stale = generateToken(u, null, { authTime: now() - 86400 });
  const legacy = generateToken(u, null);
  let info = await call('GET', '/api/auth/me/deletion', stale);
  assert.equal(info.body.reauth.method, 'recent_sign_in');
  assert.equal(info.body.reauth.recent_sign_in, false);
  for (const tok of [stale, legacy]) {
    const r = await del(tok, { confirm: u.email, password: 'anything' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'reauth_recent_sign_in_required');
  }
  assert.ok(!gone(u.id));

  // Re-minting a session (switching workspace) carries the OLD sign-in time: it is not a re-auth.
  const sw = await call('POST', '/api/auth/switch-workspace', stale, { workspace_id: `ws-${u.id}` });
  assert.equal(sw.status, 200);
  assert.equal(jwt.decode(sw.body.token).auth_time, jwt.decode(stale).auth_time);
  assert.equal((await del(sw.body.token, { confirm: u.email })).status, 403);

  const fresh = session(u, { signedInAgo: 60 });
  info = await call('GET', '/api/auth/me/deletion', fresh);
  assert.equal(info.body.reauth.recent_sign_in, true);
  const r = await del(fresh, { confirm: u.email });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(gone(u.id));
});

test('owning an organization with other members: 409, nothing deleted, no subscription touched', async () => {
  const u = user({ sub: 'sub_shared' });
  const other = user();
  const { org, ws } = soloOrg(u);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(ws, other.id);
  const calls = [];
  stripeClient.__setForTests({ subscriptions: { list: async () => ({ data: [] }), cancel: async (id) => { calls.push(id); } } });

  const info = await call('GET', '/api/auth/me/deletion', session(u));
  assert.equal(info.body.blocked, 'org_has_other_members');
  const r = await del(session(u), { confirm: u.email, password: PASSWORD });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'org_has_other_members');
  assert.deepEqual(r.body.organizations.map((o) => o.id), [org]);
  assert.match(r.body.error, /Transfer ownership/);
  assert.ok(!gone(u.id));
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE workspace_id = ?').get(ws), 'the shared workspace is intact');
  assert.deepEqual(calls, [], 'Stripe is not called before the refusal');
});

test('a member of someone else\'s organization keeps that org\'s content when they leave', async () => {
  const owner = user();
  const { ws } = soloOrg(owner);
  const member = user();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(ws, member.id);
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('pl-made-by-member', ?, ?, 'Theirs')").run(member.id, ws);
  const r = await del(session(member), { confirm: member.email, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT user_id FROM playlists WHERE id = 'pl-made-by-member'").get().user_id, owner.id);
  assert.ok(db.prepare('SELECT 1 FROM organizations WHERE owner_user_id = ?').get(owner.id));
});

test('a legacy workspace-less row of theirs does not break the delete (no admin acting)', async () => {
  const u = user();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, NULL, 'Legacy')").run(`legacy-${u.id}`, u.id);
  const r = await del(session(u), { confirm: u.email, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Inherited by the platform admin, exactly as an admin-initiated delete would leave it.
  assert.equal(db.prepare('SELECT user_id FROM playlists WHERE id = ?').get(`legacy-${u.id}`).user_id, admin.id);
});

test('hosted: every live subscription is cancelled BEFORE the delete, and a Stripe failure deletes nothing', async () => {
  const u = user({ sub: 'sub_main', customer: 'cus_1' });
  soloOrg(u);
  const order = [];
  stripeClient.__setForTests({ subscriptions: {
    list: async ({ customer }) => { order.push(`list:${customer}`); return { data: [{ id: 'sub_main', status: 'active' }, { id: 'sub_dupe', status: 'past_due' }, { id: 'sub_old', status: 'canceled' }] }; },
    cancel: async (id) => { order.push(`cancel:${id}:${gone(u.id) ? 'after' : 'before'}`); return { id, status: 'canceled' }; },
  } });
  const info = await call('GET', '/api/auth/me/deletion', session(u));
  assert.equal(info.body.subscription.active, true);
  const r = await del(session(u), { confirm: u.email, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subscriptions_cancelled, 2);
  assert.deepEqual(order, ['list:cus_1', 'cancel:sub_main:before', 'cancel:sub_dupe:before'], 'cancelled first, the already-cancelled one left alone');
  assert.ok(gone(u.id));

  const v = user({ sub: 'sub_v' });
  stripeClient.__setForTests({ subscriptions: { list: async () => ({ data: [] }), cancel: async () => { throw Object.assign(new Error('Stripe is down'), { statusCode: 500 }); } } });
  const f = await del(session(v), { confirm: v.email, password: PASSWORD });
  assert.equal(f.status, 502);
  assert.equal(f.body.code, 'billing_cancel_failed');
  assert.ok(!gone(v.id), 'still charged? then still here');

  // An id Stripe no longer knows is not a failure.
  stripeClient.__setForTests({ subscriptions: { list: async () => ({ data: [] }), cancel: async () => { throw Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 }); } } });
  const ok = await del(session(v), { confirm: v.email, password: PASSWORD });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('break-glass recovery and support sessions are refused', async () => {
  const grants = require('../lib/recovery-grant');
  const g = grants.mint({ ttlSec: 600 });
  const recovery = jwt.sign({ id: 'recovery-' + g.jti, email: 'admin@localhost', role: 'platform_admin', recovery: true, jti: g.jti },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  for (const p of [['GET', '/api/auth/me/deletion'], ['DELETE', '/api/auth/me']]) {
    const r = await call(p[0], p[1], recovery, p[0] === 'DELETE' ? { confirm: 'admin@localhost', password: 'x' } : undefined);
    assert.equal(r.status, 403, p.join(' '));
    assert.equal(r.body.code, 'session_not_eligible');
  }

  const jti = crypto.randomBytes(16).toString('hex');
  const exp = now() + 3600;
  db.prepare("INSERT INTO support_grants (jti, request_code, org, reason, issued_by, expires_at) VALUES (?, 'REQ1', 'org', 'help', 'ops', ?)").run(jti, exp);
  const support = generateSupportSessionToken({ jti, issuedBy: 'ops', expiresAt: exp });
  const r = await del(support, { confirm: 'support@screentinker.com', password: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'session_not_eligible');
});

test('the last platform admin cannot delete themselves; with a second admin they can', async () => {
  // Make `admin` the only platform admin left (earlier tests may have created none, but be sure).
  db.prepare("UPDATE users SET role = 'user' WHERE id != ? AND role IN ('platform_admin','superadmin')").run(admin.id);
  const info = await call('GET', '/api/auth/me/deletion', session(admin));
  assert.equal(info.body.blocked, 'last_platform_admin');
  const r = await del(session(admin), { confirm: admin.email, password: PASSWORD });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'last_platform_admin');
  assert.ok(!gone(admin.id));

  const second = user({ role: 'platform_admin' });
  const ok = await del(session(second), { confirm: second.email, password: PASSWORD });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('afterwards, every old session and API token of the account is unusable', async () => {
  const u = user();
  const { ws } = soloOrg(u);
  const raw = apiToken(u, ws);
  const older = session(u, { signedInAgo: 3600 });
  assert.equal((await call('GET', '/api/auth/me', older)).status, 200);
  assert.equal((await call('GET', '/probe/token', raw)).status, 200);

  const r = await del(session(u), { confirm: u.email, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', '/api/auth/me', older)).status, 401, 'old session');
  assert.equal((await call('GET', '/probe/token', raw)).status, 401, 'API token');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(u.id).c, 0);
});

test('lib: a self-service cascade (the person as the actor, no other admin) deletes their legacy rows instead of failing', () => {
  const { deleteUserCascade } = require('../lib/user-deletion');
  const u = user();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, NULL, 'Legacy')").run(`legacy2-${u.id}`, u.id);
  // Before: COALESCE(owner, actor) put the person's own id back, and COMMIT failed the foreign key.
  deleteUserCascade(db, { targetId: u.id, actingAdminId: u.id });
  assert.ok(gone(u.id));
  assert.equal(db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(`legacy2-${u.id}`), undefined);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
