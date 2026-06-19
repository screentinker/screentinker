'use strict';

// TV-news-style live weather radar PiP overlay.
//
//   node radar.js [path/to/config.json]
//
// Two modes (config.mode):
//   "always"     - keep the radar overlay on screen permanently.
//   "on_warning" - (default) poll the NWS and only "cut to radar" when a qualifying
//                  warning (Tornado / Severe Thunderstorm / Flash Flood / Flood, by
//                  default) covers the configured point; clear it when none remain.
//
// The overlay page (radar-overlay.html) does the actual map drawing in the player's
// browser: CARTO basemap + animated RainViewer radar + live NWS warning polygons. This
// script just decides WHEN to show it and pushes/clears the PiP. Node 18+ (global fetch),
// needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

// ---- pure, offline-testable helpers -------------------------------------------------

const EVENT_COLORS = {
  'Tornado Warning': '#FF2D2D',
  'Severe Thunderstorm Warning': '#FFD12E',
  'Flash Flood Warning': '#25D0C0',
  'Flood Warning': '#46C766',
};
const DEFAULT_COLOR = '#FF8A1F';
function colorForEvent(event) { return EVENT_COLORS[event] || DEFAULT_COLOR; }

// Normalise a NWS GeoJSON FeatureCollection into the minimal shape we gate on.
function normaliseFeatureCollection(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  const feats = (obj && Array.isArray(obj.features)) ? obj.features : [];
  return feats.map((f) => {
    const p = (f && f.properties) || {};
    const g = (f && f.geometry) || null;
    return {
      identifier: p.id || (f && f.id) || null,
      event: p.event || null,
      severity: p.severity || 'Unknown',
      expires: p.expires || p.ends || null,
      headline: p.headline || p.event || '',
      hasGeometry: !!(g && (g.type === 'Polygon' || g.type === 'MultiPolygon')),
    };
  });
}

function isExpired(expires, now) {
  if (!expires) return false;
  const t = Date.parse(expires);
  return Number.isFinite(t) && t <= now;
}

// Show-worthy if it's one of the configured warning events, still active, and has a
// polygon we can actually draw on the map.
function qualifies(alert, opts = {}) {
  const events = opts.events || Object.keys(EVENT_COLORS);
  const now = opts.now || Date.now();
  if (!alert || !alert.event) return false;
  if (!events.includes(alert.event)) return false;
  if (!alert.hasGeometry) return false;
  if (isExpired(alert.expires, now)) return false;
  return true;
}

