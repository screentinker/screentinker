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
  return { status: res.status, body: json, text, headers: res.headers };
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
  assert.deepEqual({ hpf: pm.line.hpf, eq: pm.line.eq, gate: pm.line.gate, comp: pm.line.comp, fx: pm.line.fx, denoise: pm.line.denoise }, { hpf: true, eq: { low: -6, mid: 0, high: 12, low_f: 120, lomid: 0, lomid_f: 400, lomid_q: 1, mid_f: 1200, mid_q: 0.9, high_f: 8000 }, gate: 0.4, comp: 1, fx: 0.25, denoise: 0.5 });
  assert.deepEqual([pm.master.level, pm.master.muted, pm.master.eq.mid, pm.master.gate], [0.8, false, 3, undefined], 'the master has an EQ, a compressor and a fader, no gate');
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
    '00-03: HDMI 0 : HDMI 0 : playback 1\n02-00: USB Audio : USB Audio : playback 1 : capture 1\n'), [{ device: 'plughw:2,0', channels: 2, name: 'USB AUDIO CODEC: USB Audio' }]);
  assert.deepEqual(audio.parseCapture('', ''), []);
  const s = audio.cleanSettings({ line: { device: 'hw:0; rm -rf /', level: 99, eq: { low: 'x', mid: -50 }, gate: 7, denoise: -1 }, master: { muted: 1, level: -3, comp: 1 }, extra: { level: 1 }, net: { url: 'file:///etc/passwd' } });
  assert.deepEqual(Object.keys(s).sort(), ['bed', 'console', 'fx', 'line', 'master', 'mic', 'net', 'net2', 'programme']);
  assert.deepEqual(s.master, { level: 0, muted: true, eq: { low: 0, mid: 0, high: 0, low_f: 120, lomid: 0, lomid_f: 400, lomid_q: 1, mid_f: 1200, mid_q: 0.9, high_f: 8000 }, comp: 1, cmp: { on: false, thr: -20, ratio: 3, att: 8, rel: 200, gain: 0 } });
  assert.deepEqual(s.line, { level: audio.MAX_LEVEL, muted: false, trim: 0, inv: false, pan: 0, hpf: false, hpf_f: 80, lpf: 0, eq: { low: 0, mid: -12, high: 0, low_f: 120, lomid: 0, lomid_f: 400, lomid_q: 1, mid_f: 1200, mid_q: 0.9, high_f: 8000 }, gate: 1, comp: 0, cmp: { on: false, thr: -20, ratio: 3, att: 8, rel: 200, gain: 0 }, deess: 0, chorus: 0, fx: 0, dly: 0, duck: 0, device: null, denoise: 0, noise: null });
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

/*
 * METERS. A meter has to show a peak to a desk that only looks a few times a second, so the mixer
 * holds each strip's loudest moment and lets it fall at a steady rate; and the meters of one
 * workspace are not another's to read.
 */
test('a strip\'s meter holds its peak and falls back gradually, instead of showing only the last instant', async () => {
  const m = new audio.Mix({});
  const src = new PassThrough(); m.attach('net', src, { live: true });
  src.write(pcm(16384, 882)); await tick();
  m.next(882 * 4);
  assert.ok(Math.abs(m.held.net - 0.5) < 0.001 && Math.abs(m.held.master - 0.5) < 0.001, 'the peak is there');
  m.next(882 * 4);                                                     // 20 ms of nothing
  assert.ok(m.held.net < 0.5 && m.held.net > 0.45, 'a moment later it has only begun to fall');
  for (let i = 0; i < 50; i++) m.next(882 * 4);                        // one more second
  assert.ok(m.held.net < 0.06 && m.held.net > 0.04, 'a second later it is 20 dB down');
  for (let i = 0; i < 300; i++) m.next(882 * 4);
  assert.equal(m.held.net, 0, 'and it comes to rest at nothing');
});

test('the meters endpoint lists only running outputs of the caller\'s workspace', async () => {
  assert.deepEqual((await call('GET', '/api/stream-out/levels', A.jwt)).body, { levels: {} });
  assert.deepEqual((await call('GET', '/api/stream-out/levels', V.jwt)).body, { levels: {} }, 'a read-only member may watch the meters');
  assert.equal((await call('GET', '/api/stream-out/levels')).status, 401);
});

/*
 * THE DESK MICROPHONE and STANDBY. The microphone of the computer the desk is open on arrives as
 * pieces of the browser's recording; only someone who may operate the workspace's streams can
 * send them, only into an output that is running, and only something that is a piece of sound.
 */
