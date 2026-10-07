'use strict';

/*
 * The S3 backend and the rules that make S3-COMPATIBLE stores work. No network: the SDK client is
 * mocked or merely constructed, and the presigner is compared against the SDK's own.
 *
 *   ⚠️ WHEN_REQUIRED on both checksum settings, every client — or MinIO/R2/B2/Spaces reject PUTs
 *   ⚠️ path-style when a custom endpoint is set; virtual-hosted for AWS
 *   ⚠️ a presign never names the INTERNAL endpoint; no public endpoint -> the origin proxy
 *   ⚠️ Range is forwarded to the store, and the proxy answers 206
 *   ⚠️ SSRF: metadata always refused; loopback only with the per-profile opt-in
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storage-s3-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.STORAGE_PROVIDER;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Readable } = require('node:stream');
const { db } = require('../db/database');
const storage = require('../lib/storage');
const locations = require('../lib/storage/locations');
const { S3Backend, buildS3ClientConfig } = require('../lib/storage/s3');
const { checkEndpoint } = require('../lib/storage/endpoint-guard');
const { serveFromStorage } = require('../lib/storage/serve');
const { installMemoryBackends } = require('./helpers/storage-memory');

const CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const id = () => crypto.randomUUID();

test('S3 client: WHEN_REQUIRED checksums on every client, path-style when an endpoint is set', () => {
  const minio = buildS3ClientConfig({ id: 'p', bucket: 'b', endpoint: 'http://minio:9000', credentials: CREDS });
  assert.equal(minio.requestChecksumCalculation, 'WHEN_REQUIRED');
  assert.equal(minio.responseChecksumValidation, 'WHEN_REQUIRED');
  assert.equal(minio.forcePathStyle, true);
  assert.equal(minio.endpoint, 'http://minio:9000');
  assert.equal(minio.region, 'us-east-1', 'region defaults even when the store ignores it');

  const aws = buildS3ClientConfig({ id: 'p', bucket: 'b', region: 'eu-west-1', credentials: CREDS });
  assert.equal(aws.forcePathStyle, false, 'AWS with no endpoint stays virtual-hosted');
  assert.equal(aws.endpoint, undefined);
  assert.equal(aws.requestChecksumCalculation, 'WHEN_REQUIRED');

  const r2 = buildS3ClientConfig({ id: 'p', bucket: 'b', endpoint: 'https://abc123.r2.cloudflarestorage.com', credentials: CREDS });
  assert.equal(r2.region, 'auto');

  const explicit = buildS3ClientConfig({ id: 'p', bucket: 'b', endpoint: 'https://s3.example.com', force_path_style: 0, credentials: CREDS });
  assert.equal(explicit.forcePathStyle, false, 'an explicit setting wins');
});

test('the constructed SDK client carries those settings (no request is sent)', async () => {
  const be = new S3Backend({ id: 'p', bucket: 'b', endpoint: 'http://minio:9000', credentials: CREDS });
  const client = be.client;
  assert.equal(await client.config.requestChecksumCalculation(), 'WHEN_REQUIRED');
  assert.equal(await client.config.responseChecksumValidation(), 'WHEN_REQUIRED');
  assert.equal(client.config.forcePathStyle, true);
});

test('our synchronous presign is byte-identical to @aws-sdk/s3-request-presigner', async () => {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const date = new Date('2026-10-06T12:00:00Z');
  const key = 'st/org/ws/a b(1)!.mp4';
  for (const p of [
    { id: 'aws', bucket: 'my-bucket', region: 'eu-west-1', credentials: CREDS },
    { id: 'pub', bucket: 'media', endpoint: 'http://minio:9000', public_endpoint: 'https://s3.example.com', credentials: CREDS },
  ]) {
    const mine = new S3Backend(p).presignGet(key, { expiresSec: 900, contentType: 'video/mp4', now: date });
    const cfg = buildS3ClientConfig({ ...p, endpoint: p.public_endpoint || p.endpoint });
    delete cfg.requestHandler;
    const sdk = await getSignedUrl(new S3Client(cfg), new GetObjectCommand({ Bucket: p.bucket, Key: key, ResponseContentType: 'video/mp4' }), { expiresIn: 900, signingDate: date });
    assert.equal(mine, sdk, p.id);
  }
});

test('⚠️ a presign never names the internal endpoint: custom endpoint with no public one -> null', () => {
  const internal = new S3Backend({ id: 'p', bucket: 'b', endpoint: 'http://minio:9000', credentials: CREDS });
  assert.equal(internal.presignGet('st/x.mp4'), null);
  const pub = new S3Backend({ id: 'p', bucket: 'b', endpoint: 'http://minio:9000', public_endpoint: 'https://media.example.com', credentials: CREDS });
  const url = pub.presignGet('st/x.mp4');
  assert.match(url, /^https:\/\/media\.example\.com\/b\/st\/x\.mp4\?/);
  assert.ok(!url.includes('minio'));
  const cdn = new S3Backend({ id: 'p', bucket: 'b', endpoint: 'http://minio:9000', public_base_url: 'https://cdn.example.com/', credentials: CREDS });
  assert.equal(cdn.presignGet('st/x.mp4'), 'https://cdn.example.com/st/x.mp4');
});

test('S3 getStream forwards Range to the store and reports the partial answer', async () => {
  const sent = [];
  const be = new S3Backend({ id: 'p', bucket: 'b', endpoint: 'http://minio:9000', credentials: CREDS }, {
    clientFactory: () => ({
      send: async (cmd) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        return { Body: Readable.from([Buffer.alloc(10, 1)]), ContentLength: 10, ContentRange: 'bytes 10-19/100', ContentType: 'video/mp4' };
      },
    }),
  });
  const out = await be.getStream('st/x.mp4', { range: { start: 10, end: 19 } });
  assert.equal(sent[0].name, 'GetObjectCommand');
  assert.equal(sent[0].input.Range, 'bytes=10-19');
  assert.deepEqual([out.start, out.end, out.size, out.partial], [10, 19, 100, true]);
  await be.getStream('st/x.mp4', { range: { start: null, end: null, suffix: 500 } });
  assert.equal(sent[1].input.Range, 'bytes=-500');
});

/* ─────────── selection + proxy against a seeded row (memory backends) ─────────── */

