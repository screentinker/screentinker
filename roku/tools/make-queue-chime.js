#!/usr/bin/env node
'use strict';

/*
 * Writes roku/sounds/queue-chime.wav, the "Now serving" chime the Roku player plays
 * (source/lib/queuechime.brs, components/MainScene.xml SoundEffect).
 *
 * The same two tones the web player synthesises in playQueueChime (server/player/index.html):
 *   880 Hz from 0 s for 0.35 s, then 660 Hz from 0.38 s for 0.5 s; each a sine whose gain rises
 *   exponentially from 0.0001 to 0.5 over 20 ms, then decays exponentially back to 0.0001 at the
 *   end of the tone (the Web Audio exponentialRampToValueAtTime curve). 0.9 s in all, mono 16-bit
 *   PCM at 44.1 kHz. A SoundEffect plays it once; nothing loops it.
 *
 * Our own generated sound: no licence to track. Deterministic, so a test checks the committed file
 * is exactly what this writes (server/test/queue-chime-roku.test.js).
 *
 *   node roku/tools/make-queue-chime.js            (writes the file)
 *   node roku/tools/make-queue-chime.js --check    (exit 1 if the committed file differs)
 */

const fs = require('fs');
const path = require('path');

const RATE = 44100;
const TOTAL_S = 0.9;
const PEAK = 0.5;
const FLOOR = 0.0001;
const RISE_S = 0.02;
const TONES = [
  { freq: 880, at: 0, len: 0.35 },
  { freq: 660, at: 0.38, len: 0.5 },
];
const OUT = path.join(__dirname, '..', 'sounds', 'queue-chime.wav');

// Web Audio's exponential ramp from v0 at t0 to v1 at t1.
const expRamp = (v0, v1, t0, t1, t) => v0 * Math.pow(v1 / v0, (t - t0) / (t1 - t0));

function gainAt(tone, t) {
  const s = t - tone.at;
  if (s < 0 || s > tone.len) return 0;
  if (s <= RISE_S) return expRamp(FLOOR, PEAK, 0, RISE_S, s);
  return expRamp(PEAK, FLOOR, RISE_S, tone.len, s);
}

function samples() {
  const n = Math.round(TOTAL_S * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (const tone of TONES) {
      const g = gainAt(tone, t);
      if (g > 0) v += g * Math.sin(2 * Math.PI * tone.freq * (t - tone.at));
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

function build() {
  const pcm = samples();
  const data = pcm.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);          // PCM fmt chunk size
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(1, 22);           // mono
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);    // byte rate
  b.writeUInt16LE(2, 32);           // block align
  b.writeUInt16LE(16, 34);          // bits per sample
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  return b;
}

if (require.main === module) {
  const wav = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
    if (!cur || !cur.equals(wav)) { console.error(`${OUT} is not what this script writes; run it again`); process.exit(1); }
    console.log(`${OUT} is current (${wav.length} bytes)`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, wav);
    console.log(`wrote ${OUT} (${wav.length} bytes, ${TOTAL_S} s, ${RATE} Hz mono 16-bit)`);
  }
}

module.exports = { build, gainAt, RATE, TOTAL_S, TONES, PEAK, OUT };
