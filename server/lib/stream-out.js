'use strict';

/*
 * STREAM OUT: a mixer output that goes to a streaming service (YouTube, Facebook, Twitch, any
 * RTMP/RTMPS or SRT ingest) instead of a screen.
 *
 * How a stream is made: this server opens its own headless browser on the web player
 * (/stream-render/<secret>, the player's follow-a-feed mode), takes the frames the browser paints,
 * and hands them at a steady rate to ffmpeg, which encodes and sends them. What the output shows
 * is a playlist, chosen with TAKE on the mixer like any screen; graphics are keyed the same way.
 *
 * ⚠️ SELF-HOSTED ONLY. Encoding costs one to two CPU cores per stream for as long as it runs, on
 * the machine that runs this server. On the hosted service that is not part of any plan (it is
 * arranged per enterprise agreement), so everything here refuses unless config.selfHosted.
 *
 * ⚠️ LICENCE. ScreenTinker ships no GPL code and does not ship ffmpeg: it runs whatever `ffmpeg`
 * the operator installed, as a separate program. Most distribution builds of ffmpeg are GPL
 * (x264). licenceOf() reads the build so the dashboard can say which one is installed.
 *
 * SOUND. The stream's sound is mixed in this process (lib/stream-audio.js) and handed to ffmpeg
 * as PCM at a steady rate beside the picture: the programme's own sound (when PulseAudio is on
 * the server), an audio bed, and a sound card input, each with a fader and mute, into a master.
 * With nothing to play the track is silence, which the services require anyway.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const config = require('../config');

const MAX_STREAMS = Math.max(1, Math.min(8, parseInt(process.env.STREAM_OUT_MAX || '2', 10) || 2));
const ENCODER = /^[a-z0-9_]{2,32}$/.test(process.env.STREAM_OUT_ENCODER || '') ? process.env.STREAM_OUT_ENCODER : 'libx264';

const KINDS = {
  youtube: { label: 'YouTube Live', base: 'rtmp://a.rtmp.youtube.com/live2' },
  facebook: { label: 'Facebook Live', base: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  twitch: { label: 'Twitch', base: 'rtmp://live.twitch.tv/app' },
  rtmp: { label: 'Custom RTMP / RTMPS', base: null },
  srt: { label: 'SRT', base: null },
};
const SIZES = [[1280, 720], [1920, 1080]];
const { RATE, FRAME, MAX_LEVEL } = require('./stream-audio');

function chromePath() { return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || ''; }
function puppeteer() { try { return require('puppeteer-core'); } catch { return null; } }

/** What `ffmpeg -version` says: present or not, and whether it is a GPL build. Probed once. */
let ffProbe = null;
function ffmpegInfo() {
  if (!ffProbe) {
    ffProbe = new Promise((resolve) => execFile('ffmpeg', ['-hide_banner', '-version'], { timeout: 10000 }, (err, out) => {
      if (err) return resolve({ present: false, licence: null, version: null });
      resolve({ present: true, licence: licenceOf(out), version: (String(out).match(/^ffmpeg version (\S+)/) || [])[1] || null });
    }));
  }
  return ffProbe;
}
/** 'gpl' | 'nonfree' | 'lgpl', from the configure line ffmpeg prints about itself. */
function licenceOf(versionText) {
  const s = String(versionText || '');
  if (/--enable-nonfree\b/.test(s)) return 'nonfree';
  return /--enable-gpl\b/.test(s) ? 'gpl' : 'lgpl';
}

/** { available, reason } where reason is 'hosted' | 'no_browser' | 'no_ffmpeg' | null. */
async function availability(cfg = config) {
  if (!cfg.selfHosted) return { available: false, reason: 'hosted', ffmpeg: null };
  const ff = await ffmpegInfo();
  if (!ff.present) return { available: false, reason: 'no_ffmpeg', ffmpeg: ff };
  const exe = chromePath();
  if (!puppeteer() || !exe || !fs.existsSync(exe)) return { available: false, reason: 'no_browser', ffmpeg: ff };
  return { available: true, reason: null, ffmpeg: ff };
}

