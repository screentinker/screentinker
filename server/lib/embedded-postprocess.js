'use strict';

/*
 * Post-processor for the embedded renderer.
 *
 * Takes a raw PNG buffer (the renderer's output) and produces the final byte payload
 * for a specific embedded display according to its screen_profile:
 *
 *   1. Resize to (width × height) — cover mode (crops to fill, no letterbox).
 *   2. Rotate by profile.rotation degrees.
 *   3. Convert to the target color depth.
 *   4. Pack and emit in the target output format.
 *
 * Color depth conversion:
 *   24bit-rgb888  → PNG (pass-through after resize)
 *   16bit-rgb565  → raw R5G6B5 little-endian packed bytes
 *   4bit-gray     → raw nibble-packed grayscale (MSN first per byte)
 *   1bit          → 1 bit per pixel, MSB first, rows NOT padded to byte boundaries
 *                   (the natural SSD1677/SSD1608/UC8151 wire format)
 *                   Dithering: none | floyd-steinberg | atkinson
 *
 * Output formats for 1bit:
 *   x-epd-packed  → raw packed bits, no header (preferred for MCUs)
 *   raw           → raw packed bits, no header
 *   bmp           → 1-bit BMP with a 2-colour palette (Windows BMP v3 DIB header)
 *   png           → greyscale PNG (for debugging; use x-epd-packed on-device)
 */

const { Jimp } = require('jimp');
const { parseColorToRgba, safeHexColor, fitImageOntoCanvas } = require('./embedded-render');

// ─── Dithering algorithms ──────────────────────────────────────────────────────

/*
 * Floyd-Steinberg error diffusion on a Float32 grayscale buffer (0.0–1.0).
 * Returns a Uint8Array of packed 1-bit pixels (MSB first, no row padding).
 */
function floydSteinberg(gray, w, h) {
  const err = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) err[i] = gray[i];

  const out = new Uint8Array(Math.ceil(w * h / 8));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = err[idx];
      const nw  = old < 0.5 ? 0.0 : 1.0;
      const e   = old - nw;

      if (nw > 0.5) {
        out[Math.floor(idx / 8)] |= (1 << (7 - (idx % 8)));
      }

      if (x + 1 < w)           err[idx + 1]     += e * 7 / 16;
      if (y + 1 < h) {
        if (x - 1 >= 0)         err[idx + w - 1] += e * 3 / 16;
                                err[idx + w]     += e * 5 / 16;
        if (x + 1 < w)          err[idx + w + 1] += e * 1 / 16;
      }
    }
  }
  return out;
}

/*
 * Atkinson dithering — distributes 3/4 of the error (6 × 1/8), producing lighter
 * halftones that preserve text readability on high-contrast e-paper content.
 */
function atkinson(gray, w, h) {
  const err = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) err[i] = gray[i];

  const out = new Uint8Array(Math.ceil(w * h / 8));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = err[idx];
      const nw  = old < 0.5 ? 0.0 : 1.0;
      const e   = (old - nw) / 8;

      if (nw > 0.5) {
        out[Math.floor(idx / 8)] |= (1 << (7 - (idx % 8)));
      }

      // 6 neighbours: (+1,0),(+2,0),(-1,+1),(0,+1),(+1,+1),(0,+2)
      const neighbours = [
        [x + 1, y], [x + 2, y],
        [x - 1, y + 1], [x, y + 1], [x + 1, y + 1],
        [x, y + 2],
      ];
      for (const [nx, ny] of neighbours) {
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          err[ny * w + nx] += e;
        }
      }
    }
  }
  return out;
}

/*
 * Simple threshold — no dithering. Fastest; best for high-contrast source images.
 */
