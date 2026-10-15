'use strict';

/*
 * The data handling report (lib/trust/report.js) follows the RUNNING configuration; the public /trust
 * facts never carry anything sensitive; who sees which view; and "delete everything" for an org owner.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-trust-report-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-trust-report';
process.env.NODE_ENV = 'test';
for (const k of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'PEXELS_API_KEY', 'PIXABAY_API_KEY']) delete process.env[k];

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const report = require('../lib/trust/report');
const telemetry = require('../lib/telemetry');
const VERSION = require('../version');

const U = { plat: 'u-tr-plat', owner: 'u-tr-owner', admin: 'u-tr-admin', viewer: 'u-tr-viewer', other: 'u-tr-other' };
for (const [k, id] of Object.entries(U)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x',?,?)").run(id, `${k}@report.local`, k === 'plat' ? 'platform_admin' : 'user', k);
}
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-tr','Trusty Cafe',?)").run(U.owner);
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-tr2','Other Org',?)").run(U.other);
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-tr','org-tr','Main')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-tr2','org-tr2','Theirs')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-tr',?,'org_owner')").run(U.owner);
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-tr',?,'org_admin')").run(U.admin);
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-tr2',?,'org_owner')").run(U.other);
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-tr',?,'workspace_viewer')").run(U.viewer);
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-tr',?,'workspace_admin')").run(U.owner);
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-tr2',?,'workspace_admin')").run(U.other);

const app = express();
app.use(express.json());
app.use('/api/trust', requireAuth, resolveTenancy, require('../routes/trust'));
const trustRoutes = require('../routes/trust');
app.get('/api/public/trust', trustRoutes.publicJson);
app.get('/trust', trustRoutes.publicPage((req, res) => res.send('<html>trust</html>')));
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, p, who, body, ws = 'ws-tr') {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${generateToken(userRow(U[who]), ws)}`;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const int = (r, id) => r.integrations.find((i) => i.id === id);

/* ───────────── follows the running configuration ───────────── */

