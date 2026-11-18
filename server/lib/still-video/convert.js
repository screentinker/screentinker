'use strict';

/*
 * Turn a decoded RGBA bitmap into a short H.264 MP4 that shows it as a still.
 *
 * Pure function of its inputs (no I/O), so it is testable without spawning anything. The worker
 * process (worker.js) does the file reading and writing around it.
 */

const { encodeStill } = require('./h264-still');
const { writeMp4 } = require('./mp4');

/** Largest size that fits in maxW x maxH keeping the aspect ratio, never upscaled, both even. */
function fitSize(width, height, maxW, maxH) {
  const scale = Math.min(1, maxW / width, maxH / height);
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(Math.round(width * scale)), height: even(Math.round(height * scale)) };
}

/**
 * Area-average resample of RGBA to RGB at (tw, th). Alpha is composited over black, which is what
 * the player draws behind an image. Downscaling averages every source pixel a target pixel covers,
 * so fine detail does not alias; an exact 1:1 size is a straight copy.
 */
function resampleRgb(src, sw, sh, tw, th) {
  const out = new Uint8Array(tw * th * 3);
  const xs = new Int32Array(tw + 1), ys = new Int32Array(th + 1);
  for (let x = 0; x <= tw; x++) xs[x] = Math.min(sw, Math.floor((x * sw) / tw));
  for (let y = 0; y <= th; y++) ys[y] = Math.min(sh, Math.floor((y * sh) / th));
  for (let ty = 0; ty < th; ty++) {
    const y0 = ys[ty], y1 = Math.max(ys[ty + 1], y0 + 1);
    for (let tx = 0; tx < tw; tx++) {
      const x0 = xs[tx], x1 = Math.max(xs[tx + 1], x0 + 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const a = src[i + 3];
          r += src[i] * a; g += src[i + 1] * a; b += src[i + 2] * a;
          n++;
        }
      }
      const o = (ty * tw + tx) * 3, d = n * 255;
      out[o] = Math.round(r / d); out[o + 1] = Math.round(g / d); out[o + 2] = Math.round(b / d);
    }
  }
  return out;
}

const clip = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** RGB (sRGB) to BT.709 limited-range 4:2:0; chroma from the 2x2 average. */
function rgbToYuv420(rgb, w, h) {
  const y = new Uint8Array(w * h), u = new Uint8Array((w >> 1) * (h >> 1)), v = new Uint8Array((w >> 1) * (h >> 1));
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    y[i] = clip(Math.round(16 + 0.1826 * rgb[p] + 0.6142 * rgb[p + 1] + 0.0620 * rgb[p + 2]));
  }
  const cw = w >> 1;
  for (let cy = 0; cy < h >> 1; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((cy * 2 + dy) * w + cx * 2 + dx) * 3;
          r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2];
        }
      }
      r /= 4; g /= 4; b /= 4;
      u[cy * cw + cx] = clip(Math.round(128 - 0.1006 * r - 0.3386 * g + 0.4392 * b));
      v[cy * cw + cx] = clip(Math.round(128 + 0.4392 * r - 0.3989 * g - 0.0403 * b));
    }
  }
  return { y, u, v };
}

/**
 * RGBA bitmap -> MP4 bytes. `seconds` 1-fps frames: one intra frame, the rest "unchanged" frames.
 * QP rises in steps if the intra frame would break the level's minimum compression ratio (only
 * pathological noise gets near it at the default QP).
 */
function stillToMp4({ data, width, height }, { maxWidth = 3840, maxHeight = 2160, qp = 14, seconds = 60 } = {}) {
  const size = fitSize(width, height, maxWidth, maxHeight);
  const rgb = resampleRgb(data, width, height, size.width, size.height);
  const yuv = rgbToYuv420(rgb, size.width, size.height);
  const rawBytes = size.width * size.height * 1.5;
  let enc;
  for (let q = qp; ; q += 4) {
    enc = encodeStill({ width: size.width, height: size.height, ...yuv, qp: Math.min(q, 40) });
    if (enc.idr.length <= rawBytes / 2 || q >= 40) break;
  }
  const frames = Math.max(1, Math.floor(seconds));
  const samples = [[enc.idr]];
  for (let i = 1; i < frames; i++) samples.push([enc.skip(i)]);
  const mp4 = writeMp4({ width: size.width, height: size.height, sps: enc.sps, pps: enc.pps, samples });
  return { mp4, width: size.width, height: size.height, qp: enc.qp, frames };
}

module.exports = { stillToMp4, fitSize, resampleRgb, rgbToYuv420 };
