'use strict';

// NOAA / US National Weather Service adapter for api.weather.gov.
//
// Unlike the RFS CAP-AU feed (EDXL-wrapped XML, geofence client-side, gate on a custom
// AlertLevel parameter because CAP severity is "Unknown"), NWS is:
//   - JSON (GeoJSON FeatureCollection), parsed directly.
//   - Geofenced BY THE API: /alerts/active?point=lat,lon returns only alerts covering
//     that point, so there's no polygon math here.
//   - Gated on the REAL CAP severity/urgency, which NWS actually populates.
//   - api.weather.gov REQUIRES a User-Agent header (403 without one).
//
// Exposes a pure normaliser/gate (offline-testable) and a thin live fetch.

// Severity ranking for threshold comparison.
const SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

// Default colours by severity (overridable via cfg.colors).
const SEV_COLORS = { Extreme: '7B0000', Severe: 'CC0000', Moderate: 'E8730C', Minor: 'F2C200', Unknown: '888888' };

// Normalise one GeoJSON feature's `properties` into the shared alert shape the monitor
// and overlay use (same field names the CAP-AU path produces, so the rest is source-agnostic).
function normaliseFeature(feature) {
  const p = (feature && feature.properties) || {};
  const severity = p.severity || 'Unknown';
  return {
    source: 'noaa',
    identifier: p.id || (feature && feature.id) || null,
    msgType: p.messageType || null,        // Alert | Update | Cancel
    status: p.status || null,              // Actual | Exercise | Test | ...
    sent: p.sent || null,
    expires: p.expires || p.ends || null,  // NWS populates expires reliably; ends as fallback
    headline: p.headline || p.event || '(no headline)',
    event: p.event || null,
    severity,
    urgency: p.urgency || null,            // Immediate | Expected | Future | Past | Unknown
    certainty: p.certainty || null,
    response: p.response || null,          // Shelter | Evacuate | Prepare | Avoid | Monitor | ...
    areaDesc: p.areaDesc || null,
    agency: p.senderName || 'US National Weather Service',
    web: (p.parameters && p.parameters.WMOidentifier) ? null : null, // NWS has no single web link field
    // for overlay display:
    displayLevel: p.event || severity,     // the event name reads better than the bare severity
    color: SEV_COLORS[severity] || SEV_COLORS.Unknown,
  };
}

function normaliseFeatureCollection(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  const feats = (obj && Array.isArray(obj.features)) ? obj.features : [];
  return feats.map(normaliseFeature);
}

function isExpired(alert, now = Date.now()) {
  if (!alert.expires) return false;
  const t = Date.parse(alert.expires);
  return Number.isFinite(t) && t <= now;
}

// The gate: NWS-style. Show if it's a live Alert/Update, not expired, status Actual, and
// at/above the severity threshold (default Severe+). Optionally also require an urgency in
// cfg.urgencies. Geofencing already happened at fetch time (?point=).
function shouldShow(alert, opts = {}) {
  const minSev = opts.minSeverity || 'Severe';
  const now = opts.now || Date.now();
  const urgencies = opts.urgencies || null;   // e.g. ["Immediate","Expected"] or null = any
  if (alert.msgType === 'Cancel') return { show: false, reason: 'cancelled' };
  if (alert.status && alert.status !== 'Actual') return { show: false, reason: `status ${alert.status}` };
  if (isExpired(alert, now)) return { show: false, reason: 'expired' };
  if ((SEV_RANK[alert.severity] || 0) < (SEV_RANK[minSev] || 0)) {
    return { show: false, reason: `severity ${alert.severity} below ${minSev}` };
  }
  if (urgencies && !urgencies.includes(alert.urgency)) {
    return { show: false, reason: `urgency ${alert.urgency} not in [${urgencies.join(',')}]` };
  }
  return { show: true, reason: `${alert.severity}, at/above ${minSev}` };
}

// Live fetch: alerts active at a point. NWS resolves the point to its zones server-side, so
// everything returned already covers the screen. Requires a User-Agent.
async function fetchActiveForPoint(lat, lon, userAgent) {
  // API caps coordinate precision at 4 decimals.
  const p = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  const url = `https://api.weather.gov/alerts/active?point=${encodeURIComponent(p)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent || 'ScreenTinker-CAP-Alert-Monitor (set contact in config)',
      Accept: 'application/geo+json',
    },
  });
  if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);
  return normaliseFeatureCollection(await res.text());
}

module.exports = {
  normaliseFeature,
  normaliseFeatureCollection,
  shouldShow,
  isExpired,
  fetchActiveForPoint,
  SEV_RANK,
  SEV_COLORS,
};
