'use strict';

/*
 * The integrations of #520-#526 against tenant deletion, member removal and token revocation, on the
 * REAL schema (db/database.js).
 *
 * Most of their tables have no foreign key at all (canva_*, social_feeds/posts, automation_*,
 * audience_buckets, cloud_folder_removed), so nothing could cascade them, and the rest relied on a
 * cascade being live on the connection that does the delete. Each deletion test runs twice: once with
 * foreign_keys OFF, where the explicit purge in lib/user-deletion.js is the ONLY thing that can clean
 * up, and once with it ON, where COMMIT must also come out without a dangling reference.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-tenant-integ-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tenant-integrations';
delete process.env.CANVA_CLIENT_ID;
delete process.env.CANVA_CLIENT_SECRET;

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const secretbox = require('../lib/secretbox');
const config = require('../config');
const {
  deleteUserCascade, deleteOrgCascade, deleteWorkspaceCascade, releaseWorkspaceMember, dropTokenSubscriptions,
} = require('../lib/user-deletion');

// Every table a seeded workspace writes to, with the clause that finds ITS rows.
const WS_TABLES = {
  cloud_folders: "workspace_id = $W", cloud_folder_items: "folder_id = 'cf-$W'", cloud_folder_removed: "folder_id = 'cf-$W'",
  canva_links: "workspace_id = $W", canva_jobs: "workspace_id = $W",
  social_feeds: "workspace_id = $W", social_posts: "feed_id = 'sf-$W'",
  rooms: "workspace_id = $W", room_bookings: "room_id = 'rm-$W'", room_checkins: "room_id = 'rm-$W'",
  automation_hooks: "workspace_id = $W", automation_hook_calls: "hook_id = 'hk-$W'",
  automation_overrides: "workspace_id = $W", automation_events: "workspace_id = $W",
  automation_subscriptions: "workspace_id = $W", automation_deliveries: "subscription_id IN ('sub-$W', 'subtok-$W')",
  automation_device_state: "device_id = 'dev-$W'",
  cap_feeds: "workspace_id = $W", cap_alerts: "feed_id = 'cap-$W'", cap_feed_scopes: "feed_id = 'cap-$W'",
  audience_buckets: "device_id = 'dev-$W'",
};
const ORG_TABLES = {
  org_m365_apps: 'organization_id = $O', canva_integrations: 'organization_id = $O', bi_connections: 'organization_id = $O',
  social_connections: 'organization_id = $O', room_connections: 'organization_id = $O', audience_org_settings: 'organization_id = $O',
  canva_connections: "integration_key = 'org:' || $O",
};
// $W / $O stand for the (test-controlled, quote-free) id, bare or inside a literal.
const count = (table, where, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${
  where.replace(/'([^']*)\$[WO]([^']*)'/g, `'$1${id}$2'`).replace(/\$[WO]/g, `'${id}'`)}`).get().n;
function left(tables, id) {
  const out = {};
  for (const [t, w] of Object.entries(tables)) { const n = count(t, w, id); if (n) out[t] = n; }
  return out;
}

function user(id, role = 'user') {
  db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)")
    .run(id, `${id}@t.test`, id, role);
}
function org(id, ownerId) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id, id, ownerId);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(id, ownerId);
  db.prepare("INSERT INTO org_m365_apps (organization_id, tenant_id, client_id) VALUES (?, 't', 'c')").run(id);
  db.prepare("INSERT INTO canva_integrations (organization_id, client_id, client_secret_enc) VALUES (?, ?, ?)").run(id, `cid-${id}`, secretbox.encrypt(`csecret-${id}`));
  db.prepare("INSERT INTO bi_connections (id, organization_id, created_by, kind, name) VALUES (?, ?, ?, 'grafana', 'g')").run(`bi-${id}`, id, ownerId);
  db.prepare("INSERT INTO social_connections (id, organization_id, created_by, kind, name) VALUES (?, ?, ?, 'instagram', 'i')").run(`sc-${id}`, id, ownerId);
  db.prepare("INSERT INTO room_connections (id, organization_id, kind, name) VALUES (?, ?, 'm365', 'r')").run(`rc-${id}`, id);
  db.prepare('INSERT INTO audience_org_settings (organization_id, allowed) VALUES (?, 1)').run(id);
}
function canvaConnection(userId, key) {
  db.prepare('INSERT INTO canva_connections (user_id, integration_key, access_enc, refresh_enc) VALUES (?, ?, ?, ?)')
    .run(userId, key, secretbox.encrypt(`access-${userId}-${key}`), secretbox.encrypt(`refresh-${userId}-${key}`));
}
const HASH = (w) => crypto.createHash('sha256').update(`img-${w}`).digest('hex');
/** A workspace with one row in every integration table, set up by `by`. */
function ws(id, orgId, by, ...members) {
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id, orgId, id);
  for (const m of members) db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(id, m);
  const t = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'screen')").run(`dev-${id}`, by, id);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, mime_type) VALUES (?, ?, ?, 'c.png', 'image/png')").run(`c-${id}`, by, id);
  db.prepare(`INSERT INTO cloud_folders (id, workspace_id, organization_id, user_id, name, share_url, drive_id, item_id)
    VALUES (?, ?, ?, ?, 'Menus', 'https://x.sharepoint.com/s', 'd', 'i')`).run(`cf-${id}`, id, orgId, by);
  db.prepare("INSERT INTO cloud_folder_items (folder_id, remote_id, content_id) VALUES (?, 'r1', ?)").run(`cf-${id}`, `c-${id}`);
  db.prepare("INSERT INTO cloud_folder_removed (folder_id, content_id) VALUES (?, 'gone')").run(`cf-${id}`);
  db.prepare(`INSERT INTO canva_links (content_id, workspace_id, user_id, integration_key, design_id, pages, format)
    VALUES (?, ?, ?, ?, 'D1', '[1]', 'png')`).run(`c-${id}`, id, by, `org:${orgId}`);
  db.prepare("INSERT INTO canva_jobs (id, workspace_id, user_id, kind, status) VALUES (?, ?, ?, 'import', 'done')").run(`cj-${id}`, id, by);
  db.prepare("INSERT INTO social_feeds (id, workspace_id, created_by, name) VALUES (?, ?, ?, 'wall')").run(`sf-${id}`, id, by);
  db.prepare(`INSERT INTO social_posts (feed_id, network, post_id, source_key, status, media, posted_at, first_seen_at, last_seen_at)
    VALUES (?, 'instagram', 'p1', 'k', 'shown', ?, ?, ?, ?)`).run(`sf-${id}`, JSON.stringify([HASH(id)]), t, t, t);
  db.prepare("INSERT INTO social_media (hash, url, mime, bytes, created_at) VALUES (?, ?, 'image/png', 4, ?)").run(HASH(id), `https://cdn.test/${id}`, t);
  const mediaDir = path.join(config.dataDir, 'social-media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, HASH(id)), 'png!');
  db.prepare("INSERT INTO rooms (id, workspace_id, name, source) VALUES (?, ?, 'Boardroom', 'ics')").run(`rm-${id}`, id);
  db.prepare("INSERT INTO room_bookings (id, room_id, event_id, start_ms, end_ms, created_at) VALUES (?, ?, 'e1', 1, 2, ?)").run(`rb-${id}`, `rm-${id}`, t);
  db.prepare("INSERT INTO room_checkins (room_id, event_id, kind, at) VALUES (?, 'e1', 'checkin', ?)").run(`rm-${id}`, t);
  db.prepare("INSERT INTO cap_feeds (id, workspace_id, user_id, name, url, source) VALUES (?, ?, ?, 'hook feed', 'hook:', 'hook')").run(`cap-${id}`, id, by);
  db.prepare("INSERT INTO cap_alerts (feed_id, akey, data, first_seen, last_seen) VALUES (?, 'a1', '{}', ?, ?)").run(`cap-${id}`, t, t);
  db.prepare("INSERT INTO cap_feed_scopes (feed_id, scope_kind, scope_id) VALUES (?, 'workspace', ?)").run(`cap-${id}`, id);
  db.prepare("INSERT INTO automation_hooks (id, workspace_id, name, kind, secret_hash, feed_id, created_by) VALUES (?, ?, 'h', 'emergency', 'x', ?, ?)").run(`hk-${id}`, id, `cap-${id}`, by);
  db.prepare('INSERT INTO automation_hook_calls (hook_id, at, status) VALUES (?, ?, 200)').run(`hk-${id}`, t);
  db.prepare("INSERT INTO automation_overrides (id, workspace_id, hook_id, scope_kind, scope_id, playlist_id, starts_at, ends_at) VALUES (?, ?, ?, 'workspace', ?, 'p', ?, ?)")
    .run(`ov-${id}`, id, `hk-${id}`, id, t, t + 60);
  const ev = db.prepare("INSERT INTO automation_events (workspace_id, type, data, created_at) VALUES (?, 'device_offline', '{}', ?)").run(id, t).lastInsertRowid;
  // One subscription from a dashboard session, one made with an API token of `by`.
  const tok = `tok-${id}`;
  db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, 'st_x', 'zap', ?, ?, 'write')").run(tok, `h-${id}`, by, id);
  db.prepare("INSERT INTO automation_subscriptions (id, workspace_id, token_id, user_id, event, target_url) VALUES (?, ?, NULL, ?, 'device_offline', 'https://hooks.zapier.test/a')").run(`sub-${id}`, id, by);
  db.prepare("INSERT INTO automation_subscriptions (id, workspace_id, token_id, user_id, event, target_url) VALUES (?, ?, ?, ?, 'device_offline', 'https://hooks.zapier.test/b')").run(`subtok-${id}`, id, tok, by);
  for (const s of [`sub-${id}`, `subtok-${id}`]) db.prepare('INSERT INTO automation_deliveries (subscription_id, event_id, next_at, created_at) VALUES (?, ?, ?, ?)').run(s, ev, t, t);
  db.prepare("INSERT INTO automation_device_state (device_id, status) VALUES (?, 'online')").run(`dev-${id}`);
  db.prepare(`INSERT INTO audience_buckets (device_id, workspace_id, bucket_start, bucket_sec, item_kind, present_max, present_avg_x100, arrivals, impressions, d0, d1, d2, d3, d4, d5)
    VALUES (?, ?, ?, 60, 'content', 1, 100, 1, 1, 0, 0, 0, 0, 0, 0)`).run(`dev-${id}`, id, t);
}

