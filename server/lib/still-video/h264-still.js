'use strict';

/*
 * A still-picture H.264 encoder: one intra frame, then "nothing changed" frames.
 *
 * WHY OUR OWN. The usual encoders are either GPL (x264, x265) or need a native/WASM toolchain. A
 * still frame needs none of the hard parts of video coding (no motion search, no rate control), so
 * the whole job is: predict each 16x16 block from its neighbours, transform and quantise the rest,
 * and entropy-code it with CAVLC. That is small enough to own, in plain JS, MIT like the rest.
 *
 * WHAT IT EMITS. Constrained Baseline (profile 66, constraint_set0+1): the subset every hardware
 * H.264 decoder implements. Intra 16x16 prediction (V/H/DC) for luma, DC/H/V for chroma, CAVLC, a
 * flat quantiser, deblocking switched off in the slice header (at the low QPs we use, 4x4 block edges
 * are not visible, and a disabled filter cannot be decoded differently by two decoders). The SPS
 * carries BT.709 limited-range colour so every player maps the YUV back to the same RGB.
 *
 * Repeat frames are P slices that skip every macroblock: about a dozen bytes each, no encoding at all.
 * They make a clip last as long as wanted without costing CPU.
 *
 * THE CORRECTNESS CONTRACT. The encoder keeps its own reconstruction using the decoder's exact integer
 * arithmetic (8.5 in the spec), and later blocks predict from that reconstruction, not from the source.
 * So a conforming decoder reproduces `recon` bit for bit; the test suite checks exactly that with
 * ffmpeg. Any drift (a wrong table, scan order or rounding) shows up there as a mismatch, not as a
 * subtle quality loss on someone's TV.
 *
 * CAVLC code tables follow the H.264 spec (Tables 9-5, 9-7, 9-8, 9-9, 9-10). Their packed layout was
 * cross-checked against minih264 by lieff (CC0 1.0, public domain).
 */

// ------------------------------------------------------------------ bit writer

