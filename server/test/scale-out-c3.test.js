'use strict';

/*
 * Scale-out C3 — the replica content cache (docs/scale-out-design.md §6a). Unit half: the cache
 * module against a real schema with a fake primary (fetchImpl). The two-process half is in
 * scale-out-c3-e2e.test.js.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-c3-'));
process.env.DATA_DIR = path.join(TMP, 'unit');
process.env.SELF_HOSTED = 'true'; process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'c3-' + crypto.randomBytes(4).toString('hex');
process.env.PRIMARY_URL = 'http://primary.test:1';   // never dialled: fetchImpl is a fake
process.env.REPLICA_CACHE_BYTES = '3000';            // tiny, so eviction is testable
const { db } = require('../db/database');
const config = require('../config');
const cache = require('../lib/mesh/content-cache');
const capabilities = require('../lib/mesh/capabilities');
const replicaProxy = require('../lib/replica-proxy');
const uid = () => crypto.randomUUID();
const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------ fixtures ------------------------------ */

const userId = uid(), orgId = uid(), copiedWs = uid(), ownWs = uid();
const ORIGIN = 'primary-' + crypto.randomBytes(3).toString('hex');
db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'o', 'h', 'platform_admin')").run(userId, `o-${userId.slice(0, 6)}@x.local`);
db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, 'A', ?, 'free')").run(orgId, userId);
db.prepare("INSERT INTO workspaces (id, organization_id, name, origin_node_id) VALUES (?, ?, 'copy', ?)").run(copiedWs, orgId, ORIGIN);
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'mine')").run(ownWs, orgId);
const EDGE = uid();
function setEdge(caps) {
  db.prepare('DELETE FROM mesh_edges WHERE id = ?').run(EDGE);
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories, transport_direction, tls_verify, created_at, token_hash, token_expires_at)
              VALUES (?, ?, 'down', ?, ?, 'they-dial', 1, ?, 'h', ?)`)
    .run(EDGE, ORIGIN, JSON.stringify(caps), JSON.stringify(['workspace-replication']), nowSec(), nowSec() + 3600);
}
/** A copied content row with fake bytes the fake primary will serve. */
const PRIMARY_FILES = new Map();   // name -> Buffer
function contentRow(ws, bytes, { thumb = true, digest = true } = {}) {
  const id = uid();
  const name = `${id}.png`;
  const buf = Buffer.from(bytes);
  PRIMARY_FILES.set(name, buf);
  const tn = thumb ? `thumb_${name}` : null;
  if (tn) PRIMARY_FILES.set(tn, Buffer.from('T' + bytes.slice(0, 4)));
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, thumbnail_path, mime_type, file_size, byte_digest)
              VALUES (?, ?, ?, 'slide.png', ?, ?, 'image/png', ?, ?)`)
    .run(id, userId, ws, name, tn, buf.length, digest ? crypto.createHash('sha256').update(buf).digest('hex') : null);
  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}
const urls = [];
let primaryUp = true;
const fetchImpl = async (url, opts = {}) => {
  urls.push(url);
  if (!primaryUp) throw new Error('ECONNREFUSED');
  const name = decodeURIComponent(String(url).split('/').pop());
  const buf = PRIMARY_FILES.get(name);
  if (!buf) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  // The puller streams with res.body; give it a web ReadableStream like fetch would.
  const { Readable } = require('node:stream');
  const range = opts.headers && opts.headers.Range;
  const from = range ? Number(range.replace(/bytes=(\d+)-/, '$1')) : 0;
  const slice = buf.subarray(from);
  return {
    ok: true, status: from ? 206 : 200,
    headers: { get: (h) => (h === 'etag' ? '"e1"' : null) },
    body: Readable.toWeb(Readable.from([slice])),
    arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
  };
};
const local = (name) => path.join(config.contentDir, name);
const cacheRows = () => db.prepare('SELECT * FROM mesh_content_cache ORDER BY fetched_at').all();

/* ------------------------------ tests ------------------------------ */

