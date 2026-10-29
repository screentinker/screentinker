'use strict';

/*
 * The 'radar' widget: an animated precipitation radar loop on a dark map, centred on the screen.
 *
 * Built in rather than a web page widget pointing at a radar site, because a third-party map app
 * does not run in the player's sandbox: the frame is an opaque origin with no storage, and
 * RainViewer's own page sat on "Fetching map data..." on a Pi 5. This page is ours: Leaflet
 * (BSD-2-Clause, frontend/vendor/leaflet) from this server, RainViewer's public radar frames (image
 * tiles plus one CORS-open JSON index, which work in the sandbox), and a map drawn from Natural Earth
 * data bundled in lib/radar/basemap.json (public domain; see build-basemap.js for why not tiles).
 * The server inlines only the area around the screen. An org with its own map-tile key can set
 * `tile_url` (an https template with {z}/{x}/{y}) to draw on those tiles instead.
 *
 * Where it points: the screen's own location by default (lib/widget-location.js fills
 * latitude/longitude from ?device=), or a pinned latitude/longitude with location_source 'fixed'.
 *
 * Sources and terms (the attribution is drawn on the map and must stay):
 *   map      Natural Earth (public domain), or the org's own tiles with their attribution
 *   radar    RainViewer public weather-maps API (radar data tops out at zoom 7; Leaflet upscales)
 * ⚠️ Check RainViewer's current API terms before relying on it commercially at scale; its URLs are in
 * one place below so a different radar provider is a small change.
 */

const { escapeHtml } = require('../widget-sanitize');
const { backgroundColor } = require('../safe-color');

const SANDBOX = 'sandbox allow-scripts';
const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_HOST = 'https://tilecache.rainviewer.com';
const THEMES = {
  dark: { land: '#16191d', lake: '#0b2233', coast: '#5b6b7a', country: '#94a3b8', state: '#475569', city: '#cbd5e1' },
  light: { land: '#e8e6e1', lake: '#a9c7dd', coast: '#7b8a99', country: '#475569', state: '#94a3b8', city: '#1e293b' },
};

let basemap = null;
function basemapData() {
  if (!basemap) basemap = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'basemap.json'), 'utf8'));
  return basemap;
}

// The part of the bundled map a screen can see, with room to spare: lines are cut to the runs that
// pass through the box (one point beyond each end so they leave the frame cleanly), lakes kept
// whole when they touch it, and the most prominent cities in it.
function cropBasemap(lat, lon, zoom) {
  const spanLon = (360 / Math.pow(2, zoom)) * 6;
  const spanLat = spanLon * 0.75;
  const w = lon - spanLon, e = lon + spanLon, s = lat - spanLat, n = lat + spanLat;
  const inside = (p) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
  const cut = (ls) => {
    const out = [];
    for (const l of ls) {
      let run = null;
      for (let i = 0; i < l.length; i++) {
        if (inside(l[i])) {
          if (!run) { run = i > 0 ? [l[i - 1]] : []; }
          run.push(l[i]);
        } else if (run) {
          run.push(l[i]);
          if (run.length > 1) out.push(run);
          run = null;
        }
      }
      if (run && run.length > 1) out.push(run);
    }
    return out;
  };
  const b = basemapData();
  const cities = b.cities.filter((c) => c[1] >= s && c[1] <= n && c[2] >= w && c[2] <= e)
    .sort((a, b2) => a[3] - b2[3]).slice(0, 60);
  return {
    states: cut(b.states), countries: cut(b.countries), coast: cut(b.coast),
    lakes: b.lakes.filter((ring) => ring.some(inside)),
    cities,
  };
}

