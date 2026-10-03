'use strict';

/**
 * Built-in weather data source (type `weather`) backed by Open-Meteo. Keyless: Open-Meteo's
 * forecast and geocoding APIs need no account, so this works out of the box with plugins off.
 *
 * Output is a FLAT object so `{{ds:slug.key}}` can address every value. The key names are a
 * contract with the template catalog (research/TEMPLATES-BUILD-SPEC.md, "Weather data-source
 * keys"): location, temperature, apparent_temperature, humidity, wind_speed, condition, icon,
 * code, units, updated, and day{0..5}_{name,date,high,low,condition,icon,code,precip_prob}.
 * Do not rename or add keys without changing the spec first.
 *
 * Everything that comes back from upstream is treated as untrusted: every field is type-checked
 * before use and a malformed body becomes one clean Error ("... could not be parsed"), never a
 * TypeError from deep inside the mapping.
 *
 * Egress: only https://api.open-meteo.com and https://geocoding-api.open-meteo.com, through the
 * SSRF guard, with a timeout, a byte cap, and NO redirects (a redirect could otherwise carry the
 * request to a host outside the allowlist, which the guard would permit if it were public).
 */

const { guardedRequest, GuardedRequestError } = require('../ssrf-guard');
const { isAllowed } = require('../plugins/egress');

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_HOSTS = Object.freeze(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);

const FORECAST_DAYS = 6;
const MAX_DAILY_ENTRIES = 16; // Open-Meteo's own maximum forecast_days
const MAX_RESPONSE_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const MIN_INTERVAL_MIN = 10;
const DEFAULT_INTERVAL_MIN = 15;
const MAX_INTERVAL_MIN = 1440;

const GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEOCODE_CACHE_MAX = 256;

const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
// Same structural shape slide-render.js accepts for an IANA zone; 'auto' lets Open-Meteo pick the
// location's own zone (the common case for a sign showing its own city).
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENT_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_LOCATION_CHARS = 100;