test('storage: the report says what STORAGE_PROVIDER says, the moment it changes', () => {
  let r = report.build({ db });
  assert.equal(r.storage.default.provider, 'local');
  assert.equal(r.residency.all_on_server, true, JSON.stringify(r.residency));
  process.env.STORAGE_PROVIDER = 's3'; process.env.S3_BUCKET = 'trusty-media-bucket'; process.env.S3_REGION = 'eu-west-2';
  process.env.S3_ENDPOINT = 'https://s3.eu-west-2.amazonaws.com';
  try {
    r = report.build({ db });
    assert.equal(r.storage.default.provider, 's3');
    assert.equal(r.storage.default.region, 'eu-west-2');
    assert.equal(r.storage.default.bucket, 'trusty-media-bucket');
    assert.equal(r.residency.all_on_server, false);
    assert.ok(r.residency.reasons.includes('storage'));
    assert.equal(int(r, 'storage').enabled, true);
  } finally { for (const k of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT']) delete process.env[k]; }
  assert.equal(report.build({ db }).storage.default.provider, 'local');
});

test('a MinIO beside the server is still "on this server\'s network"', () => {
  process.env.STORAGE_PROVIDER = 's3'; process.env.S3_BUCKET = 'b'; process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
  try { assert.equal(report.build({ db }).residency.all_on_server, true); }
  finally { for (const k of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_ENDPOINT']) delete process.env[k]; }
});

test('integrations: stock media and telemetry flip with their keys and settings', () => {
  assert.equal(int(report.build({ db }), 'stock_media').enabled, false);
  process.env.PEXELS_API_KEY = 'pexels-key-value';
  try {
    const r = report.build({ db });
    assert.equal(int(r, 'stock_media').enabled, true);
    assert.ok(!JSON.stringify(r).includes('pexels-key-value'), 'a key is never in the report');
  } finally { delete process.env.PEXELS_API_KEY; }
  telemetry.setEnabled(true);
  let t = int(report.build({ db }), 'telemetry');
  assert.equal(t.enabled, true);
  assert.deepEqual(t.hosts, ['stats.screentinker.com']);
  telemetry.setEnabled(false);
  t = int(report.build({ db }), 'telemetry');
  assert.equal(t.enabled, false);
  // Always on, and said so: the update check.
  assert.equal(int(report.build({ db }), 'updates').enabled, true);
});

test('an organization\'s integrations count only its own rows', () => {
  db.prepare("INSERT INTO alert_channels (id,workspace_id,kind,name,config,enabled) VALUES ('ac-tr2','ws-tr2','slack','x','{}',1)").run();
  db.prepare("INSERT INTO data_sources (id,workspace_id,slug,name,type,config) VALUES ('ds-tr','ws-tr','sq','Square','square','{}')").run();
  const mine = report.build({ db, orgId: 'org-tr' });
  assert.equal(int(mine, 'alert_channels').enabled, false);
  assert.equal(int(mine, 'pos_menus').count, 1);
  const theirs = report.build({ db, orgId: 'org-tr2' });
  assert.equal(int(theirs, 'alert_channels').enabled, true);
  assert.equal(int(theirs, 'pos_menus').count, 0);
  // An org that turns on Slack alerts is no longer "everything stays here".
  assert.equal(theirs.residency.all_on_server, false);
  assert.ok(theirs.residency.reasons.includes('alert_channels'));
});

test('Telegram alerts list api.telegram.org, and the ledger files its requests under alert channels', () => {
  db.prepare("INSERT INTO alert_channels (id,workspace_id,kind,name,config,enabled) VALUES ('ac-tr-tg','ws-tr2','telegram','tg','{}',1)").run();
  try {
    const a = int(report.build({ db, orgId: 'org-tr2' }), 'alert_channels');
    assert.equal(a.enabled, true);
    assert.ok(a.hosts.includes('api.telegram.org'), JSON.stringify(a.hosts));
    assert.equal(a.detail.kinds.telegram, 1);
    assert.equal(require('../lib/trust/features').featureForHost('api.telegram.org'), 'alert_channels');
  } finally { db.prepare("DELETE FROM alert_channels WHERE id = 'ac-tr-tg'").run(); }
});

test('encryption at rest lists the encrypted columns from the schema itself', () => {
  const r = report.build({ db });
  assert.ok(r.encryption.encrypted_columns.includes('storage_profiles.credentials_enc'));
  assert.ok(r.encryption.encrypted_columns.includes('users.totp_secret_enc'));
  assert.equal(r.encryption.secrets_at_rest, 'aes-256-gcm');
});

test('retention reflects the configured horizons', () => {
  const r = report.build({ db });
  const pop = r.retention.find((x) => x.id === 'proof_of_play');
  assert.equal(pop.days, config.playLogRetentionDays);
});

/* ───────────── who sees what ───────────── */

test('instance view: platform admins only; org view: owners and admins only; viewers neither', async () => {
  assert.equal((await call('GET', '/api/trust/report?scope=instance', 'plat')).status, 200);
  assert.equal((await call('GET', '/api/trust/report?scope=instance', 'owner')).status, 403);
  const org = await call('GET', '/api/trust/report', 'admin');
  assert.equal(org.status, 200);
  assert.equal(org.json.scope, 'organization');
  assert.equal(org.json.organization.name, 'Trusty Cafe');
  assert.equal(org.json.database.path, undefined, 'an org admin is not told the server\'s file paths');
  assert.equal((await call('GET', '/api/trust/report', 'viewer')).status, 403);
  assert.equal((await call('GET', '/api/trust/outbound', 'viewer')).status, 403);
  assert.equal((await call('GET', '/api/trust/outbound?scope=instance', 'admin')).status, 403);
});

test('⚠️ the org ledger view shows only hosts contacted on that organization\'s behalf', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const ins = db.prepare('INSERT INTO outbound_ledger (day,host,feature,category,scope,workspace_id,organization_id,count,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,1,1,1)');
  ins.run(day, 'mine.example', 'data_sources', 'data', 'internet', 'ws-tr', 'org-tr');
  ins.run(day, 'theirs-private.example', 'data_sources', 'data', 'internet', 'ws-tr2', 'org-tr2');
  ins.run(day, 'ghcr.io', 'updates', 'platform', 'internet', '', '');
  const mine = await call('GET', '/api/trust/outbound?days=30', 'admin');
  assert.deepEqual(mine.json.rows.map((r) => r.host), ['mine.example']);
  const all = await call('GET', '/api/trust/outbound?days=90&scope=instance', 'plat');
  assert.deepEqual(all.json.rows.map((r) => r.host).sort(), ['ghcr.io', 'mine.example', 'theirs-private.example']);
  assert.equal(all.json.days, 90);
});

/* ───────────── the public page ───────────── */

test('the public page is off by default and only a platform admin can switch it on', async () => {
  assert.equal((await call('GET', '/api/public/trust', null)).status, 404);
  assert.equal((await call('GET', '/trust', null)).status, 404);
  assert.equal((await call('PUT', '/api/trust/public', 'owner', { enabled: true })).status, 403);
  const on = await call('PUT', '/api/trust/public', 'plat', { enabled: true });
  assert.equal(on.json.enabled, true);
  assert.equal((await call('GET', '/trust', null)).status, 200);
  assert.equal((await call('GET', '/api/public/trust', null)).status, 200);
});

test('⚠️ the public facts never carry anything sensitive', async () => {
  process.env.STORAGE_PROVIDER = 's3'; process.env.S3_BUCKET = 'secret-bucket-name'; process.env.S3_REGION = 'eu-central-1';
  process.env.S3_ENDPOINT = 'https://private-endpoint.internal.example'; process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLEKEY'; process.env.S3_SECRET_ACCESS_KEY = 'SECRETACCESS';
  process.env.PEXELS_API_KEY = 'pexels-public-leak';
  try {
    const r = await call('GET', '/api/public/trust', null);
    assert.equal(r.status, 200);
    const text = r.text;
    for (const leak of ['secret-bucket-name', 'private-endpoint', 'AKIAEXAMPLEKEY', 'SECRETACCESS', 'pexels-public-leak', config.dbPath,
      config.dataDir, 'Trusty Cafe', 'Other Org', '@report.local', 'mine.example', 'theirs-private', VERSION]) {
      assert.ok(!text.includes(leak), `public page leaked ${leak}`);
    }
    // Structural: none of these keys may appear anywhere in the public JSON.
    const banned = new Set(['path', 'bucket', 'endpoint', 'endpoint_host', 'hosts', 'host', 'version', 'email', 'dir', 'members', 'count',
      'organization', 'encrypted_columns', 'local_dir', 'files', 'profiles', 'detail', 'requests', 'internet_hosts']);
    const walk = (o, at) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) { assert.ok(!banned.has(k), `public key ${at}.${k}`); walk(v, `${at}.${k}`); }
    };
    walk(r.json, '$');
    assert.equal(r.json.storage.provider, 's3');
    assert.equal(r.json.storage.region, 'eu-central-1', 'the region is a residency fact procurement needs');
  } finally {
    for (const k of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'PEXELS_API_KEY']) delete process.env[k];
  }
  await call('PUT', '/api/trust/public', 'plat', { enabled: false });
  assert.equal((await call('GET', '/api/public/trust', null)).status, 404);
});