class BitWriter {
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.acc = 0; // pending bits, right-aligned
    this.n = 0;   // number of pending bits (< 8 between calls)
  }

  _grow() {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }

  /** Write the low `bits` bits of `value` (bits <= 32). */
  u(bits, value) {
    if (bits > 24) {
      this.u(bits - 16, Math.floor(value / 65536));
      this.u(16, value & 0xffff);
      return;
    }
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      if (this.pos >= this.buf.length) this._grow();
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }

  ue(value) {
    const x = value + 1;
    const len = 31 - Math.clz32(x); // floor(log2(x))
    if (len) this.u(len, 0);
    this.u(len + 1, x);
  }

  se(value) {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** rbsp_trailing_bits: a stop bit, then zeros to the byte boundary. */
  trailing() {
    this.u(1, 1);
    if (this.n) this.u(8 - this.n, 0);
  }

  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

/** Wrap an RBSP as a NAL unit payload (header byte + emulation prevention). No start code. */
function nal(refIdc, type, rbsp) {
  const out = new Uint8Array(rbsp.length + (rbsp.length >> 1) + 2);
  let o = 0;
  out[o++] = (refIdc << 5) | type;
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros >= 2 && b <= 3) {
      out[o++] = 3;
      zeros = 0;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.slice(0, o);
}

// ------------------------------------------------------------------ CAVLC tables

// coeff_token, indexed by trailingOnes + 4 * (totalCoeff - trailingOnes).
// Each entry packs (code << 4) | (length - 1). Tables for 0<=nC<2, 2<=nC<4, 4<=nC<8, and nC == -1.
const pack = (v, len) => (v << 4) | (len - 1);
const COEFF_TOKEN = [
  [ // 0 <= nC < 2
    pack(1, 1), pack(1, 2), pack(1, 3), pack(3, 5), pack(5, 6), pack(4, 6), pack(5, 7), pack(3, 6),
    pack(7, 8), pack(6, 8), pack(5, 8), pack(4, 7), pack(7, 9), pack(6, 9), pack(5, 9), pack(4, 8),
    pack(7, 10), pack(6, 10), pack(5, 10), pack(4, 9), pack(7, 11), pack(6, 11), pack(5, 11), pack(4, 10),
    pack(15, 13), pack(14, 13), pack(13, 13), pack(4, 11), pack(11, 13), pack(10, 13), pack(9, 13), pack(12, 13),
    pack(8, 13), pack(14, 14), pack(13, 14), pack(12, 14), pack(15, 14), pack(10, 14), pack(9, 14), pack(8, 14),
    pack(11, 14), pack(14, 15), pack(13, 15), pack(12, 15), pack(15, 15), pack(10, 15), pack(9, 15), pack(8, 15),
    pack(11, 15), pack(1, 15), pack(13, 16), pack(12, 16), pack(15, 16), pack(14, 16), pack(9, 16), pack(8, 16),
    pack(11, 16), pack(10, 16), pack(5, 16), 0, pack(7, 16), pack(6, 16), 0, 0, pack(4, 16),
  ],
  [ // 2 <= nC < 4
    pack(3, 2), pack(2, 2), pack(3, 3), pack(5, 4), pack(11, 6), pack(7, 5), pack(9, 6), pack(4, 4),
    pack(7, 6), pack(10, 6), pack(5, 6), pack(6, 5), pack(7, 7), pack(6, 6), pack(5, 7), pack(8, 6),
    pack(7, 8), pack(6, 7), pack(5, 8), pack(4, 6), pack(4, 8), pack(6, 8), pack(5, 9), pack(4, 7),
    pack(7, 9), pack(6, 9), pack(13, 11), pack(4, 9), pack(15, 11), pack(14, 11), pack(9, 11), pack(12, 11),
    pack(11, 11), pack(10, 11), pack(13, 12), pack(8, 11), pack(15, 12), pack(14, 12), pack(9, 12), pack(12, 12),
    pack(11, 12), pack(10, 12), pack(13, 13), pack(12, 13), pack(8, 12), pack(14, 13), pack(9, 13), pack(8, 13),
    pack(15, 13), pack(10, 13), pack(6, 13), pack(1, 13), pack(11, 13), pack(11, 14), pack(10, 14), pack(4, 14),
    pack(7, 13), pack(8, 14), pack(5, 14), 0, pack(9, 14), pack(6, 14), 0, 0, pack(7, 14),
  ],
  [ // 4 <= nC < 8
    pack(15, 4), pack(14, 4), pack(13, 4), pack(12, 4), pack(15, 6), pack(15, 5), pack(14, 5), pack(11, 4),
    pack(11, 6), pack(12, 5), pack(11, 5), pack(10, 4), pack(8, 6), pack(10, 5), pack(9, 5), pack(9, 4),
    pack(15, 7), pack(8, 5), pack(13, 6), pack(8, 4), pack(11, 7), pack(14, 6), pack(9, 6), pack(13, 5),
    pack(9, 7), pack(10, 6), pack(13, 7), pack(12, 6), pack(8, 7), pack(14, 7), pack(10, 7), pack(12, 7),
    pack(15, 8), pack(14, 8), pack(13, 8), pack(12, 8), pack(11, 8), pack(10, 8), pack(9, 8), pack(8, 8),
    pack(15, 9), pack(14, 9), pack(13, 9), pack(12, 9), pack(11, 9), pack(10, 9), pack(9, 9), pack(10, 10),
    pack(8, 9), pack(7, 9), pack(11, 10), pack(6, 10), pack(13, 10), pack(12, 10), pack(7, 10), pack(2, 10),
    pack(9, 10), pack(8, 10), pack(3, 10), 0, pack(5, 10), pack(4, 10), 0, 0, pack(1, 10),
  ],
  null, // nC >= 8: a 6-bit fixed-length code, computed below
  // Zero entries are unreachable (trailingOnes > totalCoeff). Note pack(0, 7): a real 7-bit
  // all-zero code (TotalCoeff 4, TrailingOnes 3), not a placeholder.
  [ // nC == -1 (chroma DC, 4:2:0)
    pack(1, 2), pack(1, 1), pack(1, 3), pack(5, 6), pack(7, 6), pack(6, 6), pack(2, 7), pack(0, 7), pack(4, 6),
    pack(3, 7), pack(2, 8), 0, pack(3, 6), pack(3, 8), 0, 0, pack(2, 6),
  ],
];

// total_zeros for 4x4 blocks, by totalCoeff 1..15, indexed by total_zeros. [code, length] pairs.
const TOTAL_ZEROS = [
  null,
  [[1, 1], [3, 3], [2, 3], [3, 4], [2, 4], [3, 5], [2, 5], [3, 6], [2, 6], [3, 7], [2, 7], [3, 8], [2, 8], [3, 9], [2, 9], [1, 9]],
  [[7, 3], [6, 3], [5, 3], [4, 3], [3, 3], [5, 4], [4, 4], [3, 4], [2, 4], [3, 5], [2, 5], [3, 6], [2, 6], [1, 6], [0, 6]],
  [[5, 4], [7, 3], [6, 3], [5, 3], [4, 4], [3, 4], [4, 3], [3, 3], [2, 4], [3, 5], [2, 5], [1, 6], [1, 5], [0, 6]],
  [[3, 5], [7, 3], [5, 4], [4, 4], [6, 3], [5, 3], [4, 3], [3, 4], [3, 3], [2, 4], [2, 5], [1, 5], [0, 5]],
  [[5, 4], [4, 4], [3, 4], [7, 3], [6, 3], [5, 3], [4, 3], [3, 3], [2, 4], [1, 5], [1, 4], [0, 5]],
  [[1, 6], [1, 5], [7, 3], [6, 3], [5, 3], [4, 3], [3, 3], [2, 3], [1, 4], [1, 3], [0, 6]],
  [[1, 6], [1, 5], [5, 3], [4, 3], [3, 3], [3, 2], [2, 3], [1, 4], [1, 3], [0, 6]],
  [[1, 6], [1, 4], [1, 5], [3, 3], [3, 2], [2, 2], [2, 3], [1, 3], [0, 6]],
  [[1, 6], [0, 6], [1, 4], [3, 2], [2, 2], [1, 3], [1, 2], [1, 5]],
  [[1, 5], [0, 5], [1, 3], [3, 2], [2, 2], [1, 2], [1, 4]],
  [[0, 4], [1, 4], [1, 3], [2, 3], [1, 1], [3, 3]],
  [[0, 4], [1, 4], [1, 2], [1, 1], [1, 3]],
  [[0, 3], [1, 3], [1, 1], [1, 2]],
  [[0, 2], [1, 2], [1, 1]],
  [[0, 1], [1, 1]],
];

// total_zeros for 4:2:0 chroma DC (maxNumCoeff 4), by totalCoeff 1..3.
const TOTAL_ZEROS_CHROMA_DC = [
  null,
  [[1, 1], [1, 2], [1, 3], [0, 3]],
  [[1, 1], [1, 2], [0, 2]],
  [[1, 1], [0, 1]],
];

// run_before, by min(zerosLeft, 7) 1..7, indexed by run_before.
const RUN_BEFORE = [
  null,
  [[1, 1], [0, 1]],
  [[1, 1], [1, 2], [0, 2]],
  [[3, 2], [2, 2], [1, 2], [0, 2]],
  [[3, 2], [2, 2], [1, 2], [1, 3], [0, 3]],
  [[3, 2], [2, 2], [3, 3], [2, 3], [1, 3], [0, 3]],
  [[3, 2], [0, 3], [1, 3], [3, 3], [2, 3], [5, 3], [4, 3]],
  [[7, 3], [6, 3], [5, 3], [4, 3], [3, 3], [2, 3], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8], [1, 9], [1, 10], [1, 11]],
];