// WMO weather interpretation codes (WW), as used by Open-Meteo's `weather_code`.
const WMO_CODES = Object.freeze({
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Depositing rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Moderate drizzle', '🌦️'],
  55: ['Dense drizzle', '🌧️'],
  56: ['Light freezing drizzle', '🌧️'],
  57: ['Dense freezing drizzle', '🌧️'],
  61: ['Slight rain', '🌦️'],
  63: ['Moderate rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Light freezing rain', '🌧️'],
  67: ['Heavy freezing rain', '🌧️'],
  71: ['Slight snowfall', '🌨️'],
  73: ['Moderate snowfall', '🌨️'],
  75: ['Heavy snowfall', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Slight rain showers', '🌦️'],
  81: ['Moderate rain showers', '🌧️'],
  82: ['Violent rain showers', '⛈️'],
  85: ['Slight snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with slight hail', '⛈️'],
  99: ['Thunderstorm with heavy hail', '⛈️'],
});
const UNKNOWN_CONDITION = ['Unknown', '🌡️'];

function describeWmo(code) {
  if (code === null || code === undefined) return ['', ''];
  return WMO_CODES[code] || UNKNOWN_CONDITION;
}

class WeatherParseError extends Error {
  constructor(detail) {
    super(`Upstream weather data could not be parsed: ${detail}`);
    this.name = 'WeatherParseError';
    this.code = 'weather-parse';
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate a weather config as a user would submit it. Returns an error string, or null when the
 * config is acceptable. Shared by the routes (400 on refusal) and the resolver (which refuses a
 * stored config that no longer validates rather than sending garbage upstream).
 */
function validateWeatherConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'Config must be an object';

  const hasLat = config.latitude !== undefined && config.latitude !== null && config.latitude !== '';
  const hasLon = config.longitude !== undefined && config.longitude !== null && config.longitude !== '';
  const hasLocation = config.location !== undefined && config.location !== null && config.location !== '';

  if (hasLocation) {
    if (typeof config.location !== 'string') return 'Location must be a string';
    const loc = config.location.trim();
    if (!loc) return 'Location must not be blank';
    if (loc.length > MAX_LOCATION_CHARS) return `Location must be at most ${MAX_LOCATION_CHARS} characters`;
    if (CONTROL_RE.test(loc)) return 'Location contains invalid characters';
  }

  if (hasLat || hasLon) {
    if (!hasLat || !hasLon) return 'Latitude and longitude must be given together';
    if (!isFiniteNumber(config.latitude) || config.latitude < -90 || config.latitude > 90) {
      return 'Latitude must be a number between -90 and 90';
    }
    if (!isFiniteNumber(config.longitude) || config.longitude < -180 || config.longitude > 180) {
      return 'Longitude must be a number between -180 and 180';
    }
  } else if (!hasLocation) {
    return 'A location or latitude/longitude is required';
  }

  if (config.units !== undefined && config.units !== null && config.units !== '') {
    if (config.units !== 'metric' && config.units !== 'imperial') return 'Units must be "metric" or "imperial"';
  }

  if (config.locale !== undefined && config.locale !== null && config.locale !== '') {
    if (typeof config.locale !== 'string' || !LOCALE_RE.test(config.locale)) return 'Invalid locale';
  }

  if (config.timezone !== undefined && config.timezone !== null && config.timezone !== '') {
    const tz = config.timezone;
    if (typeof tz !== 'string' || tz.length > 64 || (tz !== 'auto' && !TZ_RE.test(tz))) {
      return `Invalid timezone: "${String(tz).slice(0, 64)}"`;
    }
  }

  if (config.interval_min !== undefined && config.interval_min !== null && config.interval_min !== '') {
    const n = Number(config.interval_min);
    if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_MIN) {
      return `Sync interval must be a whole number of minutes between 1 and ${MAX_INTERVAL_MIN}`;
    }
  }

  return null;
}

/** The refresh interval actually used: default 15, never more often than every 10 minutes. */
function weatherIntervalMin(config) {
  const n = parseInt(config && config.interval_min, 10);
  return Math.max(MIN_INTERVAL_MIN, Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MIN);
}

function normalizeConfig(config) {
  const err = validateWeatherConfig(config);
  if (err) throw Object.assign(new Error(`Invalid weather configuration: ${err}`), { code: 'weather-config' });
  const hasCoords = isFiniteNumber(config.latitude) && isFiniteNumber(config.longitude);
  return {
    location: typeof config.location === 'string' ? config.location.trim() : '',
    latitude: hasCoords ? config.latitude : null,
    longitude: hasCoords ? config.longitude : null,
    units: config.units === 'imperial' ? 'imperial' : 'metric',
    locale: typeof config.locale === 'string' && config.locale ? config.locale : 'en',
    timezone: typeof config.timezone === 'string' && config.timezone ? config.timezone : 'auto',
  };
}

// ─── Egress ──────────────────────────────────────────────────────────────────

function assertWeatherHost(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) {
    throw new GuardedRequestError('weather fetch target is not a valid URL', 'egress-not-allowed');
  }
  if (parsed.protocol !== 'https:' || !isAllowed(url, WEATHER_HOSTS)) {
    throw new GuardedRequestError(`host "${parsed.hostname}" is not an allowed weather host`, 'egress-not-allowed');
  }
}

/**
 * The production fetch: host allowlist, then the SSRF guard with a deadline, a byte cap and no
 * redirects. Resolves to `{ text }` like guardedRequest's text mode.
 */
function weatherFetch(url) {
  try { assertWeatherHost(url); } catch (err) { return Promise.reject(err); }
  return guardedRequest(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'ScreenTinker-Weather/1.0' },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    responseType: 'text',
    accept2xx: true,
    maxRedirects: 0,
  });
}

