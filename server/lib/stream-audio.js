'use strict';

/*
 * THE SOUND OF A STREAM OUTPUT (lib/stream-out.js): a small audio mixer.
 *
 * A stream's sound is mixed in this process, as 16-bit stereo PCM at 44.1 kHz, and handed to the
 * encoder beside the picture. Its inputs, each a strip with its own fader and mute, are summed into a master:
 *
 *   programme   what the programme itself is playing (the sound of its videos and audio tracks).
 *               The renderer's browser plays into a PulseAudio sink of its own and this reads the
 *               sink back. Needs PulseAudio on the server; without it the input is simply absent.
 *   bed         an uploaded audio item, looped.
 *   mic         the microphone of the computer the desk is open on: the browser records it and
 *               sends it up a quarter of a second at a time (routes/stream-out.js /:id/mic).
 *   c1..c32     the channels of a mixing console (or any multichannel interface) plugged into the
 *               server over USB: a Yamaha TF, a PreSonus StudioLive, a multichannel sound card.
 *               One capture reads every channel of the device and each of the first N becomes a
 *               strip of its own (mono, in the centre), with its own name.
 *   line        a sound card input on the server (a USB audio interface, a desk's output),
 *               read through ALSA.
 *
 *   net, net2   a network feed: SRT, RTMP, RTSP, RTP or UDP, or an HTTP audio stream. This is how a
 *               remote contributor, a wireless link's receiver, an AES67/RTP source or another
 *               studio comes in.
 *
 * Every input strip has the processing a desk channel has (lib/stream-dsp.js): noise floor
 * subtraction (a room's steady noise, air handling, hum, hiss, taken out by frequency, from a
 * learned print of the noise or a running estimate), high-pass, a three-band EQ, a gate, a
 * compressor, the fader, and a send to the reverb. The master has its own EQ and fader and ends in a
 * limiter, so the sum is held under full scale instead of clipping.
 *
 * Each input is a child process that writes PCM to its stdout (ffmpeg in all three cases). The
 * mixer never waits for an input: at each tick it takes what is there and fills the rest with
 * silence, so a stalled or dead input costs its own sound and nothing else. Faders are applied
 * to the samples as they go out, which is what makes them live.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const dsp = require('./stream-dsp');

const RATE = 44100;
const FRAME = 4;                 // bytes per stereo 16-bit sample
const SECOND = RATE * FRAME;
const MAX_LEVEL = 1.5;
const INPUTS = ['programme', 'bed', 'mic', 'line', 'net', 'net2'];
const MAX_CHANNELS = 32;
const channelNames = (count) => Array.from({ length: Math.max(0, Math.min(MAX_CHANNELS, count | 0)) }, (_, i) => 'c' + (i + 1));
/** Every input strip of a mix with these settings, in desk order: the fixed inputs, then the console's channels. */
const inputNames = (settings) => [...INPUTS, ...channelNames(settings && settings.console ? settings.console.count : 0)];
const NET_SCHEMES = ['srt:', 'rtmp:', 'rtmps:', 'rtsp:', 'rtsps:', 'rtp:', 'udp:', 'http:', 'https:'];

const level = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(MAX_LEVEL, n)) : dflt; };
const unit = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };
const strip = (s) => ({ level: level(s && s.level, 1), muted: !!(s && s.muted), ...dsp.cleanProcessing(s) });

/** A network feed's address, or null when it is not one this mixer takes. */
function netUrl(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\s\u0000-\u001f]/.test(v.trim())) return null;
  try { const u = new URL(v.trim()); return NET_SCHEMES.includes(u.protocol) && (u.hostname || u.protocol === 'udp:' || u.protocol === 'rtp:' || u.protocol === 'srt:') ? v.trim() : null; } catch { return null; }
}
/** The same address with any password hidden, for showing on the desk. */
function maskUrl(v) { return typeof v === 'string' ? v.replace(/(\/\/[^/@:]*):[^/@]*@/, '$1:***@') : null; }