const ALL = ['audience_buckets', 'audience_org_settings', 'automation_deliveries', 'automation_device_state', 'automation_events',
  'automation_hook_calls', 'automation_hooks', 'automation_overrides', 'automation_subscriptions', 'bi_connections', 'canva_connections',
  'canva_integrations', 'canva_jobs', 'canva_links', 'cap_alerts', 'cap_feed_scopes', 'cap_feeds', 'cloud_folder_items', 'cloud_folder_removed',
  'cloud_folders', 'org_m365_apps', 'room_bookings', 'room_checkins', 'room_connections', 'rooms', 'social_connections', 'social_feeds',
  'social_media', 'social_posts', 'api_tokens', 'content', 'devices', 'workspace_members', 'organization_members', 'workspaces', 'organizations', 'users'];

let revoked;
const recorder = (integration, token) => { revoked.push(`${integration.key}|${token}`); };
const flush = () => new Promise((r) => setImmediate(r));
const mediaFile = (w) => path.join(config.dataDir, 'social-media', HASH(w));
const fkViolations = () => db.prepare('PRAGMA foreign_key_check').all()
  .filter((v) => Object.keys(WS_TABLES).includes(v.table) || Object.keys(ORG_TABLES).includes(v.table));

beforeEach(() => {
  revoked = [];
  db.pragma('foreign_keys = OFF');
  for (const t of ALL) db.prepare(`DELETE FROM ${t}`).run();
  user('admin', 'platform_admin');
  user('owner'); user('member'); user('solo'); user('other');
  org('orgA', 'owner');
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('orgA', 'member', 'org_member')").run();
  ws('wsA', 'orgA', 'member', 'owner', 'member');
  ws('wsA2', 'orgA', 'owner', 'owner');
  org('orgS', 'solo');
  ws('wsS', 'orgS', 'solo', 'solo');
  org('orgB', 'other');
  ws('wsB', 'orgB', 'other', 'other');
  canvaConnection('member', 'org:orgA');
  canvaConnection('owner', 'org:orgA');
  canvaConnection('solo', 'org:orgS');
  canvaConnection('solo', 'instance');
  canvaConnection('other', 'org:orgB');
});