async function fetchJson(fetchFn, url) {
  assertWeatherHost(url);
  const res = await fetchFn(url);
  const text = res && typeof res.text === 'string' ? res.text
    : (res && Buffer.isBuffer(res.buffer) ? res.buffer.toString('utf8') : null);
  if (text === null) throw new WeatherParseError('empty response');
  if (text.length > MAX_RESPONSE_BYTES) throw new WeatherParseError('response too large');
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new WeatherParseError('not JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WeatherParseError('not an object');
  if (body.error === true) throw new WeatherParseError('upstream reported an error');
  return body;
}

// ─── Geocoding (cached in memory) ────────────────────────────────────────────

const geocodeCache = new Map(); // key -> { value, expires }

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function geocode(fetchFn, name, locale, nowMs) {
  const lang = locale.split('-')[0].toLowerCase();
  const key = `${name.toLowerCase()}|${lang}`;
  const hit = geocodeCache.get(key);
  if (hit && hit.expires > nowMs) return hit.value;
  if (hit) geocodeCache.delete(key);

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=${encodeURIComponent(lang)}&format=json`;
  const body = await fetchJson(fetchFn, url);
  if (body.results === undefined) {
    throw Object.assign(new Error(`Location not found: "${name}"`), { code: 'weather-location' });
  }
  if (!Array.isArray(body.results) || body.results.length > 100) throw new WeatherParseError('geocoding results');
  if (body.results.length === 0) {
    throw Object.assign(new Error(`Location not found: "${name}"`), { code: 'weather-location' });
  }
  const r = body.results[0];
  if (!r || typeof r !== 'object'
    || !isFiniteNumber(r.latitude) || r.latitude < -90 || r.latitude > 90
    || !isFiniteNumber(r.longitude) || r.longitude < -180 || r.longitude > 180) {
    throw new WeatherParseError('geocoding coordinates');
  }
  const value = {
    latitude: r.latitude,
    longitude: r.longitude,
    name: cleanText(r.name, MAX_LOCATION_CHARS) || name,
  };

  if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    geocodeCache.delete(geocodeCache.keys().next().value); // oldest insertion
  }
  geocodeCache.set(key, { value, expires: nowMs + GEOCODE_TTL_MS });
  return value;
}

function clearGeocodeCache() {
  geocodeCache.clear();
}

// ─── Forecast parsing ────────────────────────────────────────────────────────

const SANE_ABS = 1000; // no real temperature/wind/humidity is anywhere near this

/** A required-ish number: null → '' (upstream gap), wrong type → parse error. */
function num(v, what, { allowNull = true } = {}) {
  if (v === null || v === undefined) {
    if (allowNull) return null;
    throw new WeatherParseError(`${what} missing`);
  }
  if (!isFiniteNumber(v) || Math.abs(v) > SANE_ABS) throw new WeatherParseError(`${what} is not a number`);
  return v;
}

function wmo(v, what) {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0 || v > 99) throw new WeatherParseError(`${what} is not a WMO code`);
  return v;
}

function roundOrBlank(v) {
  if (v === null) return '';
  const r = Math.round(v);
  return r === 0 ? 0 : r; // no "-0"
}

function dailyArray(daily, field) {
  const arr = daily[field];
  if (!Array.isArray(arr)) throw new WeatherParseError(`daily.${field} is not an array`);
  if (arr.length > MAX_DAILY_ENTRIES) throw new WeatherParseError(`daily.${field} is too long`);
  return arr;
}

function makeDayNamer(locale) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  } catch (_) {
    fmt = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
  }
  return (date) => {
    // Noon UTC on the calendar date: the weekday of a plain date, independent of server TZ.
    const d = new Date(`${date}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? '' : fmt.format(d);
  };
}