/** Settings as stored and as sent, made safe: every strip present, every control in range. */
function cleanSettings(s) {
  const x = s && typeof s === 'object' ? s : {};
  const out = {};
  // A console on the server: its device, and how many of its channels are brought in as strips.
  const con = x.console && typeof x.console === 'object' ? x.console : {};
  const device = typeof con.device === 'string' && /^plughw:\d{1,2},\d{1,2}$/.test(con.device) ? con.device : null;
  const total = Math.max(1, Math.min(64, parseInt(con.channels, 10) || 2));
  out.console = { device, channels: total, count: device ? Math.max(0, Math.min(MAX_CHANNELS, total, parseInt(con.count, 10) || 0)) : 0 };
  const names = inputNames(out);
  for (const name of names) out[name] = strip(x[name]);
  for (const name of channelNames(out.console.count)) out[name].label = typeof (x[name] && x[name].label) === 'string' ? x[name].label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) : '';
  out.line.device = typeof (x.line && x.line.device) === 'string' && /^plughw:\d{1,2},\d{1,2}$/.test(x.line.device) ? x.line.device : null;
  for (const name of names) {
    out[name].denoise = unit(x[name] && x[name].denoise);
    out[name].noise = x[name] && dsp.isPrint(x[name].noise) ? x[name].noise : null;   // the learned noise print, packed
  }
  for (const name of ['net', 'net2']) out[name].url = netUrl(x[name] && x[name].url);
  const m = x.master && typeof x.master === 'object' ? x.master : {};
  out.master = { level: level(m.level, 1), muted: !!m.muted, eq: dsp.cleanProcessing(m).eq };
  out.fx = { decay: x.fx && Number.isFinite(Number(x.fx.decay)) ? unit(x.fx.decay) : 0.5 };
  return out;
}

class Mix {
  constructor(settings) {
    this.settings = cleanSettings(settings);
    this.inputs = new Map();     // name -> { q: Buffer[], bytes, stream, live, odd }
    this.strips = {}; this.denoisers = {};        // made when a strip is first used: the console's channels come and go
    this.masterEq = new dsp.Strip();
    this.reverb = new dsp.Reverb();
    this.limiter = new dsp.Limiter();
    this.peaks = Object.fromEntries([...INPUTS, 'master'].map((n) => [n, 0]));
    // What a meter shows: the loudest each strip has been lately, falling back at 20 dB a second,
    // so a desk that looks a few times a second still sees every peak.
    this.held = Object.fromEntries([...INPUTS, 'master'].map((n) => [n, 0]));
    this.limiting = 0;           // dB the limiter is holding back right now
  }

  setSettings(s) { this.settings = cleanSettings(s); }

  /**
   * Attach an input's PCM stream. `live` inputs (everything but the bed) are happening now: when
   * more than half a second is waiting, the oldest is dropped so the sound stays with the picture.
   * A file (the bed) is paused instead, so none of it is lost.
   */
  attach(name, stream, { live = false } = {}) {
    this.detach(name);
    const input = { q: [], bytes: 0, stream, live, odd: null };
    this.inputs.set(name, input);
    stream.on('data', (d) => { if (this.inputs.get(name) === input) this._take(input, d); });
    stream.on('error', () => {});
  }

  detach(name) { this.inputs.delete(name); this.peaks[name] = 0; this.held[name] = 0; if (this.denoisers[name]) this.denoisers[name].cancelLearn(); }
  _dn(name) { return this.denoisers[name] || (this.denoisers[name] = new dsp.Denoiser()); }

  /** An input fed by push() instead of a stream of its own (one channel of the console's capture). */
  open(name, { live = true } = {}) {
    this.detach(name);
    const input = { q: [], bytes: 0, stream: null, live, odd: null };
    this.inputs.set(name, input);
    return input;
  }
  push(name, d) { const input = this.inputs.get(name); if (input) this._take(input, d); }
  _take(input, d) {
    // A pipe cuts where it likes; the queue only ever holds whole stereo samples.
    if (input.odd) { d = Buffer.concat([input.odd, d]); input.odd = null; }
    const whole = d.length - (d.length % FRAME);
    if (whole < d.length) input.odd = d.subarray(whole);
    if (!whole) return;
    d = d.subarray(0, whole);
    input.q.push(d); input.bytes += d.length;
    if (input.live) {
      while (input.bytes > SECOND / 2 && input.q.length > 1) input.bytes -= input.q.shift().length;
    } else if (input.bytes > SECOND && input.stream) input.stream.pause();
  }

  /** Listen to an input for a moment as noise. Resolves with its print (packed), or null. */
  learnNoise(name, seconds) { return this.inputs.has(name) ? this._dn(name).learn(seconds) : Promise.resolve(null); }