/** Checks a destination as typed. Returns { ok, error } and the cleaned values. */
function validate(input, { needKey = true } = {}) {
  const kind = String(input.kind || '');
  if (!KINDS[kind]) return { error: 'Choose where the stream goes.' };
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) return { error: 'Give the stream a name.' };
  let url = null;
  if (!KINDS[kind].base) {
    let u; try { u = new URL(String(input.url || '').trim()); } catch { return { error: 'That address is not a URL.' }; }
    const okProto = kind === 'srt' ? ['srt:'] : ['rtmp:', 'rtmps:'];
    if (!okProto.includes(u.protocol) || !u.hostname) return { error: kind === 'srt' ? 'An SRT address starts with srt://' : 'An RTMP address starts with rtmp:// or rtmps://' };
    if (u.username || u.password) return { error: 'Put credentials in the stream key field, not in the address.' };
    if (kind === 'srt' && u.search) return { error: 'Put the SRT options (streamid, passphrase) in the stream key field.' };
    url = String(input.url).trim().replace(/\/+$/, '').slice(0, 500);
  }
  const key = input.key == null ? '' : String(input.key).trim();
  if (/[\s\u0000-\u001f]/.test(key) || key.length > 600) return { error: 'The stream key has characters a key cannot have.' };
  if (needKey && !key && kind !== 'srt' && kind !== 'rtmp') return { error: 'Paste the stream key from the streaming service.' };
  const size = SIZES.find(([w, h]) => w === Number(input.width) && h === Number(input.height)) || SIZES[0];
  const fps = Number(input.fps) === 60 ? 60 : (Number(input.fps) === 25 ? 25 : 30);
  const bitrate = Math.max(800, Math.min(12000, Math.round(Number(input.bitrate_k) || (size[0] === 1920 ? 6000 : 3500))));
  return { ok: true, value: { kind, name, url, key, width: size[0], height: size[1], fps, bitrate_k: bitrate } };
}

/** The address ffmpeg is given. It contains the key: never log it, never return it. */
function targetUrl(row, key) {
  const base = KINDS[row.kind].base || row.url;
  if (row.kind === 'srt') return key ? `${base}?${key.replace(/^\?/, '')}` : base;
  return key ? `${base}/${key}` : base;
}

function ffmpegArgs({ width, height, fps, bitrate_k, target, kind, encoder = ENCODER }) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:3',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-tune', 'zerolatency'] : []),
    '-b:v', `${bitrate_k}k`, '-maxrate', `${bitrate_k}k`, '-bufsize', `${bitrate_k * 2}k`,
    '-g', String(fps * 2), '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-shortest', '-f', kind === 'srt' ? 'mpegts' : 'flv', target,
  ];
}

/** ffmpeg's last words, with the key and the address taken out. */
function redact(text, row, key) {
  let s = String(text || '');
  for (const secret of [targetUrl(row, key), key].filter((x) => x && x.length >= 4)) s = s.split(secret).join('[hidden]');
  return s.replace(/\s+/g, ' ').trim().slice(-300);
}

// ── the running streams ──────────────────────────────────────────────────────────────────────────
const sessions = new Map();   // id -> session

function status(id) {
  const s = sessions.get(id);
  if (!s) return { state: 'off' };
  return { state: s.state, since: s.since, frames: s.sent, error: s.error || null, audio_peak: Math.round(s.mix.peaks.master * 100) / 100,
    audio_peaks: Object.fromEntries(Object.entries(s.mix.peaks).map(([k, v]) => [k, Math.round(v * 100) / 100])), programme_audio: !!s.sink };
}
function localBaseUrl() { return global.__localApiOrigin || `http://127.0.0.1:${process.env.PORT || config.port || 3001}`; }

/** A chunk of sound with the fader applied. Returns the loudest sample in it, 0..1. */
function applyGain(buf, gain) {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let v = buf.readInt16LE(i);
    if (gain !== 1) { v = Math.max(-32768, Math.min(32767, Math.round(v * gain))); buf.writeInt16LE(v, i); }
    const a = v < 0 ? -v : v; if (a > peak) peak = a;
  }
  return peak / 32768;
}
const audio = require('./stream-audio');