test('caches-content is a capability that needs serves-dashboard; the grant that authorises the bytes is workspace-replication', () => {
  assert.equal(capabilities.validateCapabilities(['caches-content'], { acceptEnrollment: true }).ok, false);
  assert.equal(capabilities.validateCapabilities(['serves-dashboard', 'caches-content'], { acceptEnrollment: true }).ok, true);
  setEdge(['serves-dashboard', 'caches-content']);
  db.prepare("UPDATE mesh_edges SET grant_categories = ? WHERE id = ?").run(JSON.stringify(['health']), EDGE);
  const row = contentRow(copiedWs, 'no-grant');
  assert.equal(cache.edgeForContent(db, row), null, 'no workspace-replication -> nothing to cache from');
  db.prepare("UPDATE mesh_edges SET grant_categories = ? WHERE id = ?").run(JSON.stringify(['workspace-replication']), EDGE);
  assert.ok(cache.edgeForContent(db, row));
  assert.equal(cache.edgeForContent(db, contentRow(ownWs, 'own')), null, 'this node\'s own content is never "cached"');
});

test('test_replica_cache_absent_on_a_stock_install: no edge -> no worker, no files, and a C1 edge fetches through but stores nothing', async () => {
  setEdge(['serves-dashboard']);   // C1 shape
  cache.attach({ db, config, fetchImpl });
  assert.equal(cache.isWorkerRunning(), false, 'attach creates no timer');
  cache.onApplied([copiedWs]);
  assert.equal(cache.isWorkerRunning(), false, 'rows landing in a copied workspace start nothing without the role');
  const row = contentRow(copiedWs, 'c1-bytes');
  const r = await cache.ensure(db, config, row, { fetchImpl });
  assert.equal(r.ok, false); assert.equal(r.reason, 'not cacheable');
  assert.ok(!fs.existsSync(local(row.filepath)));
  assert.equal(cacheRows().length, 0);
  assert.deepEqual(cache.status(db, config), [], 'nothing to report on a node that caches nothing');
  cache.detach();
});

test('hit serves local; miss with the primary up fetches, verifies, stores — and only from PRIMARY_URL (I9)', async () => {
  setEdge(['serves-dashboard', 'caches-content']);
  urls.length = 0;
  const row = contentRow(copiedWs, 'hello-bytes-1');
  const miss = await cache.ensure(db, config, row, { fetchImpl });
  assert.deepEqual(miss, { ok: true, hit: false });
  assert.equal(fs.readFileSync(local(row.filepath), 'utf8'), 'hello-bytes-1');
  assert.ok(fs.existsSync(local(row.thumbnail_path)), 'thumbnail beside it');
  const hit = await cache.ensure(db, config, row, { fetchImpl });
  assert.deepEqual(hit, { ok: true, hit: true });
  assert.equal(urls.length, 2, 'the file and its thumbnail, once each; a hit dials nothing');
  for (const u of urls) assert.ok(u.startsWith(`${config.primaryUrl}/uploads/content/`), `origin is PRIMARY_URL only: ${u}`);
  const entry = db.prepare('SELECT * FROM mesh_content_cache WHERE content_id = ?').get(row.id);
  assert.equal(entry.edge_id, EDGE); assert.equal(entry.filename, row.filepath);
  assert.ok(entry.bytes >= 13);
  // A tampered body is discarded: the sha256 on the row is the truth. ONE byte flipped, same length.
  const bad = contentRow(copiedWs, 'genuine-bytes');
  const flipped = Buffer.from('genuine-bytes'); flipped[5] ^= 0x01;
  PRIMARY_FILES.set(bad.filepath, flipped);
  const r = await cache.ensure(db, config, bad, { fetchImpl });
  assert.equal(r.ok, false); assert.match(r.reason, /digest/);
  assert.ok(!fs.existsSync(local(bad.filepath)), 'nothing on disk for a mismatch');
  assert.ok(!fs.existsSync(local(bad.filepath) + '.part'), 'no partial left behind');
});