let orgId, wsId, userId, server, base, reg;
const PROFILES = {};

before(async () => {
  userId = id(); orgId = id(); wsId = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `s3-${userId}@e.test`, 'S', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(orgId, 'Org', userId);
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(wsId, orgId, 'W');
  for (const [name, endpoint, publicEndpoint] of [['internal', 'http://minio:9000', null], ['public', 'http://minio:9000', 'https://media.example.com']]) {
    const pid = id();
    db.prepare(`INSERT INTO storage_profiles (id, org_id, name, provider, bucket, endpoint, public_endpoint, mode) VALUES (?, ?, ?, 's3', 'b', ?, ?, 'rw')`).run(pid, orgId, name, endpoint, publicEndpoint);
    PROFILES[name] = pid;
  }
  reg = installMemoryBackends(storage, { [PROFILES.public]: { presignBase: 'https://media.example.com/b' } });

  const app = express();
  app.get('/f/:id', (req, res) => serveFromStorage(req, res, db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id), 'asset'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { storage._setBackendFactory(null); server && server.close(); });

function seed(profileName, bytes = Buffer.from('0123456789abcdefghij')) {
  const cid = id();
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const key = storage.keys.asset(orgId, wsId, digest, '.mp4');
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, byte_digest) VALUES (?,?,?,?,?,?,?,?)`)
    .run(cid, userId, wsId, 'clip.mp4', `${id()}.mp4`, 'video/mp4', bytes.length, digest);
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, byte_digest, size) VALUES (?, 'asset', ?, ?, 'primary', 'ready', ?, ?)`)
    .run(cid, PROFILES[profileName], key, digest, bytes.length);
  storage.backendFor(storage.getProfile(PROFILES[profileName])); // materialise the memory backend
  reg.get(PROFILES[profileName]).objects.set(key, { body: bytes, contentType: 'video/mp4' });
  return db.prepare('SELECT * FROM content WHERE id = ?').get(cid);
}

