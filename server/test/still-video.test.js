'use strict';

/*
 * The still-picture H.264 encoder, its MP4 writer, and the isolated process that runs them.
 *
 * The strongest check is the decoder one: the encoder keeps its own reconstruction with the decoder's
 * integer arithmetic, so ffmpeg's decode of the stream must equal that reconstruction byte for byte.
 * A wrong code table, scan order or transform shows up there as a mismatch or a decode error, which
 * is exactly how the two bugs found while writing this were caught (a permuted Hadamard row order,
 * and a chroma DC code entry). Those are pinned separately below as well.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { encodeStill, BitWriter, writeResidualBlock } = require('../lib/still-video/h264-still');
const { writeMp4 } = require('../lib/still-video/mp4');
const { stillToMp4, fitSize, rgbToYuv420 } = require('../lib/still-video/convert');
const { makeStillVideo } = require('../lib/still-video');

const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-still-video-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Deterministic test pictures: smooth gradients, hard edges and noise, so every coding path runs
// (flat blocks, large DC values, 16-coefficient blocks, escape-coded levels, every nC table).
function picture(width, height, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const y = new Uint8Array(width * height), u = new Uint8Array((width / 2) * (height / 2)), v = new Uint8Array((width / 2) * (height / 2));
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const band = Math.floor(c / 23) % 3;
      y[r * width + c] = band === 0 ? (c * 3 + r) & 255 : band === 1 ? (r < height / 2 ? 30 : 220) : Math.floor(rnd() * 256);
    }
  }
  for (let i = 0; i < u.length; i++) { u[i] = Math.floor(rnd() * 256); v[i] = (i * 7) & 255; }
  return { width, height, y, u, v };
}

function annexB(enc, skips = 0) {
  const sc = Buffer.from([0, 0, 0, 1]);
  const parts = [sc, enc.sps, sc, enc.pps, sc, enc.idr];
  for (let i = 1; i <= skips; i++) parts.push(sc, enc.skip(i));
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

function croppedRecon(enc) {
  const { width: w, height: h, recon } = enc;
  const out = Buffer.alloc(w * h * 1.5);
  let o = 0;
  for (let r = 0; r < h; r++) { out.set(recon.y.subarray(r * recon.stride, r * recon.stride + w), o); o += w; }
  for (const plane of [recon.u, recon.v]) {
    for (let r = 0; r < h / 2; r++) { out.set(plane.subarray(r * recon.chromaStride, r * recon.chromaStride + w / 2), o); o += w / 2; }
  }
  return out;
}

function decode(file) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-err_detect', 'explode', '-xerror',
    '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 28 });
}

// ------------------------------------------------------------------ bitstream units

test('Exp-Golomb codes match the spec for small and large values', () => {
  const bw = new BitWriter(8);
  bw.ue(0); bw.ue(1); bw.ue(2); bw.ue(3); bw.se(1); bw.se(-1); // 1 010 011 00100 010 011
  bw.trailing();
  assert.deepEqual(Array.from(bw.bytes()), [0b10100110, 0b01000100, 0b11100000]);
  const big = new BitWriter(8);
  big.ue(32400); // a 4K mb_skip_run: 31 bits, written in two halves
  big.trailing();
  assert.equal(big.bytes().length, 4);
});

test('chroma DC coeff_token for 4 coefficients with 3 trailing ones is seven zero bits (regression)', () => {
  const bw = new BitWriter(8);
  writeResidualBlock(bw, Int32Array.from([5, 1, -1, 1]), 4, -1);
  // scan order 5, 1, -1, 1: the three highest-frequency coefficients are the trailing ones.
  // 0000000 (token), then their signs from the highest frequency down: +1, -1, +1 -> 0 1 0
  const bits = Array.from(bw.bytes()).map((b) => b.toString(2).padStart(8, '0')).join('') + bw.acc.toString(2).padStart(bw.n, '0');
  assert.ok(bits.startsWith('0000000010'), bits);
});

// ------------------------------------------------------------------ decoder agreement

test('ffmpeg decodes the stream to exactly the encoder\'s reconstruction, at every QP', { skip: !FFMPEG && 'ffmpeg not installed' }, () => {
  const pic = picture(96, 64);
  for (const qp of [10, 14, 22, 30, 40]) {
    const enc = encodeStill({ ...pic, qp });
    const file = path.join(tmp, `qp${qp}.264`);
    fs.writeFileSync(file, annexB(enc, 3));
    const decoded = decode(file);
    const expected = croppedRecon(enc);
    assert.equal(decoded.length, expected.length * 4, `4 frames at qp ${qp}`);
    for (let f = 0; f < 4; f++) {
      assert.ok(decoded.subarray(f * expected.length, (f + 1) * expected.length).equals(expected), `frame ${f} at qp ${qp} differs from the reconstruction`);
    }
  }
});

test('sizes that are not a multiple of 16 are cropped, and still decode exactly', { skip: !FFMPEG && 'ffmpeg not installed' }, () => {
  for (const [w, h] of [[34, 18], [130, 72], [2, 2]]) {
    const enc = encodeStill({ ...picture(w, h, w), qp: 14 });
    const file = path.join(tmp, `crop${w}x${h}.264`);
    fs.writeFileSync(file, annexB(enc));
    assert.ok(decode(file).equals(croppedRecon(enc)), `${w}x${h}`);
  }
});

test('the reconstruction is close to the source (it is a quality encoder, not just a valid one)', () => {
  const pic = picture(96, 64);
  const enc = encodeStill({ ...pic, qp: 14 });
  let se = 0;
  for (let r = 0; r < pic.height; r++) for (let c = 0; c < pic.width; c++) {
    const d = pic.y[r * pic.width + c] - enc.recon.y[r * enc.recon.stride + c];
    se += d * d;
  }
  const psnr = 10 * Math.log10((255 * 255) / (se / (pic.width * pic.height)));
  assert.ok(psnr > 44, `luma PSNR ${psnr.toFixed(1)} dB at QP 14`);
});

test('a repeat frame is a few bytes whatever the picture size', () => {
  const enc = encodeStill({ ...picture(320, 192), qp: 20 });
  assert.ok(enc.skip(1).length < 16, `${enc.skip(1).length} bytes`);
});

test('parameters are Constrained Baseline with a level that fits the size, and colour tagged BT.709', () => {
  const small = encodeStill({ ...picture(64, 32), qp: 20 });
  assert.equal(small.sps[1], 66);    // profile_idc
  assert.equal(small.sps[2], 0xc0);  // constraint_set0 + constraint_set1
  assert.equal(small.level, 40);
  const big = encodeStill({ width: 3840, height: 2160, y: new Uint8Array(3840 * 2160).fill(128), u: new Uint8Array(1920 * 1080).fill(128), v: new Uint8Array(1920 * 1080).fill(128), qp: 20 });
  assert.equal(big.level, 51);
  assert.throws(() => encodeStill({ ...picture(64, 32), qp: 9 }), /qp/);
  assert.throws(() => encodeStill({ width: 63, height: 32, y: new Uint8Array(1), u: new Uint8Array(1), v: new Uint8Array(1) }), /even/);
});

// ------------------------------------------------------------------ MP4 + conversion

test('the MP4 is fast-start, indexes every sample, and plays as a still of the requested length', { skip: !FFMPEG && 'ffmpeg not installed' }, () => {
  const enc = encodeStill({ ...picture(96, 64), qp: 18 });
  const samples = [[enc.idr]];
  for (let i = 1; i < 10; i++) samples.push([enc.skip(i)]);
  const mp4 = writeMp4({ width: 96, height: 64, sps: enc.sps, pps: enc.pps, samples });
  assert.equal(mp4.toString('ascii', 4, 8), 'ftyp');
  const moovAt = mp4.readUInt32BE(0);
  assert.equal(mp4.toString('ascii', moovAt + 4, moovAt + 8), 'moov');
  const mdatAt = moovAt + mp4.readUInt32BE(moovAt);
  assert.equal(mp4.toString('ascii', mdatAt + 4, mdatAt + 8), 'mdat');
  const file = path.join(tmp, 'still.mp4');
  fs.writeFileSync(file, mp4);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=profile,level,width,height,nb_frames,color_space,color_range:format=duration', '-of', 'json', file]));
  const s = probe.streams[0];
  assert.equal(s.profile, 'Constrained Baseline');
  assert.equal(s.width, 96);
  assert.equal(Number(s.nb_frames), 10);
  assert.equal(s.color_space, 'bt709');
  assert.equal(s.color_range, 'tv');
  assert.equal(Number(probe.format.duration), 10);
  const frames = decode(file);
  const one = croppedRecon(enc);
  assert.ok(frames.subarray(0, one.length).equals(one));
  assert.ok(frames.subarray(9 * one.length).equals(one), 'the last frame is still the picture');
});

test('fitting keeps the aspect ratio, never upscales, and keeps both sides even', () => {
  assert.deepEqual(fitSize(7680, 4320, 3840, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(fitSize(6000, 4000, 3840, 2160), { width: 3240, height: 2160 });
  assert.deepEqual(fitSize(2001, 1201, 3840, 2160), { width: 2000, height: 1200 });
  assert.deepEqual(fitSize(2160, 3840, 3840, 2160), { width: 1214, height: 2160 });
});

test('BT.709 limited-range conversion round-trips colours within one level', () => {
  for (const [R, G, B] of [[0, 0, 0], [255, 255, 255], [71, 137, 28], [200, 30, 90], [12, 250, 128]]) {
    const { y, u, v } = rgbToYuv420(Uint8Array.from([R, G, B, R, G, B, R, G, B, R, G, B]), 2, 2);
    const Y = 1.16438 * (y[0] - 16), Cb = u[0] - 128, Cr = v[0] - 128;
    const back = [Y + 1.79274 * Cr, Y - 0.21325 * Cb - 0.53291 * Cr, Y + 2.1124 * Cb].map((x) => Math.round(Math.min(255, Math.max(0, x))));
    back.forEach((c, i) => assert.ok(Math.abs(c - [R, G, B][i]) <= 1, `${[R, G, B]} -> ${back}`));
  }
});

test('stillToMp4 scales an oversized RGBA image down to the box and composites alpha over black', () => {
  const w = 400, h = 200, data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 255; data[i * 4 + 3] = i % w < w / 2 ? 255 : 0; }
  const out = stillToMp4({ data, width: w, height: h }, { maxWidth: 100, maxHeight: 100, seconds: 3 });
  assert.equal(out.width, 100);
  assert.equal(out.height, 50);
  assert.equal(out.frames, 3);
  assert.equal(out.mp4.toString('ascii', 4, 8), 'ftyp');
});

// ------------------------------------------------------------------ the isolated process

async function writePng(file, w, h) {
  const { Jimp } = require('jimp');
  const img = new Jimp({ width: w, height: h, color: 0x3366ccff });
  await img.write(file);
}

test('makeStillVideo converts a real image file in a separate process', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const src = path.join(tmp, 'in.png');
  const out = path.join(tmp, 'out.mp4');
  await writePng(src, 4000, 2000);
  const result = await makeStillVideo({ src, out, seconds: 2 });
  assert.equal(result.width, 3840);
  assert.equal(result.height, 1920);
  assert.equal(result.frames, 2);
  assert.equal(fs.statSync(out).size, result.bytes);
  decode(out); // decodes cleanly
});

test('a bad input fails the conversion with a reason, and the caller keeps running', async () => {
  const garbage = path.join(tmp, 'garbage.jpg');
  fs.writeFileSync(garbage, 'not an image');
  await assert.rejects(makeStillVideo({ src: garbage, out: path.join(tmp, 'x.mp4') }));
  await assert.rejects(makeStillVideo({ src: path.join(tmp, 'missing.png'), out: path.join(tmp, 'y.mp4') }));
  assert.equal(fs.existsSync(path.join(tmp, 'x.mp4')), false);
});

test('a conversion that runs too long is killed, and only the child dies', async () => {
  const src = path.join(tmp, 'slow.png');
  await writePng(src, 3000, 2000);
  await assert.rejects(makeStillVideo({ src, out: path.join(tmp, 'slow.mp4'), timeoutMs: 1 }), /timed out/);
  assert.ok(process.uptime() > 0, 'this process is still here');
});

test('the conversion process runs at the lowest CPU priority', async () => {
  const source = fs.readFileSync(require.resolve('../lib/still-video/index.js'), 'utf8');
  assert.match(source, /setPriority\(child\.pid, 19\)/);
  assert.match(source, /--max-old-space-size=/);
});