test('test_replica_cache_never_invents_a_file: a miss with the primary down stores nothing, and a dead fetch tries no second URL', async () => {
  setEdge(['serves-dashboard', 'caches-content']);
  const row = contentRow(copiedWs, 'never-fetched');
  primaryUp = false; urls.length = 0;
  const r = await cache.ensure(db, config, row, { fetchImpl });
  primaryUp = true;
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(local(row.filepath)));
  assert.equal(db.prepare('SELECT 1 FROM mesh_content_cache WHERE content_id = ?').get(row.id), undefined);
  const hosts = new Set(urls.map((u) => new URL(u).host));
  assert.deepEqual([...hosts], [new URL(config.primaryUrl).host], 'every attempt went to the one operator-typed host');
  assert.match(cache.status(db, config)[0].last_error, /never-fetched|connection|ECONNREFUSED/i);
  // Source: the module knows exactly one origin and no fallback.
  const src = read('lib/mesh/content-cache.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /(screentinker\.com|https?:\/\/[a-z0-9-]+\.[a-z]{2,})/i, 'no host compiled in');
  assert.doesNotMatch(src, /fallback|alternate|peer_url|otherReplica/i, 'no second address');
  assert.match(src, /config\.primaryUrl/);
});

test('the digest is the primary\'s own function (sha256 hex from lib/content-digest), and a 0-byte asset is refused on purpose', async () => {
  const { digestFile } = require('../lib/content-digest');
  const src = read('lib/mesh/content-cache.js');
  assert.match(src, /require\('\.\.\/content-digest'\)/, 'same module the primary stores byte_digest with');
  assert.match(read('lib/content-ingest.js'), /digestFile\(path\.join\(config\.contentDir, filepath\)\)/, 'the primary computes byte_digest with it');
  const buf = Buffer.from('digest-check');
  assert.equal(await digestFile(path.join(TMP, (fs.writeFileSync(path.join(TMP, 'd.bin'), buf), 'd.bin'))), crypto.createHash('sha256').update(buf).digest('hex'));
  setEdge(['serves-dashboard', 'caches-content']);
  const empty = contentRow(copiedWs, '', { thumb: false, digest: false });
  assert.equal(empty.file_size, 0);
  const r = await cache.ensure(db, config, empty, { fetchImpl });
  assert.equal(r.ok, false); assert.equal(r.reason, 'empty asset');
  assert.ok(!fs.existsSync(local(empty.filepath)), 'no empty file on disk — a blank "hit" would look healthy');
});

