'use strict';

/*
 * Remote settings for addressable-LED screens (WS2812 / SK6812 on the XIAO LED controller), set on
 * the device page and carried to the firmware on every render answer.
 *
 * WHY A HEADER ON EVERY ANSWER, NOT A QUEUED COMMAND: the settings are state, not an action. A
 * command can be missed (TTL, a reboot before it is applied); a header on every 200 and 304 means a
 * panel that reboots, reflashes or was offline converges on the next poll. `rev` lets the firmware
 * skip the work (and the flash write) when nothing changed.
 *
 *   X-ST-Led-Config: v=1;rev=<8 hex>;b=<0-255>;o=<GRB|RGB|...>;wir=<serpentine|progressive>;
 *                    ax=<horizontal|vertical>;org=<top_left|...>;w=<cols>;h=<rows>;
 *                    pl=<mA, 0 = no limit>;auto=<0|1>;lr=<n>
 *
 *   b     brightness ceiling (the firmware's NeoPixel brightness)
 *   pl    power limit for the LEDs, mA. The firmware estimates each frame's current from its pixel
 *         values and dims that frame just enough to stay under it, so a dark frame keeps its
 *         brightness and a white one is held back (it never exceeds `b`).
 *   auto  brownout protection: after a reset the ESP32 reports as a brownout (the supply sagged),
 *         the firmware lowers its own limit by about 15%, saves it, and reports it back. It cannot
 *         see a sag on a rail it is not powered from (a C3 on USB), which is what `pl` is for.
 *   lr    "learned limit reset": bumped from the dashboard to make the firmware forget what it
 *         learned (after the operator fixes the supply).
 *
 * ⚠️ o / wir / ax / org are sent ONLY once an operator has set them here. A wall already wired up
 * with the web installer keeps its own local values until someone changes them in ScreenTinker;
 * sending the defaults would silently re-map every existing wall the day it updates. The firmware
 * reports its local values back, and the device page shows those until they are set here.
 *
 * The firmware reports back on each render request:
 *
 *   X-ST-Led-State: rev=<applied rev>;b=<brightness>;pl=<effective mA>;lpl=<learned mA, 0 = none>;
 *                   bo=<brownouts seen>;est=<last frame estimate mA>;rr=<last reset reason>;
 *                   o=<colour order>;wir=..;ax=..;org=..   (what the LEDs are actually using)
 */

const crypto = require('crypto');

const COLOR_ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR'];
const WIRINGS = ['serpentine', 'progressive'];
const AXES = ['horizontal', 'vertical'];
const ORIGINS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
// Fields that re-map the wall: sent only when an operator set them (see the header comment).
const LAYOUT_FIELDS = ['color_order', 'wiring', 'axis', 'origin'];
const RESET_REASONS = ['poweron', 'brownout', 'panic', 'watchdog', 'software', 'deepsleep', 'external', 'unknown'];

// Full brightness by default: the power limiter (power_limit_ma) is what keeps a wall inside its
// supply, dimming only the frames that would draw too much, so there is no reason to hold every
// frame back. (The firmware used to default to 180 to protect the supply; that was the only guard.)
// The power limit default is the Seeed LED driver board's rated 5 V output (3 A).
const DEFAULTS = Object.freeze({
  brightness: 255,
  color_order: 'GRB',
  wiring: 'serpentine',
  axis: 'horizontal',
  origin: 'top_left',
  power_limit_ma: 3000,
  auto_protect: true,
  learned_reset: 0,
});
const POWER_LIMIT_MAX_MA = 100000;  // 100 A: a big wall on its own supply; 0 still means "no limit"

const intIn = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const oneOf = (v, list) => {
  const s = typeof v === 'string' ? v.trim() : '';
  const hit = list.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || null;
};

/** Is this device an addressable-LED screen (the only kind these settings mean anything to)? */
function isLedDevice(device, profile) {
  if (!device || device.client_type !== 'embedded') return false;
  if (profile && profile.colorDepth === '24bit-rgb888' && profile.outputFormat === 'raw') return true;
  const raw = String(device.screen_profile || '');
  return raw.includes('seeed-xiao-led');
}

function stored(device) {
  let raw = {};
  try { raw = device && device.led_config ? JSON.parse(device.led_config) : {}; } catch (_) { raw = {}; }
  return raw && typeof raw === 'object' ? raw : {};
}

/** Which layout fields (colour order, wiring, axis, origin) an operator has set for this device. */
function explicitLayout(device) {
  const raw = stored(device);
  return LAYOUT_FIELDS.filter((k) => raw[k] !== undefined);
}

/** The stored config with defaults filled in. Never throws: a bad row reads as the defaults. */
function read(device) {
  const stored_ = stored(device);
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (stored_[k] !== undefined) out[k] = stored_[k];
  return normalise(out).value;
}

