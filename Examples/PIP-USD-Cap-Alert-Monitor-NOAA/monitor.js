'use strict';

// CAP -> ScreenTinker PiP monitor. Supports two sources via config.source:
//   "capau" (default) - NSW RFS EDXL/CAP-AU feed, client-side polygon geofence, gate on AlertLevel.
//   "noaa"            - api.weather.gov, server-side ?point= geofence, gate on real CAP severity.
//
// For each configured screen it pushes a PiP web overlay when a qualifying alert covers
// that screen, and clears it when the alert expires, is cancelled, or drops out. Overlays
// also self-remove at the alert's `expires` time via the PiP `duration` field (the player
// auto-clears), so they vanish on expiry even between polls.
//
//   node monitor.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');
const cap = require('./cap-parse');
const noaa = require('./noaa-parse');

const configPath = process.argv[2] || path.join(__dirname, 'config.json');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

const SOURCE = (cfg.source || 'capau').toLowerCase();
const POLL_SEC = cfg.poll_interval_sec || 120;
const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
const API_TOKEN = cfg.api_token;
const OVERLAY_BASE = cfg.overlay_base_url;
const SCREENS = cfg.screens || [];
const OVERLAY = cfg.overlay || {};
const PIP_DUR_MAX = 86400;   // PiP API cap (seconds)

// capau-only:
const FEED_URL = cfg.feed_url || 'https://www.rfs.nsw.gov.au/feeds/majorIncidentsCAP.xml';
const ALERT_LEVELS = cfg.alert_levels || cap.DEFAULT_LEVELS;
const CAPAU_COLORS = Object.assign({ 'Emergency Warning': 'CC0000', 'Watch and Act': 'E8730C', 'Advice': 'F2C200' }, OVERLAY.colors || {});

if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || SCREENS.length === 0) {
  console.error('config must set api_base, api_token, overlay_base_url, and at least one screen.');
  process.exit(1);
}

// active overlays: key `${device_id}|${identifier}` -> { pip_id, expiresAt }
const active = new Map();
const keyFor = (deviceId, identifier) => `${deviceId}|${identifier}`;

// Map a normalised alert (either source) to the overlay's display fields.
function viewOf(alert) {
  if (alert.source === 'noaa') {
    return {
      level: alert.displayLevel, color: alert.color, headline: alert.headline,
      area: alert.areaDesc || '', status: alert.response || alert.urgency || '',
      updated: alert.sent || '', agency: alert.agency || 'US National Weather Service',
    };
  }
  return {
    level: alert.alertLevel || 'Alert',
    color: CAPAU_COLORS[alert.alertLevel] || 'CC0000',
    headline: alert.headline || '',
    area: alert.areaDesc || alert.council || '',
    status: alert.status || '',
    updated: alert.sent || '',
    agency: OVERLAY.agency || 'NSW Rural Fire Service',
  };
}

function overlayUri(alert) {
  const v = viewOf(alert);
  const q = new URLSearchParams({
    level: v.level || '', headline: v.headline || '', area: v.area || '',
    status: v.status || '', updated: v.updated || '',
    color: (v.color || 'CC0000').replace(/[^0-9a-fA-F]/g, ''), agency: v.agency || '',
  });
  return `${OVERLAY_BASE}${OVERLAY_BASE.includes('?') ? '&' : '?'}${q.toString()}`;
}

// Seconds until expiry, clamped to the PiP duration range. 0 => keep until we clear it.
function durationForExpiry(alert, now = Date.now()) {
  if (!alert.expires) return 0;
  const t = Date.parse(alert.expires);
  if (!Number.isFinite(t)) return 0;
  const secs = Math.floor((t - now) / 1000);
  if (secs <= 0) return 0;
  return Math.min(secs, PIP_DUR_MAX);
}