  /** `n` bytes of mixed sound for right now. */
  next(n) {
    n -= n % FRAME;
    const len = n / 2;                                 // samples, both channels counted
    const sum = new Float32Array(len), send = new Float32Array(len);
    let sending = false;
    for (const name of inputNames(this.settings)) {
      const input = this.inputs.get(name);
      if (!input) { this.peaks[name] = 0; continue; }
      const set = this.settings[name];
      // Always taken from the queue, muted or not: a muted input must still be at "now" when it is opened.
      const buf = new Float32Array(len);
      let at = 0;
      while (at < len && input.q.length) {
        const head = input.q[0], take = Math.min(head.length, (len - at) * 2);
        for (let i = 0; i < take; i += 2) buf[at + i / 2] = head.readInt16LE(i) / 32768;
        at += take / 2; input.bytes -= take;
        if (take === head.length) input.q.shift(); else input.q[0] = head.subarray(take);
      }
      if (!input.live && input.stream && input.bytes < SECOND / 2 && input.stream.isPaused && input.stream.isPaused()) input.stream.resume();
      const dn = this._dn(name);
      dn.setPrint(set.noise); dn.run(buf, set.denoise);
      (this.strips[name] || (this.strips[name] = new dsp.Strip())).run(buf, set);
      const gain = set.muted ? 0 : set.level;
      let peak = 0;
      if (gain !== 0) {
        const fx = set.fx;
        for (let i = 0; i < len; i++) {
          const v = buf[i] * gain; sum[i] += v;
          const m = v < 0 ? -v : v; if (m > peak) peak = m;
          if (fx) send[i] += v * fx;
        }
        if (fx && peak > 0) sending = true;
      }
      this.peaks[name] = Math.min(1, peak);
    }
    this.reverb.run(send, sum, this.settings.fx.decay, sending);
    const master = this.settings.master;
    this.masterEq.run(sum, { hpf: false, eq: master.eq, gate: 0, comp: 0, fx: 0 });
    const mg = master.muted ? 0 : master.level;
    if (mg !== 1) for (let i = 0; i < len; i++) sum[i] *= mg;
    this.limiter.run(sum);                             // loud is held under full scale; it never wraps
    this.limiting = this.limiter.reduction;
    const out = Buffer.alloc(n);
    let peak = 0;
    for (let i = 0; i < len; i++) {
      let v = Math.round(sum[i] * 32768);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out.writeInt16LE(v, i * 2);
      const m = v < 0 ? -v : v; if (m > peak) peak = m;
    }
    this.peaks.master = peak / 32768;
    const fall = Math.pow(10, -(len / 2 / RATE));          // 20 dB a second
    for (const k in this.peaks) { const h = (this.held[k] || 0) * fall; this.held[k] = this.peaks[k] > h ? this.peaks[k] : (h < 1e-5 ? 0 : h); }
    return out;
  }
}

// ── the inputs' decoders ─────────────────────────────────────────────────────────────────────────
const PCM_OUT = ['-vn', '-f', 's16le', '-ar', String(RATE), '-ac', '2', 'pipe:1'];
const QUIET = ['-hide_banner', '-loglevel', 'error'];
const bedArgs = (file) => [...QUIET, '-re', '-stream_loop', '-1', '-i', file, ...PCM_OUT];
const lineArgs = (device) => [...QUIET, '-f', 'alsa', '-ac', '2', '-i', device, ...PCM_OUT];
// The protocol list is closed: a playlist or session description fetched from the network cannot
// point the decoder at a local file.
const netArgs = (url) => [...QUIET, '-protocol_whitelist', 'srt,rtmp,rtmps,rtsp,rtp,udp,tcp,tls,http,https,crypto', '-fflags', 'nobuffer', '-i', url, ...PCM_OUT];
/** The desk microphone arrives as the browser's own recording (WebM/Opus) on stdin. */
const micArgs = () => [...QUIET, '-fflags', 'nobuffer', '-probesize', '4096', '-analyzeduration', '0', '-f', 'matroska', '-i', 'pipe:0', ...PCM_OUT];
function micDecoder() {
  const p = spawn('ffmpeg', micArgs(), { stdio: ['pipe', 'pipe', 'ignore'] });
  p.on('error', () => {}); p.stdin.on('error', () => {});
  return p;
}
const programmeArgs = (sink) => [...QUIET, '-f', 'pulse', '-i', `${sink}.monitor`, ...PCM_OUT];
/** A console: every channel of the device, interleaved, as it comes. */
const consoleArgs = (device, total) => [...QUIET, '-f', 'alsa', '-ac', String(total), '-i', device, '-f', 's16le', '-ar', String(RATE), '-ac', String(total), 'pipe:1'];
/**
 * Splits a capture of `total` interleaved channels into its first `count`: each is handed to
 * onChunk(index, buffer) as stereo (the channel on both sides), which is what a strip takes.
 */
