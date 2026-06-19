'use strict';

// Offline test: WMO code mapping + the Open-Meteo normaliser, against fixture-weather.json.
// No network, no API token. Prints "RESULT: PASS ✅" and exits 0 on success.

const fs = require('fs');
const w = require('./weather');

const data = JSON.parse(fs.readFileSync('./fixture-weather.json', 'utf8'));
const view = w.normalise(data, { location_name: 'Portland, OR', units: 'imperial' });

console.log('normalised view:');
console.log(view);
console.log();

// WMO mapping spot-checks (clear day/night, rain, snow, thunder, unknown).
const m = [
  ['clear-day',  w.wmoToCondition(0, true),  'Clear', '☀️'],
  ['clear-night',w.wmoToCondition(0, false), 'Clear', '🌑'],
  ['rain',       w.wmoToCondition(61),       'Light rain', '🌧️'],
  ['snow',       w.wmoToCondition(71),       'Light snow', '🌨️'],
  ['thunder',    w.wmoToCondition(95),       'Thunderstorm', '⛈️'],
];
console.log('--- WMO mapping ---');
for (const [name, got, text, emoji] of m) console.log(`${name}: ${got.emoji} ${got.text}`);
const unknown = w.wmoToCondition(123456);

const checks = {
  'tempNow rounded from current': view.tempNow === 58,
  'feelsLike rounded': view.feelsLike === 56,
  'hi from daily.max[0]': view.hi === 68,
  'lo from daily.min[0]': view.lo === 51,
  'humidity': view.humidity === 81,
  'wind rounded': view.wind === 7,
  'condition from weather_code 61': view.condition === 'Light rain',
  'emoji from weather_code 61': view.emoji === '🌧️',
  'isDay true': view.isDay === true,
  'imperial unit label': view.tempUnit === '°F' && view.windUnit === 'mph',
  'location passthrough': view.location === 'Portland, OR',
  'map clear-day': m[0][1].text === 'Clear' && m[0][1].emoji === '☀️',
  'map clear-night emoji differs': m[1][1].emoji === '🌑',
  'map rain': m[2][1].text === 'Light rain' && m[2][1].emoji === '🌧️',
  'map snow': m[3][1].text === 'Light snow' && m[3][1].emoji === '🌨️',
  'map thunder': m[4][1].text === 'Thunderstorm' && m[4][1].emoji === '⛈️',
  'unknown code falls back': unknown.text === 'Unknown',
};

console.log('\n--- assertions ---');
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) ok = false;
}

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
