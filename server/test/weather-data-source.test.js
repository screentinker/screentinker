'use strict';

// Built-in `weather` data source (Open-Meteo). Every upstream call goes through an injected fake
// fetch: the tests never touch the network, and CI's sandbox would refuse it anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A private, empty database for the route / service tests below. Must be set before anything
// requires db/database.js (a module-level singleton).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-weather-ds-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const {
  resolveWeatherData,
  validateWeatherConfig,
  weatherIntervalMin,
  weatherFetch,
  describeWmo,
  clearGeocodeCache,
  WMO_CODES,
} = require('../lib/data-sources/weather-resolver');

const NOW = new Date('2026-09-29T12:00:00Z');

function forecastBody(overrides = {}) {
  return {
    latitude: 52.52,
    longitude: 13.41,
    timezone: 'Europe/Berlin',
    current: {
      time: '2026-09-29T14:15',
      temperature_2m: 17.6,
      apparent_temperature: 16.2,
      relative_humidity_2m: 71,
      wind_speed_10m: 12.4,
      weather_code: 3,
      ...(overrides.current || {}),
    },
    daily: {
      time: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
      weather_code: [3, 61, 0, 95, 71, 45],
      temperature_2m_max: [18.4, 15.5, 20.1, 16.9, 2.2, 11.0],
      temperature_2m_min: [9.6, 8.4, 7.5, 10.1, -3.6, 4.49],
      precipitation_probability_max: [10, 80, 0, 95, 60, 5],
      ...(overrides.daily || {}),
    },
  };
}

const GEOCODE_BODY = {
  results: [{ name: 'Berlin', latitude: 52.52437, longitude: 13.41053, country: 'Germany', timezone: 'Europe/Berlin' }],
};

/** A fake fetch that answers by host and records every URL it was asked for. */
function fakeFetch({ forecast = forecastBody(), geocode = GEOCODE_BODY, raw } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const host = new URL(url).hostname;
    if (raw !== undefined) return { text: raw };
    if (host === 'geocoding-api.open-meteo.com') return { text: JSON.stringify(geocode) };
    if (host === 'api.open-meteo.com') return { text: JSON.stringify(forecast) };
    throw new Error(`unexpected host ${host}`);
  };
  fn.calls = calls;
  return fn;
}

