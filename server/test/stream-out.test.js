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
  assert.deepEqual([set.body.audio.mix.bed.level, set.body.audio.mix.bed.muted], [0.6, true]);
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
  const mx = strips.body.audio.mix, lm = (s) => [s.level, s.muted];
  assert.deepEqual([lm(mx.master), lm(mx.programme), lm(mx.bed), lm(mx.line), mx.line.device], [[0.8, false], [1, true], [0.6, false], [1.2, false], null]);
  assert.deepEqual(lm((await call('GET', '/api/stream-out', A.jwt)).body.outputs.find((o) => o.id === A.stream).audio.mix.master), [0.8, false], 'kept');
  // A strip's processing, and the network feeds. Out-of-range controls are brought into range;
  // a feed is a network address and nothing else; its password is never sent back.
  const proc = await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { strips: [{ strip: 'line', hpf: true, eq: { low: -6, high: 99 }, gate: 0.4, comp: 2, fx: 0.25, denoise: 0.5 }, { strip: 'master', eq: { mid: 3 }, gate: 1 }],
    net_url: 'rtsp://cam:hunter2@192.0.2.9/audio', fx: { decay: 0.8 } });
  assert.equal(proc.status, 200, proc.text);
  const pm = proc.body.audio.mix;
  assert.deepEqual({ hpf: pm.line.hpf, eq: pm.line.eq, gate: pm.line.gate, comp: pm.line.comp, fx: pm.line.fx, denoise: pm.line.denoise }, { hpf: true, eq: { low: -6, mid: 0, high: 12 }, gate: 0.4, comp: 1, fx: 0.25, denoise: 0.5 });
  assert.deepEqual(pm.master, { level: 0.8, muted: false, eq: { low: 0, mid: 3, high: 0 } }, 'the master has an EQ and a fader, no gate');
  assert.equal(pm.fx.decay, 0.8);
  assert.match(pm.net.url, /^rtsp:\/\/cam:\*{3,}@192\.0\.2\.9\/audio$/);
  assert.doesNotMatch(proc.text, /hunter2/, 'a feed\'s password is not sent back');
  assert.match(db.prepare('SELECT audio_mix FROM stream_outputs WHERE id = ?').get(A.stream).audio_mix, /hunter2/, 'but is kept');
  await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { net_url: pm.net.url });
  assert.match(db.prepare('SELECT audio_mix FROM stream_outputs WHERE id = ?').get(A.stream).audio_mix, /hunter2/, 'saving the masked address changes nothing');
  for (const net_url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', 'not a url', 'concat:/etc/passwd|x']) {
    assert.equal((await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { net_url })).status, 400, net_url);
  }
  assert.equal((await call('POST', `/api/stream-out/${A.stream}/audio`, A.jwt, { net_url: null, net2_url: 'srt://0.0.0.0:9000?mode=listener' })).body.audio.mix.net2.url, 'srt://0.0.0.0:9000?mode=listener');
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
  const loud = new audio.Mix({});
  const la = new PassThrough(), lb = new PassThrough();
  loud.attach('programme', la, { live: true }); loud.attach('bed', lb);
  la.write(pcm(30000, 4)); lb.write(pcm(30000, 4)); await tick();
  const held = ints(loud.next(8));
  assert.ok(held.every((v) => v > 31000 && v <= 32767), 'the limiter holds a sum of 60000 just under full scale: ' + held);
  assert.ok(loud.limiting > 5, 'and says how much it is holding back');
  const m = new audio.Mix({ programme: { muted: true } });
  const a = new PassThrough(), b = new PassThrough();
  m.attach('programme', a, { live: true }); m.attach('bed', b);
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
  const s = audio.cleanSettings({ line: { device: 'hw:0; rm -rf /', level: 99, eq: { low: 'x', mid: -50 }, gate: 7, denoise: -1 }, master: { muted: 1, level: -3, comp: 1 }, extra: { level: 1 }, net: { url: 'file:///etc/passwd' } });
  assert.deepEqual(Object.keys(s).sort(), ['bed', 'fx', 'line', 'master', 'net', 'net2', 'programme']);
  assert.deepEqual(s.master, { level: 0, muted: true, eq: { low: 0, mid: 0, high: 0 } });
  assert.deepEqual(s.line, { level: audio.MAX_LEVEL, muted: false, hpf: false, eq: { low: 0, mid: -12, high: 0 }, gate: 1, comp: 0, fx: 0, device: null, denoise: 0, noise: null });
  assert.equal(s.net.url, null);
  const args = audio.netArgs('udp://239.0.0.1:5004');
  assert.equal(args[args.indexOf('-i') + 1], 'udp://239.0.0.1:5004', 'the feed is one argument');
  assert.doesNotMatch(args[args.indexOf('-protocol_whitelist') + 1], /file|concat|pipe/, 'the decoder cannot be pointed at a local file by what it fetches');
  assert.ok(!args.includes('-af'), 'the decode is plain: noise is taken out in the mixer, where the control is live');
  assert.equal(audio.cleanSettings({ line: { device: 'plughw:2,0' } }).line.device, 'plughw:2,0');
  assert.deepEqual(audio.lineArgs('plughw:2,0').slice(3, 9), ['-f', 'alsa', '-ac', '2', '-i', 'plughw:2,0'], 'the device is one argument');
});