// Frame zig-zag scan of a 4x4 block, as raster positions (row * 4 + col).
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
// Luma 4x4 block coding order inside a macroblock, as [x, y] in 4x4-block units.
const BLOCK_ORDER = [
  [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [3, 0], [2, 1], [3, 1],
  [0, 2], [1, 2], [0, 3], [1, 3], [2, 2], [3, 2], [2, 3], [3, 3],
];

// Quantisation multipliers (forward) and dequantisation scales (inverse), by qp % 6, for the three
// position classes: both indices even, both odd, mixed.
const MF = [[13107, 5243, 8066], [11916, 4660, 7490], [10082, 4194, 6554], [9362, 3647, 5825], [8192, 3355, 5243], [7282, 2893, 4559]];
const V = [[10, 16, 13], [11, 18, 14], [13, 20, 16], [14, 23, 18], [16, 25, 20], [18, 29, 23]];
const POS_CLASS = new Uint8Array(16);
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) POS_CLASS[i * 4 + j] = (i % 2 === 0 && j % 2 === 0) ? 0 : (i % 2 === 1 && j % 2 === 1) ? 1 : 2;

// Chroma QP from luma QP (chroma_qp_index_offset 0), Table 8-15.
const QPC = (() => {
  const t = [];
  const hi = [29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39];
  for (let q = 0; q < 52; q++) t.push(q < 30 ? q : hi[q - 30]);
  return t;
})();

// A level must fit CAVLC's 12-bit escape in Baseline (no level_prefix > 15). Clamping happens before
// reconstruction, so the encoder and the decoder still agree exactly.
const MAX_LEVEL = 2047;

// ------------------------------------------------------------------ CAVLC residual block

const scratchLevels = new Int32Array(16);
const scratchPos = new Int32Array(16);

