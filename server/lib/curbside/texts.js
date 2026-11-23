'use strict';

/*
 * Curbside pickup: the words customers and screens see (docs/curbside-pickup.md).
 *
 * Every string on the customer page and every label on the screen widget can be changed per
 * location in the dashboard. A location stores ONLY what the admin changed (curbside_locations.texts,
 * a JSON object); an empty value means "use the default", so a later change to a default reaches
 * every location that never touched that string.
 *
 * ⚠️ PLAIN TEXT, ALWAYS. These are inserted with textContent on every page and escaped in every
 * server-built HTML; nothing here is ever HTML. Cleaning only drops control characters, trims and
 * caps the length, so an admin who types "<b>" sees "<b>" on the page, which is the point.
 *
 * Customer messages may contain {spot} and {order}; the page swaps them for the spot label and the
 * order number (as text, client side).
 */

// key -> [default, max length]
const CUSTOMER = {
  heading: ['Curbside pickup', 60],
  intro: ["Type your order number and tap I'm here. We will bring your order out to your car.", 300],
  order_label: ['Order number', 60],
  note_label: ['Anything to help us find you? (optional, for example the colour of your car)', 120],
  button: ["I'm here", 40],
  waiting: ['Thanks! We know you are here. Please stay in spot {spot}.', 300],
  seen: ['We got you! Your order is on the way.', 300],
  done: ['All done. Thank you, and enjoy!', 300],
  spot_taken: ['Someone has already checked in at this spot. Please use another spot, or come inside.', 300],
  cancel: ['Cancel my check-in', 40],
  cancelled: ['Your check-in is cancelled.', 300],
  spot_label: ['Spot', 20],
  choose_spot: ['Choose your parking spot', 60],
  again: ['Check in again', 40],
  keep_open: ['Keep this page open: it updates by itself.', 200],
};

const WIDGET = {
  widget_heading: ['Curbside pickup', 60],
  widget_order: ['Order', 20],
  widget_spot: ['Spot', 20],
  widget_waiting: ['Waiting', 30],
  widget_seen: ['On the way', 30],
  widget_empty: ['No cars waiting', 80],
};

const ALL = { ...CUSTOMER, ...WIDGET };
const KEYS = Object.freeze(Object.keys(ALL));
const DEFAULTS = Object.freeze(Object.fromEntries(KEYS.map((k) => [k, ALL[k][0]])));
const MAX = Object.freeze(Object.fromEntries(KEYS.map((k) => [k, ALL[k][1]])));

/** One admin string, cleaned: control characters become spaces, trimmed, capped. '' means default. */
function cleanText(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The overrides to store, from whatever the dashboard sent. Unknown keys are dropped; an empty or
 * all-space value (or one equal to the default) removes the override.
 */
function cleanOverrides(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const v = cleanText(input[k], MAX[k]);
    if (v && v !== DEFAULTS[k]) out[k] = v;
  }
  return out;
}

function parseStored(json) {
  try { return cleanOverrides(JSON.parse(json || '{}')); } catch { return {}; }
}

/** Every text, resolved: the override where there is one, else the default. */
function resolve(overrides) {
  const o = overrides || {};
  const out = {};
  for (const k of KEYS) out[k] = o[k] || DEFAULTS[k];
  return out;
}

const pick = (all, keys) => Object.fromEntries(keys.map((k) => [k, all[k]]));
const customerTexts = (overrides) => pick(resolve(overrides), Object.keys(CUSTOMER));
const widgetTexts = (overrides) => pick(resolve(overrides), Object.keys(WIDGET));

module.exports = {
  KEYS, DEFAULTS, MAX, CUSTOMER_KEYS: Object.freeze(Object.keys(CUSTOMER)), WIDGET_KEYS: Object.freeze(Object.keys(WIDGET)),
  cleanText, cleanOverrides, parseStored, resolve, customerTexts, widgetTexts,
};
