'use strict';

/*
 * SIGNAL PROCESSING FOR THE STREAM MIXER (lib/stream-audio.js).
 *
 * What a channel strip on a broadcast desk does, in the order a desk does it:
 *
 *   noise       subtracts the steady noise floor under the signal (Denoiser, below)
 *   trim        input gain, and polarity
 *   high-pass   takes out rumble and handling noise (80 Hz unless moved); low-pass, the other end
 *   EQ          four bands: low shelf, two bells, high shelf, ±12 dB, each where it is put
 *   gate        closes the channel when it falls below a threshold: the room between sentences
 *   compressor  evens out loud and quiet: one "amount" control, or all five of its own
 *   de-esser    takes the edge off sibilance; chorus doubles the signal
 *   fader       level, mute and pan; ducking turns a channel down while someone talks
 *   sends       how much of the channel goes to the reverb, and to the delay
 *
 * and on the way out: the reverb's return, the master EQ and fader, and a limiter that holds the
 * sum under full scale instead of letting it clip.
 *
 * Everything works on interleaved stereo Float32 blocks in the range -1..1 and keeps its own state
 * between blocks, so block size does not matter. A control at its neutral value costs nothing: the
 * stage is skipped, and a strip with everything neutral passes its samples through untouched.
 *
 * Filters are the standard biquads (Robert Bristow-Johnson's Audio EQ Cookbook).
 */

const RATE = 44100;
const dbToLin = (db) => Math.pow(10, db / 20);
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z = [0, 0, 0, 0]; this.key = ''; }

  /** type: 'highpass' | 'lowshelf' | 'highshelf' | 'peaking'. Recomputed only when something changed. */
  set(type, freq, gainDb = 0, q = 0.707) {
    const key = `${type}|${freq}|${gainDb}|${q}`;
    if (key === this.key) return;
    this.key = key;
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * freq / RATE, cs = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    } else if (type === 'peaking') {
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
    } else {
      const sq = 2 * Math.sqrt(A) * alpha;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cs + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sq);
        a0 = (A + 1) + (A - 1) * cs + sq; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sq;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq);
        a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  /** In place, interleaved stereo (transposed direct form II, one state pair per channel). */
  run(buf) {
    const { b0, b1, b2, a1, a2, z } = this;
    let l1 = z[0], l2 = z[1], r1 = z[2], r2 = z[3];
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const xl = buf[i], yl = b0 * xl + l1; l1 = b1 * xl - a1 * yl + l2; l2 = b2 * xl - a2 * yl; buf[i] = yl;
      const xr = buf[i + 1], yr = b0 * xr + r1; r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr; buf[i + 1] = yr;
    }
    // A filter left alone with silence must settle to exactly zero, not drift in denormals.
    z[0] = Math.abs(l1) < 1e-20 ? 0 : l1; z[1] = Math.abs(l2) < 1e-20 ? 0 : l2; z[2] = Math.abs(r1) < 1e-20 ? 0 : r1; z[3] = Math.abs(r2) < 1e-20 ? 0 : r2;
  }
}

/** One-pole smoothing coefficient for a time constant in milliseconds. */
const coef = (ms) => Math.exp(-1 / (RATE * ms / 1000));

/**
 * A strip's processing controls, made safe. Neutral is: no trim, no filter, flat EQ, no dynamics,
 * no effect, no send, centre. What a channel of a digital console has:
 *
 *   trim, inv        input gain in dB, and polarity
 *   hpf, hpf_f       high-pass and where it turns over
 *   lpf              low-pass (0 = off)
 *   eq               four bands: low shelf, low-mid bell, high-mid bell, high shelf, each with its
 *                    gain and frequency, the bells with their width (Q)
 *   gate             closes the channel under a threshold
 *   comp / cmp       compressor: one "amount" knob, or (cmp.on) threshold, ratio, attack, release, make-up
 *   deess            takes the edge off sibilance (dynamic cut above 5 kHz)
 *   chorus           a modulated double of the signal
 *   fx, dly          sends to the reverb and to the delay
 *   pan              left to right; duck: turned down while someone is talking (applied by the mixer)
 */