const CONTRACT_KEYS = [
  'location', 'temperature', 'apparent_temperature', 'humidity', 'wind_speed', 'condition', 'icon',
  'code', 'units', 'updated',
];
for (let d = 0; d < 6; d++) {
  for (const k of ['name', 'date', 'high', 'low', 'condition', 'icon', 'code', 'precip_prob']) {
    CONTRACT_KEYS.push(`day${d}_${k}`);
  }
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test('weather: happy path emits exactly the contract keys, rounded', async () => {
  clearGeocodeCache();
  const fetch = fakeFetch();
  const data = await resolveWeatherData({ location: 'Berlin' }, { fetch, now: NOW });

  assert.deepEqual(Object.keys(data).sort(), [...CONTRACT_KEYS].sort(), 'flat keys match the spec exactly');
  for (const [k, v] of Object.entries(data)) {
    assert.ok(typeof v === 'string' || typeof v === 'number', `${k} is a scalar`);
  }

  assert.equal(data.location, 'Berlin');
  assert.equal(data.temperature, 18);
  assert.equal(data.apparent_temperature, 16);
  assert.equal(data.humidity, 71);
  assert.equal(data.wind_speed, 12);
  assert.equal(data.code, 3);
  assert.equal(data.condition, 'Overcast');
  assert.equal(data.icon, '☁️');
  assert.equal(data.units, 'C');
  assert.equal(data.updated, '2026-09-29 14:15');

  assert.equal(data.day0_date, '2026-09-29');
  assert.equal(data.day0_name, 'Tue');
  assert.equal(data.day1_name, 'Wed');
  assert.equal(data.day1_high, 16);
  assert.equal(data.day1_low, 8);
  assert.equal(data.day1_condition, 'Slight rain');
  assert.equal(data.day1_code, 61);
  assert.equal(data.day1_precip_prob, 80);
  assert.equal(data.day3_condition, 'Thunderstorm');
  assert.equal(data.day4_low, -4);
  assert.equal(data.day5_low, 4);
  assert.equal(data.day5_icon, '🌫️');

  // Geocode, then forecast with the geocoded coordinates and the documented parameters.
  assert.equal(fetch.calls.length, 2);
  const g = new URL(fetch.calls[0]);
  assert.equal(g.hostname, 'geocoding-api.open-meteo.com');
  assert.equal(g.searchParams.get('name'), 'Berlin');
  const f = new URL(fetch.calls[1]);
  assert.equal(f.protocol, 'https:');
  assert.equal(f.hostname, 'api.open-meteo.com');
  assert.equal(f.searchParams.get('latitude'), '52.52437');
  assert.equal(f.searchParams.get('longitude'), '13.41053');
  assert.equal(f.searchParams.get('current'), 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code');
  assert.equal(f.searchParams.get('daily'), 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  assert.equal(f.searchParams.get('forecast_days'), '6');
  assert.equal(f.searchParams.get('timezone'), 'auto');
  assert.equal(f.searchParams.get('temperature_unit'), null, 'metric is Open-Meteo default');
});

test('weather: coordinates skip geocoding; location becomes the display label', async () => {
  const fetch = fakeFetch();
  const data = await resolveWeatherData({ latitude: 40.7128, longitude: -74.006, location: 'HQ Lobby' }, { fetch, now: NOW });
  assert.equal(fetch.calls.length, 1);
  assert.equal(new URL(fetch.calls[0]).hostname, 'api.open-meteo.com');
  assert.equal(data.location, 'HQ Lobby');

  const bare = await resolveWeatherData({ latitude: 40.7128, longitude: -74.006 }, { fetch: fakeFetch(), now: NOW });
  assert.equal(bare.location, '40.71, -74.01');
});

test('weather: imperial units request fahrenheit/mph and report F', async () => {
  const fetch = fakeFetch();
  const data = await resolveWeatherData({ latitude: 1, longitude: 2, units: 'imperial', timezone: 'America/Chicago' }, { fetch, now: NOW });
  const f = new URL(fetch.calls[0]);
  assert.equal(f.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(f.searchParams.get('wind_speed_unit'), 'mph');
  assert.equal(f.searchParams.get('timezone'), 'America/Chicago');
  assert.equal(data.units, 'F');
});

test('weather: day names follow the configured locale', async () => {
  const data = await resolveWeatherData({ latitude: 1, longitude: 2, locale: 'de' }, { fetch: fakeFetch(), now: NOW });
  assert.equal(data.day0_name, 'Di');
  assert.equal(data.day1_name, 'Mi');
});

test('weather: fewer than 6 days and null gaps render as blanks, not errors', async () => {
  const forecast = forecastBody({
    current: { apparent_temperature: null },
    daily: {
      time: ['2026-09-29', '2026-09-30'],
      weather_code: [0, null],
      temperature_2m_max: [20, 21],
      temperature_2m_min: [10, null],
      precipitation_probability_max: [null, 30],
    },
  });
  const data = await resolveWeatherData({ latitude: 1, longitude: 2 }, { fetch: fakeFetch({ forecast }), now: NOW });
  assert.equal(data.apparent_temperature, '');
  assert.equal(data.day0_precip_prob, '');
  assert.equal(data.day1_condition, '');
  assert.equal(data.day1_low, '');
  assert.equal(data.day2_date, '');
  assert.equal(data.day5_name, '');
  assert.deepEqual(Object.keys(data).sort(), [...CONTRACT_KEYS].sort());
});

// ─── WMO table ───────────────────────────────────────────────────────────────

test('weather: the full WMO table maps every documented code', () => {
  const documented = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
  assert.deepEqual(Object.keys(WMO_CODES).map(Number).sort((a, b) => a - b), documented);
  for (const c of documented) {
    const [text, icon] = describeWmo(c);
    assert.ok(text && text !== 'Unknown', `code ${c} has text`);
    assert.ok(icon, `code ${c} has an icon`);
  }
  assert.deepEqual(describeWmo(0), ['Clear sky', '☀️']);
  assert.deepEqual(describeWmo(45), ['Fog', '🌫️']);
  assert.deepEqual(describeWmo(99), ['Thunderstorm with heavy hail', '⛈️']);
  assert.equal(describeWmo(42)[0], 'Unknown', 'an undocumented but in-range code is Unknown, not blank');
});

// ─── Geocoding cache ─────────────────────────────────────────────────────────

test('weather: geocoding result is cached in memory (case-insensitive)', async () => {
  clearGeocodeCache();
  const fetch = fakeFetch();
  await resolveWeatherData({ location: 'Berlin' }, { fetch, now: NOW });
  await resolveWeatherData({ location: 'berlin' }, { fetch, now: NOW });
  await resolveWeatherData({ location: '  BERLIN ' }, { fetch, now: NOW });
  const geocodes = fetch.calls.filter((u) => new URL(u).hostname === 'geocoding-api.open-meteo.com');
  assert.equal(geocodes.length, 1, 'one geocode for three syncs');
  assert.equal(fetch.calls.length, 4);

  // A different language is a different lookup (the place name comes back localised).
  await resolveWeatherData({ location: 'Berlin', locale: 'fr' }, { fetch, now: NOW });
  assert.equal(fetch.calls.filter((u) => new URL(u).hostname === 'geocoding-api.open-meteo.com').length, 2);

  // The cache expires.
  const later = new Date(NOW.getTime() + 8 * 24 * 3600 * 1000);
  await resolveWeatherData({ location: 'Berlin' }, { fetch, now: later });
  assert.equal(fetch.calls.filter((u) => new URL(u).hostname === 'geocoding-api.open-meteo.com').length, 3);
});

test('weather: an unknown place is a clean "Location not found" and is not cached', async () => {
  clearGeocodeCache();
  const fetch = fakeFetch({ geocode: { generationtime_ms: 0.3 } });
  await assert.rejects(resolveWeatherData({ location: 'Nowhereville' }, { fetch, now: NOW }), /Location not found/);
  await assert.rejects(resolveWeatherData({ location: 'Nowhereville' }, { fetch, now: NOW }), /Location not found/);
  assert.equal(fetch.calls.length, 2, 'failure retried, not cached');

  const { describeSyncError } = require('../lib/data-sources/service');
  const err = await resolveWeatherData({ location: 'Nowhereville' }, { fetch, now: NOW }).catch((e) => e);
  assert.equal(describeSyncError(err), 'The location could not be found');
});

// ─── Hostile upstream ────────────────────────────────────────────────────────

async function assertParseError(fetch, config = { latitude: 1, longitude: 2 }) {
  clearGeocodeCache();
  const err = await resolveWeatherData(config, { fetch, now: NOW }).then(
    () => assert.fail('expected rejection'),
    (e) => e,
  );
  assert.ok(!(err instanceof TypeError), `must not be a TypeError: ${err && err.message}`);
  assert.match(err.message, /could not be parsed/, err.message);
  return err;
}

test('weather: hostile upstream bodies become clean parse errors', async () => {
  await assertParseError(fakeFetch({ raw: '<html>nope</html>' }));
  await assertParseError(fakeFetch({ raw: '' }));
  await assertParseError(fakeFetch({ raw: 'null' }));
  await assertParseError(fakeFetch({ raw: '[1,2,3]' }));
  await assertParseError(fakeFetch({ raw: '"a string"' }));
  await assertParseError(async () => ({}));
  await assertParseError(async () => null);
  await assertParseError(fakeFetch({ raw: JSON.stringify({ error: true, reason: 'bad' }) }));

  // Missing blocks / arrays
  await assertParseError(fakeFetch({ forecast: { daily: forecastBody().daily } }));
  await assertParseError(fakeFetch({ forecast: { current: forecastBody().current } }));
  await assertParseError(fakeFetch({ forecast: { current: [], daily: {} } }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { time: undefined } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { temperature_2m_max: 'hot' } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { weather_code: { 0: 1 } } }) }));

  // Strings / garbage where numbers are expected
  await assertParseError(fakeFetch({ forecast: forecastBody({ current: { temperature_2m: '17.6' } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ current: { wind_speed_10m: {} } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ current: { weather_code: 3.5 } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ current: { weather_code: 1000 } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ current: { temperature_2m: 1e308 } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { temperature_2m_min: ['x', 1, 2, 3, 4, 5] } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { time: [20260929, 1, 2, 3, 4, 5] } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { time: ['<script>', 'x', 'x', 'x', 'x', 'x'] } }) }));

  // Huge arrays / huge body
  const huge = Array.from({ length: 100000 }, () => 1);
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { weather_code: huge } }) }));
  await assertParseError(fakeFetch({ forecast: forecastBody({ daily: { time: Array(17).fill('2026-09-29') } }) }));
  await assertParseError(fakeFetch({ raw: `{"pad":"${'x'.repeat(200 * 1024)}"}` }));

  // Hostile geocoding answers
  await assertParseError(fakeFetch({ geocode: { results: 'Berlin' } }), { location: 'Berlin' });
  await assertParseError(fakeFetch({ geocode: { results: [{ name: 'X', latitude: '52', longitude: 13 }] } }), { location: 'Berlin' });
  await assertParseError(fakeFetch({ geocode: { results: [{ name: 'X', latitude: 952, longitude: 13 }] } }), { location: 'Berlin' });
  await assertParseError(fakeFetch({ geocode: { results: [null] } }), { location: 'Berlin' });
  await assertParseError(fakeFetch({ geocode: { results: huge } }), { location: 'Berlin' });
});