function threshold(gray, w, h, t = 0.5) {
  const out = new Uint8Array(Math.ceil(w * h / 8));
  for (let i = 0; i < w * h; i++) {
    if (gray[i] >= t) {
      out[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
    }
  }
  return out;
}

// ─── RGB packing ───────────────────────────────────────────────────────────────

/** Pack RGBA bitmap to 16-bit RGB565 little-endian. 2 bytes per pixel. */
function toRGB565(rgba) {
  const pixels = rgba.length / 4;
  const out = Buffer.allocUnsafe(pixels * 2);
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
    out.writeUInt16LE(v, i * 2);
  }
  return out;
}

/** Pack RGBA bitmap to raw 24-bit RGB888. 3 bytes per pixel. */
function toRGB888(rgba) {
  const pixels = Math.floor(rgba.length / 4);
  const out = Buffer.allocUnsafe(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3]     = rgba[i * 4];     // R
    out[i * 3 + 1] = rgba[i * 4 + 1]; // G
    out[i * 3 + 2] = rgba[i * 4 + 2]; // B
  }
  return out;
}

/** Pack RGBA bitmap to 4-bit grayscale. MSN first per byte. */
function to4BitGray(rgba) {
  const pixels = rgba.length / 4;
  const out = Buffer.alloc(Math.ceil(pixels / 2));
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const lum = Math.round((0.299 * r + 0.587 * g + 0.114 * b) / 255 * 15);
    if (i % 2 === 0) {
      out[Math.floor(i / 2)] = (lum & 0x0F) << 4;
    } else {
      out[Math.floor(i / 2)] |= lum & 0x0F;
    }
  }
  return out;
}

// ─── Spectra 6 Packing (6-Color E-Paper) ──────────────────────────────────────

/*
 * ⚠️ `ctrl` IS THE CONTROLLER INDEX WRITTEN INTO THE NIBBLE, not the array position.
 * The Seeed driver copies nibbles straight to the panel. ED2208 (E1002 / EL073TF1) and T133A01
 * (E1004) both use standard E-Ink Spectra 6 controller nibble codes: 0 black, 1 white, 2 yellow,
 * 3 red, 4 unused, 5 blue, 6 green. Index 4 is an empty slot, so blue must be 5 and green 6.
 */
const SPECTRA6_PALETTE = [
  { r: 20,  g: 20,  b: 20,  ctrl: 0 }, // Black
  { r: 251, g: 251, b: 251, ctrl: 1 }, // White
  { r: 245, g: 222, b: 0,   ctrl: 2 }, // Yellow
  { r: 215, g: 25,  b: 32,  ctrl: 3 }, // Red
  { r: 0,   g: 91,  b: 172, ctrl: 5 }, // Blue
  { r: 0,   g: 135, b: 61,  ctrl: 6 }, // Green
];

function findNearestSpectra6(r, g, b) {
  let bestIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < SPECTRA6_PALETTE.length; i++) {
    const p = SPECTRA6_PALETTE[i];
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const diff = dr * dr + dg * dg + db * db;
    if (diff < minDiff) {
      minDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function packSpectra6(rgba, w, h, dither = 'floyd-steinberg') {
  const pixels = w * h;
  const out = Buffer.alloc(Math.ceil(pixels / 2), 0);

  if (dither === 'floyd-steinberg') {
    const rErr = new Float32Array(pixels);
    const gErr = new Float32Array(pixels);
    const bErr = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) {
      rErr[i] = rgba[i * 4];
      gErr[i] = rgba[i * 4 + 1];
      bErr[i] = rgba[i * 4 + 2];
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const r = Math.min(255, Math.max(0, rErr[idx]));
        const g = Math.min(255, Math.max(0, gErr[idx]));
        const b = Math.min(255, Math.max(0, bErr[idx]));

        const colorIdx = findNearestSpectra6(r, g, b);
        const palette = SPECTRA6_PALETTE[colorIdx];

        const er = r - palette.r;
        const eg = g - palette.g;
        const eb = b - palette.b;

        if (idx % 2 === 0) {
          out[idx >> 1] = (SPECTRA6_PALETTE[colorIdx].ctrl & 0x0F) << 4;
        } else {
          out[idx >> 1] |= (SPECTRA6_PALETTE[colorIdx].ctrl & 0x0F);
        }

        if (x + 1 < w) {
          const next = idx + 1;
          rErr[next] += er * 7 / 16;
          gErr[next] += eg * 7 / 16;
          bErr[next] += eb * 7 / 16;
        }
        if (y + 1 < h) {
          if (x - 1 >= 0) {
            const bl = idx + w - 1;
            rErr[bl] += er * 3 / 16;
            gErr[bl] += eg * 3 / 16;
            bErr[bl] += eb * 3 / 16;
          }
          const below = idx + w;
          rErr[below] += er * 5 / 16;
          gErr[below] += eg * 5 / 16;
          bErr[below] += eb * 5 / 16;
          if (x + 1 < w) {
            const br = idx + w + 1;
            rErr[br] += er * 1 / 16;
            gErr[br] += eg * 1 / 16;
            bErr[br] += eb * 1 / 16;
          }
        }
      }
    }
  } else {
    for (let i = 0; i < pixels; i++) {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      const colorIdx = findNearestSpectra6(r, g, b);
      if (i % 2 === 0) {
        out[i >> 1] = (SPECTRA6_PALETTE[colorIdx].ctrl & 0x0F) << 4;
      } else {
        out[i >> 1] |= (SPECTRA6_PALETTE[colorIdx].ctrl & 0x0F);
      }
    }
  }

  return out;
}

