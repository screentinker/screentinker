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
async function postprocess(pngBuffer, profile) {
  const { width, height, rotation = 0, colorDepth, dither, outputFormat } = profile;

  let img = await Jimp.fromBuffer(pngBuffer);

  // Cover resize: crop to fill target box without letterboxing
  img.cover({ w: width, h: height });

  // Rotation applied AFTER resize so the target box is always width×height
  if (rotation) img.rotate(rotation);

  // ── 24-bit pass-through ──────────────────────────────────────────────────────
  if (colorDepth === '24bit-rgb888') {
    const buf = await img.getBuffer('image/png');
    return { buffer: buf, contentType: 'image/png' };
  }

  const rgba = img.bitmap.data;
  const w    = img.bitmap.width;
  const h2   = img.bitmap.height;

  // ── 16-bit RGB565 ────────────────────────────────────────────────────────────
  if (colorDepth === '16bit-rgb565') {
    return { buffer: toRGB565(rgba), contentType: 'application/octet-stream' };
  }

  // ── 4-bit grayscale ──────────────────────────────────────────────────────────
  if (colorDepth === '4bit-gray') {
    return { buffer: to4BitGray(rgba), contentType: 'application/octet-stream' };
  }

  // ── 1-bit ────────────────────────────────────────────────────────────────────
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
    return { buffer: packBMP1bit(packed, w, h2), contentType: 'image/bmp' };
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
    return { buffer: buf, contentType: 'image/jpeg' };
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
    return { buffer: buf, contentType: 'image/png' };
  }

  // raw / x-epd-packed — packed bits with no header (natural SSD1677 feed)
  return { buffer: Buffer.from(packed), contentType: 'application/octet-stream' };
}

module.exports = { postprocess };