test('weather: a hostile geocoded name is stripped of control characters and bounded', async () => {
  clearGeocodeCache();
  const name = `Evil\u0000\u001b[31m${'A'.repeat(500)}`;
  const data = await resolveWeatherData({ location: 'Evil' }, {
    fetch: fakeFetch({ geocode: { results: [{ name, latitude: 1, longitude: 2 }] } }),
    now: NOW,
  });
  assert.doesNotMatch(data.location, /[\u0000-\u001f]/);
  assert.ok(data.location.length <= 100);
});

// ─── Config validation ───────────────────────────────────────────────────────

test('weather: config validation refuses bad input', () => {
  const ok = [
    { location: 'Berlin' },
    { latitude: 0, longitude: 0 },
    { latitude: -90, longitude: 180, units: 'imperial', locale: 'en-US', timezone: 'auto' },
    { location: 'Tokyo', locale: 'zh-Hant-TW', timezone: 'America/Argentina/Buenos_Aires', interval_min: 30 },
  ];
  for (const c of ok) assert.equal(validateWeatherConfig(c), null, JSON.stringify(c));

  const bad = [
    [{}, /location or latitude/],
    [{ location: '   ' }, /blank/],
    [{ location: 'x'.repeat(101) }, /at most/],
    [{ location: 42 }, /string/],
    [{ location: 'a\nb' }, /invalid characters/],
    [{ latitude: 91, longitude: 0 }, /Latitude/],
    [{ latitude: -90.01, longitude: 0 }, /Latitude/],
    [{ latitude: 0, longitude: 180.5 }, /Longitude/],
    [{ latitude: '52.5', longitude: 13 }, /Latitude/],
    [{ latitude: NaN, longitude: 13 }, /Latitude/],
    [{ latitude: 52 }, /together/],
    [{ location: 'Berlin', units: 'kelvin' }, /Units/],
    [{ location: 'Berlin', locale: 'english-please' }, /locale/],
    [{ location: 'Berlin', locale: 'en_US' }, /locale/],
    [{ location: 'Berlin', locale: '<script>' }, /locale/],
    [{ location: 'Berlin', timezone: '../../etc/passwd' }, /timezone/],
    [{ location: 'Berlin', timezone: 'Europe/Berlin&x=1' }, /timezone/],
    [{ location: 'Berlin', timezone: 'A'.repeat(65) }, /timezone/],
    [{ location: 'Berlin', interval_min: 'soon' }, /interval/],
    [{ location: 'Berlin', interval_min: 5000 }, /interval/],
    [null, /object/],
    [[], /object/],
  ];
  for (const [c, re] of bad) assert.match(validateWeatherConfig(c) || '', re, JSON.stringify(c));
});

