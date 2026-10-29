'use strict';
/*
 * WIDGETS THAT FOLLOW THE SCREEN THEY ARE ON.
 *
 * A weather widget used to show the place typed into it, a clock the zone typed into it, so one
 * widget could not serve screens in two cities and a screen moved in Device Info kept showing the
 * old city. A widget can now take the place from the SCREEN instead:
 *
 *   weather  location_source: 'screen'   the screen's latitude/longitude, labelled with its place
 *   clock    timezone_source: 'screen'   the screen's time zone
 *   radar    location_source: 'screen'   (the default for a radar; 'fixed' pins latitude/longitude)
 *
 * Resolved on the SERVER, in /api/widgets/:id/render, from the ?device=<id> every player already
 * appends (web, Android, Tizen, native). No player changes, so it works on screens in the field.
 * A device in another workspace is ignored (the render route is public: a device id must not read
 * another tenant's location), and so is a missing device or one with no location: the widget falls
 * back to its own typed place.
 *
 * ⚠️ RENDER PAGES ARE CACHED BY URL FOR A YEAR (?rev= makes them immutable). So the rev a screen is
 * sent carries revSalt(): a number derived from the place, which changes exactly when the place
 * does (ws/deviceSocket.js refreshWidgetRevs). An unchanged place keeps the URL, so the anti-flash
 * WebView reuse still holds.
 */

const deviceStmt = new WeakMap();
function stmtFor(db) {
  let s = deviceStmt.get(db);
  if (!s) {
    s = db.prepare('SELECT latitude, longitude, location_label, timezone, reported_timezone, workspace_id FROM devices WHERE id = ?');
    deviceStmt.set(db, s);
  }
  return s;
}

function followsScreen(type, cfg) {
  const c = cfg || {};
  if (type === 'radar') return c.location_source !== 'fixed';
  if (type === 'weather') return c.location_source === 'screen';
  if (type === 'clock') return c.timezone_source === 'screen';
  return false;
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { return null; }
}

// "Kenosha, Wisconsin, United States" -> "Kenosha, Wisconsin": the town and region read as a label.
function shortLabel(label) {
  if (typeof label !== 'string') return '';
  return label.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(', ').slice(0, 80);
}

/** The screen's place, or null when the device is unknown or belongs to another workspace. */
function screenPlace(db, deviceId, workspaceId) {
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 64 || !workspaceId) return null;
  const d = stmtFor(db).get(deviceId);
  if (!d || d.workspace_id !== workspaceId) return null;
  const lat = d.latitude === null || d.latitude === undefined ? NaN : Number(d.latitude);
  const lon = d.longitude === null || d.longitude === undefined ? NaN : Number(d.longitude);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  // devices.timezone defaults to 'UTC', which usually means nobody set it; the screen's own OS
  // zone is the better answer then. A zone somebody chose always wins.
  const chosen = validZone(d.timezone);
  const timezone = (chosen && chosen !== 'UTC') ? chosen : (validZone(d.reported_timezone) || chosen);
  return {
    lat: hasPoint ? Math.round(lat * 10000) / 10000 : null,
    lon: hasPoint ? Math.round(lon * 10000) / 10000 : null,
    label: shortLabel(d.location_label),
    timezone: timezone || null,
  };
}

/** The config the widget renders with on this screen. Never mutates `cfg`. */
function applyPlace(type, cfg, place) {
  const c = { ...(cfg || {}) };
  delete c.__place_query;
  if (!place || !followsScreen(type, c)) return c;
  if ((type === 'weather' || type === 'radar') && place.lat !== null) {
    if (type === 'weather') {
      c.__place_query = `${place.lat},${place.lon}`;
      c.location = place.label || c.__place_query;
    } else {
      c.latitude = place.lat;
      c.longitude = place.lon;
      if (place.label) c.label = place.label;
    }
  }
  if (type === 'clock' && place.timezone) c.timezone = place.timezone;
  return c;
}

/** 0 when the widget does not follow the screen (or the screen has no place); else 1..999999. */
function revSalt(type, cfg, place) {
  if (!place || !followsScreen(type, cfg)) return 0;
  const key = type === 'clock' ? String(place.timezone || '') : `${place.lat},${place.lon},${place.label}`;
  if (key === '' || key === 'null,null,') return 0;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 999999) + 1;
}

module.exports = { followsScreen, screenPlace, applyPlace, revSalt, shortLabel };
