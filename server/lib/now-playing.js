'use strict';

/*
 * What each display started most recently, by the server's clock — so a view-only viewer
 * (lib/view-access.js) can join a screen's playlist at the item and offset the screen is on, rather
 * than at item 1. Players keep their own playlist clocks; this is the only shared reference there is.
 *
 * Fed by the device:play-event play_start the players already send (ws/deviceSocket.js). Nothing is
 * sent to a player and nothing a player does changes.
 *
 * ⚠️ BOUNDED BY DESIGN: one entry per display (per zone, at most MAX_ZONES), replaced on every start.
 * Memory only — after a restart a viewer simply starts at the top until the screen's next item.
 */
const MAX_ZONES = 16;
const byDevice = new Map();

function noteStart(deviceId, { content_id, widget_id, zone_id }, atMs) {
  if (!deviceId) return;
  let zones = byDevice.get(deviceId);
  if (!zones) { zones = new Map(); byDevice.set(deviceId, zones); }
  const z = zone_id || '';
  if (!zones.has(z) && zones.size >= MAX_ZONES) zones.delete(zones.keys().next().value);
  zones.set(z, { content_id: content_id || null, widget_id: widget_id || null, zone_id: zone_id || null, started_ms: atMs || Date.now() });
}

/** [{content_id, widget_id, zone_id, started_ms}] for one display; [] when nothing is known. */
function forDevice(deviceId) {
  const zones = byDevice.get(deviceId);
  return zones ? Array.from(zones.values()) : [];
}

function forget(deviceId) { byDevice.delete(deviceId); }

module.exports = { noteStart, forDevice, forget, __reset: () => byDevice.clear() };
