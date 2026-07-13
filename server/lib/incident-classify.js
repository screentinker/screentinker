'use strict';

// Offline-cause / incident classification — pure helpers shared by deviceSocket.js
// (the live path) and the unit tests. No DB, no socket, no side effects: given a
// device-reported connectivity snapshot (or a raw socket.io disconnect reason),
// return the canonical {reason, detail, type} the offline-cause log records.
//
// Keeping this here (a) makes the classification rules testable without spinning a
// socket server, and (b) guarantees the live handler and the tests agree on the exact
// strings (glyphs included) by construction.

// device_events.type allowed set (the unified incident feed). Anything outside this is
// dropped by the device:event handler so a forged/typo'd type can't pollute the feed.
const ALLOWED_EVENT_TYPES = new Set([
  'offline', 'online', 'display_off', 'display_on', 'crash', 'reboot', 'network', 'app_error',
]);

function isAllowedEventType(type) {
  return typeof type === 'string' && ALLOWED_EVENT_TYPES.has(type);
}

// Normalize a socket.io disconnect reason (transport close / ping timeout / transport
// error / etc.) into a category token, falling back to 'silent' when none was supplied.
// Mirrors the contract: String(reason||'').trim().replace(/\s+/g,'_').toLowerCase().
function normalizeDisconnectReason(reason) {
  const norm = String(reason == null ? '' : reason).trim().replace(/\s+/g, '_').toLowerCase();
  return norm || 'silent';
}

// Compose reason + detail (and the device_events type) from a device connectivity report
// sent on reconnect after an in-process disconnect. The app SURVIVED the gap, so absent a
// cold_start it was NOT a reboot. Rules are the offline-cause contract's:
//   cold_start === true            -> reboot,       "Device restarted (power/reboot)"
//   else link_lost === true        -> network,      "Wi‑Fi/Ethernet link lost"
//   else link up — split by the device's internet probe (8.8.8.8/1.1.1.1) during the gap, which
//   pinpoints blame between the customer's internet and OUR server:
//     internet_ok === true         -> server_down,  "Internet reachable — our server was unreachable"
//     internet_ok === false        -> no_internet,  "No internet — router/ISP down"
//     internet_ok absent (no probe)-> network,       "Local network up but server unreachable (router/upstream)"
// then append, when present: SSID, weak-signal (rssi < -75), IP-changed detail fragments.
function classifyConnectivity(report) {
  const r = report || {};
  let reason;
  let detail;
  if (r.cold_start === true) {
    reason = 'reboot';
    detail = 'Device restarted (power/reboot)';
  } else if (r.link_lost === true) {
    reason = 'network';
    detail = 'Wi‑Fi/Ethernet link lost';
  } else if (r.internet_ok === true) {
    // Link up AND the wider internet was reachable, but WE weren't -> our server/hosting, not the site.
    reason = 'server_down';
    detail = 'Internet reachable but the ScreenTinker server was unreachable (server/hosting issue)';
  } else if (r.internet_ok === false) {
    reason = 'no_internet';
    detail = 'No internet — router/ISP down (device link up, public hosts unreachable)';
  } else {
    reason = 'network';
    detail = 'Local network up but server unreachable (router/internet/upstream)';
  }

  if (r.ssid) detail += ` · SSID "${String(r.ssid)}"`;
  if (typeof r.rssi === 'number' && r.rssi < -75) detail += ` · weak signal (${r.rssi} dBm)`;
  if (r.ip_changed) detail += ' · IP changed (DHCP/router)';

  // device_events.type for this incident: a reboot is its own type, everything else is 'network'.
  const type = reason === 'reboot' ? 'reboot' : 'network';
  return { reason, detail, type };
}

module.exports = {
  ALLOWED_EVENT_TYPES,
  isAllowedEventType,
  normalizeDisconnectReason,
  classifyConnectivity,
};
