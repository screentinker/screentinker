'use strict';

/*
 * Animated GIF playback for embedded screens that can show motion (LED matrices, RGB LCDs).
 *
 * ⚠️ OPT-IN BY THE FIRMWARE, NEVER BY THE SERVER. A device only gets an animation when it sends
 * `X-ST-Animation: 1` on its render request. Every older firmware keeps getting exactly what it got
 * before (the GIF's first frame as one raw frame), because the LED firmware reads whatever arrives
 * straight into its pixel buffer: an animation container sent to it would light up as noise.
 *
 * Only the two raw formats that can refresh fast enough are animated: 24-bit RGB888 (LED strips and
 * matrices) and 16-bit RGB565 (RGB LCD panels). E-paper never is; a refresh takes seconds and ghosts.
 *
 * WIRE FORMAT "STA1" (all integers little-endian), Content-Type application/x-st-anim:
 *
 *   header, 16 bytes
 *     0  char[4]  magic "STA1"
 *     4  u8       version (1)
 *     5  u8       pixel format: 1 = RGB888 (3 bytes/px), 2 = RGB565 LE (2 bytes/px)
 *     6  u16      width   (the frame as sent, after any rotation, same as X-ST-Screen-Width)
 *     8  u16      height
 *    10  u16      frame count (>= 2)
 *    12  u16      loop count: 0 = forever, N = play N times then hold the last frame
 *    14  u16      reserved (0)
 *
 *   then per frame, 16 bytes + data
 *     0  u16  delay before the next frame, ms (already clamped to the device's max fps)
 *     2  u16  x  ┐ the rectangle this frame replaces. Frame 0 is always the whole screen;
 *     4  u16  y  │ later frames carry only the box that changed since the previous frame
 *     6  u16  w  │ (w = h = 0 means "nothing changed, just wait").
 *     8  u16  h  ┘
 *    10  u16  reserved (0)
 *    12  u32  data length = w * h * bytes-per-pixel
 *    16  ...  the rectangle's pixels, row-major, same pixel format as the header
 *
 * The player keeps one framebuffer, copies each rectangle into it and shows it. Delta rectangles are
 * what make this fit a CrowPanel (2 MB PSRAM, 261 KB per full frame); LED frames are small anyway.
 */

const { Jimp } = require('jimp');
const { GifReader } = require('omggif');
const { toRGB888, toRGB565 } = require('./embedded-postprocess');

const MAGIC = Buffer.from('STA1', 'ascii');
const CONTENT_TYPE = 'application/x-st-anim';
const FORMAT_RGB888 = 1;
const FORMAT_RGB565 = 2;

const BUDGET_DEFAULT = 256 * 1024;
const BUDGET_MIN = 16 * 1024;
const BUDGET_MAX = 4 * 1024 * 1024;
const FPS_DEFAULT = 30;
const MAX_SOURCE_FRAMES = 300;          // decode at most this many frames of a source GIF
const MAX_SOURCE_PIXELS = 1920 * 1080;  // refuse to decode absurd canvases (memory)
// WS2812-class LEDs clock out about 30 µs per LED on one data line, so a big matrix cannot refresh
// faster than that no matter what the GIF asks for. Plus a little slack for the MCU's own work.
const LED_US_PER_PIXEL = 30;
const LED_SLACK_MS = 5;

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * What the requesting firmware says it can play, or null when it cannot (or the profile is not a
 * fast raw format). Header names are case-insensitive in Node (always lower-case here).
 */
function animationCapability(headers, profile) {
  const flag = String((headers && headers['x-st-animation']) || '').trim().toLowerCase();
  if (flag !== '1' && flag !== 'sta1') return null;
  const format = pixelFormatFor(profile);
  if (!format) return null;
  return {
    format,
    budget: budgetStep(clampInt(headers['x-st-animation-budget'], BUDGET_MIN, BUDGET_MAX, BUDGET_DEFAULT)),
    maxFps: clampInt(headers['x-st-animation-max-fps'], 1, 60, FPS_DEFAULT),
  };
}

/*
 * The budget a device reports is its free heap at that moment, which moves by a few KB from poll to
 * poll. It is part of the cache key, so used raw it changed the key (and the ETag) on every poll: no
 * 304s, and a slide re-captured in the browser each time. Round DOWN to a fixed ladder, so the
 * answer still fits and the key only moves when the room really changes.
 */
