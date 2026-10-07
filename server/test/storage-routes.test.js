'use strict';

/*
 * /api/storage-profiles, in process, with the tenancy fields set the way resolveTenancy sets them
 * (the JWT-only firewall for this mount is covered by test/api.test.js, which reads the same
 * config/api-surface.js list server.js mounts from).
 *
 *   - secrets never come back: not on POST, not on GET, not in the list
 *   - SSRF at save: metadata refused always; loopback refused without the opt-in; on a HOSTED
 *     instance only a platform admin may grant the opt-in
 *   - org admin only; org B cannot see org A's profile
 *   - import by reference never puts and never deletes
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storage-routes-' + crypto.randomBytes(4).toString('hex'));
delete process.env.SELF_HOSTED;            // a HOSTED instance: the stricter rules apply
process.env.NODE_ENV = 'test';
delete process.env.STORAGE_PROVIDER;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const storage = require('../lib/storage');
const { installMemoryBackends } = require('./helpers/storage-memory');

const id = () => crypto.randomUUID();
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEYID = 'AKIAIOSFODNN7EXAMPLE';
let server, base, reg, userId, orgA, orgB, wsA, wsB;

// Who is calling: resolveTenancy's output, chosen per request by a test header.
const CALLERS = {};
before(async () => {
  userId = id(); orgA = id(); orgB = id(); wsA = id(); wsB = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `r-${userId}@e.test`, 'R', 'x');
  for (const o of [orgA, orgB]) db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(o, 'Org', userId);
  for (const [w, o] of [[wsA, orgA], [wsB, orgB]]) db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, o, 'W');
  Object.assign(CALLERS, {
    adminA: { organizationId: orgA, workspaceId: wsA, orgRole: 'org_admin' },
    adminB: { organizationId: orgB, workspaceId: wsB, orgRole: 'org_admin' },
    editorA: { organizationId: orgA, workspaceId: wsA, orgRole: null, workspaceRole: 'workspace_editor' },
    platform: { organizationId: orgA, workspaceId: wsA, orgRole: null, isPlatformAdmin: true, isPlatformStaff: true },
  });
  reg = installMemoryBackends(storage);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { Object.assign(req, { user: { id: userId } }, CALLERS[req.headers['x-who']] || {}); next(); });
  app.use('/api/storage-profiles', require('../routes/storage-profiles'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { storage._setBackendFactory(null); server && server.close(); });

async function call(who, method, p, body) {
  const r = await fetch(base + '/api/storage-profiles' + p, {
    method, headers: { 'content-type': 'application/json', 'x-who': who }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

const s3Body = (extra = {}) => ({ name: `p-${id().slice(0, 6)}`, provider: 's3', bucket: 'media', region: 'eu-west-1', credentials: { accessKeyId: KEYID, secretAccessKey: SECRET }, ...extra });

test('secret redaction: POST and GET return configured + a 4-char hint, never the key', async () => {
  const created = await call('adminA', 'POST', '/', s3Body());
  assert.equal(created.status, 201, created.text);
  assert.ok(!created.text.includes(SECRET) && !created.text.includes(KEYID));
  assert.equal(created.body.configured, true);
  assert.equal(created.body.hint, 'MPLE');
  const one = await call('adminA', 'GET', `/${created.body.id}`);
  assert.ok(!one.text.includes(SECRET) && !one.text.includes(KEYID));
  const list = await call('adminA', 'GET', '/');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(SECRET) && !list.text.includes(KEYID));
  assert.ok(list.body.profiles.some((p) => p.id === 'local'), 'local disk is always listed');
  // Stored encrypted, not in the clear.
  const row = db.prepare('SELECT credentials_enc FROM storage_profiles WHERE id = ?').get(created.body.id);
  assert.ok(row.credentials_enc && !row.credentials_enc.includes(SECRET));
});

test('an update without credentials keeps the stored ones', async () => {
  const created = await call('adminA', 'POST', '/', s3Body());
  const before = db.prepare('SELECT credentials_enc FROM storage_profiles WHERE id = ?').get(created.body.id).credentials_enc;
  const upd = await call('adminA', 'PUT', `/${created.body.id}`, { name: 'renamed', read_priority: 5 });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.body.name, 'renamed');
  assert.equal(db.prepare('SELECT credentials_enc FROM storage_profiles WHERE id = ?').get(created.body.id).credentials_enc, before);
});

test('SSRF at save: the metadata endpoint is refused, even for a platform admin with the opt-in', async () => {
  const r = await call('platform', 'POST', '/', s3Body({ endpoint: 'http://169.254.169.254', allow_private: true }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not allowed/);
});

test('SSRF at save: loopback is refused without the opt-in; a tenant on a hosted instance cannot grant it', async () => {
  const plain = await call('adminA', 'POST', '/', s3Body({ endpoint: 'http://127.0.0.1:9000' }));
  assert.equal(plain.status, 400);
  const tenant = await call('adminA', 'POST', '/', s3Body({ endpoint: 'http://127.0.0.1:9000', allow_private: true }));
  assert.equal(tenant.status, 403);
  const op = await call('platform', 'POST', '/', s3Body({ endpoint: 'http://127.0.0.1:9000', allow_private: true }));
  assert.equal(op.status, 201, op.text);
  assert.equal(op.body.allow_private, true);
  assert.equal(op.body.force_path_style, null, 'path style is derived (true) at connect time when unset');
});

test('org admin only, and org B never sees org A\'s profile', async () => {
  const created = await call('adminA', 'POST', '/', s3Body());
  assert.equal((await call('editorA', 'GET', '/')).status, 403);
  assert.equal((await call('editorA', 'POST', '/', s3Body())).status, 403);
  assert.equal((await call('adminB', 'GET', `/${created.body.id}`)).status, 404);
  assert.equal((await call('adminB', 'POST', `/${created.body.id}/test`)).status, 404);
  assert.equal((await call('adminB', 'POST', `/${created.body.id}/migrate`)).status, 404);
  const listB = await call('adminB', 'GET', '/');
  assert.ok(!listB.body.profiles.some((p) => p.id === created.body.id));
});

test('import by reference: head + a ranged sniff only — never put, never delete', async () => {
  const created = await call('adminA', 'POST', '/', s3Body({ mode: 'ro' }));
  assert.equal(created.body.manage_scope, 'none', 'a read-only profile manages nothing');
  const be = storage.backendFor(storage.getProfile(created.body.id));
  const mem = reg.get(created.body.id);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  mem.objects.set('brand/logo.png', { body: PNG, contentType: 'image/png' });
  mem.objects.set('brand/notes.txt', { body: Buffer.from('hello'), contentType: 'text/plain' });
  mem.calls.length = 0;

  const r = await call('adminA', 'POST', `/${created.body.id}/import`, { keys: ['brand/logo.png', 'brand/notes.txt', '../escape.png'], mode: 'reference' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.imported.length, 1);
  assert.equal(r.body.errors.length, 2, 'a non-media key and a traversal key are refused');
  const row = r.body.imported[0];
  assert.equal(row.mime_type, 'image/png');
  assert.equal(row.file_size, PNG.length);
  const loc = db.prepare('SELECT * FROM content_locations WHERE content_id = ?').get(row.id);
  assert.equal(loc.object_key, 'brand/logo.png');
  assert.equal(loc.owned, 0);
  await new Promise((res) => setTimeout(res, 300));   // the background thumbnail job may read the object
  assert.equal(mem.ops('put').length, 0, 'never put to the attached bucket');
  assert.equal(mem.ops('delete').length, 0, 'never deleted from it');
  const ranged = mem.ops('get').filter((g) => g.range);
  assert.ok(ranged.length >= 1 && ranged[0].range.start === 0, 'the type was sniffed from a ranged GET');
  assert.ok(be);
});

test('list caps a page at 200 and refuses a traversal prefix', async () => {
  const created = await call('adminA', 'POST', '/', s3Body({ mode: 'ro' }));
  const ok = await call('adminA', 'GET', `/${created.body.id}/objects?prefix=brand/&limit=5000`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(reg.get(created.body.id).ops('list').at(-1).limit, 200, 'the backend was asked for at most 200');
  const bad = await call('adminA', 'GET', `/${created.body.id}/objects?prefix=../`);
  assert.equal(bad.status, 400);
});

test('test connection distinguishes failures and never echoes a secret', async () => {
  const created = await call('adminA', 'POST', '/', s3Body());
  const mem = (storage.backendFor(storage.getProfile(created.body.id)), reg.get(created.body.id));
  mem.down = true;
  const r = await call('adminA', 'POST', `/${created.body.id}/test`);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'network');
  assert.ok(!r.text.includes(SECRET));
  mem.down = false;
  const ok = await call('adminA', 'POST', `/${created.body.id}/test`);
  assert.equal(ok.body.ok, true);
});

test('a profile that still holds copies cannot be deleted', async () => {
  const created = await call('adminA', 'POST', '/', s3Body());
  const cid = id();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?,?,?,?,?,?)`).run(cid, userId, wsA, 'x', 'x.png', 'image/png');
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key) VALUES (?, 'asset', ?, 'st/x')`).run(cid, created.body.id);
  assert.equal((await call('adminA', 'DELETE', `/${created.body.id}`)).status, 409);
  db.prepare('DELETE FROM content_locations WHERE content_id = ?').run(cid);
  assert.equal((await call('adminA', 'DELETE', `/${created.body.id}`)).status, 200);
});