/*
 * THE CHANNEL STRIP (lib/stream-dsp.js): high-pass, three-band EQ, gate, compressor, reverb send,
 * and the limiter on the way out. Measured, not asserted on faith: each stage has to do what its
 * name says to a known tone, and a strip with every control at neutral has to change nothing.
 */
const dsp = require('../lib/stream-dsp');
const sine = (f, amp, sec = 1) => { const b = new Float32Array(dsp.RATE * sec * 2); for (let i = 0; i < b.length / 2; i++) { const v = amp * Math.sin(2 * Math.PI * f * i / dsp.RATE); b[2 * i] = v; b[2 * i + 1] = v; } return b; };
const rmsDb = (b, from = 0.5) => { let s = 0, n = 0; for (let i = Math.floor(b.length * from); i < b.length; i++) { s += b[i] * b[i]; n++; } return 20 * Math.log10(Math.sqrt(s / n) || 1e-12); };
const through = (f, amp, p) => { const b = sine(f, amp); new dsp.Strip().run(b, dsp.cleanProcessing(p)); return rmsDb(b); };

test('a strip with every control at neutral changes nothing, and the mixer then passes samples exactly', async () => {
  const b = sine(1000, 0.25), before = Float32Array.from(b);
  new dsp.Strip().run(b, dsp.cleanProcessing({}));
  assert.ok(b.every((v, i) => v === before[i]));
  const m = new audio.Mix({});
  const src = new PassThrough(); m.attach('net', src, { live: true });
  src.write(pcm(-12345, 4)); await tick();
  assert.deepEqual(ints(m.next(8)), [-12345, -12345, -12345, -12345]);
});

test('each stage of the strip does what its name says to a known tone', () => {
  const ref = through(1000, 0.25, {});
  assert.ok(through(40, 0.25, { hpf: true }) < ref - 9, 'the high-pass takes out rumble');
  assert.ok(Math.abs(through(1000, 0.25, { hpf: true }) - ref) < 0.3, 'and leaves speech alone');
  assert.ok(through(60, 0.25, { eq: { low: 12 } }) > ref + 9 && Math.abs(through(5000, 0.25, { eq: { low: 12 } }) - ref) < 0.5, 'low shelf lifts the bottom only');
  assert.ok(through(1200, 0.25, { eq: { mid: -12 } }) < ref - 10, 'the mid bell cuts its band');
  assert.ok(through(12000, 0.25, { eq: { high: 6 } }) > ref + 4.5, 'high shelf lifts the top');
  assert.ok(through(1000, 0.001, { gate: 0.5 }) < -100, 'the gate closes on a signal under its threshold');
  assert.ok(Math.abs(through(1000, 0.25, { gate: 0.5 }) - ref) < 0.3, 'and is open for one over it');
  const loud = through(1000, 0.7, { comp: 0.5 }), quiet = through(1000, 0.01, { comp: 0.5 });
  assert.ok((rmsDb(sine(1000, 0.7)) - rmsDb(sine(1000, 0.01))) - (loud - quiet) > 8, 'the compressor brings loud and quiet closer together');
});

