'use strict';
const r = require('./radar');

let pass = true;
const checks = [];
function ok(name, cond) { checks.push([name, !!cond]); if (!cond) pass = false; }

// fixture: NWS-style FeatureCollection
const now = Date.parse('2026-06-18T22:00:00Z');
const fc = {
  type: 'FeatureCollection',
  features: [
    { id: 'A', properties: { id: 'A', event: 'Tornado Warning', severity: 'Extreme', expires: '2026-06-18T22:30:00Z', headline: 'TOR until 5:30' }, geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } },
    { id: 'B', properties: { id: 'B', event: 'Flood Warning', severity: 'Severe', expires: '2026-06-18T21:00:00Z', headline: 'expired' }, geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } },
    { id: 'C', properties: { id: 'C', event: 'Heat Advisory', severity: 'Moderate', expires: '2026-06-19T00:00:00Z', headline: 'not a warning' }, geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } },
    { id: 'D', properties: { id: 'D', event: 'Severe Thunderstorm Warning', severity: 'Severe', expires: '2026-06-18T22:45:00Z', headline: 'SVR' }, geometry: null },
  ],
};
const alerts = r.normaliseFeatureCollection(fc);
const byId = Object.fromEntries(alerts.map((a) => [a.identifier, a]));

ok('normalise parses 4', alerts.length === 4);
ok('normalise reads geometry flag', byId.A.hasGeometry === true && byId.D.hasGeometry === false);

const EV = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Flood Warning'];
ok('qualifies: active tornado w/ polygon', r.qualifies(byId.A, { events: EV, now }) === true);
ok('qualifies: expired excluded', r.qualifies(byId.B, { events: EV, now }) === false);
ok('qualifies: non-listed event excluded', r.qualifies(byId.C, { events: EV, now }) === false);
ok('qualifies: missing geometry excluded', r.qualifies(byId.D, { events: EV, now }) === false);

ok('color: tornado red', r.colorForEvent('Tornado Warning') === '#FF2D2D');
ok('color: svr yellow', r.colorForEvent('Severe Thunderstorm Warning') === '#FFD12E');
ok('color: unknown -> default', r.colorForEvent('Dust Storm Warning') === r.DEFAULT_COLOR);

const url = r.frameTileUrl('https://tilecache.rainviewer.com', '/v2/radar/abc', 5, 8, 12);
ok('rainviewer tile url', url === 'https://tilecache.rainviewer.com/v2/radar/abc/256/5/8/12/4/1_1.png');

const uri = r.buildOverlayUri('https://s/radar-overlay.html', {
  lat: 43.0389, lon: -87.9065, zoom: 8, area: 'Milwaukee County, WI', states: ['WI'], events: EV,
});
const back = new URLSearchParams(uri.split('?')[1]);
ok('overlay uri: lat/lon round-trip', back.get('lat') === '43.0389' && back.get('lon') === '-87.9065');
ok('overlay uri: area round-trip', back.get('area') === 'Milwaukee County, WI');
ok('overlay uri: states/events joined', back.get('states') === 'WI' && back.get('events') === EV.join(','));

console.log(`Weather-Radar checks (${checks.filter((c) => c[1]).length}/${checks.length}):`);
for (const [name, good] of checks) console.log(`  ${good ? '✓' : '✗'} ${name}`);
console.log('\nRESULT:', pass ? 'PASS ✅' : 'FAIL ❌');
process.exit(pass ? 0 : 1);
