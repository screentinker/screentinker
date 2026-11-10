'use strict';

/*
 * THE SOUND OF A STREAM OUTPUT (lib/stream-out.js): a small audio mixer.
 *
 * A stream's sound is mixed in this process, as 16-bit stereo PCM at 44.1 kHz, and handed to the
 * encoder beside the picture. There are three inputs, each with its own fader and mute, summed
 * into a master with its own:
 *
 *   programme   what the programme itself is playing (the sound of its videos and audio tracks).
 *               The renderer's browser plays into a PulseAudio sink of its own and this reads the
 *               sink back. Needs PulseAudio on the server; without it the input is simply absent.
 *   bed         an uploaded audio item, looped.
 *   line        a sound card input on the server (a USB audio interface, a desk's output),
 *               read through ALSA.
 *
 * Each input is a child process that writes PCM to its stdout (ffmpeg in all three cases). The
 * mixer never waits for an input: at each tick it takes what is there and fills the rest with
 * silence, so a stalled or dead input costs its own sound and nothing else. Faders are applied
 * to the samples as they go out, which is what makes them live.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');

const RATE = 44100;
const FRAME = 4;                 // bytes per stereo 16-bit sample
const SECOND = RATE * FRAME;
const MAX_LEVEL = 1.5;
const INPUTS = ['programme', 'bed', 'line'];

const level = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(MAX_LEVEL, n)) : dflt; };
const strip = (s, dflt = 1) => ({ level: level(s && s.level, dflt), muted: !!(s && s.muted) });

/** Settings as stored and as sent, made safe: every strip present, every level in range. */
function cleanSettings(s) {
  const x = s && typeof s === 'object' ? s : {};
  const out = { master: strip(x.master), programme: strip(x.programme), bed: strip(x.bed), line: strip(x.line) };
  out.line.device = typeof (x.line && x.line.device) === 'string' && /^plughw:\d{1,2},\d{1,2}$/.test(x.line.device) ? x.line.device : null;
  return out;
}

class Mix {
  constructor(settings) {
    this.settings = cleanSettings(settings);
    this.inputs = new Map();     // name -> { q: Buffer[], bytes, stream, live }
    this.peaks = { master: 0, programme: 0, bed: 0, line: 0 };
  }

  setSettings(s) { this.settings = cleanSettings(s); }

  /**
   * Attach an input's PCM stream. `live` inputs (programme, line) are happening now: when more
   * than half a second is waiting, the oldest is dropped so the sound stays with the picture.
   * A file (the bed) is paused instead, so none of it is lost.
   */
  attach(name, stream, { live = false } = {}) {
    this.detach(name);
    const input = { q: [], bytes: 0, stream, live, odd: null };
    this.inputs.set(name, input);
    stream.on('data', (d) => {
      if (this.inputs.get(name) !== input) return;
      // A pipe cuts where it likes; the queue only ever holds whole stereo samples.
      if (input.odd) { d = Buffer.concat([input.odd, d]); input.odd = null; }
      const whole = d.length - (d.length % FRAME);
      if (whole < d.length) input.odd = d.subarray(whole);
      if (!whole) return;
      d = d.subarray(0, whole);
      input.q.push(d); input.bytes += d.length;
      if (live) {
        while (input.bytes > SECOND / 2 && input.q.length > 1) input.bytes -= input.q.shift().length;
      } else if (input.bytes > SECOND) stream.pause();
    });
    stream.on('error', () => {});
  }

  detach(name) { this.inputs.delete(name); this.peaks[name] = 0; }

  /** `n` bytes of mixed sound for right now. */
  next(n) {
    n -= n % FRAME;
    const samples = n / 2;
    const sum = new Int32Array(samples);
    for (const name of INPUTS) {
      const input = this.inputs.get(name);
      let peak = 0;
      if (input) {
        const set = this.settings[name];
        const gain = set.muted ? 0 : set.level;
        let at = 0;                                    // sample index
        while (at < samples && input.q.length) {
          const head = input.q[0], takeBytes = Math.min(head.length, (samples - at) * 2);
          if (gain !== 0) {
            for (let i = 0; i < takeBytes; i += 2) {
              const v = head.readInt16LE(i) * gain;
              sum[at + i / 2] += v;
              const m = v < 0 ? -v : v; if (m > peak) peak = m;
            }
          }
          at += takeBytes / 2; input.bytes -= takeBytes;
          if (takeBytes === head.length) input.q.shift(); else input.q[0] = head.subarray(takeBytes);
        }
        if (!input.live && input.bytes < SECOND / 2 && input.stream.isPaused && input.stream.isPaused()) input.stream.resume();
      }
      this.peaks[name] = Math.min(1, peak / 32768);
    }
    const out = Buffer.alloc(n);
    const master = this.settings.master.muted ? 0 : this.settings.master.level;
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      let v = Math.round(sum[i] * master);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;   // loud clips; it never wraps
      out.writeInt16LE(v, i * 2);
      const a = v < 0 ? -v : v; if (a > peak) peak = a;
    }
    this.peaks.master = peak / 32768;
    return out;
  }
}

// ── the inputs' decoders ─────────────────────────────────────────────────────────────────────────
const PCM_OUT = ['-vn', '-f', 's16le', '-ar', String(RATE), '-ac', '2', 'pipe:1'];
const QUIET = ['-hide_banner', '-loglevel', 'error'];
const bedArgs = (file) => [...QUIET, '-re', '-stream_loop', '-1', '-i', file, ...PCM_OUT];
const lineArgs = (device) => [...QUIET, '-f', 'alsa', '-ac', '2', '-i', device, ...PCM_OUT];
const programmeArgs = (sink) => [...QUIET, '-f', 'pulse', '-i', `${sink}.monitor`, ...PCM_OUT];
function decoder(args) {
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', () => {});
  return p;
}

// ── sound card inputs (ALSA) ─────────────────────────────────────────────────────────────────────
/** From /proc/asound/cards and /proc/asound/pcm: the devices that can record. */
function parseCapture(cardsText, pcmText) {
  const names = new Map();
  for (const m of String(cardsText || '').matchAll(/^\s*(\d+)\s+\[[^\]]*\]:\s*\S+\s+-\s+(.+)$/gm)) names.set(Number(m[1]), m[2].trim());
  const out = [];
  for (const line of String(pcmText || '').split('\n')) {
    const m = line.match(/^(\d+)-(\d+):\s*([^:]*):/);
    if (!m || !/capture\s+\d+/.test(line)) continue;
    const card = Number(m[1]), dev = Number(m[2]);
    out.push({ device: `plughw:${card},${dev}`, name: `${names.get(card) || 'Sound card ' + card}${m[3].trim() ? ': ' + m[3].trim() : ''}`.slice(0, 120) });
  }
  return out;
}
function captureDevices() {
  try { return parseCapture(fs.readFileSync('/proc/asound/cards', 'utf8'), fs.readFileSync('/proc/asound/pcm', 'utf8')); } catch { return []; }
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

module.exports = { RATE, FRAME, SECOND, MAX_LEVEL, INPUTS, Mix, cleanSettings, bedArgs, lineArgs, programmeArgs, decoder, parseCapture, captureDevices, pulse, createSink, removeSink };