test('the limiter holds a hot sum under full scale and leaves anything below alone; the reverb has a tail', () => {
  const hot = sine(1000, 1.8); const lim = new dsp.Limiter(); lim.run(hot);
  assert.ok(hot.every((v) => Math.abs(v) <= 0.9801)); assert.ok(lim.reduction > 4);
  const fine = sine(1000, 0.5), was = Float32Array.from(fine); new dsp.Limiter().run(fine);
  assert.ok(fine.every((v, i) => v === was[i]));
  const rv = new dsp.Reverb(), wet = new Float32Array(dsp.RATE * 2), tail = new Float32Array(dsp.RATE * 2), later = new Float32Array(dsp.RATE * 2);
  rv.run(sine(1000, 0.5), wet, 0.5, true); rv.run(new Float32Array(dsp.RATE * 2), tail, 0.5, false);
  assert.ok(rmsDb(wet) > -30, 'it sounds'); assert.ok(rmsDb(tail, 0) > -60, 'and rings on after the input stops');
  for (let i = 0; i < 6; i++) rv.run(new Float32Array(dsp.RATE * 2), later, 0.5, false);
  const silent = new Float32Array(dsp.RATE * 2); rv.run(new Float32Array(dsp.RATE * 2), silent, 0.5, false);
  assert.ok(silent.every((v) => v === 0), 'then stops costing anything');
});

test('a channel\'s reverb send and EQ are heard in the mix', async () => {
  const dry = new audio.Mix({}), wet = new audio.Mix({ bed: { fx: 1 }, fx: { decay: 0.9 } });
  for (const m of [dry, wet]) { const s = new PassThrough({ highWaterMark: 1 << 22 }); m.attach('bed', s); const tone = sine(440, 0.3, 0.5), raw = Buffer.alloc(tone.length * 2); tone.forEach((v, i) => raw.writeInt16LE(Math.round(v * 32767), i * 2)); s.write(raw); }
  await tick(); await tick();
  dry.next(audio.SECOND / 2); wet.next(audio.SECOND / 2);
  const after = (m) => { const o = ints(m.next(audio.SECOND / 2)); return Math.max(...o.map(Math.abs)); };
  assert.equal(after(dry), 0, 'dry: nothing after the sound ends');
  assert.ok(after(wet) > 200, 'with the send up, the room is still ringing');
});

/*
 * NOISE FLOOR SUBTRACTION (lib/stream-dsp.js Denoiser). Measured on known signals: steady noise
 * has to go down by a real amount, what stands above the noise has to come through at its level,
 * and with the control at zero the strip is untouched.
 */
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
const hiss = (amp, sec) => { const b = new Float32Array(dsp.RATE * sec * 2); for (let i = 0; i < b.length; i++) b[i] = rnd() * amp; return b; };
const inBlocks = (dn, buf, amount) => { for (let i = 0; i < buf.length; i += 1764) dn.run(buf.subarray(i, Math.min(buf.length, i + 1764)), amount); return buf; };

test('noise subtraction takes steady noise down, with a learned print or without one, and leaves the signal at its level', async () => {
  const dn = new dsp.Denoiser();
  const learning = dn.learn(1.5);
  const heard = hiss(0.02, 2), was = Float32Array.from(heard);
  inBlocks(dn, heard, 0);
  assert.ok(heard.every((v, i) => v === was[i]), 'learning with the control at zero does not change the sound');
  const print = await learning;
  assert.ok(dsp.isPrint(print), 'the print is a short string that can be stored');
  dn.setPrint(print);
  const noise = hiss(0.02, 2), level = rmsDb(noise, 0);
  assert.ok(rmsDb(inBlocks(dn, noise, 0.6)) < level - 12, 'noise alone goes down by more than 12 dB');
  const both = hiss(0.02, 2), tone = sine(1000, 0.3, 2); for (let i = 0; i < both.length; i++) both[i] += tone[i];
  assert.ok(Math.abs(rmsDb(inBlocks(dn, both, 0.6)) - rmsDb(tone)) < 0.5, 'a tone over the noise comes through at its own level');
  // Speech-like: bursts of tone with gaps. The bursts keep their level.
  const bursts = hiss(0.02, 3); let burstSum = 0, n = 0;
  for (let i = 0; i < bursts.length / 2; i++) { if (Math.floor(i / (dsp.RATE * 0.25)) % 2 === 0) { const v = 0.3 * Math.sin(2 * Math.PI * 700 * i / dsp.RATE); bursts[2 * i] += v; bursts[2 * i + 1] += v; } }
  inBlocks(dn, bursts, 0.6);
  for (let i = dsp.RATE; i < bursts.length / 2; i++) { const j = i - dsp.NFFT; if (Math.floor(j / (dsp.RATE * 0.25)) % 2 === 0 && (j % (dsp.RATE * 0.25)) > 2000) { burstSum += bursts[2 * i] ** 2; n++; } }
  assert.ok(Math.abs(10 * Math.log10(burstSum / n) - 20 * Math.log10(0.3 / Math.SQRT2)) < 1, 'bursts between gaps keep their level');
  // No print: the estimate comes from the signal itself.
  const auto = new dsp.Denoiser(), n2 = hiss(0.02, 4);
  assert.ok(rmsDb(inBlocks(auto, n2, 0.6)) < level - 12, 'and without a print the running estimate finds the floor');
  // Off is off.
  const off = sine(440, 0.4), ref = Float32Array.from(off); new dsp.Denoiser().run(off, 0);
  assert.ok(off.every((v, i) => v === ref[i]));
});