test('a partial fetch that dies mid-body never gets the basename, is never a hit, and leaves no .part', async () => {
  setEdge(['serves-dashboard', 'caches-content']);
  const row = contentRow(copiedWs, 'half-of-this-arrives-then-the-link-drops', { thumb: false });
  const buf = PRIMARY_FILES.get(row.filepath);
  let calls = 0;
  const flaky = async (url, opts = {}) => {
    calls++;
    if (calls > 1) throw new Error('ECONNREFUSED');   // the primary is gone after the first half
    const { Readable } = require('node:stream');
    const half = buf.subarray(0, Math.floor(buf.length / 2));
    return { ok: true, status: 200, headers: { get: () => null }, body: Readable.toWeb(Readable.from([half])) };
  };
  const r = await cache.ensure(db, config, row, { fetchImpl: flaky });
  assert.equal(r.ok, false, r.reason);
  assert.ok(!fs.existsSync(local(row.filepath)), 'a short body is never renamed to the basename');
  assert.ok(!fs.existsSync(local(row.filepath) + '.part'), 'the partial is removed once the attempt chain ends');
  assert.equal(db.prepare('SELECT 1 FROM mesh_content_cache WHERE content_id = ?').get(row.id), undefined);
  const again = await cache.ensure(db, config, row, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(again.ok, false); assert.notEqual(again.hit, true, 'never reported as a hit');
  // pull-download's own guarantee: ok only when the staged size equals expectedBytes.
  assert.match(read('lib/mesh/pull-download.js'), /if \(size === expectedBytes\) return \{ ok: true/);
});

test('a name that is not on a copied row is still not an open proxy, and the cache only knows copied rows', () => {
  assert.equal(replicaProxy.isCopiedUploadName(db, 'not-a-row.png'), false);
  assert.equal(cache.contentForName(db, 'not-a-row.png'), null);
  assert.equal(cache.contentForName(db, '../../etc/passwd'), null);
  const own = contentRow(ownWs, 'own-bytes');
  assert.equal(cache.contentForName(db, own.filepath), null, 'this node\'s own file is not "copied"');
  const copied = contentRow(copiedWs, 'copied-bytes');
  assert.equal(cache.contentForName(db, copied.filepath).id, copied.id);
  assert.equal(cache.contentForName(db, copied.thumbnail_path).id, copied.id, 'the thumbnail name resolves to the same row');
});

test('test_replica_cache_follows_a_primary_delete: the row goes, the file goes; revoke or role removal drops every file of that edge', async () => {
  setEdge(['serves-dashboard', 'caches-content']);
  const a = contentRow(copiedWs, 'delete-me-bytes');
  const b = contentRow(copiedWs, 'keep-me-bytes!!');
  await cache.ensure(db, config, a, { fetchImpl }); await cache.ensure(db, config, b, { fetchImpl });
  assert.ok(fs.existsSync(local(a.filepath)) && fs.existsSync(local(b.filepath)));
  // What the incremental does when the primary deleted the row.
  db.prepare('DELETE FROM content WHERE id = ?').run(a.id);
  assert.equal(cache.sweep(db, config), 1);
  assert.ok(!fs.existsSync(local(a.filepath)) && !fs.existsSync(local(a.thumbnail_path)), 'file and thumbnail unlinked');
  assert.ok(fs.existsSync(local(b.filepath)), 'the other one stays');
  // The role is removed from the edge: everything cached for it goes; the rows stay.
  setEdge(['serves-dashboard']);
  assert.equal(cache.sweep(db, config) >= 1, true);
  assert.ok(!fs.existsSync(local(b.filepath)));
  assert.ok(db.prepare('SELECT 1 FROM content WHERE id = ?').get(b.id), 'the copied row is untouched — C1\'s rule');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mesh_content_cache WHERE edge_id = ?').get(EDGE).n, 0);
});

test('quota: LRU eviction under REPLICA_CACHE_BYTES; a file larger than the cap is never stored; status reports it', async () => {
  setEdge(['serves-dashboard', 'caches-content']);
  db.prepare('DELETE FROM mesh_content_cache').run();
  assert.equal(config.replicaCacheBytes, 3000);
  const big = contentRow(copiedWs, 'x'.repeat(1200), { thumb: false });
  const mid = contentRow(copiedWs, 'y'.repeat(1200), { thumb: false });
  const third = contentRow(copiedWs, 'z'.repeat(1200), { thumb: false });
  await cache.ensure(db, config, big, { fetchImpl });
  await cache.ensure(db, config, mid, { fetchImpl });
  // Read `big` again so `mid` is the least recently read; then a third file must evict `mid`.
  db.prepare('UPDATE mesh_content_cache SET last_read_at = ? WHERE content_id = ?').run(nowSec() + 10, big.id);
  await cache.ensure(db, config, third, { fetchImpl });
  assert.ok(fs.existsSync(local(big.filepath)) && fs.existsSync(local(third.filepath)));
  assert.ok(!fs.existsSync(local(mid.filepath)), 'the least recently read file was evicted');
  assert.ok(cache.usedBytes(db, EDGE) <= 3000);
  // PINNED: a file a playlist still names is never the victim, however old its last read.
  const pl = uid();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'wall')").run(pl, userId, copiedWs);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(pl, big.id);
  db.prepare('UPDATE mesh_content_cache SET last_read_at = 1 WHERE content_id = ?').run(big.id);   // oldest by far
  const fourth = contentRow(copiedWs, 'w'.repeat(1200), { thumb: false });
  await cache.ensure(db, config, fourth, { fetchImpl });
  assert.ok(fs.existsSync(local(big.filepath)), 'the on-screen slide stays');
  assert.ok(!fs.existsSync(local(third.filepath)), 'the unreferenced one went instead');
  assert.equal(cache.status(db, config)[0].pinned_bytes, 1200);
  // If the pinned set alone fills the cap, new files are served through rather than evicting a slide.
  const pl2 = uid();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'wall2')").run(pl2, userId, copiedWs);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(pl2, fourth.id);
  const fifth = contentRow(copiedWs, 'v'.repeat(1200), { thumb: false });
  await cache.ensure(db, config, fifth, { fetchImpl });   // 1200 + 1200 pinned + 1200 = 3600 > 3000
  assert.ok(!fs.existsSync(local(fifth.filepath)), 'served through, not stored');
  assert.ok(fs.existsSync(local(big.filepath)) && fs.existsSync(local(fourth.filepath)), 'both pinned slides untouched');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id IN (?, ?)').run(pl, pl2);
  const huge = contentRow(copiedWs, 'h'.repeat(3001), { thumb: false });
  const r = await cache.ensure(db, config, huge, { fetchImpl });
  assert.equal(r.ok, false); assert.equal(r.reason, 'exceeds cache');
  assert.ok(!fs.existsSync(local(huge.filepath)));
  const st = cache.status(db, config)[0];
  assert.equal(st.cap_bytes, 3000); assert.equal(st.files, 2); assert.match(st.last_error, /does not fit/);
});