/* ───────────── delete everything ───────────── */

test('delete everything: only the owner, only with the exact name, once; cancellable', async () => {
  assert.equal((await call('POST', '/api/trust/org-deletion', 'admin', { confirm_name: 'Trusty Cafe', understand: true })).status, 403);
  assert.equal((await call('POST', '/api/trust/org-deletion', 'viewer', { confirm_name: 'Trusty Cafe', understand: true })).status, 403);
  assert.equal((await call('POST', '/api/trust/org-deletion', 'owner', { confirm_name: 'trusty cafe', understand: true })).status, 400);
  assert.equal((await call('POST', '/api/trust/org-deletion', 'owner', { confirm_name: 'Trusty Cafe' })).status, 400);
  const ok = await call('POST', '/api/trust/org-deletion', 'owner', { confirm_name: 'Trusty Cafe', understand: true });
  assert.equal(ok.status, 202);
  assert.ok(ok.json.execute_after > Date.now() / 1000 + 13 * 86400);
  assert.equal((await call('POST', '/api/trust/org-deletion', 'owner', { confirm_name: 'Trusty Cafe', understand: true })).status, 409);
  const st = await call('GET', '/api/trust/org-deletion', 'admin');
  assert.equal(st.json.scheduled, true);
  // Nothing is deleted during the grace period.
  assert.deepEqual(require('../lib/trust/org-deletion').sweep({ db }), []);
  assert.ok(db.prepare("SELECT 1 FROM organizations WHERE id = 'org-tr'").get());
  assert.equal((await call('DELETE', '/api/trust/org-deletion', 'admin')).status, 403);
  assert.equal((await call('DELETE', '/api/trust/org-deletion', 'owner')).status, 200);
  assert.equal((await call('GET', '/api/trust/org-deletion', 'owner')).json.scheduled, false);
  const acts = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'trust.org_deletion%'").all().map((r) => r.action);
  assert.deepEqual(acts.sort(), ['trust.org_deletion_cancelled', 'trust.org_deletion_scheduled']);
});

test('after the grace period the organization and its data are gone; the other organization is untouched', async () => {
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('pl-tr',?, 'ws-tr','Doomed')").run(U.owner);
  const ok = await call('POST', '/api/trust/org-deletion', 'owner', { confirm_name: 'Trusty Cafe', understand: true });
  assert.equal(ok.status, 202);
  db.prepare("UPDATE org_deletion_requests SET execute_after = 1 WHERE organization_id = 'org-tr'").run();
  const done = require('../lib/trust/org-deletion').sweep({ db, unlink: () => {} });
  assert.deepEqual(done, ['org-tr']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE id = 'org-tr'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'ws-tr'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE id = 'pl-tr'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbound_ledger WHERE organization_id = 'org-tr'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE id = 'org-tr2'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(U.admin).n, 1, 'member accounts survive');
  const audit = db.prepare("SELECT details FROM activity_log WHERE action = 'trust.org_deleted'").get();
  assert.ok(audit && audit.details.includes('Trusty Cafe'));
});

/* ───────────── every computed label exists in English ───────────── */

test('every integration, feature and retention id the page renders has an English label', () => {
  const en = fs.readFileSync(require('path').join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const has = (k) => en.includes(`'${k}':`);
  for (const i of require('../lib/trust/integrations').INTEGRATIONS) {
    assert.ok(has(`trust.int.${i.id}`), `trust.int.${i.id}`);
    assert.ok(has(`trust.int.${i.id}.sends`), `trust.int.${i.id}.sends`);
  }
  for (const f of Object.keys(require('../lib/trust/features').FEATURES)) assert.ok(has(`trust.feature.${f}`), `trust.feature.${f}`);
  for (const r of report.build({ db }).retention) assert.ok(has(`trust.ret.${r.id}`), `trust.ret.${r.id}`);
});
