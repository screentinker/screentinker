'use strict';

// Thumbnail serving: remote (proxied) vs local (sendFile). Regression test for the
// YouTube hqdefault.jpg ENOENT bug — content.js stores thumbnail_path as a REMOTE URL
// (https://img.youtube.com/vi/<id>/hqdefault.jpg), and the serving route used to
// path.resolve it into contentDir -> a local file that never existed -> ENOENT spam.
// Now the route proxies remote http(s) thumbnails server-side; local files still
// sendFile unchanged. A local HTTP server stands in for img.youtube.com (the "mock
// upstream") so no network is needed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const PORT = 3990;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-thumb-test-' + crypto.randomBytes(4).toString('hex'));
const CONTENT_DIR = path.join(DATA_DIR, 'uploads', 'content');
const LOG = path.join(os.tmpdir(), 'st-thumb-' + crypto.randomBytes(4).toString('hex') + '.log');
// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYAAAAxN7CkAAAAASUVORK5CYII=', 'base64');

let proc, upstream, upstreamPort, upstreamHits = 0, seedDb;

async function jget(p) {
  const res = await fetch(BASE + p);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', buf };
}

// Insert a content row + a playlist_items row (so the public thumbnail gate passes).
// Uses ONE long-lived seeding connection (opened in before()): opening a fresh write
// connection per insert can race WAL visibility against the server's reader. FK
// enforcement is disabled on this connection so a dummy playlist_id needs no real playlist.
function makeContent(thumbnailPath, { mime = 'image/png' } = {}) {
  const id = crypto.randomUUID();
  seedDb.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, thumbnail_path) VALUES (?,?,?,?,0,?)")
    .run(id, 'item', '', mime, thumbnailPath);
  seedDb.prepare('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)').run('pl-test', id);
  return id;
}

before(async () => {
  // Mock upstream standing in for img.youtube.com. /missing/* -> 404 to exercise the
  // clean-failure path; everything else -> a 200 image/png.
  upstream = http.createServer((req, res) => {
    upstreamHits++;
    if (req.url.includes('missing')) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  seedDb = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  seedDb.pragma('foreign_keys = OFF');
});

after(() => {
  try { seedDb.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { upstream.close(); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('local-file thumbnail still serves via sendFile', () => {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTENT_DIR, 'localthumb.png'), PNG);
  const id = makeContent('localthumb.png');
  return jget(`/api/content/${id}/thumbnail`).then((r) => {
    assert.equal(r.status, 200, 'local thumbnail served');
    assert.match(r.type, /^image\//, 'image content-type');
    assert.ok(r.buf.equals(PNG), 'served the local bytes');
  });
});

test('remote http thumbnail is proxied (no local read, no ENOENT)', async () => {
  const before = upstreamHits;
  // A YouTube-style remote thumbnail. The basename is hqdefault.jpg — the exact name
  // the old bug tried (and failed) to read from contentDir.
  const id = makeContent(`http://127.0.0.1:${upstreamPort}/vi/abc/hqdefault.jpg`, { mime: 'video/youtube' });
  // The local file the buggy path would have looked for must NOT exist.
  assert.ok(!fs.existsSync(path.join(CONTENT_DIR, 'hqdefault.jpg')), 'no local hqdefault.jpg exists');

  const r = await jget(`/api/content/${id}/thumbnail`);
  assert.equal(r.status, 200, 'remote thumbnail proxied');
  assert.equal(r.type, 'image/png', 'upstream content-type passed through');
  assert.ok(r.buf.equals(PNG), 'served the upstream bytes');
  assert.equal(upstreamHits, before + 1, 'fetched the upstream once (proxied, not read from disk)');

  // The bug symptom was ENOENT spam in the logs; the proxy path must not produce it.
  const log = fs.readFileSync(LOG, 'utf8');
  assert.ok(!log.includes('ENOENT'), 'no ENOENT logged for the remote thumbnail');
});

test('remote upstream 404 yields a clean 404 (process stays up)', async () => {
  const id = makeContent(`http://127.0.0.1:${upstreamPort}/vi/missing/hqdefault.jpg`, { mime: 'video/youtube' });
  const r = await jget(`/api/content/${id}/thumbnail`);
  assert.equal(r.status, 404, 'upstream 404 maps to a clean 404');
  // server still alive
  assert.equal((await fetch(BASE + '/api/status')).ok, true, 'server survived the upstream failure');
});