test('prefetch: rows that land in a cached workspace are fetched by a worker that exists only once there is something to fetch', async () => {
  setEdge(['serves-dashboard', 'caches-content']);
  cache.attach({ db, config, fetchImpl });
  assert.equal(cache.isWorkerRunning(), false);
  const row = contentRow(copiedWs, 'prefetched-bytes', { thumb: false });
  cache.onApplied([copiedWs]);
  assert.equal(cache.isWorkerRunning(), true, 'now there is work');
  // Earlier tests left other uncached rows in this workspace; the worker takes them one per second first.
  for (let i = 0; i < 250 && !fs.existsSync(local(row.filepath)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(local(row.filepath)), 'fetched in the background');
  cache.detach();
  // Secrets: nothing but content names ever reach disk from this module.
  const src = read('lib/mesh/content-cache.js');
  assert.doesNotMatch(src, /data_sources|credentials|device_token|password/);
});

/* ------------------------------ real boot: stock install ------------------------------ */

test('a stock boot with the flags off grows no cache: table empty, no worker, and /uploads/content/<unknown> is a plain 404', async () => {
  const dir = path.join(TMP, 'stock');
  const { freePort } = require('./helpers/free-port');
  const port = await freePort();
  const env = { ...process.env, DATA_DIR: dir, SELF_HOSTED: 'true', NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'x' };
  delete env.MESH_ACCEPT_ENROLLMENT; delete env.MESH_ALLOW_UPLINK; delete env.PRIMARY_URL; delete env.REPLICA_CACHE_BYTES;
  const logFd = fs.openSync(path.join(TMP, 'stock.log'), 'w');
  const proc = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd] });
  try {
    let up = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) { up = true; break; } } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
    assert.ok(up);
    const r = await fetch(`http://127.0.0.1:${port}/uploads/content/nope.png`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('x-st-served-by'), null);
    assert.equal(r.headers.get('x-st-replica-cache'), null);
    const Database = require('better-sqlite3');
    const sdb = new Database(path.join(dir, 'db', 'remote_display.db'), { readonly: true });
    assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM mesh_content_cache').get().n, 0);
    sdb.close();
    const files = fs.existsSync(path.join(dir, 'uploads', 'content')) ? fs.readdirSync(path.join(dir, 'uploads', 'content')) : [];
    assert.deepEqual(files, [], 'nothing prefetched onto a stock install');
    const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(st.scale_out, undefined);
  } finally { try { proc.kill('SIGKILL'); } catch { /* */ } }
});
