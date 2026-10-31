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
  // ── Seeed Studio reTerminal Series ──────────────────────────────────────────
  // NOTE: supportedColorModes and supportsPartialRefresh drive the dashboard dropdowns
  // in frontend/js/views/device-detail.js (color mode & refresh behavior selectors).
  // Keep both places in sync when adding presets or modes.
  'seeed-reterminal-sticky': {
    width: 800, height: 480, rotation: 0,
    supportedColorModes: ['1bit', 'gray4'],
    defaultColorDepth: '1bit',
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
    supportsPartialRefresh: true, minRefreshInterval: 5,
    fullRefreshDurationMs: 1800, partialRefreshDurationMs: 350,
    touchSupported: true, touchController: 'GT911',
  },
  'seeed-reterminal-e1001': {
    width: 800, height: 480, rotation: 0,
    supportedColorModes: ['1bit', 'gray4'],
    defaultColorDepth: '1bit',
    colorDepth: '1bit', dither: 'floyd-steinberg', outputFormat: 'x-epd-packed',
    supportsPartialRefresh: true, minRefreshInterval: 5,
    fullRefreshDurationMs: 3000, partialRefreshDurationMs: 350,
    mcuTranspose: true,
    touchSupported: false,
  },
  'seeed-reterminal-e1002': {
    width: 800, height: 480, rotation: 0,
    supportedColorModes: ['spectra6'],
    defaultColorDepth: 'spectra6',
    colorDepth: 'spectra6', dither: 'floyd-steinberg', outputFormat: 'x-epd-spectra6',
    supportsPartialRefresh: false, minRefreshInterval: 30,
    fullRefreshDurationMs: 14000, partialRefreshDurationMs: 0,
    mcuTranspose: true,
    touchSupported: false,
  },
  'seeed-reterminal-e1003': {
    width: 1872, height: 1404, rotation: 0,
    supportedColorModes: ['gray16'],
    defaultColorDepth: 'gray16',
    colorDepth: 'gray16', dither: 'floyd-steinberg', outputFormat: 'x-epd-gray16',
    supportsPartialRefresh: true, minRefreshInterval: 2,
    fullRefreshDurationMs: 1200, partialRefreshDurationMs: 180,
    mcuTranspose: true,
    touchSupported: true, touchController: 'GT911',
  },
  'seeed-reterminal-e1004': {
    width: 1200, height: 1600, rotation: 0,
    supportedColorModes: ['spectra6'],
    defaultColorDepth: 'spectra6',
    colorDepth: 'spectra6', dither: 'floyd-steinberg', outputFormat: 'x-epd-spectra6',
    supportsPartialRefresh: false, minRefreshInterval: 60,
    fullRefreshDurationMs: 22000, partialRefreshDurationMs: 0,
    mcuTranspose: true,
    touchSupported: false,
  },
  // ── Waveshare E-Paper B/W ────────────────────────────────────────────────────
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
  // ── Elecrow CrowPanel Series ──────────────────────────────────────────────────
  'elecrow-crowpanel-43': {
    width: 480, height: 272, rotation: 0,
    supportedColorModes: ['16bit-rgb565'],
    defaultColorDepth: '16bit-rgb565',
    colorDepth: '16bit-rgb565', dither: 'none', outputFormat: 'raw',
    supportsPartialRefresh: false, minRefreshInterval: 1,
    fullRefreshDurationMs: 20, partialRefreshDurationMs: 20,
    touchSupported: true, touchController: 'XPT2046',
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
  // ── LED Strip (Seeed Studio XIAO LED Controller) ──────────────────────────────
  'seeed-xiao-led': {
    width: 5, height: 1, rotation: 0,
    parameterizedDimensions: true,
    supportedColorModes: ['24bit-rgb888'],
    defaultColorDepth: '24bit-rgb888',
    colorDepth: '24bit-rgb888', dither: 'none', outputFormat: 'raw',
    supportsPartialRefresh: true, minRefreshInterval: 1,
    fullRefreshDurationMs: 50, partialRefreshDurationMs: 50,
  },
};