// Build the overlay iframe URL with the area/config encoded in the query string.
function buildOverlayUri(base, o = {}) {
  const q = new URLSearchParams();
  if (o.lat != null) q.set('lat', String(o.lat));
  if (o.lon != null) q.set('lon', String(o.lon));
  if (o.zoom != null) q.set('zoom', String(o.zoom));
  if (o.area) q.set('area', o.area);
  if (Array.isArray(o.states) && o.states.length) q.set('states', o.states.join(','));
  if (Array.isArray(o.events) && o.events.length) q.set('events', o.events.join(','));
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${q.toString()}`;
}

// RainViewer tile URL for one radar frame. size/color/smooth/snow per their public API.
function frameTileUrl(host, framePath, z, x, y, opt = {}) {
  const size = opt.size || 256, color = opt.color != null ? opt.color : 4;
  const smooth = opt.smooth != null ? opt.smooth : 1, snow = opt.snow != null ? opt.snow : 1;
  return `${host}${framePath}/${size}/${z}/${x}/${y}/${color}/${smooth}_${snow}.png`;
}

module.exports = {
  EVENT_COLORS, DEFAULT_COLOR, colorForEvent,
  normaliseFeatureCollection, isExpired, qualifies, buildOverlayUri, frameTileUrl,
};

// ---- live monitor (only when run directly) ------------------------------------------

if (require.main === module) {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

  const MODE = (cfg.mode || 'on_warning').toLowerCase();
  const POLL_SEC = cfg.poll_interval_sec || 60;
  const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
  const API_TOKEN = cfg.api_token;
  const OVERLAY_BASE = cfg.overlay_base_url;
  const DEVICE = cfg.device_id;
  const EVENTS = cfg.events || Object.keys(EVENT_COLORS);
  const UA = cfg.noaa_user_agent || 'ScreenTinker-Weather-Radar (set contact in config)';

  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE) {
    console.error('config must set api_base, api_token, overlay_base_url, and device_id.');
    process.exit(1);
  }

  const overlayUri = buildOverlayUri(OVERLAY_BASE, {
    lat: cfg.lat, lon: cfg.lon, zoom: cfg.zoom || 8, area: cfg.area_label, states: cfg.states, events: EVENTS,
  });

  let active = null; // { pip_id }

  async function pipShow() {
    const body = {
      device_id: DEVICE, type: 'web', uri: overlayUri,
      position: cfg.position || 'center',
      width: cfg.width || 1100, height: cfg.height || 720,
      duration: 0, border_radius: cfg.border_radius != null ? cfg.border_radius : 12,
      title: cfg.area_label ? `Live Radar — ${cfg.area_label}` : 'Live Radar',
    };
    const res = await fetch(`${API_BASE}/api/pip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.pip_id) throw new Error(`pip show failed (${res.status}): ${json.error || 'unknown'}`);
    return json.pip_id;
  }

  async function pipClear() {
    if (!active) return;
    const res = await fetch(`${API_BASE}/api/pip/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ device_id: DEVICE, pip_id: active.pip_id }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(`pip clear failed (${res.status}): ${json.error || 'unknown'}`);
    }
    active = null;
  }

  async function show(reason) {
    if (active) return;
    const pip_id = await pipShow();
    active = { pip_id };
    console.log(`[${new Date().toISOString()}] SHOW radar on ${DEVICE} pip=${pip_id} — ${reason}`);
  }
  async function clear(reason) {
    if (!active) return;
    const id = active.pip_id;
    await pipClear();
    console.log(`[${new Date().toISOString()}] CLEAR radar pip=${id} — ${reason}`);
  }

  async function fetchActive(now) {
    // Geofenced by NWS at the point; we still re-check qualifies() for event/expiry/geometry.
    const p = `${Number(cfg.lat).toFixed(4)},${Number(cfg.lon).toFixed(4)}`;
    const url = `https://api.weather.gov/alerts/active?point=${encodeURIComponent(p)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
    if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);
    const alerts = normaliseFeatureCollection(await res.text());
    return alerts.filter((a) => qualifies(a, { events: EVENTS, now }));
  }

  async function tick() {
    const now = Date.now();
    if (MODE === 'always') { await show('mode=always'); return; }
    let hits;
    try { hits = await fetchActive(now); }
    catch (e) { console.error(`[${new Date().toISOString()}] NWS fetch error: ${e.message}`); return; }
    if (hits.length) {
      const top = hits.slice().sort((a, b) => EVENTS.indexOf(a.event) - EVENTS.indexOf(b.event))[0];
      await show(`${hits.length} warning(s): ${top.event} — ${top.headline}`).catch((e) =>
        console.error(`show error: ${e.message}`));
    } else {
      await clear('no qualifying warnings').catch((e) => console.error(`clear error: ${e.message}`));
    }
  }

  async function main() {
    console.log(`Weather-radar PiP monitor — mode=${MODE}, poll ${POLL_SEC}s`);
    console.log(`  area: ${cfg.area_label || `${cfg.lat},${cfg.lon}`}  events: ${EVENTS.join(', ')}`);
    console.log(`  overlay: ${overlayUri}`);
    await tick();
    const timer = setInterval(tick, POLL_SEC * 1000);
    async function shutdown() {
      clearInterval(timer);
      try { await clear('shutting down'); } catch { /* best effort */ }
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  main();
}