test('a noise print is kept only when it is one, belongs to its strip, and is never sent to the desk', async () => {
  const print = Buffer.alloc(513, 90).toString('base64');
  const s = audio.cleanSettings({ line: { noise: print, denoise: 0.4 }, bed: { noise: '../../etc/passwd' }, net: { noise: { a: 1 } }, programme: { denoise: 2 } });
  assert.equal(s.line.noise, print); assert.equal(s.bed.noise, null); assert.equal(s.net.noise, null); assert.equal(s.programme.denoise, 1);
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Noise', kind: 'rtmp', url: 'rtmp://ingest.example.com/live', key: KEY })).body;
  const off = await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { learn_noise: 'line' });
  assert.equal(off.status, 409, 'there is nothing to listen to while the stream is off');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { learn_noise: 'master' })).status, 400);
  db.prepare('UPDATE stream_outputs SET audio_mix = ? WHERE id = ?').run(JSON.stringify({ line: { noise: print, denoise: 0.4 } }), so.id);
  const seen = await call('GET', '/api/stream-out', A.jwt);
  const mix = seen.body.outputs.find((o) => o.id === so.id).audio.mix;
  assert.equal(mix.line.noise, true); assert.equal(mix.bed.noise, false);
  assert.ok(!seen.text.includes(print), 'the desk is told a print is kept, not handed it');
  const turned = await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [{ strip: 'line', denoise: 0.7 }] });
  assert.equal(turned.body.audio.mix.line.denoise, 0.7);
  assert.equal(JSON.parse(db.prepare('SELECT audio_mix FROM stream_outputs WHERE id = ?').get(so.id).audio_mix).line.noise, print, 'turning a control keeps the print');
  const gone = await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { forget_noise: 'line' });
  assert.equal(gone.body.audio.mix.line.noise, false);
  await call('DELETE', `/api/stream-out/${so.id}`, A.jwt);
});

/*
 * RECORDING. A stream can be written to a file on the server as well, or only recorded. What has
 * to hold: the file goes where nothing serves it, a workspace reaches only its own recordings and
 * only by a name this module could have written, a download link is a random ticket for one file,
 * and the stream key cannot break out of the encoder's output syntax.
 */
test('an output can be recorded, or be a recording only, and the encoder is told so safely', () => {
  const rec = streamOut.validate({ kind: 'record', name: 'Tape' });
  assert.ok(rec.ok); assert.deepEqual([rec.value.url, rec.value.key, rec.value.record], [null, '', true]);
  assert.equal(streamOut.validate({ kind: 'youtube', name: 'Y', key: 'k', record: true }).value.record, true);
  assert.equal(streamOut.validate({ kind: 'youtube', name: 'Y', key: 'k', record: 'yes' }).value.record, false);
  const base = { width: 1280, height: 720, fps: 30, bitrate_k: 3500 };
  const only = streamOut.ffmpegArgs({ ...base, kind: 'record', target: null, recordFile: '/r/a.mkv' });
  assert.deepEqual(only.slice(-3), ['-f', 'matroska', '/r/a.mkv']);
  const plain = streamOut.ffmpegArgs({ ...base, kind: 'rtmp', target: 'rtmp://h/live/k' });
  assert.deepEqual(plain.slice(-3), ['-f', 'flv', 'rtmp://h/live/k'], 'without recording nothing changes');
  const both = streamOut.ffmpegArgs({ ...base, kind: 'rtmp', target: "rtmp://h/live/a|b[f=null]'c\\d", recordFile: '/r/a.mkv' });
  assert.deepEqual(both.slice(-3, -1), ['-f', 'tee']);
  assert.equal(both[both.length - 1], "[f=flv:onfail=abort]rtmp://h/live/a\\|b\\[f=null\\]\\'c\\\\d|[f=matroska:onfail=ignore]/r/a.mkv",
    'a key cannot add an output or an option: the stream ending ends the encoder, the file failing does not');
  const srt = streamOut.ffmpegArgs({ ...base, kind: 'srt', target: 'srt://h:9000?streamid=x', recordFile: '/r/a.mkv' });
  assert.match(srt[srt.length - 1], /^\[f=mpegts:onfail=abort\]srt:/);
});

