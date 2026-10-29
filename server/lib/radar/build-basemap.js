'use strict';
/*
 * Builds lib/radar/basemap.json, the radar widget's map, from Natural Earth (public domain,
 * naturalearthdata.com: "use the maps in any manner ... personal, educational, and commercial").
 *
 * Why a bundled map and not map tiles: every keyless basemap tile service is either gone (CARTO's
 * basemaps answer "API KEY REQUIRED" since 2026) or forbids fleet use (OpenStreetMap's own servers).
 * State/country lines, coastlines, lakes and cities are what a weather radar needs, and as data they
 * work offline and need no account.
 *
 *   node lib/radar/build-basemap.js <dir with the Natural Earth .geojson files>
 *
 * Inputs (github.com/nvkelso/natural-earth-vector/tree/master/geojson):
 *   ne_50m_admin_1_states_provinces_lines, ne_50m_admin_0_boundary_lines_land, ne_50m_coastline,
 *   ne_50m_lakes, ne_10m_populated_places_simple
 *
 * Output: { states, countries, coast: [line...], lakes: [ring...], cities: [[name, lat, lon, rank]] }
 * with coordinates as [lon, lat] rounded to 0.01 degree (about 1 km, finer than a 50m line).
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('usage: node lib/radar/build-basemap.js <natural-earth-geojson-dir>'); process.exit(2); }
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name + '.geojson'), 'utf8'));
const r = (v) => Math.round(v * 100) / 100;

function line(coords) {
  const out = [];
  for (const [lon, lat] of coords) {
    const p = [r(lon), r(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length > 1 ? out : null;
}
function lines(fc) {
  const out = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const p of parts) { const l = line(p); if (l) out.push(l); }
  }
  return out;
}
function rings(fc) {
  const out = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) { const l = line(poly[0]); if (l && l.length > 3) out.push(l); }
  }
  return out;
}

const cities = read('ne_10m_populated_places_simple').features
  .map((f) => f.properties)
  .filter((p) => p && p.name && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
  // rank: Natural Earth's own scalerank (0 = world capital .. 10 = small town); smaller shows first.
  .map((p) => [String(p.name), r(p.latitude), r(p.longitude), Number.isFinite(p.scalerank) ? p.scalerank : 10]);

const out = {
  source: 'Natural Earth (public domain), 1:50m lines and lakes, 1:10m places',
  states: lines(read('ne_50m_admin_1_states_provinces_lines')),
  countries: lines(read('ne_50m_admin_0_boundary_lines_land')),
  coast: lines(read('ne_50m_coastline')),
  lakes: rings(read('ne_50m_lakes')),
  cities,
};
const file = path.join(__dirname, 'basemap.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${file}: ${fs.statSync(file).size} bytes; states ${out.states.length}, countries ${out.countries.length}, coast ${out.coast.length}, lakes ${out.lakes.length}, cities ${out.cities.length}`);
