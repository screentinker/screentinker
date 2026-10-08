'use strict';

/*
 * Conditions about WHERE a screen is: the weather at its location, and whether it is inside an
 * area. Item play_when types 'weather' and 'geo' (routes/playlists.js parsePlayWhen).
 *
 *   { type:'weather', field:'condition', op:'eq'|'neq', value:'rain' }
 *   { type:'weather', field:'temperature', op:'gt'|'gte'|'lt'|'lte', value:20, units:'c'|'f' }
 *   { type:'geo', op:'within'|'outside', lat, lon, radius_km }
 *
 * ⚠️ EVALUATED ON THE SERVER, when a screen's payload is built (ws/deviceSocket.js), and an item
 * that fails is left out of the payload. The players evaluate play_when themselves for the older
 * types, but changing four player codebases (web, Tizen, Android, Pi/Windows) for this would be a
 * release of each; old players treat an unknown type as "play" anyway. So these conditions are
 * resolved here and stripped from the item before it is sent. The cost: when the weather changes,
 * the screen gets a new payload, which restarts its playlist (the player fingerprint is
 * structural). It happens only when a cell's condition group or whole-degree temperature changes,
 * at most once per refresh.
 *
 * MISSING DATA: weather fails OPEN (no location or no reading -> the item plays, like every other
 * condition), geo fails CLOSED (a regional item never plays on a screen nobody has placed).
 *
 * Weather is cached per ~11 km cell (0.1 degree) and refreshed every 15 minutes by a sweep, from
 * Open-Meteo through the weather source's own allowlisted, SSRF-guarded fetch. A payload build
 * never waits on the network: it reads the cache.
 */

const REFRESH_MS = 15 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const GROUPS = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];

let cache = new Map();          // cell -> { at, data: { group, temperature_c, code, is_day } }
let fetchOverride = null;       // tests

/** WMO weather code -> one of GROUPS. */
function groupOf(code) {
  const c = Number(code);
  if (c === 0 || c === 1) return 'clear';
  if (c === 2 || c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95 && c <= 99) return 'storm';
  return null;
}

const cellOf = (lat, lon) => `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`;
const validLatLon = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** For parsePlayWhen: a normalised condition, or false when invalid. Only 'weather' and 'geo'. */
function normalise(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type === 'weather') {
    if (obj.field === 'condition') {
      const v = String(obj.value || '').toLowerCase();
      if (!GROUPS.includes(v)) return false;
      return { type: 'weather', field: 'condition', op: obj.op === 'neq' ? 'neq' : 'eq', value: v };
    }
    if (obj.field === 'temperature') {
      const v = Number(obj.value);
      if (!Number.isFinite(v) || v < -80 || v > 150) return false;
      if (!['gt', 'gte', 'lt', 'lte'].includes(obj.op)) return false;
      return { type: 'weather', field: 'temperature', op: obj.op, value: v, units: obj.units === 'f' ? 'f' : 'c' };
    }
    return false;
  }
  if (obj.type === 'geo') {
    const lat = Number(obj.lat), lon = Number(obj.lon), r = Number(obj.radius_km);
    if (!validLatLon(lat, lon) || !Number.isFinite(r) || r <= 0 || r > 20000) return false;
    return { type: 'geo', op: obj.op === 'outside' ? 'outside' : 'within', lat, lon, radius_km: r, label: String(obj.label || '').slice(0, 120) };
  }
  return false;
}

const isLocal = (w) => !!w && (w.type === 'weather' || w.type === 'geo');

/** Does this screen pass the condition? `device`: { latitude, longitude }. */
function passes(when, device) {
  const lat = device ? Number(device.latitude) : NaN, lon = device ? Number(device.longitude) : NaN;
  const placed = device && device.latitude != null && device.longitude != null && validLatLon(lat, lon);
  if (when.type === 'geo') {
    if (!placed) return false;                                   // fails CLOSED
    const inside = haversineKm(lat, lon, when.lat, when.lon) <= when.radius_km;
    return when.op === 'outside' ? !inside : inside;
  }
  if (when.type === 'weather') {
    if (!placed) return true;                                    // fails OPEN
    const hit = cache.get(cellOf(lat, lon));
    if (!hit || !hit.data) return true;
    const w = hit.data;
    if (when.field === 'condition') {
      if (!w.group) return true;
      return when.op === 'neq' ? w.group !== when.value : w.group === when.value;
    }
    if (!Number.isFinite(w.temperature_c)) return true;
    const t = when.units === 'f' ? w.temperature_c * 9 / 5 + 32 : w.temperature_c;
    if (when.op === 'gt') return t > when.value;
    if (when.op === 'gte') return t >= when.value;
    if (when.op === 'lt') return t < when.value;
    return t <= when.value;
  }
  return true;
}

/**
 * Leave out the items whose local condition fails for this screen, and strip local conditions
 * from the rest (players do not know these types). Items without one are untouched.
 */
function filterItems(items, device) {
  if (!Array.isArray(items) || !items.some((it) => it && isLocal(it.play_when))) return items;
  const out = [];
  for (const it of items) {
    if (!it || !isLocal(it.play_when)) { out.push(it); continue; }
    if (!passes(it.play_when, device)) continue;
    const { play_when, ...rest } = it;   // eslint-disable-line no-unused-vars
    out.push(rest);
  }
  return out;
}

/* ============================== weather cache ============================== */