/** (Re)start one input of a running stream from its settings. */
function startInput(s, name) {
  stopInput(s, name);
  let proc = null;
  if (name === 'bed' && s.bedFile) proc = audio.decoder(audio.bedArgs(s.bedFile));
  else if (name === 'line' && s.mix.settings.line.device) proc = audio.decoder(audio.lineArgs(s.mix.settings.line.device));
  else if (name === 'programme' && s.sink) proc = audio.decoder(audio.programmeArgs(s.sink.name));
  if (!proc) return;
  s.inputs[name] = proc;
  s.mix.attach(name, proc.stdout, { live: name !== 'bed' });
}
function stopInput(s, name) {
  const p = s.inputs[name];
  if (p) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  delete s.inputs[name];
  s.mix.detach(name);
}
/** Change a live stream's sound: any fader or mute, the bed, or the line input. */
function setAudio(id, next) {
  const s = sessions.get(id);
  if (!s) return false;
  const before = s.mix.settings.line.device;
  s.mix.setSettings(next && next.settings);
  if (((next && next.file) || null) !== s.bedFile) { s.bedFile = (next && next.file) || null; startInput(s, 'bed'); }
  if (s.mix.settings.line.device !== before) startInput(s, 'line');
  return true;
}

async function start(row, key, sound) {
  const a = await availability();
  if (!a.available) throw Object.assign(new Error('Streaming out is not available on this server.'), { code: a.reason });
  if (sessions.has(row.id)) return status(row.id);
  if (sessions.size >= MAX_STREAMS) throw Object.assign(new Error(`This server runs at most ${MAX_STREAMS} stream(s) at once (STREAM_OUT_MAX).`), { code: 'limit' });
  const s = { id: row.id, row, key, state: 'starting', since: Date.now(), sent: 0, last: null, wanted: true, retries: 0, error: null,
    mix: new audio.Mix(sound && sound.settings), bedFile: (sound && sound.file) || null, inputs: {}, sink: null };
  sessions.set(row.id, s);
  try {
    // Programme sound: the browser plays into a sink of its own, which the mixer reads back.
    // Without PulseAudio there is no sink and the browser stays muted, as before.
    s.sink = await audio.createSink(row.id).catch(() => null);
    s.browser = await puppeteer().launch({
      executablePath: chromePath(), headless: 'new',
      env: s.sink ? { ...process.env, PULSE_SINK: s.sink.name } : process.env,
      // puppeteer mutes a headless browser by default; with a sink to play into, it must not.
      ignoreDefaultArgs: s.sink ? ['--mute-audio'] : [],
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...(s.sink ? [] : ['--mute-audio']), '--hide-scrollbars',
        '--autoplay-policy=no-user-gesture-required', `--window-size=${row.width},${row.height}`],
    });
    s.browser.on('disconnected', () => { if (s.wanted) { s.error = 'The renderer stopped.'; stop(row.id, 'error'); } });
    const page = await s.browser.newPage();
    await page.setViewport({ width: row.width, height: row.height });
    await page.goto(`${localBaseUrl()}/stream-render/${row.feed_secret}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The player keeps media silent until someone has touched the page (the browser's autoplay
    // rule, lib/media-mute.js). Nobody will: this click is that touch.
    if (s.sink) { try { await page.mouse.click(5, 5); } catch { /* it plays muted */ } }
    const cdp = await page.createCDPSession();
    cdp.on('Page.screencastFrame', (f) => {
      s.last = Buffer.from(f.data, 'base64');
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: row.width, maxHeight: row.height, everyNthFrame: 1 });
    if (!s.wanted) return status(row.id);
    for (const name of audio.INPUTS) startInput(s, name);
    encode(s);
  } catch (e) {
    s.error = e.message; await stop(row.id, 'error');
    throw e;
  }
  return status(row.id);
}

/** Runs ffmpeg for a session and feeds it frames at a steady rate, the last frame again when the
 *  page has not changed: a still image must not stall the stream. */
function encode(s) {
  const { row } = s;
  const ff = spawn('ffmpeg', ffmpegArgs({ ...row, target: targetUrl(row, s.key) }), { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  s.ff = ff; s.t0 = Date.now(); s.written = 0;
  // Sound, paced by the same clock as the picture: every 20 ms, the samples that are now due.
  const snd = ff.stdio[3]; let sndBytes = 0;
  snd.on('error', () => {});
  s.sndTimer = setInterval(() => {
    if (!snd.writable || snd.writableNeedDrain) return;
    let due = Math.floor((Date.now() - s.t0) * RATE / 1000) * FRAME - sndBytes;
    if (due > RATE * FRAME / 2) { sndBytes += due - RATE * FRAME / 5; due = RATE * FRAME / 5; }   // fell behind: skip ahead
    due -= due % FRAME;
    if (due <= 0) return;
    snd.write(s.mix.next(due)); sndBytes += due;
  }, 20);
  let tail = '';
  ff.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
  ff.stdin.on('error', () => {});
  ff.on('error', (e) => { tail += ' ' + e.message; });
  s.timer = setInterval(() => {
    if (!s.last || !ff.stdin.writable) return;
    const due = Math.floor((Date.now() - s.t0) * row.fps / 1000);
    let n = Math.min(due - s.written, 5);                       // catch up after a hiccup, a little at a time
    if (due - s.written > row.fps * 2) s.written = due - 5;      // too far behind to catch up: let go
    while (n-- > 0 && !ff.stdin.writableNeedDrain) { ff.stdin.write(s.last); s.written++; s.sent++; }
    if (s.state === 'starting' && s.sent > row.fps * 3) s.state = 'live';
    if (s.state === 'reconnecting' && s.written > row.fps * 3) { s.state = 'live'; s.error = null; }
  }, Math.max(8, Math.floor(1000 / row.fps / 2)));
  ff.on('close', () => {
    clearInterval(s.timer); clearInterval(s.sndTimer);
    if (!s.wanted || sessions.get(s.id) !== s) return;
    const ranFor = Date.now() - s.t0;
    if (ranFor > 60000) s.retries = 0;
    s.error = redact(tail, row, s.key) || 'The connection to the streaming service ended.';
    if (++s.retries > 8) { stop(s.id, 'error'); return; }
    s.state = 'reconnecting';
    s.retry = setTimeout(() => { if (s.wanted && sessions.get(s.id) === s) encode(s); }, Math.min(30000, 2000 * 2 ** (s.retries - 1)));
  });
}

const stopped = new Map();   // id -> last error, so the desk can say why a stream went off
async function stop(id, why) {
  const s = sessions.get(id);
  if (!s) return { state: 'off' };
  s.wanted = false;
  sessions.delete(id);
  if (why === 'error' && s.error) stopped.set(id, { error: s.error, at: Date.now() }); else stopped.delete(id);
  clearInterval(s.timer); clearInterval(s.sndTimer); clearTimeout(s.retry);
  for (const name of Object.keys(s.inputs)) stopInput(s, name);
  audio.removeSink(s.sink);
  try { if (s.ff) { s.ff.stdin.end(); try { s.ff.stdio[3].end(); } catch { /* gone */ } const ff = s.ff; setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref(); } } catch { /* gone */ }
  try { if (s.browser) await s.browser.close(); } catch { /* gone */ }
  return { state: 'off' };
}
function lastError(id) { const e = stopped.get(id); return e ? e.error : null; }
async function stopAll() { await Promise.all([...sessions.keys()].map((id) => stop(id))); }
process.on('exit', () => { for (const s of sessions.values()) { try { s.ff && s.ff.kill('SIGKILL'); } catch { /* */ } try { Object.values(s.inputs).forEach((p) => p.kill('SIGKILL')); } catch { /* */ } try { s.browser && s.browser.process() && s.browser.process().kill('SIGKILL'); } catch { /* */ } } });

module.exports = { MAX_LEVEL, applyGain, setAudio, KINDS, SIZES, MAX_STREAMS, availability, ffmpegInfo, licenceOf, validate, targetUrl, ffmpegArgs, redact, start, stop, stopAll, status, lastError };
