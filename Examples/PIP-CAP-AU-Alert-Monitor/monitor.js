'use strict';

// CAP-AU -> ScreenTinker PiP monitor.
//
// Polls a CAP-AU feed (default: the NSW RFS majorIncidentsCAP feed), and for each
// configured screen, pushes a PiP web overlay when a qualifying alert covers that
// screen's location — then clears it when the alert expires, is cancelled, or drops
// out of the feed. It talks to the EXISTING ScreenTinker PiP API (POST /api/pip and
// POST /api/pip/clear); it adds no server code.
//
//   node monitor.js [path/to/config.json]
//
// Requires Node 18+ (uses global fetch). The config needs an st_ API token with the
// 'full' scope (PiP is fleet-affecting and full-trust, so the route demands it).

const fs = require('fs');
const path = require('path');
const cap = require('./cap-parse');

const configPath = process.argv[2] || path.join(__dirname, 'config.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`Could not read config at ${configPath}: ${e.message}`);
  console.error('Copy config.example.json to config.json and fill it in.');
  process.exit(1);
}

const FEED_URL = cfg.feed_url || 'https://www.rfs.nsw.gov.au/feeds/majorIncidentsCAP.xml';
const POLL_SEC = cfg.poll_interval_sec || 120;       // RFS refreshes ~every 30 min; 2 min poll is plenty
const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
const API_TOKEN = cfg.api_token;
const OVERLAY_BASE = cfg.overlay_base_url;            // where alert-overlay.html is hosted, reachable BY THE PLAYER
const SCREENS = cfg.screens || [];                   // [{ name, lat, lon, device_id }]
const ALERT_LEVELS = cfg.alert_levels || cap.DEFAULT_LEVELS;
const OVERLAY = cfg.overlay || {};

if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || SCREENS.length === 0) {
  console.error('config must set api_base, api_token, overlay_base_url, and at least one screen.');
  process.exit(1);
}

// active overlays: key `${device_id}|${identifier}` -> { pip_id, expiresAt }
const active = new Map();
const keyFor = (deviceId, identifier) => `${deviceId}|${identifier}`;

// Colour the overlay by alert level (overridable in config.overlay.colors).
const LEVEL_COLORS = Object.assign(
  { 'Emergency Warning': 'CC0000', 'Watch and Act': 'E8730C', 'Advice': 'F2C200' },
  OVERLAY.colors || {},
);

function overlayUri(alert) {
  const color = LEVEL_COLORS[alert.alertLevel] || 'CC0000';
  const q = new URLSearchParams({
    level: alert.alertLevel || '',
    headline: alert.headline || '',
    area: alert.areaDesc || alert.council || '',
    status: alert.status || '',
    updated: alert.sent || '',
    color: color,
    more: alert.web || '',
  });
  return `${OVERLAY_BASE}${OVERLAY_BASE.includes('?') ? '&' : '?'}${q.toString()}`;
}

async function pipShow(deviceId, alert) {
  const body = {
    device_id: deviceId,
    type: 'web',
    uri: overlayUri(alert),
    position: OVERLAY.position || 'center',
    width: OVERLAY.width || 900,
    height: OVERLAY.height || 320,
    duration: 0,                                   // 0 = until we explicitly clear it
    opacity: OVERLAY.opacity != null ? OVERLAY.opacity : 1,
    border_radius: OVERLAY.border_radius != null ? OVERLAY.border_radius : 16,
    close_button: false,
    title: alert.alertLevel || 'Alert',
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

async function pipClear(deviceId, pipId) {
  const res = await fetch(`${API_BASE}/api/pip/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ device_id: deviceId, pip_id: pipId }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`pip clear failed (${res.status}): ${json.error || 'unknown'}`);
  }
}

async function tick() {
  let alerts;
  try {
    const res = await fetch(FEED_URL, { headers: { Accept: 'application/xml, text/xml' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    alerts = cap.parseFeed(await res.text());
  } catch (e) {
    console.error(`[${new Date().toISOString()}] feed fetch/parse error: ${e.message}`);
    return;                                        // keep the last state; try again next tick
  }

  const now = Date.now();
  const stillQualifying = new Set();               // keys that should remain shown this tick

  for (const screen of SCREENS) {
    const point = { lat: screen.lat, lon: screen.lon };
    for (const alert of alerts) {
      if (!alert.identifier) continue;
      const decision = cap.shouldShow(alert, point, { alertLevels: ALERT_LEVELS, now });
      const key = keyFor(screen.device_id, alert.identifier);
      if (!decision.show) continue;
      stillQualifying.add(key);
      if (active.has(key)) continue;               // already on screen
      try {
        const pipId = await pipShow(screen.device_id, alert);
        active.set(key, { pip_id: pipId, expiresAt: Date.parse(alert.expires) || null });
        console.log(`[${new Date().toISOString()}] SHOW "${alert.headline}" (${alert.alertLevel}) on ${screen.name} [${screen.device_id}] pip=${pipId}`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] show error on ${screen.name}: ${e.message}`);
      }
    }
  }

  // Clear anything active that no longer qualifies (gone from feed, cancelled, expired,
  // dropped below threshold, or moved out of area).
  for (const [key, rec] of [...active.entries()]) {
    if (stillQualifying.has(key)) continue;
    const [deviceId] = key.split('|');
    try {
      await pipClear(deviceId, rec.pip_id);
      active.delete(key);
      console.log(`[${new Date().toISOString()}] CLEAR pip=${rec.pip_id} on ${deviceId} (no longer qualifying)`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] clear error: ${e.message}`);
    }
  }
}

async function main() {
  console.log(`CAP-AU PiP monitor starting`);
  console.log(`  feed:    ${FEED_URL}`);
  console.log(`  poll:    every ${POLL_SEC}s`);
  console.log(`  levels:  ${ALERT_LEVELS.join(', ')}`);
  console.log(`  screens: ${SCREENS.map(s => `${s.name}(${s.lat},${s.lon})`).join(', ')}`);
  await tick();
  const timer = setInterval(tick, POLL_SEC * 1000);

  // On shutdown, clear everything we put up so screens don't keep a stale alert.
  async function shutdown() {
    clearInterval(timer);
    console.log('\nclearing active overlays before exit...');
    for (const [key, rec] of active.entries()) {
      const [deviceId] = key.split('|');
      try { await pipClear(deviceId, rec.pip_id); } catch { /* best effort */ }
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