// ─── Gray16 Packing (16-Level Grayscale) ───────────────────────────────────────

function packGray16(rgba, w, h, dither = 'floyd-steinberg') {
  const pixels = w * h;
  const out = Buffer.alloc(Math.ceil(pixels / 2), 0);

  if (dither === 'floyd-steinberg') {
    const err = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      err[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255 * 15;
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const oldVal = err[idx];
        const quantized = Math.min(15, Math.max(0, Math.round(oldVal)));
        const e = oldVal - quantized;

        if (idx % 2 === 0) {
          out[idx >> 1] = (quantized & 0x0F) << 4;
        } else {
          out[idx >> 1] |= (quantized & 0x0F);
        }

        if (x + 1 < w)           err[idx + 1]     += e * 7 / 16;
        if (y + 1 < h) {
          if (x - 1 >= 0)         err[idx + w - 1] += e * 3 / 16;
                                  err[idx + w]     += e * 5 / 16;
          if (x + 1 < w)          err[idx + w + 1] += e * 1 / 16;
        }
      }
    }
  } else {
    for (let i = 0; i < pixels; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const lum = Math.min(15, Math.max(0, Math.round((0.299 * r + 0.587 * g + 0.114 * b) / 255 * 15)));
      if (i % 2 === 0) {
        out[i >> 1] = (lum & 0x0F) << 4;
      } else {
        out[i >> 1] |= (lum & 0x0F);
      }
    }
  }

  return out;
}

// ─── Gray4 Packing (4-Level Grayscale) ─────────────────────────────────────────

/*
 * 4-level grayscale packing for SSD1677 (Sticky) and UC8179 (E1001).
 * 2 bits per pixel, 4 pixels per byte (MSB-first):
 *   byte = [px0 (bits 7..6) | px1 (bits 5..4) | px2 (bits 3..2) | px3 (bits 1..0)]
 *
 * Levels:
 *   0 = Black (#000000)
 *   1 = Dark Gray (#555555)
 *   2 = Light Gray (#AAAAAA)
 *   3 = White (#FFFFFF)
 */