test('weather: resolver refuses an invalid stored config before any fetch', async () => {
  const fetch = fakeFetch();
  await assert.rejects(resolveWeatherData({ latitude: 200, longitude: 0 }, { fetch, now: NOW }), /Invalid weather configuration/);
  assert.equal(fetch.calls.length, 0);
});

test('weather: refresh interval defaults to 15 and is floored at 10 minutes', () => {
  assert.equal(weatherIntervalMin({}), 15);
  assert.equal(weatherIntervalMin({ interval_min: 1 }), 10);
  assert.equal(weatherIntervalMin({ interval_min: 60 }), 60);
  const { syncIntervalMin } = require('../lib/data-sources/service');
  assert.equal(syncIntervalMin('weather', { interval_min: 1 }), 10);
  assert.equal(syncIntervalMin('ical', { interval_min: 1 }), 1, 'ical keeps its own floor');
});

// ─── Egress allowlist ────────────────────────────────────────────────────────

test('weather: the production fetch refuses every host but the two Open-Meteo APIs', async () => {
  for (const url of [
    'https://example.com/v1/forecast',
    'https://api.open-meteo.com.evil.example/v1/forecast',
    'https://evil-api.open-meteo.com/v1/forecast',
    'https://open-meteo.com/',
    'http://api.open-meteo.com/v1/forecast', // plain http refused too
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'not a url',
  ]) {
    await assert.rejects(weatherFetch(url), (e) => e.code === 'egress-not-allowed', url);
  }
});

