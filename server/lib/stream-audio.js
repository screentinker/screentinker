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
 *   pads        the sound pads: short audio items (a jingle, a sting, applause) fired from the desk,
 *               several at once if need be, each with its own level; the strip is their sum.
 *   g:<id>      each guest of the stream (lib/mixer-guests.js), a strip of their own, made when their
 *               sound first arrives from the renderer (lib/stream-out.js, the renderer's audio link)
 *               and gone when they leave. Heard only while the guest is on air; metered always, so
 *               the desk sees a guest in the green room speaking. New guests start from the `guest`
 *               settings (the operator's "use for new guests").
 *
 * What goes back: the mix itself (to screens showing the stream), and for each guest who is to hear
 * the show, the mix without their own voice (a mix-minus: nobody hears themselves come back late).
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
const INPUTS = ['programme', 'bed', 'mic', 'line', 'net', 'net2'];   // each started from its settings (lib/stream-out.js)
const STRIPS = [...INPUTS, 'pads'];                                    // ...and the pads, fed from here
const MAX_PADS = 12;
const isGuestStrip = (name) => typeof name === 'string' && /^g:[A-Za-z0-9_-]{1,64}$/.test(name);
const MAX_CHANNELS = 32;
const channelNames = (count) => Array.from({ length: Math.max(0, Math.min(MAX_CHANNELS, count | 0)) }, (_, i) => 'c' + (i + 1));
/** Every input strip of a mix with these settings, in desk order: the fixed inputs, then the console's channels. */
const inputNames = (settings) => [...STRIPS, ...channelNames(settings && settings.console ? settings.console.count : 0)];
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
  // What a new guest's strip starts as.
  out.guest = { ...strip(x.guest), denoise: unit(x.guest && x.guest.denoise), noise: null };
  // The pads: which audio item each is, what it is called, its own level, whether it loops.
  out.pad_list = (Array.isArray(x.pad_list) ? x.pad_list : []).slice(0, MAX_PADS).map((p) => (p && typeof p === 'object' && typeof p.content_id === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(p.content_id)
    ? { content_id: p.content_id, label: typeof p.label === 'string' ? p.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) : '', level: level(p.level, 1), loop: p.loop === true } : null));
  const m = x.master && typeof x.master === 'object' ? x.master : {};
  const mp = dsp.cleanProcessing(m);
  out.master = { level: level(m.level, 1), muted: !!m.muted, eq: mp.eq, comp: mp.comp, cmp: mp.cmp };
  const fx = x.fx && typeof x.fx === 'object' ? x.fx : {};
  const num = (v, lo, hi, dflt) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  out.fx = { decay: num(fx.decay, 0, 1, 0.5), delay_ms: num(fx.delay_ms, 50, 1500, 350), delay_fb: num(fx.delay_fb, 0, 0.9, 0.35) };
  return out;
}

class Mix {
  constructor(settings) {
    this.settings = cleanSettings(settings);
    this.inputs = new Map();     // name -> { q: Buffer[], bytes, stream, live, odd }
    this.strips = {}; this.denoisers = {};        // made when a strip is first used: the console's channels come and go
    this.masterEq = new dsp.Strip();
    this.reverb = new dsp.Reverb(); this.delay = new dsp.Delay();
    this.talk = 0; this.ducked = 0;      // how loud the talking strips were a moment ago; how far ducking is in (0..1)
    this.limiter = new dsp.Limiter();
    this.peaks = Object.fromEntries([...INPUTS, 'master'].map((n) => [n, 0]));
    // What a meter shows: the loudest each strip has been lately, falling back at 20 dB a second,
    // so a desk that looks a few times a second still sees every peak.
    this.held = Object.fromEntries([...INPUTS, 'master'].map((n) => [n, 0]));
    this.limiting = 0;           // dB the limiter is holding back right now
    this.guests = {};            // 'g:<id>' -> { set (strip settings), on (on air), hear (gets a mix-minus) }
    this.voices = [];            // the pads that are sounding: { pad, pcm, pos, gain, loop, fade }
    this.onMix = null;           // (mix Buffer, Map(guest strip -> its mix-minus Buffer)) after each block, when set
  }

