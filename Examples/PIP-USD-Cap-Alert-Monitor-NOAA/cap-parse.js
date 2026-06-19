'use strict';

// CAP-AU parser for the NSW RFS "majorIncidentsCAP" feed (and other CAP-AU sources that
// wrap their alerts the same way). Three jobs:
//   1. Unwrap the EDXL-DE envelope and pull out each embedded CAP <alert>.
//   2. Normalise the bits we actually gate/render on (AlertLevel lives in <parameter>,
//      NOT in CAP <severity> — RFS leaves severity "Unknown" for routine incidents).
//   3. Geofence: is a given screen's lat/lon inside an alert's <area>? CAP coordinates
//      are "lat,lon" (note: the REVERSE of GeoJSON's lon,lat) — this module keeps the
//      flip in one place so callers never have to think about it.

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,        // EDXLDistribution and alert sit in different namespaces
  parseTagValue: false,        // keep everything as strings; we coerce deliberately
  trimValues: true,
});

// Always work with arrays even when the XML has a single child.
function arr(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

// Pull the <parameter> name/value pairs into a flat map. This is where the useful,
// already-structured fields live (AlertLevel, IncidentType, Status, ...), so we read
// these instead of regexing the HTML-encoded <description> blob.
function paramsToMap(info) {
  const out = {};
  for (const p of arr(info && info.parameter)) {
    if (p && p.valueName != null) out[String(p.valueName)] = p.value == null ? '' : String(p.value);
  }
  return out;
}

// Parse a CAP "<polygon>" string ("lat,lon lat,lon ...") into [{lat, lon}, ...].
function parsePolygon(str) {
  if (!str) return null;
  const pts = String(str).trim().split(/\s+/).map((pair) => {
    const [lat, lon] = pair.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }).filter(Boolean);
  return pts.length >= 3 ? pts : null;
}

// Parse a CAP "<circle>" string ("lat,lon radiusKm"). RFS often emits radius 0 (a point),
// which can never contain anything, so callers should treat a 0-radius circle as "no
// usable circle" and rely on the polygon.
function parseCircle(str) {
  if (!str) return null;
  const [center, radius] = String(str).trim().split(/\s+/);
  const [lat, lon] = (center || '').split(',').map(Number);
  const km = Number(radius);
  if (![lat, lon, km].every(Number.isFinite)) return null;
  return { lat, lon, km };
}

// Ray-casting point-in-polygon. We map lon -> x and lat -> y so the algorithm is ordinary
// planar; that mapping is the ONE place the CAP lat,lon order is reconciled.
function pointInPolygon(pt, poly) {
  const x = pt.lon, y = pt.lat;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon, yi = poly[i].lat;
    const xj = poly[j].lon, yj = poly[j].lat;
    const intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Does {lat, lon} fall inside this alert's area? Polygon first; fall back to a non-zero
// circle. Returns false when the alert has no usable geometry.
function pointInAlertArea(point, alert) {
  if (alert.polygon && pointInPolygon(point, alert.polygon)) return true;
  if (alert.circle && alert.circle.km > 0 && haversineKm(point, alert.circle) <= alert.circle.km) return true;
  return false;
}

// Flatten one embedded CAP <alert> into the shape the monitor works with.
function normaliseAlert(a) {
  const info = Array.isArray(a.info) ? a.info[0] : a.info || {};
  const area = Array.isArray(info.area) ? info.area[0] : info.area || {};
  const params = paramsToMap(info);
  return {
    identifier: a.identifier != null ? String(a.identifier) : null,
    msgType: a.msgType || null,                 // Alert | Update | Cancel
    sent: a.sent || null,
    headline: info.headline || params.IncidentName || '(no headline)',
    event: info.event || null,
    category: info.category || null,
    responseType: info.responseType || null,    // mostly "Monitor" in this feed
    severity: info.severity || null,            // mostly "Unknown" — do NOT gate on this
    expires: info.expires || null,
    web: info.web || null,
    // RFS-specific, the field that actually carries urgency:
    alertLevel: params.AlertLevel || null,      // Planned Burn | Advice | Watch and Act | Emergency Warning
    incidentType: params.IncidentType || null,
    status: params.Status || null,
    size: params.Fireground || params.Size || null,
    council: params.CouncilArea || params.Location || null,
    isFire: (params.IsFire || '').toLowerCase() === 'yes',
    polygon: parsePolygon(area.polygon),
    circle: parseCircle(area.circle),
    areaDesc: area.areaDesc || null,
    params,
  };
}

// Parse a full feed body (EDXL-DE wrapping embedded CAP alerts) into normalised alerts.
function parseFeed(xml) {
  const root = parser.parse(xml);
  const dist = root.EDXLDistribution || root.Distribution || null;
  const alerts = [];
  if (dist) {
    for (const co of arr(dist.contentObject)) {
      const embedded = co && co.xmlContent && co.xmlContent.embeddedXMLContent;
      for (const e of arr(embedded)) {
        for (const al of arr(e && e.alert)) alerts.push(normaliseAlert(al));
      }
    }
  } else {
    // Fallback: a bare CAP feed (no EDXL envelope).
    for (const al of arr(root.alert)) alerts.push(normaliseAlert(al));
  }
  return alerts;
}

// Has this alert's <expires> passed? (Treats missing/unparseable expiry as "not expired".)
function isExpired(alert, now = Date.now()) {
  if (!alert.expires) return false;
  const t = Date.parse(alert.expires);
  return Number.isFinite(t) && t <= now;
}

// The gate: should this alert put something on a screen at `point`?
//   - msgType must be Alert/Update (Cancel clears, never shows)
//   - not expired
//   - AlertLevel is at or above the configured threshold
//   - the screen falls inside the alert area
// Returns { show: bool, reason } so callers can log why something did/didn't fire.
const DEFAULT_LEVELS = ['Watch and Act', 'Emergency Warning'];

function shouldShow(alert, point, opts = {}) {
  const levels = opts.alertLevels || DEFAULT_LEVELS;
  const now = opts.now || Date.now();
  if (alert.msgType === 'Cancel') return { show: false, reason: 'cancelled' };
  if (isExpired(alert, now)) return { show: false, reason: 'expired' };
  if (!alert.alertLevel || !levels.includes(alert.alertLevel)) {
    return { show: false, reason: `alertLevel "${alert.alertLevel}" below threshold` };
  }
  if (!alert.polygon && !(alert.circle && alert.circle.km > 0)) {
    return { show: false, reason: 'no usable geometry' };
  }
  if (!pointInAlertArea(point, alert)) return { show: false, reason: 'outside area' };
  return { show: true, reason: 'in-area, at/above threshold' };
}

module.exports = {
  parseFeed,
  normaliseAlert,
  parsePolygon,
  parseCircle,
  pointInPolygon,
  pointInAlertArea,
  haversineKm,
  isExpired,
  shouldShow,
  DEFAULT_LEVELS,
};