/** Write one residual block with CAVLC. Returns TotalCoeff (stored for later nC predictions). */
function writeResidualBlock(bw, coeffs, maxNum, nC) {
  let total = 0;
  for (let i = maxNum - 1; i >= 0; i--) {
    if (coeffs[i]) {
      scratchLevels[total] = coeffs[i];
      scratchPos[total] = i;
      total++;
    }
  }
  // scratch arrays are in reverse scan order (highest frequency first)
  let t1 = 0;
  while (t1 < total && t1 < 3 && (scratchLevels[t1] === 1 || scratchLevels[t1] === -1)) t1++;

  const idx = t1 + 4 * (total - t1);
  if (nC === -1) {
    const e = COEFF_TOKEN[4][idx];
    bw.u((e & 15) + 1, e >> 4);
  } else if (nC >= 8) {
    bw.u(6, total === 0 ? 3 : (((total - 1) << 2) | t1));
  } else {
    const e = COEFF_TOKEN[nC < 2 ? 0 : nC < 4 ? 1 : 2][idx];
    bw.u((e & 15) + 1, e >> 4);
  }
  if (!total) return 0;

  for (let i = 0; i < t1; i++) bw.u(1, scratchLevels[i] < 0 ? 1 : 0);

  let suffixLength = total > 10 && t1 < 3 ? 1 : 0;
  for (let i = t1; i < total; i++) {
    const level = scratchLevels[i];
    let levelCode = level > 0 ? 2 * level - 2 : -2 * level - 1;
    if (i === t1 && t1 < 3) levelCode -= 2;
    let prefix;
    let suffix = 0;
    let suffixSize = 0;
    if (suffixLength === 0) {
      if (levelCode < 14) {
        prefix = levelCode;
      } else if (levelCode < 30) {
        prefix = 14; suffix = levelCode - 14; suffixSize = 4;
      } else {
        prefix = 15; suffix = levelCode - 30; suffixSize = 12;
      }
    } else if ((levelCode >> suffixLength) < 15) {
      prefix = levelCode >> suffixLength;
      suffix = levelCode & ((1 << suffixLength) - 1);
      suffixSize = suffixLength;
    } else {
      prefix = 15; suffix = levelCode - (15 << suffixLength); suffixSize = 12;
    }
    if (suffix >= 4096) throw new Error('level out of range for Baseline CAVLC');
    if (prefix) bw.u(prefix, 0);
    bw.u(1, 1);
    if (suffixSize) bw.u(suffixSize, suffix);
    if (suffixLength === 0) suffixLength = 1;
    const abs = level < 0 ? -level : level;
    if (abs > (3 << (suffixLength - 1)) && suffixLength < 6) suffixLength++;
  }

  if (total < maxNum) {
    // zeros below the highest-frequency coefficient
    const totalZeros = scratchPos[0] + 1 - total;
    const table = maxNum === 4 ? TOTAL_ZEROS_CHROMA_DC[total] : TOTAL_ZEROS[total];
    const [code, len] = table[totalZeros];
    bw.u(len, code);
    let zerosLeft = totalZeros;
    for (let i = 0; i < total - 1 && zerosLeft > 0; i++) {
      const run = scratchPos[i] - scratchPos[i + 1] - 1;
      const [c, l] = RUN_BEFORE[zerosLeft > 6 ? 7 : zerosLeft][run];
      bw.u(l, c);
      zerosLeft -= run;
    }
  }
  return total;
}

// ------------------------------------------------------------------ transforms

/** Forward 4x4 integer core transform, in place on a raster block. */
function forward4x4(b) {
  for (let r = 0; r < 16; r += 4) {
    const a = b[r] + b[r + 3], d = b[r] - b[r + 3], c1 = b[r + 1] + b[r + 2], c2 = b[r + 1] - b[r + 2];
    b[r] = a + c1; b[r + 1] = 2 * d + c2; b[r + 2] = a - c1; b[r + 3] = d - 2 * c2;
  }
  for (let c = 0; c < 4; c++) {
    const x0 = b[c], x1 = b[c + 4], x2 = b[c + 8], x3 = b[c + 12];
    const a = x0 + x3, d = x0 - x3, c1 = x1 + x2, c2 = x1 - x2;
    b[c] = a + c1; b[c + 4] = 2 * d + c2; b[c + 8] = a - c1; b[c + 12] = d - 2 * c2;
  }
}

/** Inverse 4x4 transform (8.5.12.2), in place: scaled coefficients in, residual out. */
function inverse4x4(d) {
  for (let r = 0; r < 16; r += 4) {
    const e0 = d[r] + d[r + 2], e1 = d[r] - d[r + 2];
    const e2 = (d[r + 1] >> 1) - d[r + 3], e3 = d[r + 1] + (d[r + 3] >> 1);
    d[r] = e0 + e3; d[r + 1] = e1 + e2; d[r + 2] = e1 - e2; d[r + 3] = e0 - e3;
  }
  for (let c = 0; c < 4; c++) {
    const f0 = d[c], f1 = d[c + 4], f2 = d[c + 8], f3 = d[c + 12];
    const g0 = f0 + f2, g1 = f0 - f2, g2 = (f1 >> 1) - f3, g3 = f1 + (f3 >> 1);
    d[c] = (g0 + g3 + 32) >> 6; d[c + 4] = (g1 + g2 + 32) >> 6;
    d[c + 8] = (g1 - g2 + 32) >> 6; d[c + 12] = (g0 - g3 + 32) >> 6;
  }
}

function quant(w, mf, qbits, f) {
  const a = w < 0 ? -w : w;
  let z = Math.floor((a * mf + f) / (2 ** qbits));
  if (z > MAX_LEVEL) z = MAX_LEVEL;
  return w < 0 ? -z : z;
}

// ------------------------------------------------------------------ the encoder

/**
 * Encode one picture. `y`, `u`, `v` are 8-bit planes (4:2:0, limited range) of `width` x `height`
 * (both even). Returns { sps, pps, idr, skip(frameNum), recon } where the NAL payloads carry no start
 * codes. `qp` is 10..40.
 */