/**
 * Validate a (partial) config. Returns { value } with every field valid, or { error } naming the
 * first bad field. Fields not given keep `base` (the current config) values.
 */
function normalise(input, base = DEFAULTS) {
  const src = input && typeof input === 'object' ? input : {};
  const value = { ...base };
  const set = (k, v) => { if (v === null) throw Object.assign(new Error(`invalid ${k}`), { field: k }); value[k] = v; };
  try {
    if (src.brightness !== undefined) set('brightness', intIn(src.brightness, 0, 255));
    if (src.color_order !== undefined) set('color_order', oneOf(src.color_order, COLOR_ORDERS));
    if (src.wiring !== undefined) set('wiring', oneOf(src.wiring, WIRINGS));
    if (src.axis !== undefined) set('axis', oneOf(src.axis, AXES));
    if (src.origin !== undefined) set('origin', oneOf(src.origin, ORIGINS));
    if (src.power_limit_ma !== undefined) set('power_limit_ma', intIn(src.power_limit_ma, 0, POWER_LIMIT_MAX_MA));
    if (src.auto_protect !== undefined) {
      if (typeof src.auto_protect !== 'boolean') set('auto_protect', null);
      value.auto_protect = src.auto_protect;
    }
    if (src.learned_reset !== undefined) set('learned_reset', intIn(src.learned_reset, 0, 0xffff));
  } catch (e) {
    return { error: e.message, field: e.field };
  }
  // A limit below what the controller itself draws (~1 mA per LED idle) is not a setting anyone wants.
  if (value.power_limit_ma > 0 && value.power_limit_ma < 100) return { error: 'invalid power_limit_ma', field: 'power_limit_ma' };
  return { value };
}

/**
 * The X-ST-Led-Config header for this device and frame size. `layout` names the layout fields an
 * operator set (explicitLayout); the others are left out so the wall keeps its own.
 */
function header(config, width, height, layout = LAYOUT_FIELDS) {
  const c = normalise(config).value || { ...DEFAULTS };
  const has = (k) => layout.includes(k);
  const body = [
    `b=${c.brightness}`,
    has('color_order') ? `o=${c.color_order}` : null,
    has('wiring') ? `wir=${c.wiring}` : null,
    has('axis') ? `ax=${c.axis}` : null,
    has('origin') ? `org=${c.origin}` : null,
    `w=${intIn(width, 1, 65535) || 0}`, `h=${intIn(height, 1, 65535) || 0}`,
    `pl=${c.power_limit_ma}`, `auto=${c.auto_protect ? 1 : 0}`, `lr=${c.learned_reset}`,
  ].filter(Boolean).join(';');
  const rev = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `v=1;rev=${rev};${body}`;
}

/** Parse X-ST-Led-State from the firmware into a clean object, or null when absent/garbage. */
function parseState(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  const kv = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const out = {
    rev: /^[0-9a-f]{8}$/.test(kv.rev || '') ? kv.rev : null,
    brightness: intIn(kv.b, 0, 255),
    effective_limit_ma: intIn(kv.pl, 0, POWER_LIMIT_MAX_MA),
    learned_limit_ma: intIn(kv.lpl, 0, POWER_LIMIT_MAX_MA),
    brownouts: intIn(kv.bo, 0, 1e6),
    frame_estimate_ma: intIn(kv.est, 0, 1e6),
    reset_reason: oneOf(kv.rr, RESET_REASONS),
    color_order: oneOf(kv.o, COLOR_ORDERS),
    wiring: oneOf(kv.wir, WIRINGS),
    axis: oneOf(kv.ax, AXES),
    origin: oneOf(kv.org, ORIGINS),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/*
 * Store what the firmware reported, only when it changed (a poll every few seconds must not write
 * the row every time). `est` moves with every frame, so it alone does not count as a change.
 */
function recordState(db, device, raw, now = Math.floor(Date.now() / 1000)) {
  const state = parseState(raw);
  if (!state || !device) return false;
  let prev = null;
  try { prev = device.led_state ? JSON.parse(device.led_state) : null; } catch (_) { prev = null; }
  const strip = (s) => (s ? JSON.stringify({ ...s, frame_estimate_ma: null }) : '');
  const changed = strip(prev) !== strip(state);
  const stale = !device.led_state_at || now - device.led_state_at > 300;
  if (!changed && !stale) return false;
  db.prepare('UPDATE devices SET led_state = ?, led_state_at = ? WHERE id = ?').run(JSON.stringify(state), now, device.id);
  return true;
}

function readState(device) {
  try { return device && device.led_state ? JSON.parse(device.led_state) : null; } catch (_) { return null; }
}

module.exports = {
  DEFAULTS, COLOR_ORDERS, WIRINGS, AXES, ORIGINS, LAYOUT_FIELDS, POWER_LIMIT_MAX_MA,
  isLedDevice, read, explicitLayout, normalise, header, parseState, recordState, readState,
};