function packGray4(rgba, w, h, dither = 'floyd-steinberg') {
  if (w % 4 !== 0) {
    throw new UnpackableWidthError(`width ${w} is not divisible by 4: gray4 packs four pixels per byte and would straddle rows`);
  }
  const pixels = w * h;
  const out = Buffer.alloc(Math.ceil(pixels / 4), 0);
  const err = new Float32Array(pixels);

  // 1. Calculate luminance (BT.601) scaled to 0..3
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    err[i] = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * 3.0;
  }

  // 2. Quantize & diffuse error (0=Black, 1=DarkGray, 2=LightGray, 3=White)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const oldVal = err[idx];
      const quantized = Math.min(3, Math.max(0, Math.round(oldVal)));
      const e = oldVal - quantized;

      if (dither === 'floyd-steinberg') {
        if (x + 1 < w) err[idx + 1] += (e * 7) / 16;
        if (x > 0 && y + 1 < h) err[idx + w - 1] += (e * 3) / 16;
        if (y + 1 < h) err[idx + w] += (e * 5) / 16;
        if (x + 1 < w && y + 1 < h) err[idx + w + 1] += (e * 1) / 16;
      }

      // 3. Pack 4 pixels per byte (MSB-first)
      const byteIdx = (idx >> 2);
      const shift = 6 - (2 * (x & 3));
      out[byteIdx] |= ((quantized & 0x03) << shift);
    }
  }
  return out;
}

// ─── BMP encoding for 1-bit ────────────────────────────────────────────────────

/*
 * Produce a Windows BMP v3 file for a 1-bit monochrome image.
 * Rows are padded to 4-byte boundaries (BMP spec requirement).
 * Colour table: index 0 = black, index 1 = white.
 */
function packBMP1bit(packed, w, h) {
  const rowBytes  = Math.ceil(w / 8);
  const rowStride = Math.ceil(rowBytes / 4) * 4; // 4-byte aligned
  const pixelData = rowStride * h;
  const fileSize  = 62 + pixelData; // 14 + 40 + 8 (colour table) + pixels

  const buf = Buffer.alloc(fileSize, 0);
  let o = 0;

  // BMP file header (14 bytes)
  buf.write('BM', o); o += 2;
  buf.writeUInt32LE(fileSize, o); o += 4;
  buf.writeUInt32LE(0, o); o += 4;          // reserved
  buf.writeUInt32LE(62, o); o += 4;         // pixel data offset

  // DIB header — BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, o); o += 4;
  buf.writeInt32LE(w, o); o += 4;
  buf.writeInt32LE(-h, o); o += 4;          // negative = top-down scan order
  buf.writeUInt16LE(1, o); o += 2;          // colour planes
  buf.writeUInt16LE(1, o); o += 2;          // bits per pixel
  buf.writeUInt32LE(0, o); o += 4;          // compression: none
  buf.writeUInt32LE(pixelData, o); o += 4;
  buf.writeInt32LE(2835, o); o += 4;        // ~72 DPI X
  buf.writeInt32LE(2835, o); o += 4;        // ~72 DPI Y
  buf.writeUInt32LE(2, o); o += 4;          // colours in table
  buf.writeUInt32LE(2, o); o += 4;          // important colours

  // Colour table (2 × 4 bytes BGRA)
  buf.writeUInt32LE(0x00000000, o); o += 4; // index 0 = black
  buf.writeUInt32LE(0x00FFFFFF, o); o += 4; // index 1 = white

  // Pixel data with row stride padding
  for (let y = 0; y < h; y++) {
    const srcStart = y * rowBytes;
    const dstStart = o + y * rowStride;
    for (let b = 0; b < rowBytes; b++) {
      buf[dstStart + b] = packed[srcStart + b] ?? 0;
    }
  }

  return buf;
}

// ─── Main entry point ──────────────────────────────────────────────────────────