for (const fk of ['OFF', 'ON']) {
  test(`deleteWorkspaceCascade purges every integration table of that workspace only (foreign_keys ${fk})`, async () => {
    db.pragma(`foreign_keys = ${fk}`);
    deleteWorkspaceCascade(db, { workspaceId: 'wsA', revokeCanva: recorder });
    await flush();
    assert.deepEqual(left(WS_TABLES, 'wsA'), {});
    assert.equal(Object.keys(left(WS_TABLES, 'wsA2')).length, Object.keys(WS_TABLES).length, 'the sibling workspace is untouched');
    assert.equal(Object.keys(left(ORG_TABLES, 'orgA')).length, Object.keys(ORG_TABLES).length, 'org settings stay with the org');
    assert.equal(fs.existsSync(mediaFile('wsA')), false, 'the cached social image no post uses any more is deleted');
    assert.equal(fs.existsSync(mediaFile('wsA2')), true, 'a surviving post keeps its image');
    assert.deepEqual(revoked, [], 'no Canva connection belongs to a workspace');
    if (fk === 'ON') assert.deepEqual(fkViolations(), []);
  });

  test(`deleteOrgCascade purges workspace and org integration rows, revoking the org app's Canva tokens (foreign_keys ${fk})`, async () => {
    db.pragma(`foreign_keys = ${fk}`);
    deleteOrgCascade(db, { orgId: 'orgA', revokeCanva: recorder });
    await flush();
    assert.deepEqual(left(WS_TABLES, 'wsA'), {});
    assert.deepEqual(left(WS_TABLES, 'wsA2'), {});
    assert.deepEqual(left(ORG_TABLES, 'orgA'), {});
    assert.equal(Object.keys(left(ORG_TABLES, 'orgB')).length, Object.keys(ORG_TABLES).length, 'another org is untouched');
    assert.equal(Object.keys(left(WS_TABLES, 'wsB')).length, Object.keys(WS_TABLES).length);
    assert.deepEqual(revoked.sort(), [
      'org:orgA|access-member-org:orgA', 'org:orgA|access-owner-org:orgA',
      'org:orgA|refresh-member-org:orgA', 'org:orgA|refresh-owner-org:orgA',
    ]);
    if (fk === 'ON') assert.deepEqual(fkViolations(), []);
  });

  test(`deleteUserCascade of a solo owner purges their org's integrations and every Canva connection of theirs (foreign_keys ${fk})`, async () => {
    process.env.CANVA_CLIENT_ID = 'inst-id'; process.env.CANVA_CLIENT_SECRET = 'inst-secret';
    try {
      db.pragma(`foreign_keys = ${fk}`);
      deleteUserCascade(db, { targetId: 'solo', actingAdminId: 'admin', revokeCanva: recorder });
      await flush();
    } finally { delete process.env.CANVA_CLIENT_ID; delete process.env.CANVA_CLIENT_SECRET; }
    assert.deepEqual(left(WS_TABLES, 'wsS'), {});
    assert.deepEqual(left(ORG_TABLES, 'orgS'), {});
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canva_connections WHERE user_id = 'solo'").get().n, 0, 'the instance-app connection too');
    assert.deepEqual(revoked.sort(), [
      'instance|access-solo-instance', 'instance|refresh-solo-instance',
      'org:orgS|access-solo-org:orgS', 'org:orgS|refresh-solo-org:orgS',
    ]);
    assert.equal(Object.keys(left(WS_TABLES, 'wsA')).length, Object.keys(WS_TABLES).length, 'nobody else loses anything');
    if (fk === 'ON') assert.deepEqual(fkViolations(), []);
  });
}