function encodeStill({ width, height, y, u, v, qp = 14 }) {
  if (!(width > 0 && height > 0) || width % 2 || height % 2) throw new Error('width and height must be even and positive');
  if (!(qp >= 10 && qp <= 40)) throw new Error('qp must be within 10..40');
  const mbW = Math.ceil(width / 16), mbH = Math.ceil(height / 16);
  const W = mbW * 16, H = mbH * 16, CW = W >> 1, CH = H >> 1;

  // Source planes padded to whole macroblocks by repeating the edge.
  const pad = (src, sw, sh, dw, dh) => {
    const out = new Uint8Array(dw * dh);
    for (let r = 0; r < dh; r++) {
      const sr = Math.min(r, sh - 1) * sw;
      const or = r * dw;
      out.set(src.subarray(sr, sr + sw), or);
      if (dw > sw) out.fill(src[sr + sw - 1], or + sw, or + dw);
    }
    return out;
  };
  const sy = pad(y, width, height, W, H);
  const su = pad(u, width >> 1, height >> 1, CW, CH);
  const sv = pad(v, width >> 1, height >> 1, CW, CH);
  const ry = new Uint8Array(W * H), ru = new Uint8Array(CW * CH), rv = new Uint8Array(CW * CH);

  // TotalCoeff per 4x4 block, for nC prediction (luma 4x4 grid; chroma 2x2 per MB per plane).
  const nzY = new Uint8Array(mbW * 4 * mbH * 4);
  const nzU = new Uint8Array(mbW * 2 * mbH * 2), nzV = new Uint8Array(mbW * 2 * mbH * 2);

  const qpc = QPC[qp];
  const qbits = 15 + Math.floor(qp / 6), fIntra = Math.floor((1 << qbits) / 3);
  const qbitsC = 15 + Math.floor(qpc / 6), fIntraC = Math.floor((1 << qbitsC) / 3);
  const mfY = MF[qp % 6], vY = V[qp % 6], shY = Math.floor(qp / 6);
  const mfC = MF[qpc % 6], vC = V[qpc % 6], shC = Math.floor(qpc / 6);

  const bw = new BitWriter(1 << 20);

  // ---- slice header (IDR, I slice)
  bw.ue(0);        // first_mb_in_slice
  bw.ue(7);        // slice_type: I (all slices)
  bw.ue(0);        // pic_parameter_set_id
  bw.u(4, 0);      // frame_num (log2_max_frame_num = 4)
  bw.ue(0);        // idr_pic_id
  bw.u(1, 0);      // no_output_of_prior_pics_flag
  bw.u(1, 0);      // long_term_reference_flag
  bw.se(0);        // slice_qp_delta (pic_init_qp carries qp)
  bw.ue(1);        // disable_deblocking_filter_idc: off

  const pred = new Int32Array(256);
  const predCb = new Int32Array(64), predCr = new Int32Array(64);
  const blk = new Int32Array(16);
  const dcW = new Int32Array(16), dcLevels = new Int32Array(16), dcRecon = new Int32Array(16);
  const acLevels = new Int32Array(16 * 16); // [blockRaster][rasterPos]
  const coeffs = new Int32Array(16);
  const cAc = [new Int32Array(64), new Int32Array(64)]; // chroma AC levels [plane][blk*16+pos]
  const cDc = [new Int32Array(4), new Int32Array(4)];
  const cDcW = new Int32Array(4);

  const lumaW4 = mbW * 4, chromaW4 = mbW * 2;
  const nCof = (nz, w4, bx, by) => {
    const hasA = bx > 0, hasB = by > 0;
    const a = hasA ? nz[by * w4 + bx - 1] : 0, b = hasB ? nz[(by - 1) * w4 + bx] : 0;
    if (hasA && hasB) return (a + b + 1) >> 1;
    if (hasA) return a;
    if (hasB) return b;
    return 0;
  };

  for (let mby = 0; mby < mbH; mby++) {
    for (let mbx = 0; mbx < mbW; mbx++) {
      const hasTop = mby > 0, hasLeft = mbx > 0;
      const x0 = mbx * 16, y0 = mby * 16;

      // ---- luma prediction mode: 0 vertical, 1 horizontal, 2 DC (by SAD)
      let bestMode = 2, bestSad = Infinity;
      let dcVal = 128;
      {
        let sT = 0, sL = 0;
        if (hasTop) for (let i = 0; i < 16; i++) sT += ry[(y0 - 1) * W + x0 + i];
        if (hasLeft) for (let i = 0; i < 16; i++) sL += ry[(y0 + i) * W + x0 - 1];
        if (hasTop && hasLeft) dcVal = (sT + sL + 16) >> 5;
        else if (hasLeft) dcVal = (sL + 8) >> 4;
        else if (hasTop) dcVal = (sT + 8) >> 4;
      }
      for (let mode = 0; mode < 3; mode++) {
        if (mode === 0 && !hasTop) continue;
        if (mode === 1 && !hasLeft) continue;
        let sad = 0;
        for (let r = 0; r < 16 && sad < bestSad; r++) {
          const row = (y0 + r) * W + x0;
          for (let c = 0; c < 16; c++) {
            const p = mode === 0 ? ry[(y0 - 1) * W + x0 + c] : mode === 1 ? ry[row - 1] : dcVal;
            const dlt = sy[row + c] - p;
            sad += dlt < 0 ? -dlt : dlt;
          }
        }
        if (sad < bestSad) { bestSad = sad; bestMode = mode; }
      }
      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 16; c++) {
          pred[r * 16 + c] = bestMode === 0 ? ry[(y0 - 1) * W + x0 + c] : bestMode === 1 ? ry[(y0 + r) * W + x0 - 1] : dcVal;
        }
      }

      // ---- luma residual: transform each 4x4, gather DCs (raster by block row/col)
      let lumaAcNonZero = false;
      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 4; bx++) {
          for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
              const py = by * 4 + r, px = bx * 4 + c;
              blk[r * 4 + c] = sy[(y0 + py) * W + x0 + px] - pred[py * 16 + px];
            }
          }
          forward4x4(blk);
          const bi = by * 4 + bx;
          dcW[bi] = blk[0];
          const base = bi * 16;
          acLevels[base] = 0;
          for (let k = 1; k < 16; k++) {
            const z = quant(blk[k], mfY[POS_CLASS[k]], qbits, fIntra);
            acLevels[base + k] = z;
            if (z) lumaAcNonZero = true;
          }
        }
      }
      // DC: Hadamard, halve, quantise
      {
        const t = dcW;
        for (let r = 0; r < 16; r += 4) {
          const a = t[r] + t[r + 1], b = t[r + 2] + t[r + 3], c1 = t[r] - t[r + 1], d = t[r + 2] - t[r + 3];
          t[r] = a + b; t[r + 1] = a - b; t[r + 2] = c1 - d; t[r + 3] = c1 + d;
        }
        for (let c = 0; c < 4; c++) {
          const a = t[c] + t[c + 4], b = t[c + 8] + t[c + 12], c1 = t[c] - t[c + 4], d = t[c + 8] - t[c + 12];
          t[c] = (a + b) >> 1; t[c + 4] = (a - b) >> 1; t[c + 8] = (c1 - d) >> 1; t[c + 12] = (c1 + d) >> 1;
        }
        for (let k = 0; k < 16; k++) dcLevels[k] = quant(t[k], mfY[0], qbits + 1, 2 * fIntra);
      }
      const lumaCbp = lumaAcNonZero ? 15 : 0;

      // ---- luma reconstruction, exactly as a decoder does it (8.5.10, 8.5.12)
      {
        const f = dcRecon;
        for (let k = 0; k < 16; k++) f[k] = dcLevels[k];
        for (let r = 0; r < 16; r += 4) {
          const a = f[r] + f[r + 1], b = f[r + 2] + f[r + 3], c1 = f[r] - f[r + 1], d = f[r + 2] - f[r + 3];
          f[r] = a + b; f[r + 1] = a - b; f[r + 2] = c1 - d; f[r + 3] = c1 + d;
        }
        for (let c = 0; c < 4; c++) {
          const a = f[c] + f[c + 4], b = f[c + 8] + f[c + 12], c1 = f[c] - f[c + 4], d = f[c + 8] - f[c + 12];
          f[c] = a + b; f[c + 4] = a - b; f[c + 8] = c1 - d; f[c + 12] = c1 + d;
        }
        const ls = 16 * vY[0];
        for (let k = 0; k < 16; k++) {
          f[k] = qp >= 36 ? (f[k] * ls) << (shY - 6) : (f[k] * ls + (1 << (5 - shY))) >> (6 - shY);
        }
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const bi = by * 4 + bx, base = bi * 16;
            blk[0] = f[bi];
            for (let k = 1; k < 16; k++) blk[k] = lumaCbp ? (acLevels[base + k] * vY[POS_CLASS[k]]) << shY : 0;
            inverse4x4(blk);
            for (let r = 0; r < 4; r++) {
              for (let c = 0; c < 4; c++) {
                const py = by * 4 + r, px = bx * 4 + c;
                const s = pred[py * 16 + px] + blk[r * 4 + c];
                ry[(y0 + py) * W + x0 + px] = s < 0 ? 0 : s > 255 ? 255 : s;
              }
            }
          }
        }
      }

      // ---- chroma: mode 0 DC, 1 horizontal, 2 vertical (chosen by SAD over both planes)
      const cx0 = mbx * 8, cy0 = mby * 8;
      const chromaDcPred = (rec, out) => {
        for (let b = 0; b < 4; b++) {
          const xO = (b & 1) * 4, yO = (b >> 1) * 4;
          let sT = 0, sL = 0;
          if (hasTop) for (let i = 0; i < 4; i++) sT += rec[(cy0 - 1) * CW + cx0 + xO + i];
          if (hasLeft) for (let i = 0; i < 4; i++) sL += rec[(cy0 + yO + i) * CW + cx0 - 1];
          let p = 128;
          if ((xO === 0 && yO === 0) || (xO > 0 && yO > 0)) {
            if (hasTop && hasLeft) p = (sT + sL + 4) >> 3;
            else if (hasLeft) p = (sL + 2) >> 2;
            else if (hasTop) p = (sT + 2) >> 2;
          } else if (xO > 0 && yO === 0) {
            if (hasTop) p = (sT + 2) >> 2;
            else if (hasLeft) p = (sL + 2) >> 2;
          } else {
            if (hasLeft) p = (sL + 2) >> 2;
            else if (hasTop) p = (sT + 2) >> 2;
          }
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[(yO + r) * 8 + xO + c] = p;
        }
      };
      const chromaPred = (mode, rec, out) => {
        if (mode === 0) return chromaDcPred(rec, out);
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            out[r * 8 + c] = mode === 1 ? rec[(cy0 + r) * CW + cx0 - 1] : rec[(cy0 - 1) * CW + cx0 + c];
          }
        }
      };
      let chromaMode = 0;
      {
        let best = Infinity;
        for (let mode = 0; mode < 3; mode++) {
          if (mode === 1 && !hasLeft) continue;
          if (mode === 2 && !hasTop) continue;
          chromaPred(mode, ru, predCb);
          chromaPred(mode, rv, predCr);
          let sad = 0;
          for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
              const i = (cy0 + r) * CW + cx0 + c;
              const a = su[i] - predCb[r * 8 + c], b = sv[i] - predCr[r * 8 + c];
              sad += (a < 0 ? -a : a) + (b < 0 ? -b : b);
            }
          }
          if (sad < best) { best = sad; chromaMode = mode; }
        }
        chromaPred(chromaMode, ru, predCb);
        chromaPred(chromaMode, rv, predCr);
      }
      let chromaDcNonZero = false, chromaAcNonZero = false;
      const planes = [[su, predCb], [sv, predCr]];
      for (let p = 0; p < 2; p++) {
        const [src, pr] = planes[p];
        for (let b = 0; b < 4; b++) {
          const xO = (b & 1) * 4, yO = (b >> 1) * 4;
          for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
              blk[r * 4 + c] = src[(cy0 + yO + r) * CW + cx0 + xO + c] - pr[(yO + r) * 8 + xO + c];
            }
          }
          forward4x4(blk);
          cDcW[b] = blk[0];
          const base = b * 16;
          cAc[p][base] = 0;
          for (let k = 1; k < 16; k++) {
            const z = quant(blk[k], mfC[POS_CLASS[k]], qbitsC, fIntraC);
            cAc[p][base + k] = z;
            if (z) chromaAcNonZero = true;
          }
        }
        // 2x2 DC transform and quantisation
        const a = cDcW[0] + cDcW[1], b2 = cDcW[2] + cDcW[3], c1 = cDcW[0] - cDcW[1], d = cDcW[2] - cDcW[3];
        const t = [a + b2, c1 + d, a - b2, c1 - d];
        for (let k = 0; k < 4; k++) {
          cDc[p][k] = quant(t[k], mfC[0], qbitsC + 1, 2 * fIntraC);
          if (cDc[p][k]) chromaDcNonZero = true;
        }
      }
      const chromaCbp = chromaAcNonZero ? 2 : chromaDcNonZero ? 1 : 0;

      // chroma reconstruction
      for (let p = 0; p < 2; p++) {
        const [, pr] = planes[p];
        const rec = p ? rv : ru;
        const c = cDc[p];
        const a = c[0] + c[1], b2 = c[2] + c[3], c1 = c[0] - c[1], d = c[2] - c[3];
        const f = [a + b2, c1 + d, a - b2, c1 - d];
        const ls = 16 * vC[0];
        for (let b = 0; b < 4; b++) {
          const xO = (b & 1) * 4, yO = (b >> 1) * 4, base = b * 16;
          blk[0] = chromaCbp ? ((f[b] * ls) << shC) >> 5 : 0;
          for (let k = 1; k < 16; k++) blk[k] = chromaCbp === 2 ? (cAc[p][base + k] * vC[POS_CLASS[k]]) << shC : 0;
          inverse4x4(blk);
          for (let r = 0; r < 4; r++) {
            for (let cc = 0; cc < 4; cc++) {
              const s = pr[(yO + r) * 8 + xO + cc] + blk[r * 4 + cc];
              rec[(cy0 + yO + r) * CW + cx0 + xO + cc] = s < 0 ? 0 : s > 255 ? 255 : s;
            }
          }
        }
      }

      // ---- macroblock syntax
      bw.ue(1 + bestMode + 4 * chromaCbp + (lumaCbp ? 12 : 0)); // mb_type: I_16x16_<mode>_<cbpC>_<cbpL>
      bw.ue(chromaMode);   // intra_chroma_pred_mode
      bw.se(0);            // mb_qp_delta

      const lbx = mbx * 4, lby = mby * 4;
      // Intra16x16DCLevel: nC from the neighbours of block 0
      for (let k = 0; k < 16; k++) coeffs[k] = dcLevels[ZIGZAG[k]];
      writeResidualBlock(bw, coeffs, 16, nCof(nzY, lumaW4, lbx, lby));
      for (let i = 0; i < 16; i++) {
        const [bx, by] = BLOCK_ORDER[i];
        const gx = lbx + bx, gy = lby + by;
        if (!lumaCbp) { nzY[gy * lumaW4 + gx] = 0; continue; }
        const base = (by * 4 + bx) * 16;
        for (let k = 1; k < 16; k++) coeffs[k - 1] = acLevels[base + ZIGZAG[k]];
        nzY[gy * lumaW4 + gx] = writeResidualBlock(bw, coeffs, 15, nCof(nzY, lumaW4, gx, gy));
      }
      if (chromaCbp) {
        for (let p = 0; p < 2; p++) {
          for (let k = 0; k < 4; k++) coeffs[k] = cDc[p][k];
          writeResidualBlock(bw, coeffs, 4, -1);
        }
      }
      const cbx = mbx * 2, cby = mby * 2;
      for (let p = 0; p < 2; p++) {
        const nz = p ? nzV : nzU;
        for (let b = 0; b < 4; b++) {
          const gx = cbx + (b & 1), gy = cby + (b >> 1);
          if (chromaCbp !== 2) { nz[gy * chromaW4 + gx] = 0; continue; }
          const base = b * 16;
          for (let k = 1; k < 16; k++) coeffs[k - 1] = cAc[p][base + ZIGZAG[k]];
          nz[gy * chromaW4 + gx] = writeResidualBlock(bw, coeffs, 15, nCof(nz, chromaW4, gx, gy));
        }
      }
    }
  }
  bw.trailing();
  const idr = nal(3, 5, bw.bytes());

  // ---- parameter sets
  const mbs = mbW * mbH;
  const level = mbs <= 8192 ? 40 : mbs <= 22080 ? 50 : 51;
  const s = new BitWriter(64);
  s.u(8, 66);              // profile_idc: Baseline
  s.u(8, 0xc0);            // constraint_set0 + constraint_set1: Constrained Baseline
  s.u(8, level);
  s.ue(0);                 // seq_parameter_set_id
  s.ue(0);                 // log2_max_frame_num_minus4
  s.ue(2);                 // pic_order_cnt_type 2: output order = decode order
  s.ue(1);                 // max_num_ref_frames
  s.u(1, 0);               // gaps_in_frame_num_value_allowed_flag
  s.ue(mbW - 1);
  s.ue(mbH - 1);
  s.u(1, 1);               // frame_mbs_only_flag
  s.u(1, 1);               // direct_8x8_inference_flag
  const cropR = (W - width) >> 1, cropB = (H - height) >> 1;
  if (cropR || cropB) {
    s.u(1, 1);
    s.ue(0); s.ue(cropR); s.ue(0); s.ue(cropB);
  } else {
    s.u(1, 0);
  }
  s.u(1, 1);               // vui_parameters_present_flag
  s.u(1, 0);               // aspect_ratio_info_present_flag
  s.u(1, 0);               // overscan_info_present_flag
  s.u(1, 1);               // video_signal_type_present_flag
  s.u(3, 5);               // video_format: unspecified
  s.u(1, 0);               // video_full_range_flag: limited
  s.u(1, 1);               // colour_description_present_flag
  s.u(8, 1); s.u(8, 1); s.u(8, 1); // BT.709 primaries, transfer, matrix
  s.u(1, 0);               // chroma_loc_info_present_flag
  s.u(1, 0);               // timing_info_present_flag
  s.u(1, 0);               // nal_hrd_parameters_present_flag
  s.u(1, 0);               // vcl_hrd_parameters_present_flag
  s.u(1, 0);               // pic_struct_present_flag
  s.u(1, 0);               // bitstream_restriction_flag
  s.trailing();
  const sps = nal(3, 7, s.bytes());

  const p = new BitWriter(16);
  p.ue(0); p.ue(0);        // pps id, sps id
  p.u(1, 0);               // entropy_coding_mode_flag: CAVLC
  p.u(1, 0);               // bottom_field_pic_order_in_frame_present_flag
  p.ue(0);                 // num_slice_groups_minus1
  p.ue(0); p.ue(0);        // num_ref_idx_l0/l1_default_active_minus1
  p.u(1, 0); p.u(2, 0);    // weighted_pred_flag, weighted_bipred_idc
  p.se(qp - 26);           // pic_init_qp_minus26
  p.se(0);                 // pic_init_qs_minus26
  p.se(0);                 // chroma_qp_index_offset
  p.u(1, 1);               // deblocking_filter_control_present_flag
  p.u(1, 0);               // constrained_intra_pred_flag
  p.u(1, 0);               // redundant_pic_cnt_present_flag
  p.trailing();
  const pps = nal(3, 8, p.bytes());

  /** A P frame that skips every macroblock: the decoder repeats the previous picture. */
  const skip = (frameNum) => {
    const k = new BitWriter(16);
    k.ue(0);               // first_mb_in_slice
    k.ue(5);               // slice_type: P (all slices)
    k.ue(0);               // pic_parameter_set_id
    k.u(4, frameNum & 15); // frame_num
    k.u(1, 0);             // num_ref_idx_active_override_flag
    k.u(1, 0);             // ref_pic_list_modification_flag_l0
    k.u(1, 0);             // adaptive_ref_pic_marking_mode_flag (sliding window)
    k.se(0);               // slice_qp_delta
    k.ue(1);               // disable_deblocking_filter_idc
    k.ue(mbs);             // mb_skip_run: every macroblock
    k.trailing();
    return nal(2, 1, k.bytes());
  };

  return { width, height, codedWidth: W, codedHeight: H, level, qp, sps, pps, idr, skip, recon: { y: ry, u: ru, v: rv, stride: W, chromaStride: CW } };
}

module.exports = { encodeStill, BitWriter, nal, writeResidualBlock, ZIGZAG };