/**
 * Convert a raw PNG buffer to the format required by the device's screen_profile.
 *
 * @param {Buffer} pngBuffer    Raw PNG from the renderer.
 * @param {object} profile      Validated screen_profile object.
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
class UnpackableWidthError extends Error {
  constructor(message) { super(message); this.name = 'UnpackableWidthError'; this.code = 'UNPACKABLE_WIDTH'; }
}

async function postprocess(pngBuffer, profile) {
  const { width, height, rotation = 0, colorDepth, dither, outputFormat } = profile;

  let img = await Jimp.fromBuffer(pngBuffer);

  // Resize if dimensions do not already match the target box
  if (img.bitmap.width !== width || img.bitmap.height !== height) {
    const fitMode = (typeof profile.fitMode === 'string' && ['cover', 'contain', 'fill'].includes(profile.fitMode.toLowerCase()))
      ? profile.fitMode.toLowerCase()
      : 'cover';
    img = fitImageOntoCanvas(img, width, height, fitMode, profile.backgroundColor);
  }

  if (profile.mcuTranspose) {
    // reTerminal firmware (lib/embedded-profiles.js, "WHO TRANSPOSES"): the frame goes out as
    // composed and the MCU applies a fixed portrait transpose; only the 180-degree part of a
    // flipped mount (landscape-flipped 180, portrait-flipped 270) is applied here.
    const postRotation = (rotation === 180 || rotation === 270 || profile.orientation === 'landscape-flipped' || profile.orientation === 'portrait-flipped') ? 180 : 0;
    if (postRotation) img.rotate(postRotation);
  } else if (rotation) {
    // Every other profile, exactly as before: rotation applied AFTER resize so the composed box is
    // always width x height, and the bytes leave in the panel's native order.
    img.rotate(rotation);
  }

  const rgba = img.bitmap.data;
  const w    = img.bitmap.width;
  const h2   = img.bitmap.height;

  // ── 24-bit pass-through / raw RGB888 ──────────────────────────────────────────
  if (colorDepth === '24bit-rgb888') {
    if (outputFormat === 'raw') {
      return { buffer: toRGB888(rgba), contentType: 'application/octet-stream', width: w, height: h2 };
    }
    if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
      const buf = await img.getBuffer('image/jpeg');
      return { buffer: buf, contentType: 'image/jpeg', width: w, height: h2 };
    }
    const buf = await img.getBuffer('image/png');
    return { buffer: buf, contentType: 'image/png', width: w, height: h2 };
  }

  // ── 16-bit RGB565 ────────────────────────────────────────────────────────────
  if (colorDepth === '16bit-rgb565') {
    if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
      const buf = await img.getBuffer('image/jpeg');
      return { buffer: buf, contentType: 'image/jpeg', width: w, height: h2 };
    }
    if (outputFormat === 'png') {
      const buf = await img.getBuffer('image/png');
      return { buffer: buf, contentType: 'image/png', width: w, height: h2 };
    }
    return { buffer: toRGB565(rgba), contentType: 'application/octet-stream', width: w, height: h2 };
  }

  // ── 4-bit grayscale ──────────────────────────────────────────────────────────
  if (colorDepth === '4bit-gray') {
    return { buffer: to4BitGray(rgba), contentType: 'application/octet-stream', width: w, height: h2 };
  }

  // ── Gray4 needs width divisible by 4 (four pixels per byte) ──────────────────
  if (colorDepth === 'gray4' && w % 4 !== 0) {
    throw new UnpackableWidthError(`width ${w} is not divisible by 4: gray4 packs four pixels per byte and would straddle rows`);
  }

  // ── Spectra 6 / Gray16 need an even width (two pixels per byte) ──────────────
  if ((colorDepth === 'spectra6' || colorDepth === 'gray16') && w % 2 !== 0) {
    throw new UnpackableWidthError(`width ${w} is odd: ${colorDepth} packs two pixels per byte and would straddle rows`);
  }

  // ── Gray4 (4-Level Grayscale) ────────────────────────────────────────────────
  if (colorDepth === 'gray4') {
    return { buffer: packGray4(rgba, w, h2, dither), contentType: 'application/octet-stream', outputFormat: 'x-epd-gray4', width: w, height: h2 };
  }

  // ── Spectra 6 (6-Color E-Paper) ──────────────────────────────────────────────
  if (colorDepth === 'spectra6') {
    return { buffer: packSpectra6(rgba, w, h2, dither), contentType: 'application/octet-stream', width: w, height: h2 };
  }

  // ── Gray16 (16-Level Grayscale) ──────────────────────────────────────────────
  if (colorDepth === 'gray16') {
    return { buffer: packGray16(rgba, w, h2, dither), contentType: 'application/octet-stream', width: w, height: h2 };
  }

  // ── 1-bit ────────────────────────────────────────────────────────────────────
  // Any width, as always: fielded 1-bit panels use odd ones (e.g. 249 wide).
  // Build a Float32 grayscale buffer (0.0 = black, 1.0 = white) using BT.601 luminance.
  const pixels = w * h2;
  const gray   = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  let packed;
  if (dither === 'floyd-steinberg') {
    packed = floydSteinberg(gray, w, h2);
  } else if (dither === 'atkinson') {
    packed = atkinson(gray, w, h2);
  } else {
    packed = threshold(gray, w, h2);
  }

  if (outputFormat === 'bmp') {
    return { buffer: packBMP1bit(packed, w, h2), contentType: 'image/bmp', width: w, height: h2 };
  }

  if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
    const mono = new Jimp({ width: w, height: h2, color: 0xFFFFFFFF });
    for (let i = 0; i < pixels; i++) {
      const x = i % w;
      const y = Math.floor(i / w);
      const isWhite = !!(packed[Math.floor(i / 8)] & (1 << (7 - (i % 8))));
      mono.setPixelColor(isWhite ? 0xFFFFFFFF : 0x000000FF, x, y);
    }
    const buf = await mono.getBuffer('image/jpeg');
    return { buffer: buf, contentType: 'image/jpeg', width: w, height: h2 };
  }

  if (outputFormat === 'png') {
    // Build a greyscale PNG via Jimp — primarily for debugging and dashboard preview.
    // x-epd-packed is the preferred format for MCUs.
    const mono = new Jimp({ width: w, height: h2, color: 0xFFFFFFFF });
    for (let i = 0; i < pixels; i++) {
      const x = i % w;
      const y = Math.floor(i / w);
      const isWhite = !!(packed[Math.floor(i / 8)] & (1 << (7 - (i % 8))));
      mono.setPixelColor(isWhite ? 0xFFFFFFFF : 0x000000FF, x, y);
    }
    const buf = await mono.getBuffer('image/png');
    return { buffer: buf, contentType: 'image/png', width: w, height: h2 };
  }

  // raw / x-epd-packed — packed bits with no header (natural SSD1677 feed)
  return { buffer: Buffer.from(packed), contentType: 'application/octet-stream', width: w, height: h2 };
}

/*
 * Full-colour output for a player that shows the frame on a real TV (the Roku, via
 * routes/player-raster.js) rather than on e-paper.
 *
 * ⚠️ NOT a postprocess() profile, deliberately. postprocess() only ever emits JPEG as dithered 1-bit
 * mono (its jpeg branch is an e-paper debugging aid), and every colour depth below 24-bit is a
 * packed wire format for an MCU. A colour JPEG is a different product with a different knob (the
 * quality), so it gets its own small function and postprocess()'s behaviour is untouched.
 *
 * The frame is cover-resized to exactly width x height (a page screenshot already is; this keeps
 * the contract when a renderer returns something else), then encoded:
 *   jpeg -> colour, `quality` 1..100 (the route clamps it to 40..95)
 *   png  -> lossless, for text-heavy frames where JPEG ringing shows
 *
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function encodeColour(pngBuffer, { width, height, format = 'jpeg', quality = 85 } = {}) {
  const img = await Jimp.fromBuffer(pngBuffer);
  if (width && height && (img.bitmap.width !== width || img.bitmap.height !== height)) {
    img.cover({ w: width, h: height });
  }
  if (format === 'png') {
    return { buffer: await img.getBuffer('image/png'), contentType: 'image/png' };
  }
  const q = Math.max(1, Math.min(100, Math.round(Number(quality) || 85)));
  return { buffer: await img.getBuffer('image/jpeg', { quality: q }), contentType: 'image/jpeg' };
}

module.exports = { postprocess, encodeColour, UnpackableWidthError, packGray4, toRGB888, toRGB565 };