test('a recording is named by this server, lives in its workspace\'s own directory, and only such names resolve', () => {
  const ws = 'ws-1234', dir = streamOut.recordingsDir(ws);
  assert.ok(dir.endsWith(path.join('uploads', 'recordings', ws)));
  assert.ok(!dir.includes(path.join('uploads', 'content')), 'not under the directory the server serves');
  assert.equal(streamOut.recordingPath(ws, 'Show-20261110-101500.mkv'), path.join(dir, 'Show-20261110-101500.mkv'));
  for (const bad of ['../x.mkv', '..%2Fx.mkv', 'a/b.mkv', 'x.mp4', '.mkv', '', null, 'a\0.mkv', 'x.mkv/..', '../../db/remote_display.db']) assert.equal(streamOut.recordingPath(ws, bad), null, String(bad));
  assert.equal(streamOut.recordingsDir('../../etc'), streamOut.recordingsDir('etc'), 'a workspace id cannot climb either');
});

test('recordings are listed, linked and deleted per workspace; a link is a ticket for one file', async () => {
  const dirA = path.join(DATA_DIR, 'uploads', 'recordings', A.wsId); fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'Show-20261110-101500.mkv'), 'matroska-bytes'); fs.writeFileSync(path.join(dirA, 'notes.txt'), 'x');
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Rec', kind: 'record' })).body;
  assert.deepEqual([so.kind, so.has_key, so.record, so.file_only], ['record', false, true, true]);
  const yt = (await call('POST', '/api/stream-out', A.jwt, { name: 'Both', kind: 'youtube', key: KEY, record: true })).body;
  assert.equal(yt.record, true);
  assert.equal((await call('PUT', `/api/stream-out/${yt.id}`, A.jwt, { record: false })).body.record, false);
  assert.equal((await call('PUT', `/api/stream-out/${yt.id}`, A.jwt, { name: 'Both again' })).body.record, false, 'a change that does not mention it leaves it');
  assert.equal((await call('PUT', `/api/stream-out/${yt.id}`, V.jwt, { record: true })).status, 403);
  const mineList = await call('GET', '/api/stream-out/recordings', A.jwt);
  assert.deepEqual(mineList.body.recordings.map((r) => [r.name, r.bytes, r.recording]), [['Show-20261110-101500.mkv', 14, false]], 'only recordings are listed');
  assert.deepEqual((await call('GET', '/api/stream-out', A.jwt)).body.recordings.map((r) => r.name), ['Show-20261110-101500.mkv']);
  assert.deepEqual((await call('GET', '/api/stream-out/recordings', B.jwt)).body.recordings, [], 'another workspace sees none of them');
  assert.equal((await call('POST', '/api/stream-out/recordings/Show-20261110-101500.mkv/link', B.jwt)).status, 404);
  assert.equal((await call('DELETE', '/api/stream-out/recordings/Show-20261110-101500.mkv', B.jwt)).status, 404);
  assert.equal((await call('DELETE', '/api/stream-out/recordings/Show-20261110-101500.mkv', V.jwt)).status, 403, 'a read-only member cannot delete');
  assert.equal((await call('POST', '/api/stream-out/recordings/notes.txt/link', A.jwt)).status, 404);
  assert.equal((await call('POST', '/api/stream-out/recordings/' + encodeURIComponent('../../db/remote_display.db') + '/link', A.jwt)).status, 404);
  assert.equal((await call('GET', '/api/stream-out/recordings')).status, 401);
  const link = await call('POST', '/api/stream-out/recordings/Show-20261110-101500.mkv/link', A.jwt);
  assert.match(link.body.url, /^\/stream-recording\/[A-Za-z0-9_-]{43}$/);
  const got = await call('GET', link.body.url);
  assert.equal(got.status, 200); assert.equal(got.text, 'matroska-bytes');
  assert.equal((await call('GET', '/stream-recording/' + 'A'.repeat(43))).status, 404, 'a guessed ticket is nothing');
  assert.equal((await call('DELETE', '/api/stream-out/recordings/Show-20261110-101500.mkv', A.jwt)).status, 200);
  assert.ok(!fs.existsSync(path.join(dirA, 'Show-20261110-101500.mkv'))); assert.ok(fs.existsSync(path.join(dirA, 'notes.txt')), 'and nothing else is touched');
  assert.equal((await call('GET', link.body.url)).status, 404, 'the ticket does not outlive the file');
  for (const id of [so.id, yt.id]) await call('DELETE', `/api/stream-out/${id}`, A.jwt);
});