function cleanProcessing(p) {
  const x = p && typeof p === 'object' ? p : {};
  const eq = x.eq && typeof x.eq === 'object' ? x.eq : {};
  const c = x.cmp && typeof x.cmp === 'object' ? x.cmp : {};
  return {
    trim: clamp(x.trim, -20, 40, 0), inv: x.inv === true, pan: clamp(x.pan, -1, 1, 0),
    hpf: x.hpf === true, hpf_f: clamp(x.hpf_f, 20, 400, 80), lpf: Number(x.lpf) > 0 ? clamp(x.lpf, 1000, 20000, 0) : 0,
    eq: {
      low: clamp(eq.low, -12, 12, 0), mid: clamp(eq.mid, -12, 12, 0), high: clamp(eq.high, -12, 12, 0), lomid: clamp(eq.lomid, -12, 12, 0),
      low_f: clamp(eq.low_f, 40, 400, 120), lomid_f: clamp(eq.lomid_f, 100, 2000, 400), lomid_q: clamp(eq.lomid_q, 0.3, 6, 1),
      mid_f: clamp(eq.mid_f, 400, 8000, 1200), mid_q: clamp(eq.mid_q, 0.3, 6, 0.9), high_f: clamp(eq.high_f, 2000, 16000, 8000),
    },
    gate: clamp(x.gate, 0, 1, 0),        // 0 off; up to 1 = closes below about -20 dB
    comp: clamp(x.comp, 0, 1, 0),        // 0 off; up to 1 = heavy
    cmp: { on: c.on === true, thr: clamp(c.thr, -60, 0, -20), ratio: clamp(c.ratio, 1, 20, 3), att: clamp(c.att, 0.1, 100, 8), rel: clamp(c.rel, 10, 2000, 200), gain: clamp(c.gain, 0, 24, 0) },
    deess: clamp(x.deess, 0, 1, 0), chorus: clamp(x.chorus, 0, 1, 0),
    fx: clamp(x.fx, 0, 1, 0),            // send to the reverb
    dly: clamp(x.dly, 0, 1, 0),          // send to the delay
    duck: clamp(x.duck, 0, 1, 0),
  };
}

class Strip {
  constructor() {
    this.hp = new Biquad(); this.lp = new Biquad(); this.lo = new Biquad(); this.lm = new Biquad(); this.mid = new Biquad(); this.hi = new Biquad();
    this.ess = new Biquad(); this.essShelf = new Biquad(); this.essEnv = 0; this.essOn = false;
    this.gateEnv = 0; this.gateGain = 1; this.compEnv = 0;
    this.reduction = 0;                  // what the compressor is taking off right now, in dB (for the desk)
    this.ch = null;                      // the chorus's delay lines, made when it is first used
  }