const VALID_COLOR_DEPTHS   = new Set(['1bit', 'gray4', '4bit-gray', 'gray16', 'spectra6', '16bit-rgb565', '24bit-rgb888']);
const VALID_DITHERS        = new Set(['none', 'floyd-steinberg', 'atkinson']);
const VALID_OUTPUT_FORMATS = new Set(['png', 'bmp', 'raw', 'x-epd-packed', 'x-epd-gray4', 'x-epd-spectra6', 'x-epd-gray16', 'jpeg', 'jpg']);
const VALID_ROTATIONS      = new Set([0, 90, 180, 270]);

const DEFAULTS = {
  rotation: 0,
  colorDepth: '1bit',
  dither: 'floyd-steinberg',
  outputFormat: 'x-epd-packed',
};

const { ROTATION_DEG } = require('./orientation-style');
const VALID_ORIENTATIONS = new Set(['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped']);

/*
 * ⚠️ WHO TRANSPOSES A PORTRAIT FRAME — THE SERVER OR THE PANEL.
 *
 * Every profile that existed before the reTerminal E-Series gets main's server-side rotation: the
 * frame is composed at width x height, then img.rotate(rotation) turns it into the panel's native
 * order, and the panel writes the bytes straight out. Hundreds of fielded panels depend on exactly
 * those bytes.
 *
 * The reTerminal firmware (screentinker_mcu >= 1.3.0) instead receives the frame UNROTATED in the
 * composed orientation and transposes it itself whenever X-ST-Screen-Width/Height differ from its
 * native panel; the server only applies the 180-degree part of a flipped mount. That is
 * `mcuTranspose`, and it applies only to:
 *   - the E1001-E1004 presets, which never shipped any other way;
 *   - a stored profile that says `"mcuTranspose": true` itself;
 *   - the Sticky preset, but only when the panel (or a preview of it) states an orientation or
 *     rotation in the request: only that firmware does, and an existing Sticky that states none
 *     keeps main's bytes, including one stored with its own `rotation`.
 */
const MCU_TRANSPOSE_STATED = new Set(['seeed-reterminal-sticky']);
const NIBBLE_DEPTHS = new Set(['spectra6', 'gray16']);
const CRUMB_DEPTHS  = new Set(['gray4']);

/**
 * Return a validated, fully-populated profile object.
 * Unknown/invalid fields fall back to DEFAULTS rather than throwing — a corrupt stored
 * profile should produce a degraded image, not a 500.
 *
 * ⚠️ `overrides` must only ever carry an orientation/rotation someone STATED: the request
 * (?orientation= / ?rotation= / X-ST-Device-Orientation / X-ST-Device-Rotation) or one the device
 * itself reported earlier. Never devices.orientation: every row has 'landscape' there by schema
 * default, so it is not a choice, and feeding it in turned a portrait custom profile landscape and
 * wiped a profile's own rotation.
 *
 * @param {string|object|null} raw  JSON string from devices.screen_profile, or plain object.
 * @param {object|string} [overrides] Optional stated { orientation, rotation }.
 * @returns {object|null}  Validated profile, or null if raw is empty/unparseable/missing dims.
 */
/*
 * ⚠️ HOW BIG A RENDER MAY BE, decided by the PRESET, never by the profile. Every render is a headless
 * Chromium screenshot plus a full RGBA bitmap in this process, so a 10000×10000 profile was ~400 MB
 * per request on a shared server. A profile is operator JSON (PUT /devices, or what a panel sent at
 * pairing), so a flag it carries cannot relax a limit: `parameterizedDimensions: false` in a profile
 * used to switch the LED cap off. The LED cap comes from the preset's own definition, and raw RGB888
 * output (what an LED controller takes) is held to it whatever the preset.
 *
 *   any profile        at most MAX_SIDE per side and MAX_PIXELS in all (a 4K panel; the largest
 *                      real e-paper, reTerminal E1003, is 1872×1404)
 *   LED / raw RGB888   at most LED_MAX_SIDE per side and LED_MAX_PIXELS in all
 */