// An org's own map tiles: https only, the three placeholders, nothing that could break out of a
// JS string or a CSP source. Returns { url, host } or null.
function tileSource(raw) {
  if (typeof raw !== 'string' || raw.length > 300 || !/\{z\}/.test(raw) || !/\{x\}/.test(raw) || !/\{y\}/.test(raw)) return null;
  let u;
  try { u = new URL(raw.replace(/\{(z|x|y|s|r)\}/g, '0')); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname)) return null;
  if (/[\s"'`<>\\;]/.test(raw)) return null;
  return { url: raw, host: `https://${u.hostname}${raw.includes('{s}') ? ` https://*.${u.hostname.split('.').slice(1).join('.')}` : ''}` };
}

function bounded(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

/** Settings as rendered: every field present and in range. Unknown fields dropped. */
function normalise(raw) {
  const c = raw || {};
  const lat = Number(c.latitude), lon = Number(c.longitude);
  const hasPoint = c.latitude !== null && c.latitude !== undefined && c.latitude !== ''
    && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    location_source: c.location_source === 'fixed' ? 'fixed' : 'screen',
    latitude: hasPoint ? lat : null,
    longitude: hasPoint ? lon : null,
    label: typeof c.label === 'string' ? c.label.slice(0, 80) : '',
    zoom: Math.round(bounded(c.zoom, 3, 10, 7)),
    opacity: bounded(c.opacity, 0.2, 1, 0.8),
    basemap: c.basemap === 'light' ? 'light' : 'dark',
    tile_url: typeof c.tile_url === 'string' ? c.tile_url.trim().slice(0, 300) : '',
    tile_attribution: typeof c.tile_attribution === 'string' ? c.tile_attribution.slice(0, 120) : '',
    animate: c.animate !== false,
    show_label: c.show_label !== false,
    background: backgroundColor(c.background) || '#0b0d10',
  };
}

function messagePage(bg, text) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:${bg}}</style></head><body><div style="height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;font:22px sans-serif;text-align:center;padding:24px;box-sizing:border-box">${escapeHtml(text)}</div></body></html>`;
}

/** The page for a radar widget. Returns { html, csp }. `origin` is this server, for Leaflet. */
function render(rawConfig, { origin } = {}) {
  const c = normalise(rawConfig);
  if (c.latitude === null) {
    return {
      html: messagePage(c.background, c.location_source === 'fixed'
        ? 'Set a latitude and longitude in this radar\'s settings.'
        : 'Set this screen\'s location in Device Info and the radar centres on it.'),
      csp: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
  }
  const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const lib = `${origin}/vendor/leaflet`;
  const theme = THEMES[c.basemap];
  const tiles = tileSource(c.tile_url);
  // Own tiles when the org set them; otherwise the bundled Natural Earth map around this screen.
  const shapes = tiles ? null : cropBasemap(c.latitude, c.longitude, c.zoom);
  const attribution = (tiles ? escapeHtml(c.tile_attribution || 'Map tiles') : 'Natural Earth') + ' &middot; Radar: RainViewer';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${escapeHtml(lib)}/leaflet.css">
<style>
  html,body,#map{margin:0;height:100%;width:100%;overflow:hidden;background:${tiles ? c.background : theme.land}}
  .leaflet-container{background:${tiles ? c.background : theme.land}}
  .leaflet-control-attribution{background:rgba(10,12,16,.55)!important;color:#9aa3ad!important;font-size:clamp(9px,2.2vh,16px)}
  .leaflet-control-attribution a{color:#c9d2db!important}
  /* Sized from the zone, not fixed pixels: the same widget sits in a 300 px corner and a 4K wall. */
  #hud{position:absolute;z-index:1000;left:2.5vh;top:2vh;color:#f8fafc;font:700 clamp(14px,7vh,72px)/1.15 -apple-system,"Segoe UI",sans-serif;text-shadow:0 2px 6px #000}
  #hud small{display:block;font-weight:500;opacity:.85;font-size:.55em}
  #dot{position:absolute;z-index:999;left:50%;top:50%;width:2vh;height:2vh;min-width:8px;min-height:8px;transform:translate(-50%,-50%);border-radius:50%;background:#38bdf8;box-shadow:0 0 0 .7vh rgba(56,189,248,.35)}
  .city{color:${theme.city};font:600 clamp(9px,3.4vh,30px)/1 -apple-system,"Segoe UI",sans-serif;white-space:nowrap;text-shadow:0 1px 3px ${c.basemap === 'dark' ? '#000' : '#fff'};transform:translate(-50%,-50%)}
</style></head><body>
<div id="map"></div><div id="dot"></div>
<div id="hud">${c.show_label ? `<span id="place">${escapeHtml(c.label)}</span>` : ''}<small id="time"></small></div>
<script src="${escapeHtml(lib)}/leaflet.js"></script>
<script>(function(){
var lat=${js(c.latitude)},lon=${js(c.longitude)},zoom=${js(c.zoom)},opacity=${js(c.opacity)},animate=${js(c.animate)};
var map=L.map("map",{zoomControl:false,attributionControl:true,fadeAnimation:false,preferCanvas:true,dragging:false,scrollWheelZoom:false,doubleClickZoom:false,boxZoom:false,keyboard:false,touchZoom:false}).setView([lat,lon],zoom);
map.attributionControl.setPrefix(false);map.attributionControl.addAttribution(${js(attribution)});
var tiles=${js(tiles ? tiles.url : null)},shapes=${js(shapes)},theme=${js(theme)};
if(tiles){L.tileLayer(tiles,{maxZoom:19}).addTo(map);}
else{
  var ll=function(line){return line.map(function(p){return[p[1],p[0]];});};
  var lakes=map.createPane("lakes");lakes.style.zIndex=150;
  shapes.lakes.forEach(function(r){L.polygon(ll(r),{pane:"lakes",stroke:true,color:theme.coast,weight:1,fillColor:theme.lake,fillOpacity:1,interactive:false}).addTo(map);});
  var lines=map.createPane("lines");lines.style.zIndex=450;lines.style.pointerEvents="none";
  function draw(set,color,weight){set.forEach(function(l){L.polyline(ll(l),{pane:"lines",color:color,weight:weight,opacity:.9,interactive:false}).addTo(map);});}
  draw(shapes.states,theme.state,1);draw(shapes.coast,theme.coast,1.2);draw(shapes.countries,theme.country,1.6);
  // Cities over the radar, most prominent first, skipping any that would land on one already drawn.
  var placed=[],size=map.getSize(),minGap=Math.max(60,size.y*0.12);
  shapes.cities.forEach(function(c){
    var pt=map.latLngToContainerPoint([c[1],c[2]]);
    if(pt.x<0||pt.y<0||pt.x>size.x||pt.y>size.y)return;
    if(Math.abs(pt.x-size.x/2)<minGap*0.6&&Math.abs(pt.y-size.y/2)<minGap*0.3)return;
    for(var i=0;i<placed.length;i++){if(Math.abs(placed[i].x-pt.x)<minGap*1.6&&Math.abs(placed[i].y-pt.y)<minGap*0.5)return;}
    if(placed.length>=10)return;
    placed.push(pt);
    var el=document.createElement("div");el.className="city";el.textContent=c[0];
    L.marker([c[1],c[2]],{icon:L.divIcon({className:"",html:el.outerHTML,iconSize:null}),interactive:false,keyboard:false,zIndexOffset:1000}).addTo(map);
  });
}
var frames=[],layers={},cur=-1,timer=null,timeEl=document.getElementById("time");
function url(p){return ${js(RADAR_HOST)}+p+"/256/{z}/{x}/{y}/4/1_1.png";}
function show(i){
  if(!layers[i])layers[i]=L.tileLayer(url(frames[i].path),{opacity:0,zIndex:200,maxNativeZoom:7,maxZoom:19}).addTo(map);
  layers[i].setOpacity(opacity);
  if(cur!==-1&&cur!==i&&layers[cur])layers[cur].setOpacity(0);
  cur=i;
  var d=new Date(frames[i].time*1000);
  timeEl.textContent="Radar "+d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
}
function run(){
  if(timer)clearTimeout(timer);
  var i=frames.length-1;show(i);
  // Loop the past frames, holding on the newest one longer so "now" is readable.
  function tick(){i=(i+1)%frames.length;show(i);timer=setTimeout(tick,i===frames.length-1?2000:600);}
  if(animate)timer=setTimeout(tick,2000);
}
function load(){
  fetch(${js(RADAR_INDEX)}).then(function(r){return r.json();}).then(function(d){
    var past=(d.radar&&d.radar.past)||[];
    if(!past.length)return;
    if(${js(RADAR_HOST)}!==d.host)return;
    Object.keys(layers).forEach(function(k){map.removeLayer(layers[k]);});
    layers={};cur=-1;frames=past;run();
  })["catch"](function(){timeEl.textContent="Radar unavailable \\u2014 retrying";});
}
load();setInterval(load,10*60*1000);
})();</script></body></html>`;
  return {
    html,
    csp: `default-src 'none'; style-src 'unsafe-inline' ${origin}; script-src 'unsafe-inline' ${origin}; `
      + `connect-src https://api.rainviewer.com; img-src ${RADAR_HOST} ${tiles ? tiles.host + ' ' : ''}${origin} data:; ${SANDBOX}`,
  };
}

/** The editor's Preview (no screen): a pinned place renders; a screen-following one says so. */
function previewHtml(rawConfig, { origin } = {}) {
  const c = normalise(rawConfig);
  if (c.latitude !== null) return render(c, { origin }).html;
  return messagePage(c.background, 'Weather radar — centres on each screen\'s location (set in Device Info).');
}

module.exports = { render, normalise, previewHtml, RADAR_INDEX, RADAR_HOST };