async function fetchCurrent(lat, lon) {
  if (fetchOverride) return fetchOverride(lat, lon);
  const { weatherFetch } = require('./data-sources/weather-resolver');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,weather_code,is_day&timezone=auto`;
  const res = await weatherFetch(url);
  const body = JSON.parse(res.text || '{}');
  const c = body && body.current;
  if (!c || typeof c !== 'object') throw new Error('no current weather');
  const code = Number(c.weather_code);
  return { group: groupOf(code), temperature_c: Number(c.temperature_2m), code: Number.isFinite(code) ? code : null, is_day: c.is_day === 1 };
}

/** The cached reading for a screen, for the dashboard. */
function readingFor(device) {
  const lat = Number(device && device.latitude), lon = Number(device && device.longitude);
  if (!device || device.latitude == null || !validLatLon(lat, lon)) return null;
  const hit = cache.get(cellOf(lat, lon));
  return hit ? { ...hit.data, at: hit.at } : null;
}

/**
 * Refresh stale cells for placed screens in workspaces that use a weather condition, and push the
 * screens whose cell's reading changed in a way a condition can see (group, or whole degrees).
 */
async function sweep(db, io, now = Date.now()) {
  let devices;
  try {
    devices = db.prepare(`SELECT d.id, d.latitude, d.longitude FROM devices d
      WHERE d.latitude IS NOT NULL AND d.longitude IS NOT NULL AND d.workspace_id IN (
        SELECT p.workspace_id FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
        WHERE i.play_when LIKE '%"type":"weather"%' OR p.published_snapshot LIKE '%"type":"weather"%')`).all();
  } catch { return { refreshed: 0, pushed: 0 }; }
  const byCell = new Map();
  for (const d of devices) {
    const lat = Number(d.latitude), lon = Number(d.longitude);
    if (!validLatLon(lat, lon)) continue;
    const k = cellOf(lat, lon);
    if (!byCell.has(k)) byCell.set(k, { lat, lon, ids: [] });
    byCell.get(k).ids.push(d.id);
  }
  let refreshed = 0;
  const changed = [];
  for (const [k, c] of byCell) {
    const hit = cache.get(k);
    if (hit && now - hit.at < REFRESH_MS) continue;
    try {
      const data = await fetchCurrent(c.lat, c.lon);
      refreshed++;
      const sig = (x) => (x ? `${x.group}|${Math.round(x.temperature_c)}` : '');
      if (sig(hit && hit.data) !== sig(data)) changed.push(...c.ids);
      cache.set(k, { at: now, data });
      save(db, k, cache.get(k));
    } catch (e) {
      // A failed refresh keeps the last reading (stale weather beats none) and tries next sweep.
      if (hit) cache.set(k, { ...hit, at: now - REFRESH_MS + SWEEP_MS });
    }
  }
  if (io && changed.length) {
    try {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('./command-queue');
      for (const id of changed) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
    } catch (_) { /* best effort */ }
  }
  return { refreshed, pushed: changed.length };
}

/*
 * Readings are kept in the database too: after a restart the cache would otherwise start empty,
 * every weather condition would fail open until the first sweep, and that sweep would then push
 * (and so restart the playlist of) every placed screen for a change that never happened.
 */
function save(db, cell, entry) {
  try { db.prepare('INSERT INTO weather_cells (cell, data, at) VALUES (?, ?, ?) ON CONFLICT(cell) DO UPDATE SET data = excluded.data, at = excluded.at').run(cell, JSON.stringify(entry.data), entry.at); } catch (_) { /* cache only */ }
}
function load(db, now = Date.now()) {
  try {
    for (const r of db.prepare('SELECT cell, data, at FROM weather_cells WHERE at > ?').all(now - 24 * 3600 * 1000)) {
      try { cache.set(r.cell, { at: r.at, data: JSON.parse(r.data) }); } catch (_) { /* skip a bad row */ }
    }
  } catch (_) { /* table absent */ }
}

let timer = null;
function start(io) {
  if (timer) return;
  const db = require('../db/database').db;
  load(db);
  const run = () => sweep(db, io).catch((e) => console.warn(`[local-weather] sweep failed: ${e && e.message}`));
  setTimeout(run, 20 * 1000).unref?.();
  timer = setInterval(run, SWEEP_MS);
  if (timer.unref) timer.unref();
}

/** Place search for the dashboard (Open-Meteo geocoding through the same allowlisted fetch). */
async function searchPlaces(q, lang = 'en') {
  const name = String(q || '').trim().slice(0, 100);
  if (name.length < 2) return [];
  const { weatherFetch } = require('./data-sources/weather-resolver');
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=${encodeURIComponent(String(lang).slice(0, 5))}&format=json`;
  const res = await weatherFetch(url);
  let body; try { body = JSON.parse(res.text || '{}'); } catch { return []; }
  const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80);
  return (Array.isArray(body.results) ? body.results : []).slice(0, 6)
    .filter((r) => r && validLatLon(Number(r.latitude), Number(r.longitude)))
    .map((r) => ({ name: clean(r.name), region: clean(r.admin1), country: clean(r.country), latitude: Number(r.latitude), longitude: Number(r.longitude) }));
}

function _setFetch(fn) { fetchOverride = fn || null; }
function _reset() { cache = new Map(); }
function _load(db, now) { load(db, now); }

module.exports = {
  GROUPS, groupOf, cellOf, haversineKm, normalise, isLocal, passes, filterItems,
  readingFor, sweep, start, searchPlaces, _setFetch, _reset, _load,
};