const MAX_SIDE = 4096;
const MAX_PIXELS = 3840 * 2160;
const LED_MAX_SIDE = 512;
const LED_MAX_PIXELS = 16384;
function withinSizeLimit(presetName, obj, width, height) {
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return false;
  const preset = presetName ? PRESETS[presetName] : null;
  const led = !!(preset && preset.parameterizedDimensions) ||
    ((obj.colorDepth === '24bit-rgb888' || obj.colorDepth === 'rgb888') && obj.outputFormat === 'raw');
  if (led && (width > LED_MAX_SIDE || height > LED_MAX_SIDE || width * height > LED_MAX_PIXELS)) return false;
  return true;
}

function parseProfile(raw, overrides = {}) {
  if (!raw) return null;
  const opts = typeof overrides === 'string' ? { orientation: overrides } : (overrides || {});
  const statedOrientation = VALID_ORIENTATIONS.has(opts.orientation) ? opts.orientation : null;
  const statedRotation = VALID_ROTATIONS.has(opts.rotation) ? opts.rotation : undefined;
  const stated = Boolean(statedOrientation) || statedRotation !== undefined;

  let obj;
  let presetName = null;
  if (typeof raw === 'string') {
    if (PRESETS[raw] && !stated) return { ...PRESETS[raw] };
    if (PRESETS[raw]) {
      presetName = raw;
      obj = { ...PRESETS[raw] };
    } else {
      try {
        obj = JSON.parse(raw);
      } catch {
        return null;
      }
    }
  } else {
    obj = raw;
  }
  if (typeof obj === 'string' && PRESETS[obj]) {
    if (!stated) return { ...PRESETS[obj] };
    presetName = obj;
    obj = { ...PRESETS[obj] };
  }
  if (typeof obj !== 'object' || obj === null) return null;

  if (obj.preset && PRESETS[obj.preset]) {
    presetName = obj.preset;
    obj = { ...PRESETS[obj.preset], ...obj };
  }

  let width  = Number.isInteger(obj.width)  && obj.width  > 0 ? obj.width  : null;
  let height = Number.isInteger(obj.height) && obj.height > 0 ? obj.height : null;
  if (!width || !height || !withinSizeLimit(presetName, obj, width, height)) return null;

  // A stated orientation wins; otherwise the profile's own `orientation` field, if it has one.
  const profileOrientation = VALID_ORIENTATIONS.has(obj.orientation) ? obj.orientation : null;
  const orientation = statedOrientation || profileOrientation;

  // Portrait on a landscape box (or vice versa): swap width and height.
  if (orientation) {
    const isPortrait = orientation === 'portrait' || orientation === 'portrait-flipped';
    if (isPortrait && width > height) {
      const tmp = width; width = height; height = tmp;
    } else if (!isPortrait && width < height) {
      const tmp = width; width = height; height = tmp;
    }
  }

  // Rotation: stated rotation, else the stated orientation's, else the profile's OWN rotation
  // (which a profile orientation field does not override), else the profile orientation's.
  let rotation = DEFAULTS.rotation;
  if (statedRotation !== undefined) rotation = statedRotation;
  else if (statedOrientation) rotation = ROTATION_DEG[statedOrientation];
  else if (VALID_ROTATIONS.has(obj.rotation)) rotation = obj.rotation;
  else if (profileOrientation) rotation = ROTATION_DEG[profileOrientation];

  const mcuTranspose = obj.mcuTranspose === true || (stated && MCU_TRANSPOSE_STATED.has(presetName));

  const rawDepth = obj.colorDepth === 'rgb888' ? '24bit-rgb888' :
                   obj.colorDepth === 'rgb565' ? '16bit-rgb565' :
                   (obj.colorDepth === 'mono' ? '1bit' : obj.colorDepth);
  const result = {
    width,
    height,
    rotation,
    colorDepth:   VALID_COLOR_DEPTHS.has(rawDepth)            ? rawDepth         : (obj.defaultColorDepth || DEFAULTS.colorDepth),
    dither:       VALID_DITHERS.has(obj.dither)               ? obj.dither       : DEFAULTS.dither,
    outputFormat: VALID_OUTPUT_FORMATS.has(obj.outputFormat)  ? obj.outputFormat : DEFAULTS.outputFormat,
  };

  if (Array.isArray(obj.supportedColorModes)) {
    result.supportedColorModes = [...obj.supportedColorModes];
  }
  if (obj.defaultColorDepth) {
    result.defaultColorDepth = obj.defaultColorDepth;
  }

  // Validate: colorDepth must be supported by the profile (if supportedColorModes is defined)
  if (result.supportedColorModes && !result.supportedColorModes.includes(result.colorDepth)) {
    result.colorDepth = result.defaultColorDepth || DEFAULTS.colorDepth;
  }

  if (orientation) {
    result.orientation = orientation;
  }
  if (mcuTranspose) {
    result.mcuTranspose = true;
  }
  // S6: the nibble packers write two pixels per byte as one flat stream, so an odd FRAME width
  // makes every row boundary straddle a byte. Refuse the profile rather than emit a skewed picture.
  // Only the nibble formats: 1-bit always accepted odd widths and fielded panels use them.
  if (NIBBLE_DEPTHS.has(result.colorDepth) && frameDimensions(result).width % 2 !== 0) return null;
  // gray4 packs 4 pixels per byte: width must be divisible by 4 to avoid straddling byte boundaries.
  if (CRUMB_DEPTHS.has(result.colorDepth) && frameDimensions(result).width % 4 !== 0) return null;

  if (typeof obj.supportsPartialRefresh === 'boolean') {
    result.supportsPartialRefresh = obj.supportsPartialRefresh;
  }
  if (obj.refreshMode === 'always_full' || obj.refreshMode === 'smart_partial') {
    result.refreshMode = obj.refreshMode;
  }
  if (typeof obj.minRefreshInterval === 'number' && obj.minRefreshInterval >= 0) {
    result.minRefreshInterval = obj.minRefreshInterval;
  }
  if (typeof obj.fullRefreshDurationMs === 'number') {
    result.fullRefreshDurationMs = obj.fullRefreshDurationMs;
  }
  if (typeof obj.partialRefreshDurationMs === 'number') {
    result.partialRefreshDurationMs = obj.partialRefreshDurationMs;
  }
  if (typeof obj.touchSupported === 'boolean') {
    result.touchSupported = obj.touchSupported;
  }
  if (obj.touchController !== undefined) {
    result.touchController = obj.touchController;
  }
  if (typeof obj.fitMode === 'string') {
    result.fitMode = obj.fitMode.toLowerCase();
  }
  if (typeof obj.backgroundColor === 'string') {
    result.backgroundColor = obj.backgroundColor;
  }

  return result;
}

