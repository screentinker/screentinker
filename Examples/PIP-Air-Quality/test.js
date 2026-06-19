'use strict';

// Offline test: US EPA AQI band boundaries + the Open-Meteo normaliser, against
// fixture-aqi.json. No network, no API token. Prints "RESULT: PASS ✅", exits 0 on success.

const fs = require('fs');
const a = require('./aqi');

const data = JSON.parse(fs.readFileSync('./fixture-aqi.json', 'utf8'));
const view = a.normalise(data, { location_name: 'Portland, OR' });

console.log('normalised view:');
console.log(view);

console.log('\n--- AQI band boundaries ---');
const bands = [
  [0, 'Good'], [50, 'Good'], [51, 'Moderate'], [100, 'Moderate'],
  [101, 'Unhealthy (Sensitive)'], [150, 'Unhealthy (Sensitive)'],
  [151, 'Unhealthy'], [200, 'Unhealthy'],
  [201, 'Very Unhealthy'], [300, 'Very Unhealthy'], [301, 'Hazardous'], [500, 'Hazardous'],
];
for (const [n, label] of bands) console.log(`${String(n).padStart(3)} -> ${a.aqiCategory(n).label}`);

const checks = {
  '0 -> Good': a.aqiCategory(0).label === 'Good',
  '50 -> Good (upper bound)': a.aqiCategory(50).label === 'Good',
  '51 -> Moderate': a.aqiCategory(51).label === 'Moderate',
  '100 -> Moderate (upper bound)': a.aqiCategory(100).label === 'Moderate',
  '101 -> Unhealthy (Sensitive)': a.aqiCategory(101).label === 'Unhealthy (Sensitive)',
  '150 -> Unhealthy (Sensitive) (upper bound)': a.aqiCategory(150).label === 'Unhealthy (Sensitive)',
  '200 -> Unhealthy (upper bound)': a.aqiCategory(200).label === 'Unhealthy',
  '201 -> Very Unhealthy': a.aqiCategory(201).label === 'Very Unhealthy',
  '301 -> Hazardous': a.aqiCategory(301).label === 'Hazardous',
  'Good color': a.aqiCategory(25).color === '#1f9d55',
  'Moderate color': a.aqiCategory(72).color === '#F2C200',
  'Hazardous color': a.aqiCategory(400).color === '#5B0000',
  'unknown AQI falls back': a.aqiCategory(undefined).label === 'Unknown',

  'usAqi from fixture': view.usAqi === 72,
  'category from fixture': view.category === 'Moderate',
  'color matches category': view.color === '#F2C200',
  'pm25 rounded': view.pm25 === 23,
  'pm10 rounded': view.pm10 === 31,
  'ozone rounded': view.ozone === 88,
  'no2 rounded': view.no2 === 12,
  'location passthrough': view.location === 'Portland, OR',
  'updated passthrough': view.updated === '2026-06-18T10:00',
};

console.log('\n--- assertions ---');
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) ok = false;
}

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
