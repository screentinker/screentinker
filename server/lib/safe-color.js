'use strict';

/*
 * A hex colour from widget config, safe to put straight into generated HTML or CSS.
 *
 * Rebuilt from the parsed number rather than returned as given once a regex has passed it: the output
 * is then text this function produced, not the caller's string, so nothing a config can contain
 * reaches the page however the validating regex is later edited. Lower-case is the only visible
 * change (CSS colours are case-insensitive).
 */
function hexColor(value, fallback, digits = [3, 4, 6, 8]) {
  const m = /^#([0-9a-f]+)$/i.exec(typeof value === 'string' ? value.trim() : '');
  if (!m || !digits.includes(m[1].length)) return fallback;
  return '#' + parseInt(m[1], 16).toString(16).padStart(m[1].length, '0');
}

/*
 * A widget's page background (#660): see-through unless a colour was chosen. Unset, 'transparent'
 * and anything that is not a hex colour all mean transparent, so the zone, layer or screen
 * background behind the widget shows through it, the way the clock and text widgets always did.
 */
function backgroundColor(value) {
  return hexColor(value, 'transparent');
}

module.exports = { hexColor, backgroundColor };
