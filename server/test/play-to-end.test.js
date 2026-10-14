'use strict';

// #624 "Play to end": a YouTube item advances when the video ends, not after its duration_sec.
// On Android, Tizen and the Pi/Windows player a YouTube item looped and was cut off by its duration
// (10 s by default). The server's part is the flag: stored per item, defaulted ON for YouTube where
// an operator adds it, refused on anything else, carried through every copy, and sent to players
// only when set, so every other snapshot stays byte-identical.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { appliesTo, normalizePlayToEnd, resolvePlayToEnd } = require('../lib/play-to-end');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-p2e-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-p2e-' + crypto.randomBytes(4).toString('hex') + '.log');
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
const row = (id) => db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(id);
const snapshot = (playlistId) => JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId).published_snapshot);

// ---------------------------------------------------------------- unit: the shared rules

test('only YouTube carries the flag', () => {
  assert.equal(appliesTo('video/youtube'), true);
  for (const m of ['video/mp4', 'image/png', 'video/hls', undefined, null, '']) assert.equal(appliesTo(m), false, String(m));
});

test('the stored value is 1 or NULL', () => {
  for (const on of [true, 1, '1', 'true', 'on']) assert.equal(normalizePlayToEnd(on), 1, String(on));
  for (const off of [false, 0, '0', '', null, undefined, 'no']) assert.equal(normalizePlayToEnd(off), null, String(off));
});

test('a newly added YouTube item plays to the end unless asked not to; nothing else ever does', () => {
  assert.equal(resolvePlayToEnd(undefined, 'video/youtube'), 1);
  assert.equal(resolvePlayToEnd(false, 'video/youtube'), null);
  assert.equal(resolvePlayToEnd(true, 'video/youtube'), 1);
  assert.equal(resolvePlayToEnd(undefined, 'image/png'), null, 'pictures keep their duration');
  assert.equal(resolvePlayToEnd(true, 'video/mp4'), null, 'an uploaded video already ends on its own');
});

