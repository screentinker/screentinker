'use strict';

// Open-Meteo Air Quality -> ScreenTinker PiP air-quality widget.
//
// Polls air-quality-api.open-meteo.com (NO API KEY) for the current US AQI plus the
// component pollutants, and pushes a small persistent web overlay to a screen (or group).
// Re-pushes on each poll; the player keeps a single overlay slot (last-show-wins), so the
// widget updates in place. Pushed with duration 0 (stays until cleared). Clears on exit.
//
//   node aqi.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

// US EPA AQI bands -> { label, color }. Boundaries are inclusive of the upper value
// (0-50 Good, 51-100 Moderate, ...). 301+ is Hazardous.
function aqiCategory(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return { label: 'Unknown', color: '#888888' };
  if (n <= 50)  return { label: 'Good', color: '#1f9d55' };
  if (n <= 100) return { label: 'Moderate', color: '#F2C200' };
  if (n <= 150) return { label: 'Unhealthy (Sensitive)', color: '#E8730C' };
  if (n <= 200) return { label: 'Unhealthy', color: '#CC0000' };
  if (n <= 300) return { label: 'Very Unhealthy', color: '#7B0000' };
  return { label: 'Hazardous', color: '#5B0000' };
}

// Pure normaliser: Open-Meteo air-quality JSON -> the overlay's display view.
function normalise(data, cfg = {}) {
  const cur = (data && data.current) || {};
  const round = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
  const usAqi = round(cur.us_aqi);
  const cat = aqiCategory(usAqi);
  return {
    location: cfg.location_name || 'Air Quality',
    usAqi,
    category: cat.label,
    color: cat.color,
    pm25: round(cur.pm2_5),
    pm10: round(cur.pm10),
    ozone: round(cur.ozone),
    no2: round(cur.nitrogen_dioxide),
    updated: cur.time || '',
  };
}

function aqiUrl(cfg) {
  const q = new URLSearchParams({
    latitude: String(cfg.lat),
    longitude: String(cfg.lon),
    current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide',
    timezone: 'auto',
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${q.toString()}`;
}

function overlayUri(base, view) {
  const q = new URLSearchParams({
    location: view.location || '',
    aqi: view.usAqi == null ? '' : String(view.usAqi),
    category: view.category || '',
    color: (view.color || '#888888').replace(/[^0-9a-fA-F]/g, ''),
    pm25: view.pm25 == null ? '' : String(view.pm25),
    pm10: view.pm10 == null ? '' : String(view.pm10),
    ozone: view.ozone == null ? '' : String(view.ozone),
    no2: view.no2 == null ? '' : String(view.no2),
    updated: view.updated || '',
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

module.exports = { aqiCategory, normalise, aqiUrl, overlayUri };

// ---- live runner (skipped when this file is require()'d by the test) ----
if (require.main === module) {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

  const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
  const API_TOKEN = cfg.api_token;
  const OVERLAY_BASE = cfg.overlay_base_url;
  const DEVICE = cfg.device_id;
  const POLL_SEC = cfg.poll_interval_sec || 900;
  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE || cfg.lat == null || cfg.lon == null) {
    console.error('config must set api_base, api_token, overlay_base_url, device_id, lat, lon.');
    process.exit(1);
  }

  let pipId = null;

  async function pipShow(view) {
    const body = {
      device_id: DEVICE, type: 'web', uri: overlayUri(OVERLAY_BASE, view),
      position: cfg.position || 'top-right',
      width: cfg.width || 360, height: cfg.height || 200,
      duration: 0, opacity: cfg.opacity != null ? cfg.opacity : 1,
      border_radius: cfg.border_radius != null ? cfg.border_radius : 16,
      close_button: false,
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
    if (!pipId) return;
    await fetch(`${API_BASE}/api/pip/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ device_id: DEVICE, pip_id: pipId }),
    }).catch(() => {});
  }

  async function tick() {
    try {
      const res = await fetch(aqiUrl(cfg), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const view = normalise(await res.json(), cfg);
      pipId = await pipShow(view);
      console.log(`[${new Date().toISOString()}] ${view.location}: AQI ${view.usAqi} (${view.category}) pm2.5=${view.pm25} pm10=${view.pm10} pip=${pipId}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] update error: ${e.message}`);
    }
  }

  async function main() {
    console.log(`Air-Quality PiP widget — ${cfg.location_name || `${cfg.lat},${cfg.lon}`}, every ${POLL_SEC}s, ${cfg.position || 'top-right'}`);
    await tick();
    const timer = setInterval(tick, POLL_SEC * 1000);
    async function shutdown() {
      clearInterval(timer);
      console.log('\nclearing overlay before exit...');
      await pipClear();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  main();
}