test('weather: the resolver asserts the host even with an injected fetch', async () => {
  // The resolver only ever builds Open-Meteo URLs; this pins that every URL it hands to fetch is
  // on the allowlist, so a future refactor cannot route a user string into the request host.
  const fetch = fakeFetch();
  await resolveWeatherData({ location: 'evil.example/', locale: 'en' }, { fetch, now: NOW });
  for (const u of fetch.calls) {
    assert.ok(['api.open-meteo.com', 'geocoding-api.open-meteo.com'].includes(new URL(u).hostname), u);
  }
});

// ─── Plugin shadowing ────────────────────────────────────────────────────────

test('weather: a plugin cannot register the reserved `weather` data-source type', () => {
  const registry = require('../lib/plugins/registry');
  const { RESERVED_DATA_SOURCE_TYPES } = require('../lib/plugins/reserved');
  registry.reset();
  assert.equal(RESERVED_DATA_SOURCE_TYPES.has('weather'), true);
  assert.throws(() => registry.registerDataSource('x', { type: 'weather', resolve: async () => ({}) }), /reserved/);
  assert.equal(registry.isAcceptedDataSourceType('weather'), true, 'built-in weather accepted');
});

// ─── Routes + service ────────────────────────────────────────────────────────

test('weather: routes validate weather configs (and do not apply the iCal IANA check)', async () => {
  const express = require('express');
  const dataSourcesRouter = require('../routes/data-sources');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'u1', role: 'admin' };
    req.isPlatformAdmin = true;
    req.workspaceRole = 'workspace_admin';
    req.workspaceId = 'ws-weather-1';
    next();
  });
  app.use('/api/data-sources', dataSourcesRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/data-sources`;
  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    let r = await post('/test', { type: 'weather', config: { latitude: 100, longitude: 0 } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Latitude/);

    r = await post('/test', { type: 'weather', config: { location: 'Berlin', units: 'kelvin' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Units/);

    r = await post('/test', { type: 'weather', config: {} });
    assert.equal(r.status, 400);

    r = await post('/', { name: 'Wx', type: 'weather', config: { location: 'Berlin', locale: 'not a locale' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /locale/);

    r = await post('/', { name: 'Wx', type: 'weather', config: { location: 'Berlin', timezone: 'Nope/../x' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /timezone/);

    r = await post('/test', { type: 'weathr', config: { location: 'Berlin' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Unsupported/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('weather: syncDataSource dispatches `weather` and records a sanitized error for a bad stored config', async () => {
  const { db } = require('../db/database');
  const { syncDataSource } = require('../lib/data-sources/service');
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES ('u-wx', 'u-wx@t.local', 'x', 'free')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-wx', 'Org', 'u-wx')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-weather-1', 'org-wx', 'WS')").run();
  db.prepare(`
    INSERT INTO data_sources (id, workspace_id, slug, name, type, config, last_fetched_at, last_status, created_at, updated_at)
    VALUES ('ds_wx_bad', 'ws-weather-1', 'wx_bad', 'Bad Wx', 'weather', ?, 0, 'pending', ?, ?)
  `).run(JSON.stringify({ latitude: 999, longitude: 0 }), now, now);

  const out = await syncDataSource('ds_wx_bad', false);
  assert.equal(out.last_status, 'error');
  assert.equal(out.last_error, 'The weather configuration is invalid');
  assert.doesNotMatch(out.last_error, /Unsupported/, 'weather is dispatched to its resolver, not the plugin path');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});