// -------------------------------------------------------------- end to end on the routes

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
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

  const reg = await jfetch('/api/auth/register', post(null, { email: 'p' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  S.userId = reg.body.user.id;
  S.ws = reg.body.current_workspace_id;

  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.pragma('foreign_keys = OFF');
  const mkContent = (name, mime, remoteUrl = null) => {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO content (id, filename, filepath, mime_type, file_size, duration_sec, remote_url, workspace_id) VALUES (?,?,?,?,0,NULL,?,?)')
      .run(id, name, '', mime, remoteUrl, S.ws);
    return id;
  };
  S.cYt = mkContent('Talk', 'video/youtube', 'https://www.youtube.com/embed/abc123?enablejsapi=1');
  S.cYt2 = mkContent('Trailer', 'video/youtube', 'https://www.youtube.com/embed/def456?enablejsapi=1');
  S.cImage = mkContent('poster.png', 'image/png');

  S.deviceId = crypto.randomUUID();
  db.prepare('INSERT INTO devices (id, name, status, workspace_id, user_id) VALUES (?,?,?,?,?)')
    .run(S.deviceId, 'P2EDev', 'online', S.ws, S.userId);
});

after(() => {
  try { db?.close(); } catch { /* */ }
  try { proc?.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('adding YouTube to a playlist turns play to end on; an image stays on its duration', async () => {
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'p2e-add' }));
  S.pl = pl.body.id;
  const yt = await jfetch(`/api/playlists/${S.pl}/items`, post(S.jwt, { content_id: S.cYt }));
  assert.equal(yt.status, 201);
  assert.equal(row(yt.body.id).play_to_end, 1);
  S.itemYt = yt.body.id;

  const img = await jfetch(`/api/playlists/${S.pl}/items`, post(S.jwt, { content_id: S.cImage }));
  assert.equal(img.status, 201);
  assert.equal(row(img.body.id).play_to_end, null);
  assert.equal(row(img.body.id).duration_sec, 10, 'pictures keep the 10 s default');
  S.itemImg = img.body.id;

  const off = await jfetch(`/api/playlists/${S.pl}/items`, post(S.jwt, { content_id: S.cYt2, play_to_end: false }));
  assert.equal(off.status, 201);
  assert.equal(row(off.body.id).play_to_end, null, 'an explicit "no" is honoured');
  S.itemYtOff = off.body.id;
});

test('the flag is switched per item, and refused on anything but YouTube', async () => {
  const offR = await jfetch(`/api/playlists/${S.pl}/items/${S.itemYt}`, put(S.jwt, { play_to_end: false }));
  assert.equal(offR.status, 200);
  assert.equal(row(S.itemYt).play_to_end, null);
  const onR = await jfetch(`/api/playlists/${S.pl}/items/${S.itemYt}`, put(S.jwt, { play_to_end: true }));
  assert.equal(onR.status, 200);
  assert.equal(row(S.itemYt).play_to_end, 1);

  const bad = await jfetch(`/api/playlists/${S.pl}/items/${S.itemImg}`, put(S.jwt, { play_to_end: true }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /YouTube/);
  assert.equal(row(S.itemImg).play_to_end, null);
  const offImg = await jfetch(`/api/playlists/${S.pl}/items/${S.itemImg}`, put(S.jwt, { play_to_end: false }));
  assert.equal(offImg.status, 200, 'turning it off is always allowed');
});

test('the published snapshot carries the flag only where it is set, and only on YouTube', async () => {
  const pub = await jfetch(`/api/playlists/${S.pl}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200);
  const snap = snapshot(S.pl);
  const by = (cid) => snap.find((i) => i.content_id === cid);
  assert.equal(by(S.cYt).play_to_end, 1);
  assert.ok(!('play_to_end' in by(S.cYt2)), 'a YouTube item with it off sends nothing');
  assert.ok(!('play_to_end' in by(S.cImage)), 'an image sends nothing');
});

test('a playlist without YouTube publishes exactly as before (no new key anywhere)', async () => {
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'p2e-none' }));
  await jfetch(`/api/playlists/${pl.body.id}/items`, post(S.jwt, { content_id: S.cImage }));
  await jfetch(`/api/playlists/${pl.body.id}/publish`, post(S.jwt, {}));
  for (const it of snapshot(pl.body.id)) assert.ok(!('play_to_end' in it));
  const structure = db.prepare('SELECT published_structure FROM playlists WHERE id = ?').get(pl.body.id).published_structure;
  assert.ok(!structure.includes('play_to_end'), 'the stored structure is unchanged too');
});

test('discarding a draft brings the published flag back', async () => {
  await jfetch(`/api/playlists/${S.pl}/items/${S.itemYt}`, put(S.jwt, { play_to_end: false }));
  assert.equal(row(S.itemYt).play_to_end, null);
  const d = await jfetch(`/api/playlists/${S.pl}/discard`, post(S.jwt, {}));
  assert.equal(d.status, 200);
  const restored = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND content_id = ?').get(S.pl, S.cYt);
  assert.equal(restored.play_to_end, 1, 'discard restored the item without its flag');
  S.itemYt = restored.id;
});

test('duplicating an item keeps the flag', async () => {
  const dup = await jfetch(`/api/playlists/${S.pl}/items/${S.itemYt}/duplicate`, post(S.jwt, {}));
  assert.ok(dup.status === 200 || dup.status === 201, `duplicate returned ${dup.status}`);
  const copies = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND content_id = ?').all(S.pl, S.cYt);
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.play_to_end === 1));
});

test('the bulk action switches only the YouTube items in a mixed selection', async () => {
  const ids = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(S.pl).map((r) => r.id);
  const r = await jfetch(`/api/playlists/${S.pl}/items/selection`, post(S.jwt, { action: 'play_to_end', ids, play_to_end: true }));
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, 1, 'the image is skipped, not refused');
  for (const id of ids) {
    const it = row(id);
    const mime = db.prepare('SELECT mime_type FROM content WHERE id = ?').get(it.content_id).mime_type;
    assert.equal(it.play_to_end, mime === 'video/youtube' ? 1 : null);
  }
});

test('assigning YouTube straight to a display gets the same default', async () => {
  const r = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cYt }));
  assert.equal(r.status, 201);
  const playlistId = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(S.deviceId).playlist_id;
  const it = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND content_id = ?').get(playlistId, S.cYt);
  assert.equal(it.play_to_end, 1);
});
