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

module.exports = { effectiveDeviceTz, isRealTimezone };