const BUDGET_STEPS = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096].map((k) => k * 1024);
function budgetStep(bytes) {
  let out = BUDGET_STEPS[0];
  for (const s of BUDGET_STEPS) if (s <= bytes) out = s;
  return out;
}

function pixelFormatFor(profile) {
  if (!profile || profile.mcuTranspose) return 0;
  if (profile.outputFormat !== 'raw') return 0;
  if (profile.colorDepth === '24bit-rgb888') return FORMAT_RGB888;
  if (profile.colorDepth === '16bit-rgb565') return FORMAT_RGB565;
  return 0;
}

/** The cache-key suffix: two devices with different budgets must not share an encoding. */
function capabilityKey(cap) {
  return cap ? `sta1:${cap.format}:${cap.budget}:${cap.maxFps}` : null;
}

function isGifSource(content) {
  if (!content) return false;
  const mime = String(content.mime_type || '').toLowerCase();
  if (mime === 'image/gif') return true;
  const name = String(content.filepath || content.remote_url || '').toLowerCase().split('?')[0];
  return name.endsWith('.gif');
}

const isAnimationBuffer = (buf) => Buffer.isBuffer(buf) && buf.length >= 16 && buf.subarray(0, 4).equals(MAGIC);

/*
 * Browsers play a GIF delay of 0 or 1 centisecond as 100 ms (lots of GIFs in the wild rely on it),
 * so do the same, then hold every frame for at least the device's minimum.
 */
function normaliseDelayMs(centiseconds, minDelayMs) {
  let ms = Math.max(0, Number(centiseconds) || 0) * 10;
  if (ms <= 10) ms = 100;
  return Math.min(65535, Math.max(minDelayMs, ms));
}

/**
 * Decode every frame of a GIF into a full composited RGBA canvas, honouring frame disposal:
 *   0/1 leave the frame in place, 2 clear its rectangle to transparent, 3 restore the canvas
 *   to what it was before the frame. omggif blits a frame (with its transparency) but leaves
 *   disposal to the caller.
 * Returns null for a still GIF (one frame), so the caller serves it as a normal image.
 */
function decodeGif(buffer) {
  const reader = new GifReader(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length));
  const width = reader.width;
  const height = reader.height;
  if (!width || !height || width * height > MAX_SOURCE_PIXELS) {
    throw Object.assign(new Error(`GIF canvas ${width}x${height} is too large to animate`), { code: 'GIF_TOO_LARGE' });
  }
  const count = Math.min(reader.numFrames(), MAX_SOURCE_FRAMES);
  if (count < 2) return null;

  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let prev = null;
  let saved = null;
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    if (prev) {
      if (prev.disposal === 2) clearRect(canvas, width, height, prev);
      else if (prev.disposal === 3 && saved) canvas.set(saved);
    }
    saved = info.disposal === 3 ? canvas.slice() : null;
    reader.decodeAndBlitFrameRGBA(i, canvas);
    frames.push({ rgba: Buffer.from(canvas), delayCs: info.delay });
    prev = info;
  }
  // omggif: null = no NETSCAPE loop extension (browsers play it once), 0 = forever, N = N repeats.
  const lc = reader.loopCount();
  const loops = lc === null || lc === undefined ? 1 : (lc === 0 ? 0 : Math.min(65535, lc + 1));
  return { width, height, loops, frames };
}

function clearRect(canvas, width, height, r) {
  const x1 = Math.min(width, r.x + r.width);
  const y1 = Math.min(height, r.y + r.height);
  for (let y = Math.max(0, r.y); y < y1; y++) {
    canvas.fill(0, (y * width + Math.max(0, r.x)) * 4, (y * width + x1) * 4);
  }
}

/*
 * One decoded frame -> the device's packed pixels, fitted and rotated exactly as a still image is
 * (fitImageOntoCanvas, then rotation after resize, as embedded-postprocess does for raw profiles).
 */