  /**
   * Processes `buf` in place up to (not including) the fader. `p` is cleanProcessing() output.
   * Returns nothing; the caller applies level, mute, pan and the sends.
   */
  run(buf, p) {
    if (p.trim || p.inv) { const g = dbToLin(p.trim || 0) * (p.inv ? -1 : 1); for (let i = 0; i < buf.length; i++) buf[i] *= g; }
    if (p.hpf) { this.hp.set('highpass', p.hpf_f || 80, 0, 0.707); this.hp.run(buf); }
    if (p.lpf) { this.lp.set('lowpass', p.lpf, 0, 0.707); this.lp.run(buf); }
    if (p.eq.low) { this.lo.set('lowshelf', p.eq.low_f || 120, p.eq.low, 0.707); this.lo.run(buf); }
    if (p.eq.lomid) { this.lm.set('peaking', p.eq.lomid_f || 400, p.eq.lomid, p.eq.lomid_q || 1); this.lm.run(buf); }
    if (p.eq.mid) { this.mid.set('peaking', p.eq.mid_f || 1200, p.eq.mid, p.eq.mid_q || 0.9); this.mid.run(buf); }
    if (p.eq.high) { this.hi.set('highshelf', p.eq.high_f || 8000, p.eq.high, 0.707); this.hi.run(buf); }
    if (p.gate > 0) {
      // Threshold from -60 dB (barely there) to -20 dB. Fast to open, slow to close, and it closes
      // by turning down smoothly, not by cutting: a gate that clicks is worse than the noise.
      const thr = dbToLin(-60 + 40 * p.gate), rel = coef(180), open = coef(3), shut = coef(120);
      let env = this.gateEnv, g = this.gateGain;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const a = Math.max(Math.abs(buf[i]), Math.abs(buf[i + 1]));
        env = a > env ? a : a + (env - a) * rel;
        const want = env >= thr ? 1 : 0;
        g = want + (g - want) * (want > g ? open : shut);
        buf[i] *= g; buf[i + 1] *= g;
      }
      this.gateEnv = env < 1e-12 ? 0 : env; this.gateGain = g;
    } else { this.gateEnv = 0; this.gateGain = 1; }
    const c = p.cmp && p.cmp.on ? p.cmp : null;
    if (c || p.comp > 0) {
      // Set by its own controls, or by the one knob: more amount = lower threshold, higher ratio, and make-up gain to match.
      const thrDb = c ? c.thr : -10 - 20 * p.comp, ratio = c ? c.ratio : 1 + 7 * p.comp, makeup = dbToLin(c ? c.gain : 6 * p.comp);
      const att = coef(c ? c.att : 8), rel = coef(c ? c.rel : 200);
      let env = this.compEnv, most = 0;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const a = Math.max(Math.abs(buf[i]), Math.abs(buf[i + 1]));
        env = a + (env - a) * (a > env ? att : rel);
        let g = makeup;
        if (env > 1e-9) {
          const over = 20 * Math.log10(env) - thrDb;
          if (over > 0) { const cut = over - over / ratio; if (cut > most) most = cut; g *= dbToLin(-cut); }
        }
        buf[i] *= g; buf[i + 1] *= g;
      }
      this.compEnv = env < 1e-12 ? 0 : env; this.reduction = most;
    } else { this.compEnv = 0; this.reduction = 0; }
    if (p.deess > 0) {
      // What is above 5 kHz is measured on its own (a copy, filtered); when it jumps out (an "s"),
      // a high shelf is pulled down by as much, a few milliseconds at a time, and let back up after.
      const top = Float32Array.from(buf); this.ess.set('highpass', 5000, 0, 0.707); this.ess.run(top);
      const thrDb = -24 - 16 * p.deess;
      for (let at = 0; at < buf.length; at += 512) {
        const end = Math.min(buf.length, at + 512);
        let pk = 0; for (let i = at; i < end; i++) { const a = top[i] < 0 ? -top[i] : top[i]; if (a > pk) pk = a; }
        const over = pk > 1e-9 ? 20 * Math.log10(pk) - thrDb : -99;
        const want = over > 0 ? Math.min(18, 0.75 * over) : 0;
        this.essEnv = want > this.essEnv ? want : this.essEnv + (want - this.essEnv) * 0.25;      // down at once, back up over ~25 ms
        const cut = Math.round(this.essEnv * 2) / 2;
        if (cut > 0 || this.essOn) { this.essShelf.set('highshelf', 4500, -cut, 0.707); this.essShelf.run(buf.subarray(at, end)); this.essOn = cut > 0; }
      }
    } else { this.essEnv = 0; this.essOn = false; }
    if (p.chorus > 0) {
      // A copy of the signal, 15 ms late and drifting by a few ms, a little differently on each side.
      if (!this.ch) this.ch = { l: new Float32Array(2048), r: new Float32Array(2048), w: 0, ph: 0 };
      const ch = this.ch, wet = 0.5 * p.chorus, step = 2 * Math.PI * 0.8 / RATE;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        ch.l[ch.w] = buf[i]; ch.r[ch.w] = buf[i + 1];
        const tap = (line, phase) => { const d = (15 + 5 * Math.sin(ch.ph + phase)) * RATE / 1000, at = ch.w - d, i0 = Math.floor(at), fr = at - i0; return line[i0 & 2047] * (1 - fr) + line[(i0 + 1) & 2047] * fr; };
        buf[i] += tap(ch.l, 0) * wet; buf[i + 1] += tap(ch.r, Math.PI / 2) * wet;
        ch.w = (ch.w + 1) & 2047; ch.ph += step; if (ch.ph > 2 * Math.PI) ch.ph -= 2 * Math.PI;
      }
    } else if (this.ch) this.ch = null;
  }
}