function splitChannels(stream, total, count, onChunk) {
  const fb = total * 2; let odd = null;
  stream.on('data', (d) => {
    if (odd) { d = Buffer.concat([odd, d]); odd = null; }
    const whole = d.length - (d.length % fb);
    if (whole < d.length) odd = d.subarray(whole);
    const frames = whole / fb;
    if (!frames) return;
    for (let c = 0; c < count; c++) {
      const out = Buffer.allocUnsafe(frames * FRAME);
      for (let f = 0, at = c * 2; f < frames; f++, at += fb) { const v = d.readInt16LE(at); out.writeInt16LE(v, f * 4); out.writeInt16LE(v, f * 4 + 2); }
      onChunk(c, out);
    }
  });
  stream.on('error', () => {});
}
function decoder(args) {
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', () => {});
  return p;
}

// ── sound card inputs (ALSA) ─────────────────────────────────────────────────────────────────────
/** From /proc/asound/cards and /proc/asound/pcm: the devices that can record. */
/** How many capture channels a USB audio device has, from its /proc/asound/cardN/stream0 text. */
function captureChannels(streamText) {
  const cap = String(streamText || '').split(/^Capture:/m)[1];
  if (!cap) return null;
  const all = [...cap.matchAll(/^\s*Channels:\s*(\d+)/gm)].map((m) => Number(m[1]));
  return all.length ? Math.max(...all) : null;
}
function parseCapture(cardsText, pcmText, streams) {
  const names = new Map();
  streams = streams || {};
  for (const m of String(cardsText || '').matchAll(/^\s*(\d+)\s+\[[^\]]*\]:\s*\S+\s+-\s+(.+)$/gm)) names.set(Number(m[1]), m[2].trim());
  const out = [];
  for (const line of String(pcmText || '').split('\n')) {
    const m = line.match(/^(\d+)-(\d+):\s*([^:]*):/);
    if (!m || !/capture\s+\d+/.test(line)) continue;
    const card = Number(m[1]), dev = Number(m[2]);
    out.push({ device: `plughw:${card},${dev}`, channels: (dev === 0 && captureChannels(streams[card])) || 2, name: `${names.get(card) || 'Sound card ' + card}${m[3].trim() ? ': ' + m[3].trim() : ''}`.slice(0, 120) });
  }
  return out;
}
function captureDevices() {
  try {
    const cards = fs.readFileSync('/proc/asound/cards', 'utf8'), streams = {};
    for (const m of cards.matchAll(/^\s*(\d+)\s+\[/gm)) { try { streams[Number(m[1])] = fs.readFileSync(`/proc/asound/card${m[1]}/stream0`, 'utf8'); } catch { /* not a USB audio device */ } }
    return parseCapture(cards, fs.readFileSync('/proc/asound/pcm', 'utf8'), streams);
  } catch { return []; }
}

// ── programme sound (PulseAudio) ─────────────────────────────────────────────────────────────────
const run = (cmd, args, ms = 5000) => new Promise((resolve) => execFile(cmd, args, { timeout: ms }, (err, out) => resolve(err ? null : String(out))));
let pulseReady = null;
/** Whether programme sound can be captured here: PulseAudio answers, started by us if need be. */
function pulse() {
  if (!pulseReady) {
    pulseReady = (async () => {
      if (await run('pactl', ['info'])) return true;
      // Installed but not running (a container has no session to start it): start one for this server.
      if ((await run('pulseaudio', ['--start', '--exit-idle-time=-1'])) === null) return false;
      for (let i = 0; i < 10; i++) { if (await run('pactl', ['info'])) return true; await new Promise((r) => setTimeout(r, 300)); }
      return false;
    })();
    pulseReady.then((ok) => { if (!ok) setTimeout(() => { pulseReady = null; }, 60000).unref(); });   // look again later
  }
  return pulseReady;
}
/** A sink of its own for one stream's browser. Returns { name, module } or null. */
async function createSink(id) {
  if (!(await pulse())) return null;
  const name = 'st_' + String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  const mod = await run('pactl', ['load-module', 'module-null-sink', `sink_name=${name}`, `sink_properties=device.description=${name}`]);
  return mod ? { name, module: mod.trim() } : null;
}
function removeSink(sink) { if (sink && /^\d+$/.test(sink.module)) run('pactl', ['unload-module', sink.module]); }

module.exports = { MAX_CHANNELS, channelNames, inputNames, consoleArgs, splitChannels, captureChannels, RATE, FRAME, SECOND, MAX_LEVEL, INPUTS, NET_SCHEMES, Mix, cleanSettings, netUrl, maskUrl, netArgs, bedArgs, lineArgs, programmeArgs, micArgs, micDecoder, decoder, parseCapture, captureDevices, pulse, createSink, removeSink };
