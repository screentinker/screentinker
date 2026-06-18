'use strict';

// #129 mute: the per-item `muted` flag must persist on PUT /api/assignments/:id, come
// back in the item read (ITEM_SELECT), and reach the device by being included in the
// playlist's published_snapshot (buildSnapshotItems). Before the fix the PUT silently
// dropped `muted`, playlist_items had no such column, and the snapshot never carried it —
// so the dashboard mute toggle was a no-op end to end.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-mute-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-mute-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
let proc, db;
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const put = (tok, obj) => ({ method: 'PUT', ...auth(tok), body: JSON.stringify(obj || {}) });

before(async () => {
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

  const reg = await jfetch('/api/auth/register', post(null, { email: 'm' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'mute-pl' }));
  S.playlistId = pl.body.id;

  // Seed a content row + a playlist_item on a single connection (avoids WAL visibility
  // races; FK off so a NULL-workspace content row is fine for the test).
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.pragma('foreign_keys = OFF');
  S.contentId = crypto.randomUUID();
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url) VALUES (?,?,?,?,0,?)")
    .run(S.contentId, 'clip', '', 'video/mp4', 'https://example.com/clip.mp4');
  const info = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,0,10)')
    .run(S.playlistId, S.contentId);
  S.itemId = info.lastInsertRowid;
});

after(() => {
  try { db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('PUT /assignments/:id persists muted and returns it (ITEM_SELECT)', async () => {
  const on = await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  assert.equal(on.status, 200);
  assert.equal(on.body.muted, 1, 'muted persisted + returned as 1');

  const off = await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: false }));
  assert.equal(off.status, 200);
  assert.equal(off.body.muted, 0, 'unmute persisted + returned as 0');
});

test('muted reaches the device via the published snapshot (buildSnapshotItems)', async () => {
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  const pub = await jfetch(`/api/playlists/${S.playlistId}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200);

  const snapRow = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(S.playlistId);
  const snap = JSON.parse(snapRow.published_snapshot);
  const item = snap.find((i) => i.content_id === S.contentId);
  assert.ok(item, 'the item is in the published snapshot');
  assert.equal(item.muted, 1, 'snapshot (device payload) carries muted=1');
});

test('PUT ignoring muted (other field) leaves muted untouched', async () => {
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  const r = await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { duration_sec: 15 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.muted, 1, 'a non-mute update does not reset muted');
  assert.equal(r.body.duration_sec, 15);
});