/** An echo: what is sent comes back `ms` later, and again, each time quieter (`fb`), crossing sides as it goes. */
class Delay {
  constructor() { this.l = new Float32Array(1 << 17); this.r = new Float32Array(1 << 17); this.w = 0; this.active = 0; }
  run(send, out, ms, fb, hasInput) {
    if (hasInput) this.active = RATE * 8; else if (this.active <= 0) return;
    const d = Math.max(1, Math.min((1 << 17) - 1, Math.round(ms * RATE / 1000))), mask = (1 << 17) - 1;
    for (let i = 0; i + 1 < send.length; i += 2) {
      const at = (this.w - d) & mask, dl = this.l[at], dr = this.r[at];
      out[i] += dl; out[i + 1] += dr;
      this.l[this.w] = send[i] + dr * fb; this.r[this.w] = send[i + 1] + dl * fb;
      this.w = (this.w + 1) & mask;
    }
    this.active -= send.length / 2;
    if (this.active <= 0) { this.l.fill(0); this.r.fill(0); }
  }
}

/** A small room: four comb filters into two all-pass filters a side (Schroeder), fed in mono. */
class Reverb {
  constructor() {
    const line = (n) => ({ buf: new Float32Array(n), i: 0 });
    const combs = [1557, 1617, 1491, 1422], alls = [225, 556];
    this.l = { combs: combs.map((n) => line(n)), alls: alls.map((n) => line(n)) };
    this.r = { combs: combs.map((n) => line(n + 23)), alls: alls.map((n) => line(n + 23)) };   // a touch longer on the right: width
    this.active = 0;                     // samples of tail left to render after the last input
  }

  /** Adds the reverb of `send` (interleaved stereo) into `out`. `decay` 0..1 is the room's length. */
  run(send, out, decay, hasInput) {
    if (hasInput) this.active = RATE * 4; else if (this.active <= 0) return;
    const fb = 0.72 + 0.2 * decay;
    const side = (s, x) => {
      let y = 0;
      for (const c of s.combs) { const d = c.buf[c.i]; y += d; c.buf[c.i] = x + d * fb; if (++c.i === c.buf.length) c.i = 0; }
      y *= 0.25;
      for (const a of s.alls) { const d = a.buf[a.i]; const v = y + d * 0.5; a.buf[a.i] = v; y = d - v * 0.5; if (++a.i === a.buf.length) a.i = 0; }
      return y;
    };
    for (let i = 0; i + 1 < send.length; i += 2) {
      const x = (send[i] + send[i + 1]) * 0.5;
      out[i] += side(this.l, x); out[i + 1] += side(this.r, x);
    }
    this.active -= send.length / 2;
  }
}

/** Holds the sum under full scale: instant to clamp down, slow to let go. Transparent below the ceiling. */
class Limiter {
  constructor() { this.gain = 1; this.reduction = 0; }
  run(buf) {
    const ceil = 0.98, rel = coef(250);
    let g = this.gain, most = 0;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const a = Math.max(Math.abs(buf[i]), Math.abs(buf[i + 1]));
      const need = a * g > ceil ? ceil / a : 1;
      g = need < g ? need : need + (g - need) * rel;
      if (g < 1) { buf[i] *= g; buf[i + 1] *= g; const cut = -20 * Math.log10(g); if (cut > most) most = cut; }
    }
    this.gain = g > 0.9999 ? 1 : g; this.reduction = most;
  }
}

