'use strict';

// IPTV / live HLS, end to end on the routes an operator actually clicks: add a live stream, add it
// to a playlist, set its dwell, publish. Pins the URL gates (LAN allowed, non-http schemes refused),
// the type boundary (a row cannot cross into/out of video/hls), the 5-minute default dwell and the
// dwell-0 rule, and that the live item and its URL survive into the published snapshot.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-iptvroute-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-iptvroute-' + crypto.randomBytes(4).toString('hex') + '.log');
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
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await jfetch('/api/auth/register', post(null, { email: 'i' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  S.wsA = reg.body.current_workspace_id;
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'iptv-pl' }));
  S.playlistId = pl.body.id;
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
});

after(() => {
  try { db?.close(); } catch { /* */ }
  try { proc?.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

// ---------------------------------------------------------------- POST /hls

test('POST /hls stores a video/hls row for a LAN .m3u8 URL, no bytes, no fetch', async () => {
  const r = await jfetch('/api/content/hls', post(S.jwt, { url: 'http://10.20.30.40/live/index.m3u8', name: 'Lobby TV' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mime_type, 'video/hls');
  assert.equal(r.body.remote_url, 'http://10.20.30.40/live/index.m3u8');
  assert.equal(r.body.filepath, '');
  assert.equal(r.body.file_size, 0);
  S.hlsId = r.body.id;
});

test('POST /hls accepts a public .m3u8 and derives a name when none is given', async () => {
  const r = await jfetch('/api/content/hls', post(S.jwt, { url: 'https://cdn.example.com/channels/news.m3u8' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.mime_type, 'video/hls');
  assert.ok(r.body.filename, 'a name is derived from the URL');
});

test('POST /hls accepts an rtsp:// camera URL as video/rtsp (credentials allowed)', async () => {
  const r = await jfetch('/api/content/hls', post(S.jwt, { url: 'rtsp://admin:pass@10.0.0.7:554/h264', name: 'Front door cam' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mime_type, 'video/rtsp');
  assert.equal(r.body.remote_url, 'rtsp://admin:pass@10.0.0.7:554/h264');
  S.rtspId = r.body.id;
});

test('POST /hls refuses non-live schemes (udp/file), and a plain http page', async () => {
  for (const url of ['udp://239.0.0.1:1234', 'file:///etc/passwd', 'https://user:pw@10.0.0.1/x.m3u8', 'https://example.com/page']) {
    const r = await jfetch('/api/content/hls', post(S.jwt, { url }));
    assert.equal(r.status, 400, `${url} must be refused`);
  }
});

test('the live type bucket includes rtsp; video/web exclude it', async () => {
  const live = await jfetch('/api/content?type=live', auth(S.jwt));
  assert.ok(live.body.some((c) => c.mime_type === 'video/rtsp'), 'type=live includes the camera');
  const video = await jfetch('/api/content?type=video', auth(S.jwt));
  assert.ok(video.body.every((c) => c.mime_type !== 'video/rtsp'), 'type=video excludes rtsp');
});

test('POST /hls refuses a URL that is not a stream (no .m3u8), so junk is caught early', async () => {
  const r = await jfetch('/api/content/hls', post(S.jwt, { url: 'https://example.com/watch/page' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /HLS|m3u8/i);
});

test('the SSRF gate on POST /remote is UNCHANGED — a private URL is still refused there', async () => {
  const r = await jfetch('/api/content/remote', post(S.jwt, { url: 'http://10.0.0.1/thing.mp4', mime_type: 'video/mp4' }));
  assert.equal(r.status, 400, 'video/hls relaxes the gate; /remote does not');
});

// ---------------------------------------------------------------- dwell on the playlist item

test('adding a live stream to a playlist defaults to a 5-minute dwell', async () => {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.hlsId }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.duration_sec, 300, 'a live item defaults to 300s dwell, not the 10s media default');
  S.itemId = r.body.id;
});

test('dwell 0 (stay until skipped) is accepted on a live item', async () => {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items/${S.itemId}`, put(S.jwt, { duration_sec: 0 }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = db.prepare('SELECT duration_sec FROM playlist_items WHERE id = ?').get(S.itemId);
  assert.equal(stored.duration_sec, 0);
});

test('dwell 0 is refused on a NON-live item (a 0ms advance black-screens the TV)', async () => {
  const cid = crypto.randomUUID();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id) VALUES (?,?,?,?,0,?)")
    .run(cid, 'clip.mp4', 'clip.mp4', 'video/mp4', S.wsA);
  db.pragma('foreign_keys = ON');
  const add = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: cid, duration_sec: 8 }));
  assert.equal(add.status, 201);
  const r = await jfetch(`/api/playlists/${S.playlistId}/items/${add.body.id}`, put(S.jwt, { duration_sec: 0 }));
  assert.equal(r.status, 400, 'a normal clip may not be set to 0');
});

// ---------------------------------------------------------------- publish snapshot

test('the live item and its URL survive into the published snapshot at dwell 0', async () => {
  const pub = await jfetch(`/api/playlists/${S.playlistId}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200);
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(S.playlistId).published_snapshot);
  const live = snap.find((i) => i.mime_type === 'video/hls');
  assert.ok(live, 'the live item is in the snapshot');
  assert.equal(live.remote_url, 'http://10.20.30.40/live/index.m3u8', 'the m3u8 URL travels to the player');
  assert.equal(live.duration_sec, 0, 'the dwell travels as-is');
});

// ---------------------------------------------------------------- the mime boundary

test('a row cannot cross the video/hls boundary in either direction', async () => {
  const intoHls = await jfetch(`/api/content/${S.hlsId}`, put(S.jwt, { mime_type: 'video/mp4' }));
  assert.equal(intoHls.status, 400, 'a live row cannot become a plain video');

  const yt = await jfetch('/api/content/youtube', post(S.jwt, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
  assert.equal(yt.status, 201);
  const outOfYt = await jfetch(`/api/content/${yt.body.id}`, put(S.jwt, { mime_type: 'video/hls' }));
  assert.equal(outOfYt.status, 400, 'a youtube row cannot become a live stream');
});

test('a live row accepts a new LAN URL (player-opened gate) but not a non-m3u8', async () => {
  const ok = await jfetch(`/api/content/${S.hlsId}`, put(S.jwt, { remote_url: 'http://192.168.9.9/other.m3u8' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bad = await jfetch(`/api/content/${S.hlsId}`, put(S.jwt, { remote_url: 'https://example.com/not-a-stream' }));
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- library type filter

test('the library filters live streams into their own bucket, out of video and web', async () => {
  const live = await jfetch('/api/content?type=live', auth(S.jwt));
  assert.ok(live.body.every((c) => (c.mime_type === 'video/hls' || c.mime_type === 'video/rtsp')), 'type=live returns only live streams');
  assert.ok(live.body.some((c) => c.id === S.hlsId), 'and includes the one we added');

  const video = await jfetch('/api/content?type=video', auth(S.jwt));
  assert.ok(video.body.every((c) => c.mime_type !== 'video/hls'), 'type=video excludes live streams');

  const web = await jfetch('/api/content?type=web', auth(S.jwt));
  assert.ok(web.body.every((c) => c.mime_type !== 'video/hls'), 'type=web excludes live streams');
});
