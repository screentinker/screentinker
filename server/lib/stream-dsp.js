'use strict';

/*
 * SIGNAL PROCESSING FOR THE STREAM MIXER (lib/stream-audio.js).
 *
 * What a channel strip on a broadcast desk does, in the order a desk does it:
 *
 *   high-pass   takes out rumble and handling noise below 80 Hz
 *   EQ          three bands: low shelf (120 Hz), mid bell (1.2 kHz), high shelf (8 kHz), ±12 dB
 *   gate        closes the channel when it falls below a threshold: the room between sentences
 *   compressor  evens out loud and quiet, one "amount" control
 *   fader       level and mute
 *   send        how much of the channel goes to the reverb
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

/** A strip's processing controls, made safe. Neutral is: no filter, no dynamics, no send. */
function cleanProcessing(p) {
  const x = p && typeof p === 'object' ? p : {};
  const eq = x.eq && typeof x.eq === 'object' ? x.eq : {};
  return {
    hpf: x.hpf === true,
    eq: { low: clamp(eq.low, -12, 12, 0), mid: clamp(eq.mid, -12, 12, 0), high: clamp(eq.high, -12, 12, 0) },
    gate: clamp(x.gate, 0, 1, 0),        // 0 off; up to 1 = closes below about -20 dB
    comp: clamp(x.comp, 0, 1, 0),        // 0 off; up to 1 = heavy
    fx: clamp(x.fx, 0, 1, 0),            // send to the reverb
  };
}

class Strip {
  constructor() {
    this.hp = new Biquad(); this.lo = new Biquad(); this.mid = new Biquad(); this.hi = new Biquad();
    this.gateEnv = 0; this.gateGain = 1; this.compEnv = 0;
    this.reduction = 0;                  // what the compressor is taking off right now, in dB (for the desk)
  }

  /**
   * Processes `buf` in place up to (not including) the fader. `p` is cleanProcessing() output.
   * Returns nothing; the caller applies level, mute and the send.
   */
  run(buf, p) {
    if (p.hpf) { this.hp.set('highpass', 80, 0, 0.707); this.hp.run(buf); }
    if (p.eq.low) { this.lo.set('lowshelf', 120, p.eq.low, 0.707); this.lo.run(buf); }
    if (p.eq.mid) { this.mid.set('peaking', 1200, p.eq.mid, 0.9); this.mid.run(buf); }
    if (p.eq.high) { this.hi.set('highshelf', 8000, p.eq.high, 0.707); this.hi.run(buf); }
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
    if (p.comp > 0) {
      // One knob: more amount = lower threshold, higher ratio, and make-up gain to match.
      const thrDb = -10 - 20 * p.comp, ratio = 1 + 7 * p.comp, makeup = dbToLin(6 * p.comp);
      const att = coef(8), rel = coef(200);
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

module.exports = { RATE, Biquad, Strip, Reverb, Limiter, cleanProcessing, dbToLin };