// ── noise floor subtraction ──────────────────────────────────────────────────────────────────────
const NFFT = 1024, HOP = NFFT / 4, BINS = NFFT / 2 + 1;
const HANN = Float32Array.from({ length: NFFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));
const COS = Float32Array.from({ length: NFFT / 2 }, (_, i) => Math.cos(2 * Math.PI * i / NFFT));
const SIN = Float32Array.from({ length: NFFT / 2 }, (_, i) => Math.sin(2 * Math.PI * i / NFFT));
const REV = Uint16Array.from({ length: NFFT }, (_, i) => { let r = 0; for (let b = 0, x = i; b < 10; b++, x >>= 1) r = (r << 1) | (x & 1); return r; });
/** In-place radix-2 FFT of NFFT points. `inv` gives the inverse, scaled. */
function fft(re, im, inv) {
  for (let i = 0; i < NFFT; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let i = 0; i < NFFT; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = COS[k], wi = inv ? SIN[k] : -SIN[k];
        const xr = re[i + j + half] * wr - im[i + j + half] * wi, xi = re[i + j + half] * wi + im[i + j + half] * wr;
        re[i + j + half] = re[i + j] - xr; im[i + j + half] = im[i + j] - xi;
        re[i + j] += xr; im[i + j] += xi;
      }
    }
  }
  if (inv) for (let i = 0; i < NFFT; i++) { re[i] /= NFFT; im[i] /= NFFT; }
}

/** A noise print as stored: one byte per frequency bin, in half-dB steps up from -127.5 dB, base64. */
const PRINT_LEN = Math.ceil(BINS / 3) * 4;
const isPrint = (v) => typeof v === 'string' && v.length === PRINT_LEN && /^[A-Za-z0-9+/]+=*$/.test(v);
function packPrint(power) {
  const b = Buffer.alloc(BINS);
  for (let k = 0; k < BINS; k++) b[k] = Math.max(0, Math.min(255, Math.round((10 * Math.log10(power[k] + 1e-20) + 127.5) * 2)));
  return b.toString('base64');
}
function unpackPrint(text) {
  const b = Buffer.from(text, 'base64'), p = new Float32Array(BINS);
  for (let k = 0; k < BINS; k++) p[k] = Math.pow(10, (b[k] / 2 - 127.5) / 10);
  return p;
}

/**
 * NOISE FLOOR SUBTRACTION: takes the steady noise under a signal (air handling, hum, hiss, a
 * camera's preamp) out of it, by frequency.
 *
 * The sound is cut into overlapping 23 ms frames and each is taken to its spectrum. In every
 * frequency bin, the noise that is known to be there is subtracted from what arrived, and the bin
 * is turned down by the result: a bin that is all noise goes down to the floor, a bin with signal
 * well above the noise is left alone. The frames are then put back together.
 *
 * What "the noise that is known to be there" is:
 *   a learned print   learn() listens for a second and a half while nobody speaks and keeps the
 *                     average spectrum. The most exact, and it does not move afterwards.
 *   or, with no print,  a running estimate: the quietest each bin has been in the last second or
 *                     two, which is the noise as long as the signal has gaps in it (speech does;
 *                     continuous music does not, so learn a print for that).
 *
 * It delays the strip by one frame (23 ms). It is not echo cancellation and does not remove a
 * room's reverberation.
 */
class Denoiser {
  constructor() {
    const ch = () => ({ inp: new Float32Array(NFFT), out: new Float32Array(NFFT), re: new Float32Array(NFFT), im: new Float32Array(NFFT) });
    this.c = [ch(), ch()];
    this.w = 0; this.since = 0;
    this.gain = new Float32Array(BINS).fill(1);
    this.snr = new Float32Array(BINS);                     // each bin's signal-to-noise as last concluded
    this.smooth = new Float32Array(BINS);                  // smoothed power per bin, for the running estimate
    this.minNow = new Float32Array(BINS).fill(Infinity); this.minOld = new Float32Array(BINS).fill(Infinity);
    this.frames = 0;
    this.print = null; this.printKey = null;               // learned noise power per bin
    this.learning = null;                                  // { sum, left, done }
    this.on = false;
  }

  /** Use a stored print (or none). Decoded only when it changes. */
  setPrint(text) {
    const key = isPrint(text) ? text : null;
    if (key === this.printKey) return;
    this.printKey = key; this.print = key ? unpackPrint(key) : null;
  }

  /** Listen to the next `seconds` of this strip as noise. Resolves with the print, packed. */
  learn(seconds = 1.5) {
    return new Promise((resolve) => {
      if (this.learning) this.learning.done(null);
      this.learning = { sum: new Float64Array(BINS), n: 0, left: Math.max(8, Math.round(seconds * RATE / HOP)), done: resolve };
    });
  }
  cancelLearn() { if (this.learning) { const l = this.learning; this.learning = null; l.done(null); } }