test('presign vs proxy: no public endpoint -> origin URL; public endpoint -> presign', () => {
  process.env.APP_URL = 'https://signage.example.com';
  try {
    const a = seed('internal');
    const pa = locations.pickForPlayer(a, 'asset');
    assert.equal(pa.via, 'proxy');
    assert.equal(pa.url, `https://signage.example.com/api/content/${a.id}/file`);

    const b = seed('public');
    const pb = locations.pickForPlayer(b, 'asset');
    assert.equal(pb.via, 'presign');
    assert.match(pb.url, /^https:\/\/media\.example\.com\/b\/st\//);

    // A device (or workspace) that may not fetch external URLs gets the origin instead.
    const pd = locations.pickForPlayer(b, 'asset', { device: { workspace_id: wsId, storage_direct_fetch: 0 } });
    assert.equal(pd.via, 'proxy');
  } finally { delete process.env.APP_URL; }
});

test('presigned URLs are stable inside a signing window (no new URL per payload build)', () => {
  const b = seed('public');
  const t = Date.UTC(2026, 9, 6, 12, 0, 0);
  const u1 = locations.pickForPlayer(b, 'asset', { nowMs: t }).url;
  const u2 = locations.pickForPlayer(b, 'asset', { nowMs: t + 60 * 1000 }).url;
  assert.equal(u1, u2);
});

test('the proxy forwards Range, answers 206 with Content-Range and Accept-Ranges', async () => {
  const row = seed('internal', Buffer.from('0123456789abcdefghij'));
  const r = await fetch(`${base}/f/${row.id}`, { headers: { Range: 'bytes=5-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 5-9/20');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(await r.text(), '56789');
  const mem = reg.get(PROFILES.internal);
  const got = mem.ops('get').at(-1);
  assert.deepEqual([got.range.start, got.range.end], [5, 9], 'the Range reached the backend');

  const full = await fetch(`${base}/f/${row.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('etag'), `"${row.byte_digest}"`);
  assert.equal(await full.text(), '0123456789abcdefghij');
});

test('every copy unreadable -> the same 404 a player already handles', async () => {
  const row = seed('internal');
  reg.get(PROFILES.internal).objects.clear();
  const r = await fetch(`${base}/f/${row.id}`);
  assert.equal(r.status, 404);
});

/* ─────────── SSRF ─────────── */

test('SSRF: the metadata endpoint is refused, even with the private-network opt-in', async () => {
  await assert.rejects(checkEndpoint('http://169.254.169.254'), { name: 'SsrfError' });
  await assert.rejects(checkEndpoint('http://169.254.169.254', { allowPrivate: true }), { name: 'SsrfError' });
  await assert.rejects(checkEndpoint('http://[fd00:ec2::254]', { allowPrivate: true }), { name: 'SsrfError' });
  await assert.rejects(checkEndpoint('http://[fe80::1]:9000', { allowPrivate: true }), { name: 'SsrfError' });
});

test('SSRF: http://127.0.0.1:9000 is refused unless the profile opts into loopback', async () => {
  await assert.rejects(checkEndpoint('http://127.0.0.1:9000'), { name: 'SsrfError' });
  await assert.doesNotReject(checkEndpoint('http://127.0.0.1:9000', { allowPrivate: true }));
  await assert.rejects(checkEndpoint('http://user:pw@s3.example.com'), { name: 'SsrfError' });
  await assert.rejects(checkEndpoint('file:///etc/passwd'), { name: 'SsrfError' });
});

test('SSRF at connect time: the guarded lookup refuses a name that resolves to loopback', async () => {
  const { guardedLookup } = require('../lib/storage/endpoint-guard');
  const err = await new Promise((resolve) => guardedLookup({ allowPrivate: false })('localhost', {}, (e) => resolve(e)));
  assert.ok(err, 'localhost must not be connectable without the opt-in');
  const ok = await new Promise((resolve) => guardedLookup({ allowPrivate: true })('127.0.0.1', {}, (e, addr) => resolve(e || addr)));
  assert.equal(ok, '127.0.0.1');
});

test('SSRF at request time: a literal-IP endpoint is vetted per request (Node skips lookup for literals)', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(404); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}`;
  try {
    const refused = new S3Backend({ id: 'lit1', bucket: 'b', endpoint, credentials: CREDS });
    await assert.rejects(refused.head('st/x.mp4'), { code: 'ssrf' });
    assert.equal(hits, 0, 'nothing reached the loopback server');
    const allowed = new S3Backend({ id: 'lit2', bucket: 'b', endpoint, allow_private: 1, credentials: CREDS });
    assert.equal(await allowed.head('st/x.mp4'), null);
    assert.ok(hits >= 1);
  } finally { srv.close(); }
});