async function packFrame(rgba, srcW, srcH, profile, fitOpts, fitImageOntoCanvas) {
  // ⚠️ Buffer.alloc, never Buffer.from: a small Buffer.from() is a slice of Node's shared pool
  // (byteOffset != 0), and Jimp.fromBitmap reads the underlying ArrayBuffer from offset 0, so every
  // pixel lands shifted. Buffer.alloc is never pooled.
  const data = Buffer.alloc(rgba.length);
  data.set(rgba);
  const img = Jimp.fromBitmap({ data, width: srcW, height: srcH });
  const canvas = fitImageOntoCanvas(img, profile.width, profile.height, fitOpts.fitMode, fitOpts.backgroundColor);
  if (profile.rotation) canvas.rotate(profile.rotation);
  const bmp = canvas.bitmap;
  const packed = pixelFormatFor(profile) === FORMAT_RGB565 ? toRGB565(bmp.data) : toRGB888(bmp.data);
  return { packed, width: bmp.width, height: bmp.height };
}

/** The bounding box of pixels that differ between two packed frames, or null when identical. */
function changedRect(a, b, width, height, bpp) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const row = width * bpp;
  for (let y = 0; y < height; y++) {
    const off = y * row;
    // Fast path: whole row identical.
    if (a.compare(b, off, off + row, off, off + row) === 0) continue;
    for (let x = 0; x < width; x++) {
      const p = off + x * bpp;
      let diff = false;
      for (let k = 0; k < bpp; k++) if (a[p + k] !== b[p + k]) { diff = true; break; }
      if (diff) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cropRect(packed, width, rect, bpp) {
  const out = Buffer.allocUnsafe(rect.w * rect.h * bpp);
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * width + rect.x) * bpp;
    packed.copy(out, y * rect.w * bpp, src, src + rect.w * bpp);
  }
  return out;
}

/*
 * Turn packed frames into STA1 entries: frame 0 whole, later ones as changed rectangles. A frame
 * identical to the one before it is folded into the previous entry's delay instead of sent.
 */
function deltaEntries(packedFrames, width, height, bpp) {
  const entries = [];
  for (let i = 0; i < packedFrames.length; i++) {
    const f = packedFrames[i];
    if (i === 0) {
      entries.push({ delay: f.delay, rect: { x: 0, y: 0, w: width, h: height }, data: f.packed });
      continue;
    }
    const rect = changedRect(packedFrames[i - 1].packed, f.packed, width, height, bpp);
    if (!rect) {
      entries[entries.length - 1].delay = Math.min(65535, entries[entries.length - 1].delay + f.delay);
      continue;
    }
    entries.push({ delay: f.delay, rect, data: cropRect(f.packed, width, rect, bpp) });
  }
  return entries;
}

const encodedSize = (entries) => 16 + entries.reduce((n, e) => n + 16 + e.data.length, 0);

function encode(entries, { format, width, height, loops }) {
  const out = Buffer.alloc(encodedSize(entries));
  MAGIC.copy(out, 0);
  out.writeUInt8(1, 4);
  out.writeUInt8(format, 5);
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  out.writeUInt16LE(entries.length, 10);
  out.writeUInt16LE(loops, 12);
  let off = 16;
  for (const e of entries) {
    out.writeUInt16LE(e.delay, off);
    out.writeUInt16LE(e.rect.x, off + 2);
    out.writeUInt16LE(e.rect.y, off + 4);
    out.writeUInt16LE(e.rect.w, off + 6);
    out.writeUInt16LE(e.rect.h, off + 8);
    out.writeUInt32LE(e.data.length, off + 12);
    e.data.copy(out, off + 16);
    off += 16 + e.data.length;
  }
  return out;
}

/*
 * Keep every `step`-th source frame, giving each kept frame the delays of the ones it stands in
 * for, so the animation runs at the same overall speed with fewer frames.
 */
function decimate(frames, step) {
  if (step <= 1) return frames;
  const out = [];
  for (let i = 0; i < frames.length; i += step) {
    let delay = 0;
    for (let j = i; j < Math.min(frames.length, i + step); j++) delay += frames[j].delay;
    out.push({ ...frames[i], delay: Math.min(65535, delay) });
  }
  return out;
}

