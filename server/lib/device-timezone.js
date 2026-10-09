'use strict';

// The IANA zone a device's schedule blocks are evaluated in.
//
// This is the SINGLE definition, shared by the two places that must agree:
//   - ws/deviceSocket.js  — evaluating which schedule block is active right now
//   - routes/schedules.js — choosing the zone a NEW schedule is stored in
//
// They previously disagreed. Playback resolved the device's zone, while creation
// defaulted to a bare 'UTC' because the dialog never asked. A user in any non-UTC
// zone typed wall-clock hours, got UTC, and watched a screen that was correctly
// showing nothing — with no visible cue that the hours meant something else.
// Observed in the wild: a schedule set 09:00-17:00 by a user in Asia/Tokyo, stored
// as UTC, which would not open until 18:00 their time.
//
// Precedence: an explicit operator override wins, then whatever the player's OS
// last reported, then null. 'UTC' as an override is treated as "unset" because
// that is the historical default value, not a deliberate choice — a real
// UTC deployment is indistinguishable from an unconfigured one, and defaulting to
// the reported zone is the safer of the two readings.
function effectiveDeviceTz(device) {
  if (!device) return null;
  const override = device.timezone && device.timezone !== 'UTC' ? device.timezone : null;
  return override || device.reported_timezone || null;
}

function isRealTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  // Reject anything that could break out of the single-quoted string it is inlined into, before
  // handing it to Intl — this value is interpolated into generated widget JS.
  if (/['"\\\r\n]/.test(tz)) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch { return false; }
}

// Zones an OS image ships with, i.e. ones nobody chose. ⚠️ Raspberry Pi OS's default IS
// Europe/London, so a Pi set up without the Imager's locale step reports it from anywhere: a
// Pi 4 in Chicago ran its schedules on UK time. Treated as "unknown" only for the pairing fallback
// below — never to override what an operator set.
const DEFAULT_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/Universal', 'Universal', 'GMT', 'Etc/GMT', 'Europe/London']);
function isDefaultZone(tz) { return !tz || DEFAULT_ZONES.has(tz); }

// GET /api/public/timezone: the zone Cloudflare places the caller in (the cf-timezone header from
// the "Add visitor location headers" managed transform), for the installers to ask of OUR server
// rather than a third-party geo-IP service. null when we can't say: a self-hosted server with no
// Cloudflare in front, or the transform off. A forged header (a direct-to-origin request) can only
// mislead the caller about its own clock, and it is validated like any other zone.
function requestTimezone(req) {
  const tz = req && typeof req.get === 'function' ? req.get('cf-timezone') : null;
  return typeof tz === 'string' && tz.length <= 64 && isRealTimezone(tz) ? tz : null;
}

// Pairing fallback for servers that can't see where a display is (a LAN server): the admin
// pairing it is almost always in the same zone as the screen, so their browser's zone is offered
// to a display that is still on its image's default. Returns the zone to send, or null to leave
// the display alone: an operator override wins, a zone the display reports that somebody chose
// is kept, and nothing is sent when it already matches.
function pairingTimezone(device, browserTz) {
  if (!device || typeof browserTz !== 'string' || browserTz.length > 64 || !isRealTimezone(browserTz)) return null;
  if (device.timezone && device.timezone !== 'UTC') return null;
  if (!isDefaultZone(device.reported_timezone)) return null;
  if (device.reported_timezone === browserTz) return null;
  return browserTz;
}

module.exports = { effectiveDeviceTz, isRealTimezone, isDefaultZone, requestTimezone, pairingTimezone };