/*
 * The dimensions of the frame actually sent (X-ST-Screen-Width / -Height). Server-side rotation by
 * 90/270 turns a width x height composition into height x width; an MCU-transposed frame goes out as
 * composed.
 */
function frameDimensions(profile) {
  const quarter = profile.rotation === 90 || profile.rotation === 270;
  return (quarter && !profile.mcuTranspose)
    ? { width: profile.height, height: profile.width }
    : { width: profile.width, height: profile.height };
}

/* What X-ST-Orientation reports: the stated/profile orientation, else the composed box's shape. */
function frameOrientation(profile) {
  if (profile.orientation) return profile.orientation;
  return profile.height > profile.width ? 'portrait' : 'landscape';
}

/** Return a preset by key, or null if unknown. */
function getPreset(key) {
  return PRESETS[key] ? { ...PRESETS[key] } : null;
}

/** List all preset keys (for the dashboard dropdown). */
function listPresets() {
  return Object.keys(PRESETS).map(key => ({ key, ...PRESETS[key] }));
}

module.exports = { PRESETS, parseProfile, getPreset, listPresets, DEFAULTS, frameDimensions, frameOrientation, SIZE_LIMITS: { MAX_SIDE, MAX_PIXELS, LED_MAX_SIDE, LED_MAX_PIXELS } };
