'use strict';

/*
 * Hardware preset library for the embedded renderer.
 *
 * A screen_profile JSON object describes everything the post-processor needs to produce
 * the correct output for a specific display. Operators select a preset in the dashboard
 * device settings and may override individual fields.
 *
 * Fields:
 *   width        {number}  Logical pixel width  (long edge for landscape, short for portrait)
 *   height       {number}  Logical pixel height
 *   rotation     {number}  0 | 90 | 180 | 270  (applied after resize)
 *   colorDepth   {string}  '1bit' | '4bit-gray' | '16bit-rgb565' | '24bit-rgb888'
 *   dither       {string}  'none' | 'floyd-steinberg' | 'atkinson'
 *   outputFormat {string}  'png' | 'bmp' | 'raw' | 'x-epd-packed'
 *
 * outputFormat notes:
 *   png           image/png — universal, good for debugging and dashboards
 *   bmp           image/bmp — BMP with 1-bit palette; many MCU decoders support this natively
 *   raw           application/octet-stream — raw pixel bytes, no header, fastest on MCU
 *   x-epd-packed  application/octet-stream — 1-bit MSB-first, no row-padding;
 *                 the natural byte feed for SSD1677 / SSD1608 / UC8151 / GDEP controllers
 */

const PRESETS = {
  // ── E-Paper B/W ──────────────────────────────────────────────────────────────
  'seeed-reterminal-sticky': {
    width: 800, height: 480, rotation: 0,
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
  },
  'waveshare-7.5in-v2': {
    width: 800, height: 480, rotation: 0,
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
  },
  'waveshare-4.2in-v2': {
    width: 400, height: 300, rotation: 0,
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
  },
  'waveshare-2.9in-v2': {
    width: 296, height: 128, rotation: 0,
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
  },
  'waveshare-1.54in-v2': {
    width: 200, height: 200, rotation: 0,
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
  },
  // ── E-Paper Color ─────────────────────────────────────────────────────────────
  'waveshare-5.65in-acep': {
    // 7-color ACeP (black/white/red/green/blue/yellow/orange). Closest we can do without
    // palette quantization is 24-bit; callers may apply their own palette mapping.
    width: 600, height: 448, rotation: 0,
    colorDepth: '24bit-rgb888', dither: 'none', outputFormat: 'png',
  },
  // ── TFT / ILI9341 class ───────────────────────────────────────────────────────
  'generic-320x240-rgb565': {
    width: 320, height: 240, rotation: 0,
    colorDepth: '16bit-rgb565', dither: 'none', outputFormat: 'raw',
  },
  'generic-480x320-rgb565': {
    width: 480, height: 320, rotation: 0,
    colorDepth: '16bit-rgb565', dither: 'none', outputFormat: 'raw',
  },
  // ── OLED (SSD1306) ────────────────────────────────────────────────────────────
  'generic-128x64-1bit': {
    width: 128, height: 64, rotation: 0,
    colorDepth: '1bit', dither: 'atkinson', outputFormat: 'raw',
  },
  'generic-128x32-1bit': {
    width: 128, height: 32, rotation: 0,
    colorDepth: '1bit', dither: 'atkinson', outputFormat: 'raw',
  },
};

const VALID_COLOR_DEPTHS   = new Set(['1bit', '4bit-gray', '16bit-rgb565', '24bit-rgb888']);
const VALID_DITHERS        = new Set(['none', 'floyd-steinberg', 'atkinson']);
const VALID_OUTPUT_FORMATS = new Set(['png', 'bmp', 'raw', 'x-epd-packed', 'jpeg', 'jpg']);
const VALID_ROTATIONS      = new Set([0, 90, 180, 270]);

const DEFAULTS = {
  rotation: 0,
  colorDepth: '1bit',
  dither: 'floyd-steinberg',
  outputFormat: 'x-epd-packed',
};

/**
 * Return a validated, fully-populated profile object.
 * Unknown/invalid fields fall back to DEFAULTS rather than throwing — a corrupt stored
 * profile should produce a degraded image, not a 500.
 *
 * @param {string|object|null} raw  JSON string from devices.screen_profile, or plain object.
 * @returns {object|null}  Validated profile, or null if raw is empty/unparseable/missing dims.
 */
function parseProfile(raw) {
  if (!raw) return null;
  if (typeof raw === 'string' && PRESETS[raw]) {
    return { ...PRESETS[raw] };
  }
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    if (typeof raw === 'string' && PRESETS[raw]) return { ...PRESETS[raw] };
    return null;
  }
  if (typeof obj === 'string' && PRESETS[obj]) return { ...PRESETS[obj] };
  if (typeof obj !== 'object' || obj === null) return null;

  if (obj.preset && PRESETS[obj.preset]) {
    obj = { ...PRESETS[obj.preset], ...obj };
  }

  const width  = Number.isInteger(obj.width)  && obj.width  > 0 && obj.width  <= 10000 ? obj.width  : null;
  const height = Number.isInteger(obj.height) && obj.height > 0 && obj.height <= 10000 ? obj.height : null;
  if (!width || !height) return null;

  return {
    width,
    height,
    rotation:     VALID_ROTATIONS.has(obj.rotation)           ? obj.rotation     : DEFAULTS.rotation,
    colorDepth:   VALID_COLOR_DEPTHS.has(obj.colorDepth)      ? obj.colorDepth   : DEFAULTS.colorDepth,
    dither:       VALID_DITHERS.has(obj.dither)               ? obj.dither       : DEFAULTS.dither,
    outputFormat: VALID_OUTPUT_FORMATS.has(obj.outputFormat)  ? obj.outputFormat : DEFAULTS.outputFormat,
  };
}

/** Return a preset by key, or null if unknown. */
function getPreset(key) {
  return PRESETS[key] ? { ...PRESETS[key] } : null;
}

/** List all preset keys (for the dashboard dropdown). */
function listPresets() {
  return Object.keys(PRESETS).map(key => ({ key, ...PRESETS[key] }));
}

module.exports = { PRESETS, parseProfile, getPreset, listPresets, DEFAULTS };