test('microphone sound is taken only from an operator of the workspace, into a running output, as sound', async () => {
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Mic', kind: 'record' })).body;
  const piece = Buffer.from('not really opus').toString('base64');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, A.jwt, { chunk: piece, first: true })).status, 409, 'nothing is running to take it');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, A.jwt, { chunk: '<script>alert(1)</script>' })).status, 400);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, A.jwt, { chunk: 'A'.repeat(400001) })).status, 400, 'a piece has a size');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, A.jwt, {})).status, 400);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, B.jwt, { chunk: piece, first: true })).status, 404, 'not another workspace\'s output');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, V.jwt, { chunk: piece, first: true })).status, 403, 'not a read-only member');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, null, { chunk: piece })).status, 401);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/mic`, A.jwt, { stop: true })).status, 200, 'closing a microphone that is not open is fine');
  assert.ok(audio.INPUTS.includes('mic')); assert.equal(streamOut.pushMic('no-such-output', Buffer.alloc(4), true), false);
  const args = audio.micArgs(); assert.equal(args[args.indexOf('-i') + 1], 'pipe:0'); assert.equal(args[args.indexOf('-f') + 1], 'matroska', 'it is decoded as the one format a browser records, from the pipe and nowhere else');
  const strip = await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [{ strip: 'mic', level: 0.8, gate: 0.3, denoise: 0.5 }] });
  assert.deepEqual([strip.body.audio.mix.mic.level, strip.body.audio.mix.mic.gate, strip.body.audio.mix.mic.denoise], [0.8, 0.3, 0.5], 'the microphone is a strip like the others');
  await call('DELETE', `/api/stream-out/${so.id}`, A.jwt);
});

test('the desk is told what graphic is over a stream, so its Program monitor can show it', async () => {
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Gfx', kind: 'record' })).body;
  assert.equal(so.graphic_on, null);
  await call('POST', `/api/stream-out/${so.id}/gfx`, A.jwt, { kind: 'lower-third', a: 'Dana', b: 'Ops', accent: '#ff2a1f' });
  const on = (await call('GET', '/api/stream-out', A.jwt)).body.outputs.find((o) => o.id === so.id).graphic_on;
  assert.match(on.uri, /^\/gfx\/lower-third\?a=Dana&b=Ops/); assert.equal(on.position, 'bottom-left'); assert.ok(Math.abs(on.w - 0.62) < 0.01 && Math.abs(on.h - 0.2) < 0.01);
  db.prepare('UPDATE stream_outputs SET gfx_json = ? WHERE id = ?').run(JSON.stringify({ uri: 'https://evil.example/x', position: 'center', width: 10, height: 10 }), so.id);
  assert.equal((await call('GET', '/api/stream-out', A.jwt)).body.outputs.find((o) => o.id === so.id).graphic_on, null, 'only this server\'s own graphics pages are handed to the desk to frame');
  await call('POST', `/api/stream-out/${so.id}/gfx/clear`, A.jwt);
  assert.equal((await call('GET', '/api/stream-out', A.jwt)).body.outputs.find((o) => o.id === so.id).graphic_on, null);
  await call('DELETE', `/api/stream-out/${so.id}`, A.jwt);
});

/*
 * A CONSOLE ON THE SERVER. A multichannel interface (a mixing console over USB) is captured once
 * and each of its first N channels becomes a strip. What has to hold: every channel lands on its
 * own strip and nowhere else, however the capture is cut into chunks; the device is one the
 * server really has; and the number of strips is bounded.
 */
test('each channel of a multichannel capture feeds its own strip, whatever sizes the chunks arrive in', async () => {
  const total = 6, count = 3, frames = 441;
  const raw = Buffer.alloc(frames * total * 2);
  for (let f = 0; f < frames; f++) for (let c = 0; c < total; c++) raw.writeInt16LE((c + 1) * 1000, (f * total + c) * 2);   // channel n carries the value n * 1000
  const m = new audio.Mix({ console: { device: 'plughw:2,0', channels: total, count }, c2: { muted: true }, c3: { level: 0.5, label: ' Pulpit ' } });
  assert.deepEqual(audio.inputNames(m.settings).slice(-3), ['c1', 'c2', 'c3']); assert.equal(m.settings.c3.label, 'Pulpit');
  const src = new PassThrough(), names = audio.channelNames(count), got = { c1: [], c2: [], c3: [] };
  for (const n of names) m.open(n);
  audio.splitChannels(src, total, count, (i, buf) => { got[names[i]].push(...ints(buf)); m.push(names[i], buf); });
  for (const cut of [1, 7, 100, 1001, raw.length]) src.write(raw.subarray(cut === 1 ? 0 : [0, 1, 8, 108, 1109][[1, 7, 100, 1001, raw.length].indexOf(cut)], Math.min(raw.length, [1, 8, 108, 1109, raw.length][[1, 7, 100, 1001, raw.length].indexOf(cut)])));
  await tick(); await tick();
  assert.equal(got.c1.length, frames * 2); assert.ok(got.c1.every((v) => v === 1000) && got.c2.every((v) => v === 2000) && got.c3.every((v) => v === 3000), 'no channel bleeds into another, and each is on both sides');
  const out = ints(m.next(frames * 4));
  assert.ok(out.every((v) => v === 1000 + 1500), 'the mix is channel 1, plus channel 3 at half, with channel 2 muted');
  assert.ok(m.peaks.c1 > 0 && m.peaks.c2 === 0 && m.peaks.c3 > 0);
});

test('a console\'s settings are bounded, and it must be a device this server has', async () => {
  const big = audio.cleanSettings({ console: { device: 'plughw:1,0', channels: 999, count: 999 } });
  assert.deepEqual(big.console, { device: 'plughw:1,0', channels: 64, count: audio.MAX_CHANNELS });
  assert.deepEqual(audio.cleanSettings({ console: { device: 'hw:0; reboot', channels: 8, count: 8 }, c1: { level: 1 } }).console, { device: null, channels: 8, count: 0 });
  assert.ok(!('c1' in audio.cleanSettings({ c1: { level: 1 } })), 'a channel strip exists only while the console brings it in');
  assert.equal(audio.cleanSettings({ console: { device: 'plughw:1,0', channels: 4, count: 16 } }).console.count, 4, 'no more strips than the device has channels');
  const args = audio.consoleArgs('plughw:3,0', 18);
  assert.deepEqual(args.slice(3, 9), ['-f', 'alsa', '-ac', '18', '-i', 'plughw:3,0']);
  assert.equal(audio.captureChannels('Playback:\n  Interface 1\n    Channels: 4\nCapture:\n  Interface 2\n    Altset 1\n    Channels: 18\n    Altset 2\n    Channels: 2\n'), 18);
  assert.equal(audio.captureChannels('Playback:\n    Channels: 2\n'), null);
  assert.deepEqual(audio.parseCapture(' 2 [AR16c          ]: USB-Audio - StudioLive AR16c\n', '02-00: USB Audio : USB Audio : playback 1 : capture 1\n', { 2: 'Capture:\n    Channels: 18\n' }),
    [{ device: 'plughw:2,0', channels: 18, name: 'StudioLive AR16c: USB Audio' }]);
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Console', kind: 'record' })).body;
  assert.equal((await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { console_device: 'plughw:9,0', console_count: 8 })).status, 400, 'not a device of this server');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { console_count: 9999 })).status, 400);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [{ strip: 'c1', level: 1 }] })).status, 400, 'no console, no channel strips');
  db.prepare('UPDATE stream_outputs SET audio_mix = ? WHERE id = ?').run(JSON.stringify({ console: { device: 'plughw:2,0', channels: 18, count: 2 } }), so.id);
  const named = await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [{ strip: 'c2', level: 0.7, gate: 0.2, label: 'Pastor <b>' }] });
  assert.equal(named.status, 200); assert.deepEqual([named.body.audio.mix.c2.level, named.body.audio.mix.c2.gate, named.body.audio.mix.c2.label], [0.7, 0.2, 'Pastor <b>']);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [{ strip: 'c3', level: 1 }] })).status, 400);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [{ strip: 'bed', label: 'x' }] })).body.audio.mix.bed.label, undefined, 'only console channels are named');
  await call('DELETE', `/api/stream-out/${so.id}`, A.jwt);
});

/*
 * THE REST OF THE CHANNEL STRIP: trim and polarity, the filters, the parametric bands, the
 * compressor's own controls, the de-esser, chorus, pan, the delay, and ducking. Measured on known
 * signals, like the stages above.
 */
const sides = (b) => { let l = 0, r = 0; for (let i = Math.floor(b.length / 2) & ~1; i < b.length; i += 2) { l = Math.max(l, Math.abs(b[i])); r = Math.max(r, Math.abs(b[i + 1])); } return [l, r]; };
test('trim, polarity, the filters and the parametric bands do what a console\'s do', () => {
  const ref = through(1000, 0.1, {});
  assert.ok(Math.abs(through(1000, 0.1, { trim: 12 }) - (ref + 12)) < 0.1, 'trim is gain in dB');
  const inv = sine(1000, 0.1), was = Float32Array.from(inv); new dsp.Strip().run(inv, dsp.cleanProcessing({ inv: true }));
  assert.ok(inv.every((v, i) => v === -was[i]), 'polarity turns the wave over');
  assert.ok(through(200, 0.1, { hpf: true, hpf_f: 300 }) < ref - 5 && through(200, 0.1, { hpf: true, hpf_f: 40 }) > ref - 0.5, 'the high-pass is where it is put');
  assert.ok(through(12000, 0.1, { lpf: 4000 }) < ref - 15 && Math.abs(through(500, 0.1, { lpf: 4000 }) - ref) < 0.3, 'the low-pass takes the top off and leaves the rest');
  assert.ok(through(3000, 0.1, { eq: { mid: 9, mid_f: 3000 } }) > ref + 8 && through(1200, 0.1, { eq: { mid: 9, mid_f: 3000, mid_q: 4 } }) < ref + 1.5, 'a bell is moved to its frequency, and narrowed');
  assert.ok(through(400, 0.1, { eq: { lomid: -9 } }) < ref - 8 && Math.abs(through(4000, 0.1, { eq: { lomid: -9 } }) - ref) < 0.5, 'the low-mid band is its own band');
  assert.ok(through(300, 0.1, { eq: { low: 9, low_f: 300 } }) > through(300, 0.1, { eq: { low: 9, low_f: 60 } }) + 3, 'a shelf turns over where it is set');
});

test('the compressor answers to its own threshold, ratio and make-up; the de-esser takes only the top; chorus adds a moving double', () => {
  const on = (o) => ({ cmp: { on: true, ...o } });
  const ref = through(1000, 0.5, {});
  assert.ok(Math.abs(through(1000, 0.5, on({ thr: 0 })) - ref) < 0.2, 'under the threshold nothing happens');
  const four = ref - through(1000, 0.5, on({ thr: -26, ratio: 4 })), ten = ref - through(1000, 0.5, on({ thr: -26, ratio: 20 }));
  assert.ok(four > 12 && four < 17 && ten > four + 3, 'over it, the signal comes down by the ratio');
  assert.ok(Math.abs(through(1000, 0.5, on({ thr: 0, gain: 6 })) - (ref + 6)) < 0.3, 'make-up gain is gain');
  assert.ok(through(1000, 0.5, { comp: 0.5, cmp: { on: true, thr: 0 } }) > through(1000, 0.5, { comp: 0.5 }) + 3, 'its own controls, when on, replace the one knob');
  const sRef = through(8000, 0.3, {});
  assert.ok(through(8000, 0.3, { deess: 0.8 }) < sRef - 6, 'a loud "s" is brought down');
  assert.ok(Math.abs(through(300, 0.3, { deess: 0.8 }) - through(300, 0.3, {})) < 0.3, 'a vowel is not');
  const dry = sine(440, 0.2), wet = sine(440, 0.2); new dsp.Strip().run(wet, dsp.cleanProcessing({ chorus: 1 }));
  let differs = 0; for (let i = 4096; i < wet.length; i++) if (Math.abs(wet[i] - dry[i]) > 0.01) differs++;
  assert.ok(differs > wet.length / 4, 'the chorus changes the signal'); assert.ok(wet.every((v) => Math.abs(v) < 0.35), 'and stays in bounds');
});

test('pan places a strip, the delay brings it back later, and a ducked strip gives way while someone talks', async () => {
  const feed = (m, name, amp, sec = 1) => { const s = new PassThrough({ highWaterMark: 1 << 24 }); m.attach(name, s); const t = sine(440, amp, sec), raw = Buffer.alloc(t.length * 2); t.forEach((v, i) => raw.writeInt16LE(Math.round(v * 32767), i * 2)); s.write(raw); };
  const peakOf = (buf) => Math.max(...ints(buf).map(Math.abs));
  const left = new audio.Mix({ bed: { pan: -1 } }), half = new audio.Mix({ bed: { pan: 0.5 } });
  feed(left, 'bed', 0.3); feed(half, 'bed', 0.3); await tick(); await tick();
  const fa = (m) => { const o = ints(m.next(audio.SECOND / 4)); const f = new Float32Array(o.length); o.forEach((v, i) => { f[i] = v / 32768; }); return sides(f); };
  const [l1, r1] = fa(left), [l2, r2] = fa(half);
  assert.ok(l1 > 0.29 && r1 === 0, 'hard left is on the left only'); assert.ok(Math.abs(l2 - 0.15) < 0.01 && r2 > 0.29, 'half right leaves the right whole and halves the left');
  // Delay: half a second of tone, sent to a 300 ms echo. After the tone ends the echo is still arriving; dry, there is nothing.
  const dry = new audio.Mix({}), echo = new audio.Mix({ bed: { dly: 1 }, fx: { delay_ms: 300, delay_fb: 0 } });
  for (const m of [dry, echo]) feed(m, 'bed', 0.3, 0.5);
  await tick(); await tick();
  dry.next(audio.SECOND / 2); echo.next(audio.SECOND / 2);
  assert.equal(peakOf(dry.next(audio.SECOND / 5)), 0); assert.ok(peakOf(echo.next(audio.SECOND / 5)) > 8000, 'the echo of the last 300 ms is heard after the sound ends');
  echo.next(audio.SECOND / 2);
  assert.equal(peakOf(echo.next(audio.SECOND / 5)), 0, 'with no feedback it comes back once');
  assert.deepEqual(audio.cleanSettings({ fx: { delay_ms: 99999, delay_fb: 5, decay: 'x' } }).fx, { decay: 0.5, delay_ms: 1500, delay_fb: 0.9 });
  // Ducking: the bed plays alone at full level; when the microphone carries signal the bed gives way, and comes back after.
  const m = new audio.Mix({ bed: { duck: 1 }, mic: { muted: false } });
  feed(m, 'bed', 0.3, 6); await tick(); await tick();
  const bedNow = () => { m.next(882 * 4); return m.peaks.bed; };
  for (let i = 0; i < 10; i++) bedNow();
  assert.ok(bedNow() > 0.29, 'alone, the bed is at its level');
  const talk = m.open('mic', { live: true }); assert.ok(talk);
  const voice = sine(300, 0.2, 1), raw = Buffer.alloc(voice.length * 2); voice.forEach((v, i) => raw.writeInt16LE(Math.round(v * 32767), i * 2));
  for (let i = 0; i < 20; i++) { m.push('mic', raw.subarray(i * 882 * 4, (i + 1) * 882 * 4)); bedNow(); }
  assert.ok(m.peaks.bed < 0.03, 'while the microphone talks the bed is down by 24 dB');
  for (let i = 0; i < 80; i++) bedNow();
  assert.ok(m.peaks.bed > 0.29, 'and it comes back when the talking stops');
});

test('the new strip controls are stored through the API in range, and the master has a compressor', async () => {
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Strip', kind: 'record' })).body;
  const r = await call('POST', `/api/stream-out/${so.id}/audio`, A.jwt, { strips: [
    { strip: 'mic', trim: 99, inv: true, pan: -3, hpf_f: 5, lpf: 500, deess: 0.4, chorus: 2, dly: 0.3, duck: 0.5, eq: { lomid: 4, mid_f: 99999, mid_q: 0 }, cmp: { on: true, thr: -30, ratio: 99 } },
    { strip: 'master', comp: 0.3, cmp: { gain: 3 }, pan: 1, duck: 1 }], fx: { delay_ms: 500, delay_fb: 0.5 } });
  assert.equal(r.status, 200, r.text);
  const mic = r.body.audio.mix.mic, master = r.body.audio.mix.master;
  assert.deepEqual([mic.trim, mic.inv, mic.pan, mic.hpf_f, mic.lpf, mic.deess, mic.chorus, mic.dly, mic.duck], [40, true, -1, 20, 1000, 0.4, 1, 0.3, 0.5]);
  assert.deepEqual([mic.eq.lomid, mic.eq.mid_f, mic.eq.mid_q, mic.cmp.on, mic.cmp.thr, mic.cmp.ratio, mic.cmp.att], [4, 8000, 0.3, true, -30, 20, 8]);
  assert.deepEqual([master.comp, master.cmp.gain, master.pan, master.duck], [0.3, 3, undefined, undefined], 'the master takes a compressor, not a channel\'s controls');
  assert.deepEqual(r.body.audio.mix.fx, { decay: 0.5, delay_ms: 500, delay_fb: 0.5 });
  await call('DELETE', `/api/stream-out/${so.id}`, A.jwt);
});

/*
 * GUESTS (lib/mixer-guests.js). A guest comes in by an invite link, offers a connection, and is
 * backstage until the operator puts them on air. What has to hold: the link is the only way in
 * and can be closed; a guest can act only as themselves; only the workspace's operators run the
 * green room; only the output's own renderer answers for it; and what passes through is checked.
 */
const guestsLib = require('../lib/mixer-guests');
test('the green room: invite, join, backstage, on air, layouts, and its limits', () => {
  const out = { id: 'out-1', workspace_id: 'ws-1' }, t0 = 1e12;
  const token = guestsLib.invite(out, t0);
  assert.ok(token.length >= 40); assert.equal(guestsLib.invite(out, t0), token, 'an output has one invite at a time');
  assert.equal(guestsLib.join('x'.repeat(43), 'Eve', t0).status, 404);
  const a = guestsLib.join(token, ' Priya <b>N.</b>\n', t0).guest, b = guestsLib.join(token, '', t0).guest;
  assert.equal(a.name, 'Priya bN./b'); assert.equal(b.name, 'Guest 2', 'a guest with no name is numbered');
  assert.equal(guestsLib.who(token, a.id, b.key, t0), null, 'a guest is only themselves'); assert.equal(guestsLib.who(token, a.id, a.key, t0), a);
  assert.equal(guestsLib.setOffer(a, 'not sdp'), false); assert.equal(guestsLib.setOffer(a, 'v=0\r\n' + 'a'.repeat(70000)), false);
  assert.equal(guestsLib.setOffer(a, 'v=0\r\no=guest'), true);
  assert.deepEqual(guestsLib.stateFor(a, true), { on_air: false, studio: true, need_offer: false, answer: null, seq: 1, name: 'Priya bN./b', desks: [] });
  // The renderer is handed the offer of anyone it holds no connection for, and only then.
  const first = guestsLib.forRenderer('out-1', '', t0);
  assert.equal(first.list.length, 2); assert.equal(first.list[0].offer, 'v=0\r\no=guest'); assert.equal(first.list[1].offer, undefined, 'no offer yet from the second');
  assert.equal(guestsLib.forRenderer('out-1', `${a.id}:1`, t0).list[0].offer, undefined);
  assert.equal(guestsLib.fromRenderer('other-output', { guest_id: a.id, seq: 1, answer: 'v=0\r\nanswer' }), false, 'another output\'s renderer cannot answer for this one');
  assert.equal(guestsLib.fromRenderer('out-1', { guest_id: a.id, seq: 7, answer: 'v=0\r\nanswer' }), false, 'an answer is to the offer that is current');
  assert.equal(guestsLib.fromRenderer('out-1', { guest_id: a.id, seq: 1, answer: 'v=0\r\nanswer', state: 'connected', thumb: 'data:image/jpeg;base64,AAAA' }), true);
  assert.equal(guestsLib.stateFor(a, true).answer, 'v=0\r\nanswer');
  assert.equal(guestsLib.fromRenderer('out-1', { guest_id: a.id, thumb: 'data:text/html;base64,PHNjcmlwdD4=' }), true); assert.equal(a.thumb, 'data:image/jpeg;base64,AAAA', 'a thumbnail is a JPEG or it is not kept');
  // A renderer that no longer holds an answered connection: the guest is asked to offer again.
  assert.equal(guestsLib.forRenderer('out-1', '', t0).list[0].offer, undefined); assert.equal(guestsLib.stateFor(a, true).need_offer, true);
  // On air, within the limit; layouts are a closed set.
  assert.equal(guestsLib.setOnAir('out-1', a.id, true).ok, true); assert.equal(guestsLib.setOnAir('other-output', b.id, true).status, 404);
  const more = []; for (let i = 0; i < guestsLib.MAX_GUESTS - 2; i++) more.push(guestsLib.join(token, 'G', t0).guest);
  assert.equal(guestsLib.join(token, 'one too many', t0).status, 409, 'the green room has a size');
  for (const g of [b, ...more.slice(0, 2)]) assert.equal(guestsLib.setOnAir('out-1', g.id, true).ok, true);
  assert.equal(guestsLib.setOnAir('out-1', more[2].id, true).status, 409, 'and so does the air');
  assert.equal(guestsLib.setLayout('out-1', 'grid'), true); assert.equal(guestsLib.setLayout('out-1', '"><script>'), false);
  const desk = guestsLib.forDesk('out-1', t0);
  assert.equal(desk.layout, 'grid'); assert.equal(desk.guests.length, guestsLib.MAX_GUESTS); assert.ok(!JSON.stringify(desk.guests).includes(a.key), 'the desk is not handed the guests\' keys');
  // The renderer stopping takes everyone off air; a guest whose page has gone quiet is dropped; closing the room ends it.
  guestsLib.rendererGone('out-1', t0); assert.equal(guestsLib.fromRenderer('out-1', { guest_id: a.id, state: 'connected' }, t0 + 1000), false, 'a stopping renderer\'s last words are not kept');
  assert.ok(guestsLib.forDesk('out-1', t0).guests.every((g) => !g.on_air));
  assert.equal(guestsLib.stateFor(a, false).seq, 2, 'and an answer from the stopped renderer no longer fits');
  assert.equal(guestsLib.forDesk('out-1', t0 + 60000).guests.length, guestsLib.MAX_GUESTS, 'a minute of silence (a locked phone, a change of network) costs nobody their place');
  guestsLib.who(token, a.id, a.key, t0 + 125000);
  assert.deepEqual(guestsLib.forDesk('out-1', t0 + 125000).guests.map((g) => g.id), [a.id], 'only the guest still asking is still here');
  // The time limit of an invite is on coming in: whoever is inside stays, and asking for the link again renews it.
  const late = t0 + 13 * 3600 * 1000;
  assert.equal(guestsLib.who(token, a.id, a.key, late), a, 'a guest inside is not thrown out when the invite runs out'); assert.equal(guestsLib.join(token, 'late', late).status, 404);
  assert.equal(guestsLib.forDesk('out-1', late).guests.length, 1);
  assert.equal(guestsLib.invite(out, late), token, 'the same link, renewed'); assert.equal(guestsLib.forDesk('out-1', late).expires_at, late + 12 * 3600 * 1000);
  assert.ok(guestsLib.join(token, 'in time', late).guest);
  // Removed by the operator is remembered as such; an offer straight after another is refused.
  assert.equal(guestsLib.wasRemoved(a.id), false); assert.equal(guestsLib.remove('out-1', a.id, late), true); assert.equal(guestsLib.wasRemoved(a.id), true);
  assert.equal(guestsLib.mayOffer(b, late), true); assert.equal(guestsLib.mayOffer(b, late + 500), false); assert.equal(guestsLib.mayOffer(b, late + 2000), true);
  guestsLib.revoke('out-1');
  assert.equal(guestsLib.invited(token, t0), null); assert.equal(guestsLib.who(token, a.id, a.key, t0), null);
  const again = guestsLib.invite(out, t0); assert.notEqual(again, token, 'a closed link is not reopened'); guestsLib.revoke('out-1');
  const old = guestsLib.invite(out, t0); assert.equal(guestsLib.join(old, 'late', t0 + 13 * 3600 * 1000).status, 404, 'an invite ends by itself'); guestsLib.revoke('out-1');
});

test('the green room over the API: operators only, guests only as themselves, the renderer only by its secret', async () => {
  const so = (await call('POST', '/api/stream-out', A.jwt, { name: 'Guests', kind: 'record' })).body;
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/invite`, V.jwt)).status, 403, 'a read-only member cannot invite');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/invite`, B.jwt)).status, 404);
  const inv = (await call('POST', `/api/stream-out/${so.id}/guests/invite`, A.jwt)).body;
  assert.match(inv.invite_url, /^\/guest\/[A-Za-z0-9_-]{43}$/);
  const token = inv.invite_url.split('/').pop();
  const page = await call('GET', inv.invite_url);
  assert.equal(page.status, 200); assert.match(page.text, /Join the broadcast/); assert.match(page.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal((await call('POST', `/api/stream-guest/${'x'.repeat(43)}/join`, null, { name: 'Eve' })).status, 404);
  const j = (await call('POST', `/api/stream-guest/${token}/join`, null, { name: 'Priya' })).body;
  assert.deepEqual([j.name, j.on_air, j.studio, j.need_offer], ['Priya', false, false, true]); assert.ok(Array.isArray(j.ice_servers));
  assert.ok(Array.isArray((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: j.key })).body.ice_servers), 'a guest with an offer to make is given the servers again, with a fresh login');
  assert.equal((await call('GET', `/api/stream-guest/${token}/state?guest_id=${j.guest_id}&key=${j.key}`)).status, 404, 'the key is not taken from the address');
  assert.ok(!JSON.stringify(j).includes(so.id) && !JSON.stringify(j).includes(A.wsId), 'a guest learns nothing about the workspace or the output');
  assert.equal((await call('POST', `/api/stream-guest/${token}/offer`, null, { guest_id: j.guest_id, key: 'wrong', sdp: 'v=0\r\n' })).status, 404);
  assert.equal((await call('POST', `/api/stream-guest/${token}/offer`, null, { guest_id: j.guest_id, key: j.key, sdp: '<script>' })).status, 400);
  assert.equal((await call('POST', `/api/stream-guest/${token}/offer`, null, { guest_id: j.guest_id, key: j.key, sdp: 'v=0\r\no=x' })).status, 200);
  assert.equal((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: 'nope' })).status, 404);
  // The renderer: the feed lists the guest with their offer; only the feed secret answers.
  const secret = db.prepare('SELECT feed_secret FROM stream_outputs WHERE id = ?').get(so.id).feed_secret;
  const feed = (await call('GET', `/api/stream-feed/${secret}`)).body;
  assert.equal(feed.guests.list[0].offer, 'v=0\r\no=x'); assert.equal(feed.guests.layout, 'pip'); assert.ok(!JSON.stringify(feed.guests).includes(j.key));
  assert.equal((await call('POST', `/api/stream-feed/${'s'.repeat(43)}/guest`, null, { guest_id: j.guest_id, seq: 1, answer: 'v=0\r\na' })).status, 404);
  assert.equal((await call('POST', `/api/stream-feed/${secret}/guest`, null, { guest_id: j.guest_id, seq: 1, answer: 'v=0\r\na', state: 'connected' })).status, 200);
  assert.equal((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: j.key })).body.answer, 'v=0\r\na');
  // The desk: the room is listed for its workspace only; on air and remove are the operator's.
  const rooms = (await call('GET', '/api/stream-out/guests', A.jwt)).body.rooms;
  assert.deepEqual(rooms[so.id].guests.map((g) => [g.name, g.on_air, g.state]), [['Priya', false, 'connected']]); assert.equal(rooms[so.id].invite_url, inv.invite_url);
  assert.deepEqual((await call('GET', '/api/stream-out/guests', B.jwt)).body.rooms, {});
  assert.equal((await call('GET', '/api/stream-out/guests')).status, 401);
  // A read-only member sees who is in the room, not the way in and not anyone's picture.
  const seenByViewer = (await call('GET', `/api/stream-out/guests?desk=viewerdesk000001`, V.jwt)).body;
  assert.equal(seenByViewer.rooms[so.id].invite_url, null); assert.equal(seenByViewer.rooms[so.id].live, false); assert.deepEqual(seenByViewer.ice_servers, []);
  assert.deepEqual(seenByViewer.rooms[so.id].guests.map((g) => [g.name, g.thumb]), [['Priya', null]]); assert.ok(!JSON.stringify(seenByViewer).includes(token));
  assert.equal((await call('GET', `/guest/${'x'.repeat(43)}`)).status, 404, 'no page behind a link that lets nobody in');
  // The desk's own picture of a guest: offered by the guest to a desk that named itself, answered by that workspace's operator only.
  const DESK = 'desk0123456789ab';
  const live = (await call('GET', `/api/stream-out/guests?desk=${DESK}`, A.jwt)).body;
  assert.equal(live.rooms[so.id].live, true); assert.ok(Array.isArray(live.ice_servers));
  const st1 = (await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: j.key })).body;
  assert.deepEqual(st1.desks.map((d) => [d.id, d.need_offer]), [[DESK, true]]);
  assert.equal((await call('POST', `/api/stream-guest/${token}/desk-offer`, null, { guest_id: j.guest_id, key: 'wrong', desk: DESK, sdp: 'v=0\r\nd' })).status, 404);
  assert.equal((await call('POST', `/api/stream-guest/${token}/desk-offer`, null, { guest_id: j.guest_id, key: j.key, desk: 'nobody-here-0001', sdp: 'v=0\r\nd' })).status, 400);
  assert.equal((await call('POST', `/api/stream-guest/${token}/desk-offer`, null, { guest_id: j.guest_id, key: j.key, desk: DESK, sdp: 'v=0\r\nd' })).body.seq, 1);
  assert.equal((await call('GET', `/api/stream-out/guests?desk=${DESK}`, A.jwt)).body.rooms[so.id].guests[0].leg_offer, 'v=0\r\nd');
  assert.equal((await call('GET', '/api/stream-out/guests', A.jwt)).body.rooms[so.id].guests[0].leg_offer, undefined);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}/desk`, B.jwt, { desk: DESK, seq: 1, answer: 'v=0\r\ne' })).status, 404, 'another workspace cannot answer');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}/desk`, null, { desk: DESK, seq: 1, answer: 'v=0\r\ne' })).status, 401);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}/desk`, A.jwt, { desk: DESK, seq: 9, answer: 'v=0\r\ne' })).status, 409);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}/desk`, A.jwt, { desk: DESK, seq: 1, answer: 'v=0\r\ne' })).status, 200);
  assert.equal((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: j.key })).body.desks[0].answer, 'v=0\r\ne');
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}`, V.jwt, { on_air: true })).status, 403);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}`, B.jwt, { on_air: true })).status, 404);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/${j.guest_id}`, A.jwt, { on_air: true })).status, 200);
  assert.equal((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: j.key })).body.on_air, true);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/layout`, A.jwt, { layout: 'nope' })).status, 400);
  assert.equal((await call('POST', `/api/stream-out/${so.id}/guests/layout`, A.jwt, { layout: 'side' })).status, 200);
  assert.equal((await call('DELETE', `/api/stream-out/${so.id}/guests/${j.guest_id}`, A.jwt)).status, 200);
  assert.equal((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j.guest_id, key: j.key })).status, 410, 'a removed guest is out, and is told it was the studio (so the page does not come back in by itself)');
  // Deleting the output closes its green room.
  const j2 = (await call('POST', `/api/stream-guest/${token}/join`, null, { name: 'Marco' })).body;
  await call('DELETE', `/api/stream-out/${so.id}`, A.jwt);
  assert.equal((await call('POST', `/api/stream-guest/${token}/state`, null, { guest_id: j2.guest_id, key: j2.key })).status, 404);
  assert.equal((await call('POST', `/api/stream-guest/${token}/join`, null, { name: 'late' })).status, 404);
});

test('the picture is grabbed from the renderer\'s own display when there is one, and written as JPEGs when there is not', () => {
  const base = { width: 1280, height: 720, fps: 30, bitrate_k: 3500, kind: 'rtmp', target: 'rtmp://h/live/k' };
  const jpeg = streamOut.ffmpegArgs(base).join(' ');
  assert.match(jpeg, /-f image2pipe -framerate 30 -c:v mjpeg -i pipe:0/);
  assert.doesNotMatch(jpeg, /x11grab|-progress/);
  const grab = streamOut.ffmpegArgs({ ...base, display: 93 }).join(' ');
  assert.match(grab, /-f x11grab -framerate 30 -video_size 1280x720 -draw_mouse 0 [^:]*-i :93 /, 'the whole display, at the stream\'s rate, without the pointer');
  assert.doesNotMatch(grab, /image2pipe|pipe:0/, 'nothing is read from stdin: it carries the stop key');
  assert.match(grab, /-progress pipe:1/, 'ffmpeg reports the frames it has encoded: that is how the stream is known to be live');
  assert.match(grab, /-i pipe:3 /, 'the sound still comes from the mixer');
  assert.equal(streamOut.ffmpegArgs({ ...base, display: 0 }).includes(':0'), true, 'display 0 is a display');
});

test('a desk gets each guest\'s picture on a connection of its own: only named desks, only two, only by offer and matching answer', () => {
  const G = require('../lib/mixer-guests');
  const out = { id: 'out-desk-' + Date.now(), workspace_id: 'ws-desk' };
  const SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
  const t0 = 1_000_000;
  const token = G.invite(out, t0);
  const g = G.join(token, 'Ana', t0).guest;
  assert.deepEqual(G.stateFor(g, false).desks, [], 'no desk is looking: nothing to send');
  assert.equal(G.forDesk(out.id, t0).live, false, 'a desk that does not name itself is not sent pictures');
  assert.equal(G.forDesk(out.id, t0, 'short').live, false, 'a malformed desk id is refused');
  assert.equal(G.forDesk(out.id, t0, 'desk-aaaaaaaa').live, true);
  assert.equal(G.forDesk(out.id, t0, 'desk-bbbbbbbb').live, true);
  assert.equal(G.forDesk(out.id, t0, 'desk-cccccccc').live, false, 'a third desk would triple the guest\'s upload: it keeps the stills');
  assert.deepEqual(G.stateFor(g, false).desks.map((d) => [d.id, d.need_offer, d.answer]), [['desk-aaaaaaaa', true, null], ['desk-bbbbbbbb', true, null]], 'the guest is asked for an offer per desk, stream running or not');
  assert.equal(G.setDeskOffer(g, 'desk-cccccccc', SDP), null, 'no offer to a desk that is not here');
  assert.equal(G.setDeskOffer(g, 'desk-aaaaaaaa', 'not sdp'), null);
  assert.equal(G.setDeskOffer(g, 'desk-aaaaaaaa', SDP), 1);
  const seen = G.forDesk(out.id, t0, 'desk-aaaaaaaa').guests[0];
  assert.deepEqual([seen.leg_seq, seen.leg_offer], [1, SDP]);
  assert.equal(G.forDesk(out.id, t0, 'desk-bbbbbbbb').guests[0].leg_offer, undefined, 'an offer goes to the desk it was made for');
  assert.equal(G.fromDesk(out.id, g.id, 'desk-bbbbbbbb', { seq: 1, answer: SDP }), false, 'another desk cannot answer it');
  assert.equal(G.fromDesk('other-output', g.id, 'desk-aaaaaaaa', { seq: 1, answer: SDP }), false, 'nor a desk of another output');
  assert.equal(G.fromDesk(out.id, g.id, 'desk-aaaaaaaa', { seq: 7, answer: SDP }), false, 'an answer to an older offer is dropped');
  assert.equal(G.fromDesk(out.id, g.id, 'desk-aaaaaaaa', { seq: 1, answer: SDP }), true);
  assert.equal(G.stateFor(g, false).desks[0].answer, SDP, 'the guest reads the answer');
  assert.equal(G.forDesk(out.id, t0, 'desk-aaaaaaaa').guests[0].leg_offer, undefined, 'an answered offer is not handed out again');
  assert.equal(G.fromDesk(out.id, g.id, 'desk-aaaaaaaa', { again: true }), true);
  assert.equal(G.stateFor(g, false).desks[0].need_offer, true, 'a desk whose connection failed asks for a new offer');
  // A desk that stops asking is forgotten, and the guest stops sending to it.
  G.who(token, g.id, g.key, t0 + 11000);
  G.forDesk(out.id, t0 + 11000, 'desk-bbbbbbbb');
  assert.deepEqual(G.stateFor(g, false).desks.map((d) => d.id), ['desk-bbbbbbbb']);
  assert.equal(g.legs.has('desk-aaaaaaaa'), false);
  assert.equal(G.forDesk(out.id, t0 + 11000, 'desk-cccccccc').live, true, 'and its place is free');
  G.revoke(out.id);
  assert.equal(G.forDesk(out.id, t0 + 11000, 'desk-bbbbbbbb').live, false, 'a closed green room has no desks');
});

test('an open invite outlives a restart: it is kept where the caller says, and given back', () => {
  const G = require('../lib/mixer-guests');
  const saved = new Map(); const keep = { save: (id, token, until) => saved.set(id, { token, until }), drop: (id) => saved.delete(id) };
  const now = 5_000_000;
  G.restore([{ outputId: 'out-keep', workspaceId: 'ws-k', token: 'k'.repeat(43), until: now + 1000 }, { outputId: 'out-old', workspaceId: 'ws-k', token: 'o'.repeat(43), until: now - 1 }, { outputId: 'out-bad', workspaceId: 'ws-k', token: 'short', until: now + 1000 }], keep, now);
  assert.equal(G.inviteOf('out-keep'), 'k'.repeat(43), 'the link from before the restart still opens the room');
  assert.ok(G.join('k'.repeat(43), 'Back again', now).guest);
  assert.equal(G.inviteOf('out-old'), null, 'one that had run out is not brought back'); assert.equal(G.inviteOf('out-bad'), null);
  const fresh = G.invite({ id: 'out-new', workspace_id: 'ws-k' }, now);
  assert.equal(saved.get('out-new').token, fresh, 'a new invite is saved');
  G.revoke('out-new'); assert.equal(saved.has('out-new'), false, 'and a closed one is forgotten');
  G.revoke('out-keep'); G.restore([], null);
});
