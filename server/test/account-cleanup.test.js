'use strict';

// Stale-account cleanup (lib/account-cleanup.js): exactly which accounts count as stale, that the
// delete re-checks at the moment of deletion, and that uploads are removed only when unreferenced.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-cleanup-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const cleanup = require('../lib/account-cleanup');
const { unlinkIfUnreferenced } = require('../lib/content-files');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const OLD = NOW - 400 * DAY;

function user(id, o = {}) {
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, created_at, last_login, trial_started, stripe_subscription_id, subscription_status)
              VALUES (?, ?, ?, 'x', 'local', ?, ?, ?, ?, ?, ?)`)
    .run(id, `${id}@t.test`, id, o.role || 'user', o.created ?? OLD, o.login ?? null, o.trial ?? null, o.sub ?? null, o.status ?? 'active');
}
function soloOrg(ownerId, tag) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(`org-${tag}`, `Org ${tag}`, ownerId);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(`org-${tag}`, ownerId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(`ws-${tag}`, `org-${tag}`, `WS ${tag}`);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(`ws-${tag}`, ownerId);
  return `ws-${tag}`;
}
function upload(wsId, ownerId, file, bytes) {
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(path.join(config.contentDir, file), crypto.randomBytes(bytes));
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, ?, ?, ?, ?, 'image/png', ?)")
    .run(crypto.randomUUID(), ownerId, wsId, file, file, bytes);
}

beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  for (const t of ['content', 'devices', 'workspace_members', 'organization_members', 'workspaces', 'organizations']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM users WHERE id != 'admin'").run();
  db.pragma('foreign_keys = ON');
  if (!db.prepare("SELECT 1 FROM users WHERE id = 'admin'").get()) user('admin', { role: 'platform_admin', login: NOW });

  user('stale'); upload(soloOrg('stale', 'stale'), 'stale', 'stale-file.png', 2048);
  user('recent', { login: NOW - 10 * DAY }); soloOrg('recent', 'recent');
  user('newbie', { created: NOW - 5 * DAY }); soloOrg('newbie', 'newbie');       // never signed in, but only 5 days old
  user('screens'); const ws = soloOrg('screens', 'screens');
  db.prepare("INSERT INTO devices (id, workspace_id, name, status) VALUES ('dev-1', ?, 'Lobby', 'offline')").run(ws);
  user('paying', { sub: 'sub_1', status: 'active' }); soloOrg('paying', 'paying');
  user('lapsed', { sub: 'sub_2', status: 'canceled' }); soloOrg('lapsed', 'lapsed'); // cancelled long ago: stale
  user('trial', { trial: NOW - DAY }); soloOrg('trial', 'trial');
  user('staff', { role: 'platform_operator' });
  user('sharer'); soloOrg('sharer', 'sharer');
  user('guest', { login: NOW - DAY });
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-sharer', 'guest', 'org_admin')").run();
  user('member'); db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-recent', 'member', 'workspace_viewer')").run();
  user('orphan');                                                               // no org at all, never used
});

test('stale means: customer, not paying, no trial, inactive, no screens, shares nothing', () => {
  const r = cleanup.findStale(db, { inactiveDays: 180, now: NOW });
  assert.deepEqual(r.accounts.map((a) => a.id).sort(), ['lapsed', 'orphan', 'stale']);
  const stale = r.accounts.find((a) => a.id === 'stale');
  assert.equal(stale.never_signed_in, true);
  assert.equal(stale.organizations, 1);
  assert.equal(stale.content_items, 1);
  assert.equal(stale.content_bytes, 2048);
  assert.equal(r.reclaimable_bytes, 2048);
  assert.equal(cleanup.countStale(db, { inactiveDays: 180, now: NOW }), 3);
});

test('the inactivity window is honoured, and odd values fall back to 180 days', () => {
  assert.ok(cleanup.findStale(db, { inactiveDays: 30, now: NOW }).accounts.some((a) => a.id === 'orphan'));
  assert.equal(cleanup.findStale(db, { inactiveDays: 7, now: NOW }).inactive_days, 180);
  // Last sign-in 100 days ago: stale under a 90-day window, not under a 180-day one.
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(NOW - 100 * DAY, 'stale');
  const has = (days) => cleanup.findStale(db, { inactiveDays: days, now: NOW }).accounts.some((a) => a.id === 'stale');
  assert.equal(has(90), true);
  assert.equal(has(180), false);
});

test('purge deletes what is still stale, removes its files, and skips anything that is not', () => {
  const file = path.join(config.contentDir, 'stale-file.png');
  assert.ok(fs.existsSync(file));
  // "lapsed" signs in between the preview and the delete; "recent" was never stale.
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(NOW, 'lapsed');
  const out = cleanup.purge(db, {
    ids: ['stale', 'lapsed', 'recent', 'ghost'], inactiveDays: 180, actingAdminId: 'admin', now: NOW, skipNotice: true,
    unlink: (rel, col) => unlinkIfUnreferenced(rel, '__deleted_account__', col),
  });
  assert.deepEqual(out.deleted.map((d) => d.id), ['stale']);
  assert.deepEqual(out.skipped.map((s) => s.id).sort(), ['ghost', 'lapsed', 'recent']);
  assert.match(out.skipped.find((s) => s.id === 'lapsed').reason, /No longer stale/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'stale'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE id = 'org-stale'").get().n, 0, 'its solely-owned org goes with it');
  assert.equal(fs.existsSync(file), false, 'and its upload is removed from disk');
  assert.equal(out.files_removed, 1);
  assert.equal(out.bytes_freed, 2048);
  // Nobody else was touched.
  for (const id of ['recent', 'screens', 'paying', 'trial', 'staff', 'sharer', 'guest', 'member', 'lapsed']) {
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id), `${id} still exists`);
  }
});

test('a file another account still uses is not removed', () => {
  upload('ws-recent', 'recent', 'shared.png', 100);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, 'stale', 'ws-stale', 'shared.png', 'shared.png', 'image/png', 100)").run(crypto.randomUUID());
  cleanup.purge(db, { ids: ['stale'], inactiveDays: 180, actingAdminId: 'admin', now: NOW, skipNotice: true, unlink: (rel, col) => unlinkIfUnreferenced(rel, '__deleted_account__', col) });
  assert.ok(fs.existsSync(path.join(config.contentDir, 'shared.png')));
});

test('purge refuses empty and oversized batches', () => {
  assert.throws(() => cleanup.purge(db, { ids: [], actingAdminId: 'admin' }), /at least one/);
  assert.throws(() => cleanup.purge(db, { ids: Array.from({ length: 501 }, (_, i) => `x${i}`), actingAdminId: 'admin' }), /At most 500/);
});


/* ─────────────── notice first ─────────────── */

const sent = [];
const send = (ok = true) => async ({ user, deleteAfter }) => { sent.push({ email: user.email, deleteAfter }); return ok; };

test('warn records a notice only when the email went out, and never twice', async () => {
  sent.length = 0;
  let out = await cleanup.warn(db, { ids: ['stale', 'recent'], inactiveDays: 180, noticeDays: 14, now: NOW, send: send(false) });
  assert.equal(out.warned.length, 0);
  assert.match(out.skipped.find((k) => k.id === 'stale').reason, /could not be sent/);
  assert.equal(db.prepare("SELECT cleanup_warned_at FROM users WHERE id = 'stale'").get().cleanup_warned_at, null);

  out = await cleanup.warn(db, { ids: ['stale', 'recent'], inactiveDays: 180, noticeDays: 14, now: NOW, send: send(true) });
  assert.deepEqual(out.warned.map((w) => w.id), ['stale']);
  assert.equal(out.skipped.find((k) => k.id === 'recent').reason, 'Not stale');
  assert.equal(out.warned[0].delete_after, NOW + 14 * DAY);
  out = await cleanup.warn(db, { ids: ['stale'], inactiveDays: 180, now: NOW + DAY, send: send(true) });
  assert.match(out.skipped[0].reason, /Already under notice/);
  const mail = cleanup.noticeEmail({ user: { name: 'Sam', email: 'sam@t.test' }, deleteAfter: NOW + 14 * DAY, appUrl: 'https://signage.example' });
  assert.match(mail.subject, /will be deleted on/);
  assert.match(mail.text, /https:\/\/signage\.example\/app/);
  assert.match(mail.text, /sign in before then/);
});

test('delete waits for the notice period, and only takes accounts that stayed silent', async () => {
  await cleanup.warn(db, { ids: ['stale', 'lapsed'], inactiveDays: 180, noticeDays: 14, now: NOW, send: send(true) });
  const unlink = () => ({ unlinked: false });
  // During the notice period: nothing is deleted.
  let out = cleanup.purge(db, { ids: ['stale', 'lapsed', 'orphan'], inactiveDays: 180, actingAdminId: 'admin', now: NOW + 5 * DAY, unlink });
  assert.equal(out.deleted.length, 0);
  assert.match(out.skipped.find((k) => k.id === 'stale').reason, /Notice period runs until/);
  assert.match(out.skipped.find((k) => k.id === 'orphan').reason, /Not warned yet/);
  // "lapsed" does something in the dashboard after the notice: the notice is void.
  db.prepare("INSERT INTO activity_log (user_id, action, created_at) VALUES ('lapsed', 'content_upload', ?)").run(NOW + 2 * DAY);
  const later = NOW + 15 * DAY;
  const preview = cleanup.findStale(db, { inactiveDays: 180, now: later + 400 * DAY });
  assert.equal(preview.accounts.find((a) => a.id === 'lapsed')?.notice, 'not_warned', 'activity after the notice voids it');
  out = cleanup.purge(db, { ids: ['stale', 'lapsed'], inactiveDays: 180, actingAdminId: 'admin', now: later, unlink });
  assert.deepEqual(out.deleted.map((d) => d.id), ['stale'], 'the silent one goes after the notice period');
  assert.ok(db.prepare("SELECT 1 FROM users WHERE id = 'lapsed'").get(), 'the one that came back stays');
});

test('using an API token counts as activity: an automation-only account is never stale', () => {
  db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, last_used_at) VALUES ('tok1', 'h1', 'st_x', 'ci', 'orphan', 'ws-stale', ?)").run(NOW - DAY);
  assert.ok(!cleanup.findStale(db, { inactiveDays: 180, now: NOW }).accounts.some((a) => a.id === 'orphan'));
  db.prepare("DELETE FROM api_tokens WHERE id = 'tok1'").run();
});
