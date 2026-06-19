'use strict';

// Open-Meteo -> ScreenTinker PiP weather widget.
//
// Polls api.open-meteo.com (NO API KEY) for current conditions + today's high/low and
// pushes a small persistent web overlay to a screen (or group). Re-pushes on each poll;
// the player keeps a single overlay slot (last-show-wins), so the widget just updates in
// place. Pushed with duration 0 (stays until we clear it). On exit it clears itself.
//
//   node weather.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

// --- WMO weather code -> {emoji, text}. Day/night swaps the emoji for clear-ish codes. ---
const WMO = {
  0:  { text: 'Clear', day: '☀️', night: '🌑' },        // ☀️ / 🌑
  1:  { text: 'Mainly clear', day: '🌤️', night: '🌑' }, // 🌤️
  2:  { text: 'Partly cloudy', day: '⛅', night: '☁️' },      // ⛅ / ☁️
  3:  { text: 'Overcast', emoji: '☁️' },                          // ☁️
  45: { text: 'Fog', emoji: '🌫️' },                         // 🌫️
  48: { text: 'Rime fog', emoji: '🌫️' },
  51: { text: 'Light drizzle', emoji: '🌦️' },               // 🌦️
  53: { text: 'Drizzle', emoji: '🌦️' },
  55: { text: 'Heavy drizzle', emoji: '🌦️' },
  56: { text: 'Freezing drizzle', emoji: '🌧️' },            // 🌧️
  57: { text: 'Freezing drizzle', emoji: '🌧️' },
  61: { text: 'Light rain', emoji: '🌧️' },
  63: { text: 'Rain', emoji: '🌧️' },
  65: { text: 'Heavy rain', emoji: '🌧️' },
  66: { text: 'Freezing rain', emoji: '🌧️' },
  67: { text: 'Freezing rain', emoji: '🌧️' },
  71: { text: 'Light snow', emoji: '🌨️' },                  // 🌨️
  73: { text: 'Snow', emoji: '🌨️' },
  75: { text: 'Heavy snow', emoji: '🌨️' },
  77: { text: 'Snow grains', emoji: '🌨️' },
  80: { text: 'Rain showers', emoji: '🌦️' },
  81: { text: 'Rain showers', emoji: '🌦️' },
  82: { text: 'Violent showers', emoji: '🌧️' },
  85: { text: 'Snow showers', emoji: '🌨️' },
  86: { text: 'Snow showers', emoji: '🌨️' },
  95: { text: 'Thunderstorm', emoji: '⛈️' },                      // ⛈️
  96: { text: 'Thunderstorm, hail', emoji: '⛈️' },
  99: { text: 'Thunderstorm, hail', emoji: '⛈️' },
};

function wmoToCondition(code, isDay = true) {
  const e = WMO[code];
  if (!e) return { emoji: '🌡️', text: 'Unknown' };          // 🌡️
  const emoji = e.emoji || (isDay ? e.day : e.night);
  return { emoji, text: e.text };
}

// Unit labels derived from the config's `units`. metric -> °C / km/h, imperial -> °F / mph.
function unitsFor(cfg) {
  return (cfg.units || 'metric').toLowerCase() === 'imperial'
    ? { temp_unit: 'fahrenheit', wind_unit: 'mph', tempSym: '°F', windSym: 'mph' }
    : { temp_unit: 'celsius', wind_unit: 'kmh', tempSym: '°C', windSym: 'km/h' };
}

// Pure normaliser: Open-Meteo forecast JSON -> the overlay's display view.
function normalise(data, cfg = {}) {
  const u = unitsFor(cfg);
  const cur = (data && data.current) || {};
  const daily = (data && data.daily) || {};
  const isDay = cur.is_day == null ? true : Number(cur.is_day) === 1;
  const cond = wmoToCondition(Number(cur.weather_code), isDay);
  const round = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
  const hiArr = daily.temperature_2m_max || [];
  const loArr = daily.temperature_2m_min || [];
  return {
    location: cfg.location_name || 'Weather',
    tempNow: round(cur.temperature_2m),
    feelsLike: round(cur.apparent_temperature),
    hi: round(hiArr[0]),
    lo: round(loArr[0]),
    condition: cond.text,
    emoji: cond.emoji,
    humidity: round(cur.relative_humidity_2m),
    wind: round(cur.wind_speed_10m),
    isDay,
    tempUnit: u.tempSym,
    windUnit: u.windSym,
    updated: cur.time || '',
  };
}

function forecastUrl(cfg) {
  const u = unitsFor(cfg);
  const q = new URLSearchParams({
    latitude: String(cfg.lat),
    longitude: String(cfg.lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    temperature_unit: u.temp_unit,
    wind_speed_unit: u.wind_unit,
    forecast_days: '1',
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

function overlayUri(base, view) {
  const q = new URLSearchParams({
    location: view.location || '',
    temp: view.tempNow == null ? '' : String(view.tempNow),
    feels: view.feelsLike == null ? '' : String(view.feelsLike),
    hi: view.hi == null ? '' : String(view.hi),
    lo: view.lo == null ? '' : String(view.lo),
    cond: view.condition || '',
    emoji: view.emoji || '',
    humidity: view.humidity == null ? '' : String(view.humidity),
    wind: view.wind == null ? '' : String(view.wind),
    tempunit: view.tempUnit || '',
    windunit: view.windUnit || '',
    updated: view.updated || '',
    day: view.isDay ? '1' : '0',
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

module.exports = { WMO, wmoToCondition, unitsFor, normalise, forecastUrl, overlayUri };

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
  const POLL_SEC = cfg.poll_interval_sec || 600;
  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE || cfg.lat == null || cfg.lon == null) {
    console.error('config must set api_base, api_token, overlay_base_url, device_id, lat, lon.');
    process.exit(1);
  }

  let pipId = null;

  async function pipShow(view) {
    const body = {
      device_id: DEVICE, type: 'web', uri: overlayUri(OVERLAY_BASE, view),
      position: cfg.position || 'top-right',
      width: cfg.width || 360, height: cfg.height || 190,
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
      const res = await fetch(forecastUrl(cfg), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const view = normalise(await res.json(), cfg);
      pipId = await pipShow(view);
      console.log(`[${new Date().toISOString()}] ${view.location}: ${view.tempNow}${view.tempUnit} ${view.emoji} ${view.condition} (hi ${view.hi} / lo ${view.lo}) pip=${pipId}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] update error: ${e.message}`);
    }
  }

  async function main() {
    console.log(`Weather PiP widget — ${cfg.location_name || `${cfg.lat},${cfg.lon}`}, every ${POLL_SEC}s, ${cfg.position || 'top-right'}`);
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