test('deleteUserCascade of a member: Canva connection revoked + deleted, links/jobs deleted, folder paused, subscriptions gone', async () => {
  deleteUserCascade(db, { targetId: 'member', actingAdminId: 'admin', revokeCanva: recorder });
  await flush();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canva_connections WHERE user_id = 'member'").get().n, 0);
  assert.deepEqual(revoked.sort(), ['org:orgA|access-member-org:orgA', 'org:orgA|refresh-member-org:orgA']);
  assert.equal(count('canva_links', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(count('canva_jobs', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content WHERE id = 'c-wsA'").get().n, 1, 'the library item stays');
  const f = db.prepare("SELECT user_id, enabled, last_error FROM cloud_folders WHERE id = 'cf-wsA'").get();
  assert.equal(f.user_id, null);
  assert.equal(f.enabled, 0);
  assert.match(f.last_error, /no longer has an account/);
  assert.equal(count('cloud_folder_items', "folder_id = 'cf-$W'", 'wsA'), 1, 'the mapping stays for an admin to resume or remove');
  assert.equal(count('automation_subscriptions', 'workspace_id = $W', 'wsA'), 0, 'session- and token-made subscriptions both go');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automation_deliveries WHERE subscription_id IN ('sub-wsA','subtok-wsA') AND status = 'pending'").get().n, 0);
  assert.equal(db.prepare("SELECT created_by FROM social_feeds WHERE id = 'sf-wsA'").get().created_by, null, 'creator columns are unlinked');
  assert.equal(db.prepare("SELECT created_by FROM automation_hooks WHERE id = 'hk-wsA'").get().created_by, null);
  // The owner's own integrations in the same org are theirs and stay.
  assert.equal(Object.keys(left(WS_TABLES, 'wsA2')).length, Object.keys(WS_TABLES).length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canva_connections WHERE user_id = 'owner'").get().n, 1);
  assert.deepEqual(fkViolations(), []);
});

test('releaseWorkspaceMember: links deleted, folders paused, subscriptions dropped - in that workspace only', () => {
  // `member` also set things up in wsA2 (where they stay a member): those must survive.
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsA2', 'member', 'workspace_editor')").run();
  db.prepare(`INSERT INTO canva_links (content_id, workspace_id, user_id, integration_key, design_id, pages, format)
    VALUES ('c-other', 'wsA2', 'member', 'org:orgA', 'D2', '[1]', 'png')`).run();
  db.prepare("DELETE FROM workspace_members WHERE workspace_id = 'wsA' AND user_id = 'member'").run();
  const out = releaseWorkspaceMember(db, { userId: 'member', workspaceIds: ['wsA'] });
  assert.deepEqual(out, { canva_links: 1, cloud_folders_paused: 1, subscriptions: 2 });
  assert.equal(count('canva_links', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canva_links WHERE content_id = 'c-other'").get().n, 1);
  const f = db.prepare("SELECT user_id, enabled, last_error FROM cloud_folders WHERE id = 'cf-wsA'").get();
  assert.equal(f.enabled, 0);
  assert.match(f.last_error, /no longer a member/);
  assert.equal(count('automation_subscriptions', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automation_deliveries WHERE subscription_id = 'sub-wsA' AND status = 'failed'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canva_connections WHERE user_id = 'member'").get().n, 1, 'their own Canva account is not the workspace\'s');
});

test('releaseWorkspaceMember leaves an org admin alone: they still reach the workspace', () => {
  db.prepare("UPDATE organization_members SET role = 'org_admin' WHERE organization_id = 'orgA' AND user_id = 'member'").run();
  const out = releaseWorkspaceMember(db, { userId: 'member', workspaceIds: ['wsA'] });
  assert.deepEqual(out, { canva_links: 0, cloud_folders_paused: 0, subscriptions: 0 });
  assert.equal(count('automation_subscriptions', 'workspace_id = $W', 'wsA'), 2);
});

test('dropTokenSubscriptions removes only the subscriptions that token made', () => {
  assert.equal(dropTokenSubscriptions(db, ['tok-wsA']), 1);
  assert.deepEqual(db.prepare("SELECT id FROM automation_subscriptions WHERE workspace_id = 'wsA'").all().map((r) => r.id), ['sub-wsA']);
  assert.equal(db.prepare("SELECT status FROM automation_deliveries WHERE subscription_id = 'subtok-wsA'").get().status, 'failed');
});

/* ------------------------------ the routes call them ------------------------------ */

let server, base, actingUser;
function call(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end();
  });
}
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actingUser; next(); });
  app.use('/workspaces', require('../routes/workspaces'));
  app.use('/tokens', require('../routes/tokens'));
  app.use('/admin', require('../routes/admin'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch (_) { /* */ } });

test('DELETE /api/workspaces/:id/members/:userId releases what the member set up there', async () => {
  db.prepare("UPDATE workspace_members SET role = 'workspace_admin' WHERE workspace_id = 'wsA' AND user_id = 'owner'").run();
  actingUser = { id: 'owner', role: 'user' };
  const r = await call('DELETE', '/workspaces/wsA/members/member');
  assert.equal(r.status, 200, r.body);
  assert.equal(count('canva_links', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(count('automation_subscriptions', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(db.prepare("SELECT enabled FROM cloud_folders WHERE id = 'cf-wsA'").get().enabled, 0);
});

test('DELETE /api/admin/users/:id/workspaces/:workspaceId releases what the member set up there', async () => {
  actingUser = { id: 'admin', role: 'platform_admin' };
  const r = await call('DELETE', '/admin/users/member/workspaces/wsA');
  assert.equal(r.status, 200, r.body);
  assert.equal(count('canva_links', 'workspace_id = $W', 'wsA'), 0);
  assert.equal(count('automation_subscriptions', 'workspace_id = $W', 'wsA'), 0);
});

test('DELETE /api/tokens/:id revokes the token and drops its Zapier subscriptions', async () => {
  actingUser = { id: 'member', role: 'user' };
  const r = await call('DELETE', '/tokens/tok-wsA');
  assert.equal(r.status, 200, r.body);
  assert.ok(db.prepare("SELECT revoked_at FROM api_tokens WHERE id = 'tok-wsA'").get().revoked_at);
  assert.deepEqual(db.prepare("SELECT id FROM automation_subscriptions WHERE workspace_id = 'wsA'").all().map((x) => x.id), ['sub-wsA']);
});