  setSettings(s) { this.settings = cleanSettings(s); }

  /** A guest's strip: its settings, whether they are on air, whether they hear the show. Null removes it. */
  setGuest(name, g) {
    if (!isGuestStrip(name)) return;
    if (!g) { delete this.guests[name]; this.detach(name); delete this.strips[name]; delete this.denoisers[name]; delete this.peaks[name]; delete this.held[name]; return; }
    const was = this.guests[name];
    const from = g.set || this.settings.guest;
    this.guests[name] = { set: { ...strip(from), denoise: unit(from && from.denoise), noise: null }, on: !!g.on, hear: g.hear !== false };
    if (!was) { this.peaks[name] = 0; this.held[name] = 0; }
  }
  guestInput(name) { return this.inputs.get(name) || (isGuestStrip(name) ? this.open(name, { live: true }) : null); }

  /** Fires pad `n` with its sound (16-bit stereo PCM at RATE). Again while it sounds: from the top. */
  fire(n, pcm) {
    const p = this.settings.pad_list[n];
    if (!p || !pcm || !pcm.length) return false;
    this.voices = this.voices.filter((v) => v.pad !== n);
    this.voices.push({ pad: n, pcm, pos: 0, loop: p.loop, fade: 0 });
    return true;
  }
  /** Stops pad `n` (or every pad), with a short fade so nothing clicks. */
  hush(n = null) { for (const v of this.voices) if (n == null || v.pad === n) v.fade = v.fade || 1; }
  sounding() { return this.voices.filter((v) => !v.fade).map((v) => ({ pad: v.pad, at: v.pos / v.pcm.length })); }
  _pads(buf) {
    const keep = [], step = 1 / (RATE * 2 * 0.15);       // a stopped pad fades out over 150 ms
    for (const v of this.voices) {
      const p = this.settings.pad_list[v.pad], gain = p ? p.level : 0;
      let done = !p;
      for (let i = 0; i < buf.length && !done; i++) {
        if (v.pos >= v.pcm.length) { if (v.loop && !v.fade) v.pos = 0; else { done = true; break; } }
        let g = gain;
        if (v.fade) { g *= v.fade; v.fade -= step; if (v.fade <= 0) { done = true; break; } }
        buf[i] += (v.pcm.readInt16LE(v.pos) / 32768) * g; v.pos += 2;
      }
      if (!done) keep.push(v);
    }
    this.voices = keep;
  }

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
    const sum = new Float32Array(len), send = new Float32Array(len), send2 = new Float32Array(len);
    let sending = false, echoing = false, talk = 0;
    // DUCKING. While any talking strip (a microphone, the line, a console channel, a network
    // feed) carries signal, the strips set to duck (the bed, the programme) are turned down, and
    // come back when the talking stops: quick down, slow up.
    const secs = len / 2 / RATE, was = this.ducked;
    this.ducked = this.talk > 0.02 ? Math.min(1, was + secs / 0.08) : Math.max(0, was - secs / 0.9);
    const contrib = new Map();         // guest strip -> what it put into the sum (for the mix-minus)
    for (const name of [...inputNames(this.settings), ...Object.keys(this.guests)]) {
      const guest = this.guests[name] || null;
      const input = name === 'pads' ? null : this.inputs.get(name);
      if (name === 'pads' ? !this.voices.length : !input) { this.peaks[name] = 0; continue; }
      const set = guest ? guest.set : this.settings[name];
      // Always taken from the queue, muted or not: a muted input must still be at "now" when it is opened.
      const buf = new Float32Array(len);
      let at = 0;
      if (name === 'pads') this._pads(buf);
      else while (at < len && input.q.length) {
        const head = input.q[0], take = Math.min(head.length, (len - at) * 2);
        for (let i = 0; i < take; i += 2) buf[at + i / 2] = head.readInt16LE(i) / 32768;
        at += take / 2; input.bytes -= take;
        if (take === head.length) input.q.shift(); else input.q[0] = head.subarray(take);
      }
      if (input && !input.live && input.stream && input.bytes < SECOND / 2 && input.stream.isPaused && input.stream.isPaused()) input.stream.resume();
      const dn = this._dn(name);
      dn.setPrint(set.noise); dn.run(buf, set.denoise);
      (this.strips[name] || (this.strips[name] = new dsp.Strip())).run(buf, set);
      // A guest in the green room is metered (the desk sees them speak) but not heard.
      const gain = set.muted ? 0 : set.level;
      const heard = guest && !guest.on ? 0 : gain;
      let peak = 0;
      if (heard === 0 && gain !== 0) { for (let i = 0; i < len; i++) { const m = Math.abs(buf[i] * gain); if (m > peak) peak = m; } }
      if (heard !== 0) {
        const mine = guest ? new Float32Array(len) : null;
        const fx = set.fx, dly = set.dly;
        const gl = gain * (set.pan > 0 ? 1 - set.pan : 1), gr = gain * (set.pan < 0 ? 1 + set.pan : 1);
        // A ducked strip's gain moves across the block from where ducking was to where it is now: no steps to hear.
        const d0 = set.duck ? dsp.dbToLin(-24 * set.duck * was) : 1, d1 = set.duck ? dsp.dbToLin(-24 * set.duck * this.ducked) : 1;
        for (let i = 0; i < len; i++) {
          const v = buf[i] * ((i & 1) ? gr : gl) * (d0 + (d1 - d0) * (i / len)); sum[i] += v; if (mine) mine[i] = v;
          const m = v < 0 ? -v : v; if (m > peak) peak = m;
          if (fx) send[i] += v * fx;
          if (dly) send2[i] += v * dly;
        }
        if (mine) contrib.set(name, mine);
        if (fx && peak > 0) sending = true;
        if (dly && peak > 0) echoing = true;
      }
      this.peaks[name] = Math.min(1, peak);
      if (!set.duck && name !== 'programme' && name !== 'bed' && name !== 'pads' && heard !== 0 && peak > talk) talk = peak;
    }
    this.talk = talk;
    this.reverb.run(send, sum, this.settings.fx.decay, sending);
    this.delay.run(send2, sum, this.settings.fx.delay_ms, this.settings.fx.delay_fb, echoing);
    const master = this.settings.master;
    this.masterEq.run(sum, { hpf: false, eq: master.eq, gate: 0, comp: master.comp, cmp: master.cmp, fx: 0 });
    const mg = master.muted ? 0 : master.level;
    if (mg !== 1) for (let i = 0; i < len; i++) sum[i] *= mg;
    // Each guest who hears the show: the mix as it is now, less what they put into it. Soft-limited on its own.
    const minus = new Map();
    if (this.onMix) for (const [name, g] of Object.entries(this.guests)) {
      if (!g.hear) continue;
      const mine = contrib.get(name), b = Buffer.alloc(n);
      for (let i = 0; i < len; i++) { let v = sum[i] - (mine ? mine[i] * mg : 0); if (v > 0.9) v = 0.9 + 0.1 * Math.tanh((v - 0.9) / 0.1); else if (v < -0.9) v = -0.9 - 0.1 * Math.tanh((-v - 0.9) / 0.1); b.writeInt16LE(Math.round(v * 32767), i * 2); }
      minus.set(name, b);
    }
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
    if (this.onMix) { try { this.onMix(out, minus); } catch { /* a listener's trouble is not the mix's */ } }
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

module.exports = { MAX_PADS, STRIPS, isGuestStrip, MAX_CHANNELS, channelNames, inputNames, consoleArgs, splitChannels, captureChannels, RATE, FRAME, SECOND, MAX_LEVEL, INPUTS, NET_SCHEMES, Mix, cleanSettings, netUrl, maskUrl, netArgs, bedArgs, lineArgs, programmeArgs, micArgs, micDecoder, decoder, parseCapture, captureDevices, pulse, createSink, removeSink };
