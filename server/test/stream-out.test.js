'use strict';

/*
 * STREAM OUTPUTS of the vision mixer (lib/stream-out.js, routes/stream-out.js).
 *
 * What has to hold:
 *   - it runs on self-hosted instances only: a hosted instance says so and starts nothing;
 *   - a stream key goes in and never comes back out, in any response or any error text;
 *   - a destination is only ever an RTMP, RTMPS or SRT address;
 *   - one workspace cannot see, change, start or take to another's stream;
 *   - a read-only member cannot touch them, and an API token cannot reach them at all;
 *   - what the server's renderer fetches is addressed by the output's secret and nothing else;
 *   - the dashboard is told which licence the installed ffmpeg is under.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const streamOut = require('../lib/stream-out');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-so-' + crypto.randomBytes(4).toString('hex'));
const A = {}, B = {}, V = {};
const KEY = 'live_sk_' + crypto.randomBytes(8).toString('hex');

const call = async (method, p, tok, body) => {
  const res = await fetch(BASE + p, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body: json, text };
};
async function account(o, name) {
  const r = await call('POST', '/api/auth/register', null, { email: name + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name });
  assert.ok(r.body && r.body.token, r.text);
  Object.assign(o, { jwt: r.body.token, userId: r.body.user.id, wsId: r.body.current_workspace_id });
}
async function playlist(o, name) {
  const pl = await call('POST', '/api/playlists', o.jwt, { name });
  const cid = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec) VALUES (?, ?, ?, 'a.png', 'a.png', 'image/png', 10, 10)`).run(cid, o.userId, o.wsId);
  await call('POST', `/api/playlists/${pl.body.id}/items`, o.jwt, { content_id: cid });
  return pl.body.id;
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(DATA_DIR + '.log', 'w');
  // CHROME_PATH only has to exist for the instance to count as able: nothing here goes live.
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', CHROME_PATH: process.execPath }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot');
  await account(A, 'alpha');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  await account(B, 'beta');
  await account(V, 'viewer');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(A.wsId, V.userId);
  const sw = await call('POST', '/api/auth/switch-workspace', V.jwt, { workspace_id: A.wsId });
  V.jwt = (sw.body && sw.body.token) || V.jwt;
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a hosted instance does not stream out', async () => {
  assert.deepEqual(await streamOut.availability({ selfHosted: false }), { available: false, reason: 'hosted', ffmpeg: null });
});

test('the licence of the installed ffmpeg is read from what it says about itself', () => {
  assert.equal(streamOut.licenceOf('ffmpeg version 7\nconfiguration: --enable-gpl --enable-libx264'), 'gpl');
  assert.equal(streamOut.licenceOf('configuration: --enable-gpl --enable-nonfree'), 'nonfree');
  assert.equal(streamOut.licenceOf('configuration: --enable-libopenh264 --disable-gpl-thing'), 'lgpl');
});

test('a destination is an RTMP, RTMPS or SRT address and nothing else', () => {
  const ok = (x) => streamOut.validate({ name: 'n', key: 'k', ...x });
  assert.ok(ok({ kind: 'youtube' }).ok);
  assert.ok(ok({ kind: 'rtmp', url: 'rtmps://ingest.example.com/app' }).ok);
  assert.ok(ok({ kind: 'srt', url: 'srt://ingest.example.com:9000', key: 'streamid=abc' }).ok);
  for (const bad of [{ kind: 'rtmp', url: 'http://example.com/x' }, { kind: 'rtmp', url: 'file:///etc/passwd' }, { kind: 'rtmp', url: 'rtmp://user:pw@example.com/app' },
    { kind: 'srt', url: 'rtmp://example.com' }, { kind: 'srt', url: 'srt://h:1?passphrase=x' }, { kind: 'rtmp', url: 'not a url' }, { kind: 'nope' },
    { kind: 'youtube', key: '' }, { kind: 'youtube', key: 'has space' }, { kind: 'youtube', key: 'new\nline' }, { kind: 'youtube', name: '' }]) {
    assert.ok(streamOut.validate({ name: 'n', key: 'k', ...bad }).error, JSON.stringify(bad));
  }
  assert.equal(streamOut.targetUrl({ kind: 'youtube' }, 'abc'), 'rtmp://a.rtmp.youtube.com/live2/abc');
  assert.equal(streamOut.targetUrl({ kind: 'srt', url: 'srt://h:9000' }, 'streamid=x'), 'srt://h:9000?streamid=x');
});

test('the encoder is handed the address as one argument, and its last words never carry the key', () => {
  const row = { kind: 'rtmp', url: 'rtmp://ingest.example.com/app', width: 1280, height: 720, fps: 30, bitrate_k: 3500 };
  const target = streamOut.targetUrl(row, KEY);
  const args = streamOut.ffmpegArgs({ ...row, target });
  assert.equal(args[args.length - 1], target);
  assert.equal(args.filter((a) => a.includes(KEY)).length, 1);
  assert.deepEqual(args.slice(args.indexOf('-f', args.length - 3)), ['-f', 'flv', target]);
  const said = streamOut.redact(`[rtmp @ 0x1] Cannot open ${target}: refused. key=${KEY}`, row, KEY);
  assert.doesNotMatch(said, new RegExp(KEY));
  assert.match(said, /\[hidden\]/);
});

test('a stream key goes in and never comes back out', { skip: !HAS_FFMPEG && 'no ffmpeg here' }, async () => {
  const made = await call('POST', '/api/stream-out', A.jwt, { name: 'Main', kind: 'youtube', key: KEY });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.has_key, true);
  A.stream = made.body.id;
  const list = await call('GET', '/api/stream-out', A.jwt);
  assert.equal(list.body.available, true);
  assert.ok(['gpl', 'lgpl', 'nonfree'].includes(list.body.ffmpeg.licence), 'the dashboard is told the ffmpeg licence');
  const put = await call('PUT', `/api/stream-out/${A.stream}`, A.jwt, { name: 'Main channel' });
  assert.equal(put.status, 200, put.text);
  for (const r of [made, list, put]) { assert.doesNotMatch(r.text, new RegExp(KEY)); assert.doesNotMatch(r.text, /feed_secret|key_enc/); }
  const row = db.prepare('SELECT key_enc, name FROM stream_outputs WHERE id = ?').get(A.stream);
  assert.equal(row.name, 'Main channel');
  assert.ok(row.key_enc && !row.key_enc.includes(KEY), 'stored encrypted');
  assert.equal(require('../lib/secretbox').decrypt !== undefined, true);
});

test('another workspace cannot see, change, start or take to it', { skip: !HAS_FFMPEG && 'no ffmpeg here' }, async () => {
  assert.deepEqual((await call('GET', '/api/stream-out', B.jwt)).body.outputs, []);
  for (const [m, p, body] of [['PUT', '', { name: 'x' }], ['DELETE', ''], ['POST', '/start'], ['POST', '/stop'], ['POST', '/gfx', { kind: 'bug', a: 'x' }], ['POST', '/gfx/clear']]) {
    assert.equal((await call(m, `/api/stream-out/${A.stream}${p}`, B.jwt, body)).status, 404, `${m} ${p}`);
  }
  const theirs = await playlist(B, 'Theirs');
  const take = await call('POST', '/api/mixer/take', B.jwt, { stream_ids: [A.stream], playlist_id: theirs });
  assert.deepEqual(take.body.skipped, [{ stream_id: A.stream, reason: 'not_found' }]);
  assert.equal(db.prepare('SELECT playlist_id FROM stream_outputs WHERE id = ?').get(A.stream).playlist_id, null);
});

test('a read-only member cannot add, start or remove a stream, and an API token cannot reach streams at all', { skip: !HAS_FFMPEG && 'no ffmpeg here' }, async () => {
  assert.equal((await call('POST', '/api/stream-out', V.jwt, { name: 'V', kind: 'youtube', key: 'k' })).status, 403);
  assert.equal((await call('POST', `/api/stream-out/${A.stream}/start`, V.jwt)).status, 403);
  assert.equal((await call('DELETE', `/api/stream-out/${A.stream}`, V.jwt)).status, 403);
  assert.equal((await call('GET', '/api/stream-out', 'st_' + 'a'.repeat(40))).status, 401);
});

test('a stream shows what was taken to it, with its graphic, to whoever holds its secret and no one else', { skip: !HAS_FFMPEG && 'no ffmpeg here' }, async () => {
  assert.equal((await call('POST', `/api/stream-out/${A.stream}/start`, A.jwt)).status, 400, 'nothing taken to it yet: nothing to show');
  const src = await playlist(A, 'Programme');
  const take = await call('POST', '/api/mixer/take', A.jwt, { stream_ids: [A.stream], playlist_id: src });
  assert.equal(take.body.streams[0].stream_id, A.stream);
  await call('POST', `/api/stream-out/${A.stream}/gfx`, A.jwt, { kind: 'lower-third', a: 'A name', b: 'A title' });
  const secret = db.prepare('SELECT feed_secret FROM stream_outputs WHERE id = ?').get(A.stream).feed_secret;
  const feed = await call('GET', `/api/stream-feed/${secret}`);
  assert.equal(feed.status, 200, feed.text);
  assert.equal(feed.body.payload.cut_now, true);
  assert.equal(feed.body.payload.assignments.length, 1);
  assert.match(feed.body.gfx.uri, /^\/gfx\/lower-third\?a=A\+name/);
  assert.equal(feed.body.gfx.keyed, true);
  assert.equal((await call('GET', `/api/stream-feed/${secret}?rev=${feed.body.rev}`)).body.unchanged, true);
  await call('POST', `/api/stream-out/${A.stream}/gfx/clear`, A.jwt);
  assert.equal((await call('GET', `/api/stream-feed/${secret}`)).body.gfx, null);
  assert.equal((await call('GET', '/api/stream-feed/' + 'x'.repeat(43))).status, 404);
  assert.equal((await call('GET', `/api/stream-feed/${A.stream}`)).status, 404, 'the id is not the secret');
  assert.equal((await call('GET', '/stream-render/' + 'x'.repeat(43))).status, 404);
  assert.match((await call('GET', `/stream-render/${secret}`)).text, /stream-feed/);
});

test('a keyed overlay is passed to the screen as keyed, and the web player draws it with no box', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'pip.js'), 'utf8'), /if \(b\.keyed === true\) payload\.keyed = true;/);
  for (const f of ['index.html', 'legacy.html']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'player', f), 'utf8'), /keyed === true\)\s*\{\s*box\.style\.background = ['"]transparent['"]/, f);
  }
});