/**
 * Build an STA1 animation from a GIF buffer for one device, or null when the GIF is a still,
 * nothing fits the budget, or it decodes to fewer than two distinct frames. A null means "serve
 * the ordinary still frame", never an error the device would see.
 *
 * @param {Buffer} gifBuffer
 * @param {object} profile     the parsed screen profile (width, height, rotation, colorDepth...)
 * @param {object} cap         animationCapability() result
 * @param {object} fitOpts     { fitMode, backgroundColor }
 * @param {Function} fitImageOntoCanvas  shared with the still-image path (embedded-render)
 */
async function buildAnimation(gifBuffer, profile, cap, fitOpts, fitImageOntoCanvas) {
  const gif = decodeGif(gifBuffer);
  if (!gif) return null;
  return buildFromFrames(gif, profile, cap, fitOpts, fitImageOntoCanvas, { gifDelays: true });
}

/**
 * The shared half: composited RGBA frames (from a GIF, or from a browser capture of a slide's
 * animations) -> fitted, packed, delta-encoded, budgeted STA1. `src` is
 * { width, height, loops, frames: [{ rgba, delayCs } | { rgba, delayMs }] }.
 */
async function buildFromFrames(src, profile, cap, fitOpts, fitImageOntoCanvas, { gifDelays = false } = {}) {
  const gif = src;
  const bpp = cap.format === FORMAT_RGB565 ? 2 : 3;
  const frameBytes = profile.width * profile.height * bpp;
  let minDelayMs = Math.ceil(1000 / cap.maxFps);
  if (cap.format === FORMAT_RGB888) {
    minDelayMs = Math.max(minDelayMs, Math.ceil((profile.width * profile.height * LED_US_PER_PIXEL) / 1000) + LED_SLACK_MS);
  }
  // Even one whole frame plus headers must fit, or there is nothing to send.
  if (frameBytes + 32 > cap.budget) return null;

  let packed = [];
  let outW = profile.width;
  let outH = profile.height;
  for (const f of gif.frames) {
    const p = await packFrame(f.rgba, gif.width, gif.height, profile, fitOpts, fitImageOntoCanvas);
    outW = p.width; outH = p.height;
    const delay = gifDelays
      ? normaliseDelayMs(f.delayCs, minDelayMs)
      : Math.min(65535, Math.max(minDelayMs, Math.round(Number(f.delayMs) || 100)));
    packed.push({ packed: p.packed, delay });
  }

  // Shrink by dropping frames until it fits. Deltas are recomputed each time, because what changed
  // between two kept frames is more than what changed between neighbours.
  for (let step = 1; step <= packed.length; step++) {
    const entries = deltaEntries(decimate(packed, step), outW, outH, bpp);
    if (entries.length < 2) return null;
    if (encodedSize(entries) <= cap.budget) {
      return {
        buffer: encode(entries, { format: cap.format, width: outW, height: outH, loops: gif.loops }),
        frames: entries.length,
        loops: gif.loops,
        width: outW,
        height: outH,
      };
    }
  }
  return null;
}

/** Parse an STA1 buffer back into frames (used by tests and the dashboard preview). */
function decode(buf) {
  if (!isAnimationBuffer(buf)) throw new Error('not an STA1 animation');
  const format = buf.readUInt8(5);
  const header = {
    version: buf.readUInt8(4), format,
    width: buf.readUInt16LE(6), height: buf.readUInt16LE(8),
    frameCount: buf.readUInt16LE(10), loops: buf.readUInt16LE(12),
  };
  const frames = [];
  let off = 16;
  for (let i = 0; i < header.frameCount; i++) {
    const len = buf.readUInt32LE(off + 12);
    frames.push({
      delay: buf.readUInt16LE(off),
      rect: { x: buf.readUInt16LE(off + 2), y: buf.readUInt16LE(off + 4), w: buf.readUInt16LE(off + 6), h: buf.readUInt16LE(off + 8) },
      data: buf.subarray(off + 16, off + 16 + len),
    });
    off += 16 + len;
  }
  if (off !== buf.length) throw new Error(`STA1 length mismatch: parsed ${off}, buffer ${buf.length}`);
  return { ...header, frames };
}

module.exports = {
  CONTENT_TYPE, FORMAT_RGB888, FORMAT_RGB565,
  animationCapability, capabilityKey, isGifSource, isAnimationBuffer,
  decodeGif, buildAnimation, buildFromFrames, decode,
  // exported for tests
  normaliseDelayMs, changedRect, decimate, budgetStep,
};
