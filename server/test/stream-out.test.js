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
  const renderPage = (await call('GET', `/stream-render/${secret}`)).text;
  assert.match(renderPage, /stream-feed/);
  assert.match(renderPage, /"sound":true/, 'the renderer plays with sound from the first item: a live stream never waits on a click to unmute');
  assert.match(renderPage, /if \(v && v\.sound === true\) userHasInteracted = true;/);
});

test('a keyed overlay is passed to the screen as keyed, and the web player draws it with no box', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'pip.js'), 'utf8'), /if \(b\.keyed === true\) payload\.keyed = true;/);
  for (const f of ['index.html', 'legacy.html']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'player', f), 'utf8'), /keyed === true\)\s*\{\s*box\.style\.background = ['"]transparent['"]/, f);
  }
});

/*
 * A STREAM'S SOUND. The fader and mute are applied to the samples as they go out; the bed has to
 * be an audio item of the stream's own workspace whose file is on this server.
 */
test('the fader scales the samples, clips instead of wrapping, and reports the peak', () => {
  const buf = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };
  const read = (b) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
  let b = buf(1000, -2000, 0, 16384);
  assert.equal(streamOut.applyGain(b, 0.5), 8192 / 32768);
  assert.deepEqual(read(b), [500, -1000, 0, 8192]);
  b = buf(30000, -30000); streamOut.applyGain(b, 1.5);
  assert.deepEqual(read(b), [32767, -32768], 'loud is clipped, never wrapped round to the other sign');
  b = buf(12345, -12345); assert.equal(streamOut.applyGain(b, 0), 0);
  assert.deepEqual(read(b), [0, 0], 'mute is silence');
  assert.equal(streamOut.setAudio('no-such-stream', { level: 1 }), false, 'nothing to change on a stream that is not running');
});

test('a stream\'s audio bed is an audio item of its own workspace, and its level stays in range', { skip: !HAS_FFMPEG && 'no ffmpeg here' }, async () => {
  const item = (o, mime, onDisk) => {
    const id = crypto.randomUUID(), file = id + '.bin';
    if (onDisk) { fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'content'), { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'uploads', 'content', file), 'x'); }
    db.prepare('INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, o.userId, o.wsId, 'Bed ' + id.slice(0, 4), file, mime);
    return id;
  };
  const bed = item(A, 'audio/mpeg', true);
  const set = await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { content_id: bed, level: 0.6, muted: true });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual({ ...set.body.audio, name: null, mix: null }, { content_id: bed, name: null, level: 0.6, muted: true, mix: null });
  assert.deepEqual(set.body.audio.mix.bed, { level: 0.6, muted: true });
  assert.ok((await call('GET', '/api/stream-out', A.jwt)).body.audio_sources.some((a) => a.id === bed));
  assert.doesNotMatch(set.text, /uploads|\.bin/, 'where the file is on disk is not sent');
  for (const [body, status] of [[{ content_id: item(B, 'audio/mpeg', true) }, 404], [{ content_id: item(A, 'image/png', true) }, 404], [{ content_id: item(A, 'audio/mpeg', false) }, 400],
    [{ level: 2 }, 400], [{ level: -0.1 }, 400], [{ level: 'loud' }, 400]]) {
    assert.equal((await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, body)).status, status, JSON.stringify(body));
  }
  assert.equal((await call('POST', `/api/stream-out/${A.stream}/audio`, B.jwt, { level: 1 })).status, 404);
  assert.equal((await call('POST', `/api/stream-out/${A.stream}/audio`, V.jwt, { level: 1 })).status, 403);
  const cleared = await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { content_id: null, muted: false });
  assert.deepEqual({ ...cleared.body.audio, mix: null }, { content_id: null, name: null, level: 0.6, muted: false, mix: null });
  // The four strips, one at a time or together; nothing but a real strip, a level in range, and a
  // sound input that is on this server.
  const strips = await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { strips: [{ strip: 'master', level: 0.8 }, { strip: 'programme', muted: true }, { strip: 'line', level: 1.2 }] });
  assert.equal(strips.status, 200, strips.text);
  assert.deepEqual(strips.body.audio.mix, { master: { level: 0.8, muted: false }, programme: { level: 1, muted: true }, bed: { level: 0.6, muted: false }, line: { level: 1.2, muted: false, device: null } });
  assert.deepEqual((await call('GET', '/api/stream-out', A.jwt)).body.outputs.find((o) => o.id === A.stream).audio.mix.master, { level: 0.8, muted: false }, 'kept');
  for (const body of [{ strip: 'aux', level: 1 }, { strip: 'master', level: 5 }, { strips: [{ strip: 'bed', level: 1 }, { strip: 'nope' }] }, { line_device: 'plughw:99,0' }, { line_device: 'default; rm -rf /' }]) {
    assert.equal((await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, body)).status, 400, JSON.stringify(body));
  }
  const info = (await call('GET', '/api/stream-out', A.jwt)).body;
  assert.ok(Array.isArray(info.line_inputs) && typeof info.programme_audio === 'boolean', 'the desk is told what this server can take in');
});

