/*
 * The audio worklets of a stream renderer's sound link (stream-render-audio.js). Loaded by the
 * server's own renderer only, never by a screen.
 *
 *   st-tap   takes what arrives at its input (a guest's sound) and posts it to the page as 16-bit
 *            stereo, 882 samples (20 ms at 44.1 kHz) at a time.
 *   st-play  plays 16-bit stereo it is posted (the mix, a guest's mix-minus) out of its output,
 *            with a small cushion: it waits for 60 ms before it starts, starts again the same way
 *            after it runs dry, and lets go of anything more than 300 ms behind, so what comes out
 *            stays close to now.
 */
const BLOCK = 882;

class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(BLOCK * 2); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const L = input[0], R = input[1] || input[0];
    for (let k = 0; k < L.length; k++) {
      const l = Math.max(-1, Math.min(1, L[k])), r = Math.max(-1, Math.min(1, R[k]));
      this.buf[this.n * 2] = l * 32767; this.buf[this.n * 2 + 1] = r * 32767;
      if (++this.n === BLOCK) { const out = this.buf; this.port.postMessage(out.buffer, [out.buffer]); this.buf = new Int16Array(BLOCK * 2); this.n = 0; }
    }
    return true;
  }
}

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(sampleRate * 2);        // one second, both channels
    this.r = 0; this.w = 0; this.fill = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data), n = pcm.length, cap = this.ring.length;
      for (let i = 0; i < n; i++) { this.ring[this.w] = pcm[i] / 32768; this.w = (this.w + 1) % cap; }
      this.fill = Math.min(cap, this.fill + n);
      const late = Math.round(sampleRate * 0.3) * 2, keep = Math.round(sampleRate * 0.1) * 2;
      if (this.fill > late) { const drop = this.fill - keep; this.r = (this.r + drop) % cap; this.fill = keep; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], cap = this.ring.length;
    if (!this.primed && this.fill >= Math.round(sampleRate * 0.06) * 2) this.primed = true;
    for (let k = 0; k < L.length; k++) {
      if (!this.primed || this.fill < 2) { L[k] = 0; R[k] = 0; this.primed = false; continue; }
      L[k] = this.ring[this.r]; R[k] = this.ring[(this.r + 1) % cap];
      this.r = (this.r + 2) % cap; this.fill -= 2;
    }
    return true;
  }
}

registerProcessor('st-tap', Tap);
registerProcessor('st-play', Play);