function formatUpdated(current, now) {
  const m = current && typeof current.time === 'string' ? current.time.match(CURRENT_TIME_RE) : null;
  if (m) return `${m[1]} ${m[2]}`;
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function buildOutput(body, { label, units, locale, now }) {
  const current = body.current;
  const daily = body.daily;
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new WeatherParseError('current block');
  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) throw new WeatherParseError('daily block');

  const code = wmo(current.weather_code, 'current.weather_code');
  const [condition, icon] = describeWmo(code);

  const out = {
    location: label,
    temperature: roundOrBlank(num(current.temperature_2m, 'current.temperature_2m')),
    apparent_temperature: roundOrBlank(num(current.apparent_temperature, 'current.apparent_temperature')),
    humidity: roundOrBlank(num(current.relative_humidity_2m, 'current.relative_humidity_2m')),
    wind_speed: roundOrBlank(num(current.wind_speed_10m, 'current.wind_speed_10m')),
    condition,
    icon,
    code: code === null ? '' : code,
    units: units === 'imperial' ? 'F' : 'C',
    updated: formatUpdated(current, now),
  };

  const times = dailyArray(daily, 'time');
  const codes = dailyArray(daily, 'weather_code');
  const highs = dailyArray(daily, 'temperature_2m_max');
  const lows = dailyArray(daily, 'temperature_2m_min');
  const precip = dailyArray(daily, 'precipitation_probability_max');
  const dayName = makeDayNamer(locale);

  for (let d = 0; d < FORECAST_DAYS; d++) {
    const date = times[d];
    if (d >= times.length || date === null || date === undefined) {
      Object.assign(out, {
        [`day${d}_name`]: '', [`day${d}_date`]: '', [`day${d}_high`]: '', [`day${d}_low`]: '',
        [`day${d}_condition`]: '', [`day${d}_icon`]: '', [`day${d}_code`]: '', [`day${d}_precip_prob`]: '',
      });
      continue;
    }
    if (typeof date !== 'string' || !DATE_RE.test(date)) throw new WeatherParseError(`daily.time[${d}] is not a date`);
    const dCode = wmo(codes[d], `daily.weather_code[${d}]`);
    const [dCond, dIcon] = describeWmo(dCode);
    const pp = num(precip[d], `daily.precipitation_probability_max[${d}]`);
    out[`day${d}_name`] = dayName(date);
    out[`day${d}_date`] = date;
    out[`day${d}_high`] = roundOrBlank(num(highs[d], `daily.temperature_2m_max[${d}]`));
    out[`day${d}_low`] = roundOrBlank(num(lows[d], `daily.temperature_2m_min[${d}]`));
    out[`day${d}_condition`] = dCond;
    out[`day${d}_icon`] = dIcon;
    out[`day${d}_code`] = dCode === null ? '' : dCode;
    out[`day${d}_precip_prob`] = pp === null ? '' : Math.max(0, Math.min(100, roundOrBlank(pp)));
  }

  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Resolve a weather data source to its flat key/value map.
 *
 * @param {object} config  { location? | latitude+longitude, units?, locale?, timezone?, interval_min? }
 * @param {object} [deps]  { fetch?: (url) => Promise<{text}>, now?: Date }
 */
async function resolveWeatherData(config, deps = {}) {
  const fetchFn = typeof deps.fetch === 'function' ? deps.fetch : weatherFetch;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const cfg = normalizeConfig(config);

  let lat = cfg.latitude;
  let lon = cfg.longitude;
  let label = cfg.location;
  if (lat === null || lon === null) {
    const place = await geocode(fetchFn, cfg.location, cfg.locale, now.getTime());
    lat = place.latitude;
    lon = place.longitude;
    label = place.name;
  } else if (!label) {
    label = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  }

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: String(FORECAST_DAYS),
    timezone: cfg.timezone,
  });
  if (cfg.units === 'imperial') {
    params.set('temperature_unit', 'fahrenheit');
    params.set('wind_speed_unit', 'mph');
  }

  const body = await fetchJson(fetchFn, `${FORECAST_URL}?${params.toString()}`);
  return buildOutput(body, { label, units: cfg.units, locale: cfg.locale, now });
}

module.exports = {
  resolveWeatherData,
  validateWeatherConfig,
  weatherIntervalMin,
  weatherFetch,
  describeWmo,
  clearGeocodeCache,
  WMO_CODES,
  WEATHER_HOSTS,
  FORECAST_DAYS,
};