/*
 * THE MIXER (lib/stream-audio.js). Inputs are summed with their own faders into a master; the
 * mixer never waits for an input, never wraps a loud sum round to the other sign, and keeps a live
 * input with the picture by dropping what is stale.
 */
const audio = require('../lib/stream-audio');
const { PassThrough } = require('node:stream');
const pcm = (v, samples) => { const b = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) b.writeInt16LE(v, i * 2); return b; };
const ints = (b) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
const tick = () => new Promise((r) => setImmediate(r));

test('inputs are summed with their faders into the master, whatever sizes the chunks arrive in', async () => {
  const m = new audio.Mix({ bed: { level: 0.5 }, line: { level: 1 }, master: { level: 2 } });   // master is capped at the top of the fader
  const bed = new PassThrough(), line = new PassThrough();
  m.attach('bed', bed); m.attach('line', line, { live: true });
  bed.write(pcm(1000, 8).subarray(0, 7)); bed.write(pcm(1000, 8).subarray(7)); line.write(pcm(200, 8));
  await tick(); await tick();
  assert.deepEqual(ints(m.next(16)), Array(8).fill(Math.round((1000 * 0.5 + 200) * audio.MAX_LEVEL)));
  assert.ok(m.peaks.bed > 0 && m.peaks.line > 0 && m.peaks.programme === 0 && m.peaks.master > 0);
  assert.deepEqual(ints(m.next(16)), Array(8).fill(0), 'an input with nothing to give is silence, not a wait');
});

test('a loud sum clips, a muted strip is silent, and a muted master silences everything', async () => {
  const m = new audio.Mix({});
  const a = new PassThrough(), b = new PassThrough();
  m.attach('programme', a, { live: true }); m.attach('bed', b);
  a.write(pcm(30000, 4)); b.write(pcm(30000, 4)); await tick();
  assert.deepEqual(ints(m.next(8)), [32767, 32767, 32767, 32767]);
  m.setSettings({ programme: { muted: true } });
  a.write(pcm(-30000, 4)); b.write(pcm(-20000, 4)); await tick();
  assert.deepEqual(ints(m.next(8)), [-20000, -20000, -20000, -20000]);
  assert.equal(m.peaks.programme, 0);
  m.setSettings({ master: { muted: true } });
  a.write(pcm(9000, 4)); await tick();
  assert.deepEqual(ints(m.next(8)), [0, 0, 0, 0]);
});

test('a live input that has piled up is brought back to now; a file is never dropped', async () => {
  const m = new audio.Mix({});
  const live = new PassThrough({ highWaterMark: 1 << 22 }), file = new PassThrough({ highWaterMark: 1 << 22 });
  m.attach('line', live, { live: true }); m.attach('bed', file);
  for (let i = 0; i < 20; i++) { live.write(pcm(i + 1, audio.RATE / 5)); file.write(pcm(i + 1, audio.RATE / 5)); await tick(); }   // 2 s each, in 0.1 s chunks
  assert.ok(m.inputs.get('line').bytes <= audio.SECOND / 2 + audio.SECOND / 10, 'stale live sound was dropped');
  assert.ok(m.inputs.get('bed').bytes >= audio.SECOND, 'the file was paused with everything kept');
  m.setSettings({ line: { muted: true } });
  assert.equal(ints(m.next(8))[0], 1, 'the file still starts at its beginning');
});

test('sound inputs are read from the system\'s own list, and settings are made safe', () => {
  assert.deepEqual(audio.parseCapture(' 0 [NVidia         ]: HDA-Intel - HDA NVidia\n 2 [CODEC          ]: USB-Audio - USB AUDIO CODEC\n',
    '00-03: HDMI 0 : HDMI 0 : playback 1\n02-00: USB Audio : USB Audio : playback 1 : capture 1\n'), [{ device: 'plughw:2,0', name: 'USB AUDIO CODEC: USB Audio' }]);
  assert.deepEqual(audio.parseCapture('', ''), []);
  const s = audio.cleanSettings({ line: { device: 'hw:0; rm -rf /', level: 99 }, master: { muted: 1, level: -3 }, extra: { level: 1 } });
  assert.deepEqual(s, { master: { level: 0, muted: true }, programme: { level: 1, muted: false }, bed: { level: 1, muted: false }, line: { level: audio.MAX_LEVEL, muted: false, device: null } });
  assert.equal(audio.cleanSettings({ line: { device: 'plughw:2,0' } }).line.device, 'plughw:2,0');
  assert.deepEqual(audio.lineArgs('plughw:2,0').slice(3, 9), ['-f', 'alsa', '-ac', '2', '-i', 'plughw:2,0'], 'the device is one argument');
});