async function pipShow(deviceId, alert) {
  const body = {
    device_id: deviceId, type: 'web', uri: overlayUri(alert),
    position: OVERLAY.position || 'center',
    width: OVERLAY.width || 900, height: OVERLAY.height || 320,
    duration: durationForExpiry(alert),
    opacity: OVERLAY.opacity != null ? OVERLAY.opacity : 1,
    border_radius: OVERLAY.border_radius != null ? OVERLAY.border_radius : 16,
    close_button: false,
    title: viewOf(alert).level,
  };
  const res = await fetch(`${API_BASE}/api/pip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.pip_id) throw new Error(`pip show failed (${res.status}): ${json.error || 'unknown'}`);
  return { pipId: json.pip_id, duration: body.duration };
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

// Gate without geofence (for the test_feed_file override, where geometry/point isn't real).
function passesNonGeo(alert, now) {
  if (alert.msgType === 'Cancel') return false;
  if (SOURCE === 'noaa') {
    if (alert.status && alert.status !== 'Actual') return false;
    if (noaa.isExpired(alert, now)) return false;
    return (noaa.SEV_RANK[alert.severity] || 0) >= (noaa.SEV_RANK[cfg.min_severity || 'Severe'] || 0);
  }
  if (cap.isExpired(alert, now)) return false;
  return !!alert.alertLevel && ALERT_LEVELS.includes(alert.alertLevel);
}

async function collect(now) {
  const pairs = [];
  const polled = new Set();

  // Test/demo override: read alerts from a local file instead of the network, geofence
  // bypassed (every alert applies to every screen). Lets you watch the show->expire->remove
  // lifecycle on a deterministic timer. Remove `test_feed_file` from config for real use.
  if (cfg.test_feed_file) {
    let alerts = [];
    try {
      const raw = fs.readFileSync(cfg.test_feed_file, 'utf8');
      alerts = SOURCE === 'noaa' ? noaa.normaliseFeatureCollection(raw) : cap.parseFeed(raw);
    } catch (e) { console.error(`test_feed_file read error: ${e.message}`); return { pairs, polled }; }
    for (const screen of SCREENS) {
      polled.add(screen.device_id);
      for (const a of alerts) {
        if (a.identifier && passesNonGeo(a, now)) pairs.push({ screen, alert: a });
      }
    }
    return { pairs, polled };
  }

  if (SOURCE === 'noaa') {
    for (const screen of SCREENS) {
      let alerts;
      try { alerts = await noaa.fetchActiveForPoint(screen.lat, screen.lon, cfg.noaa_user_agent); }
      catch (e) { console.error(`[${new Date().toISOString()}] NWS fetch error for ${screen.name}: ${e.message}`); continue; }
      polled.add(screen.device_id);
      for (const a of alerts) {
        if (!a.identifier) continue;
        if (noaa.shouldShow(a, { minSeverity: cfg.min_severity, urgencies: cfg.urgencies, now }).show) {
          pairs.push({ screen, alert: a });
        }
      }
    }
  } else {
    let alerts;
    try {
      const res = await fetch(FEED_URL, { headers: { Accept: 'application/xml, text/xml' } });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      alerts = cap.parseFeed(await res.text());
    } catch (e) {
      console.error(`[${new Date().toISOString()}] feed fetch/parse error: ${e.message}`);
      return { pairs: [], polled };
    }
    for (const screen of SCREENS) {
      polled.add(screen.device_id);
      const point = { lat: screen.lat, lon: screen.lon };
      for (const a of alerts) {
        if (!a.identifier) continue;
        if (cap.shouldShow(a, { alertLevels: ALERT_LEVELS, now }).show) pairs.push({ screen, alert: a });
      }
    }
  }
  return { pairs, polled };
}

async function tick() {
  const now = Date.now();
  const { pairs, polled } = await collect(now);
  const stillQualifying = new Set();

  for (const { screen, alert } of pairs) {
    const key = keyFor(screen.device_id, alert.identifier);
    stillQualifying.add(key);
    if (active.has(key)) continue;
    try {
      const { pipId, duration } = await pipShow(screen.device_id, alert);
      active.set(key, { pip_id: pipId, expiresAt: Date.parse(alert.expires) || null });
      const v = viewOf(alert);
      console.log(`[${new Date().toISOString()}] SHOW "${alert.headline}" (${v.level}) on ${screen.name} pip=${pipId} dur=${duration || '∞'}s`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] show error on ${screen.name}: ${e.message}`);
    }
  }

  for (const [key, rec] of [...active.entries()]) {
    const [deviceId] = key.split('|');
    if (!polled.has(deviceId)) continue;
    if (stillQualifying.has(key)) continue;
    try {
      await pipClear(deviceId, rec.pip_id);
      active.delete(key);
      console.log(`[${new Date().toISOString()}] CLEAR pip=${rec.pip_id} on ${deviceId} (gone/expired/cancelled)`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] clear error: ${e.message}`);
    }
  }
}

async function main() {
  console.log(`CAP PiP monitor starting — source=${SOURCE}`);
  console.log(`  poll: every ${POLL_SEC}s`);
  if (SOURCE === 'noaa') console.log(`  min severity: ${cfg.min_severity || 'Severe'}${cfg.urgencies ? `, urgency in [${cfg.urgencies.join(',')}]` : ''}`);
  else console.log(`  feed: ${FEED_URL}\n  levels: ${ALERT_LEVELS.join(', ')}`);
  console.log(`  screens: ${SCREENS.map(s => `${s.name}(${s.lat},${s.lon})`).join(', ')}`);

  await tick();
  const timer = setInterval(tick, POLL_SEC * 1000);

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