  _frame(amount) {
    const [L, R] = this.c, w = this.w;
    for (const c of [L, R]) {
      for (let i = 0; i < NFFT; i++) { c.re[i] = c.inp[(w + i) & (NFFT - 1)] * HANN[i]; c.im[i] = 0; }
      fft(c.re, c.im, false);
    }
    const lr = this.learning;
    const over = 1 + 3 * amount, floor = dbToLin(-6 - 30 * amount);
    this.frames++;
    const turn = this.frames % 70 === 0;                   // every 0.4 s the "quietest so far" starts again
    for (let k = 0; k < BINS; k++) {
      const p = (L.re[k] * L.re[k] + L.im[k] * L.im[k] + R.re[k] * R.re[k] + R.im[k] * R.im[k]) * 0.5;
      const sm = this.smooth[k] = this.frames === 1 ? p : 0.8 * this.smooth[k] + 0.2 * p;
      if (sm < this.minNow[k]) this.minNow[k] = sm;
      if (lr) lr.sum[k] += p;
      // The quietest a smoothed bin has been sits under the noise's average: 1.7 brings it back up.
      const noise = this.print ? this.print[k] : Math.min(this.minNow[k], this.minOld[k]) * 1.7;
      // How far the bin stands above its noise, judged over time as well as now ("decision
      // directed": mostly what the last frame concluded, a little of this one). A single frame's
      // spectrum of noise is ragged; judging each frame alone lets isolated bins flicker open,
      // which is what sounds like water.
      let g = 1;
      if (amount > 0 && noise > 0 && Number.isFinite(noise)) {
        const post = p / (over * noise + 1e-20);
        const prio = 0.96 * this.snr[k] + 0.04 * Math.max(0, post - 1);
        g = prio / (1 + prio);
        if (g < floor) g = floor;
        this.snr[k] = Math.min(1e6, g * g * post);
      } else this.snr[k] = 0;
      this.gain[k] = g;
    }
    if (turn) { this.minOld.set(this.minNow); this.minNow.fill(Infinity); }
    if (lr) {
      lr.n++;
      if (--lr.left <= 0) {
        const mean = new Float32Array(BINS); for (let k = 0; k < BINS; k++) mean[k] = lr.sum[k] / lr.n;
        this.learning = null; lr.done(packPrint(mean));
      }
    }
    for (const c of [L, R]) {
      for (let k = 0; k < BINS; k++) {
        const g = this.gain[k]; c.re[k] *= g; c.im[k] *= g;
        if (k > 0 && k < NFFT / 2) { c.re[NFFT - k] *= g; c.im[NFFT - k] *= g; }
      }
      fft(c.re, c.im, true);
      // Four frames overlap at every sample; with a Hann window on the way in and on the way out they sum to 1.5.
      for (let i = 0; i < NFFT; i++) c.out[(w + i) & (NFFT - 1)] += c.re[i] * HANN[i] / 1.5;
    }
  }

  /** In place, interleaved stereo. `amount` 0 while nothing is being learned costs nothing. */
  run(buf, amount) {
    if (!(amount > 0) && !this.learning) {
      if (this.on) { this.on = false; for (const c of this.c) { c.inp.fill(0); c.out.fill(0); } this.gain.fill(1); this.snr.fill(0); this.frames = 0; this.minNow.fill(Infinity); this.minOld.fill(Infinity); }
      return;
    }
    this.on = true;
    const [L, R] = this.c;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const w = this.w;
      L.inp[w] = buf[i]; R.inp[w] = buf[i + 1];
      // Learning with the control at zero listens without changing the sound.
      if (amount > 0) { buf[i] = L.out[w]; buf[i + 1] = R.out[w]; }
      L.out[w] = 0; R.out[w] = 0;
      this.w = (w + 1) & (NFFT - 1);
      if (++this.since === HOP) { this.since = 0; this._frame(amount > 0 ? amount : 0); }
    }
  }
}

module.exports = { RATE, Biquad, Strip, Reverb, Delay, Limiter, Denoiser, cleanProcessing, dbToLin, isPrint, NFFT };
