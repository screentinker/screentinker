/* Live weather radar overlay — runs in the player's iframe (same-origin, external per CSP).
   CARTO dark basemap + animated RainViewer radar + live NWS warning polygons.
   All inputs come from the URL query string; all network is via https (CSP allows it). */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var lat = parseFloat(q.get('lat')); if (!isFinite(lat)) lat = 39.5;
  var lon = parseFloat(q.get('lon')); if (!isFinite(lon)) lon = -98.35;
  var zoom = parseInt(q.get('zoom'), 10); if (!isFinite(zoom)) zoom = 8;
  var area = (q.get('area') || '').trim();
  var states = (q.get('states') || '').split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
  var DEFAULT_EVENTS = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Flood Warning'];
  var events = (q.get('events') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!events.length) events = DEFAULT_EVENTS.slice();

  // How far the auto-framing is ever allowed to pull back, expressed in county-widths from
  // the configured centre. Without this, a warning several counties away drags the frame
  // out to cover it and your own area shrinks to nothing — the map ends up showing half a
  // state at a zoom where local weather is unreadable. 2 counties in every direction keeps
  // "where I am" recognisable while still catching storms about to arrive.
  var maxCounties = parseFloat(q.get('maxcounties'));
  if (!isFinite(maxCounties) || maxCounties <= 0) maxCounties = 2;
  var COUNTY_DEG = 0.35;                       // ~24 mi, a typical US county
  var MIN_HALF_LAT = 0.18;                     // ~12 mi; a floor so one small cell can't over-zoom

  var EVENT_COLORS = {
    'Tornado Warning': '#FF2D2D',
    'Severe Thunderstorm Warning': '#FFD12E',
    'Flash Flood Warning': '#25D0C0',
    'Flood Warning': '#46C766',
  };
  var DEFAULT_COLOR = '#FF8A1F';
  function colorFor(ev) { return EVENT_COLORS[ev] || DEFAULT_COLOR; }

  // Decide the frame for a set of warning polygons.
  //
  // The map NEVER PANS. Signage is watched at a glance from across a room, and a view that
  // slides to wherever the weather is stops being "my area" — you lose the landmarks you
  // orient by. So the centre is pinned to the configured point and only the ZOOM responds:
  // the box we hand to fitBounds is always symmetric about home.
  //
  // Returns null to mean "nothing worth reframing for — hold the configured view", which is
  // the case both when there are no warnings and when they are all outside the home frame.
  function frameFor(b) {
    if (!b || !b.isValid || !b.isValid()) return null;
    if (!homeFrame.intersects(b)) return null;      // a storm three counties over is not chased
    // How far from home the warning actually reaches, capped at the home frame. Taking the
    // max of the two sides is what keeps the box symmetric, and therefore centred.
    var halfLat = Math.min(Math.max(Math.abs(b.getNorth() - lat), Math.abs(lat - b.getSouth())), padLat);
    var halfLon = Math.min(Math.max(Math.abs(b.getEast() - lon), Math.abs(lon - b.getWest())), padLon);
    // Floor it so a single small cell overhead doesn't slam the map to street level.
    halfLat = Math.max(halfLat, MIN_HALF_LAT);
    halfLon = Math.max(halfLon, MIN_HALF_LAT / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    return L.latLngBounds([lat - halfLat, lon - halfLon], [lat + halfLat, lon + halfLon]);
  }

  // Bounds of a GeoJSON warning polygon, computed straight off the coordinates. Cheaper
  // than building a throwaway L.geoJSON layer per feature just to ask for its extent.
  function boundsOf(f) {
    var g = f && f.geometry; if (!g) return null;
    var polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    var s = 90, w = 180, n = -90, e = -180;
    polys.forEach(function (poly) {
      poly.forEach(function (ring) {
        ring.forEach(function (pt) {
          var x = pt[0], y = pt[1];
          if (y < s) s = y; if (y > n) n = y;
          if (x < w) w = x; if (x > e) e = x;
        });
      });
    });
    return (n >= s && e >= w) ? L.latLngBounds([s, w], [n, e]) : null;
  }

  // The chips claim to describe what is "in view", so they have to be tallied from the
  // map's ACTUAL viewport, not from the query result. The alert feed is fetched per STATE
  // (one request instead of one per county), so it routinely returns warnings hundreds of
  // miles away — reporting those as "2x Tornado Warning" over a map that shows neither of
  // them is worse than saying nothing.
  function visibleCounts() {
    var view = map.getBounds(), counts = {};
    drawn.forEach(function (f) {
      if (!f.__b || !f.__b.intersects(view)) return;
      var ev = (f.properties || {}).event;
      counts[ev] = (counts[ev] || 0) + 1;
    });
    return counts;
  }
  function refreshChips() { renderChips(visibleCounts()); }

  document.getElementById('area').textContent = area;

  var map = L.map('map', { zoomControl: false, attributionControl: true, fadeAnimation: false }).setView([lat, lon], zoom);

  // The widest frame the auto-fit may ever produce. Longitude degrees shrink toward the
  // poles, so scale them by cos(lat) to keep the box square-ish on the ground.
  var padLat = COUNTY_DEG * maxCounties;
  var padLon = padLat / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  var homeFrame = L.latLngBounds([lat - padLat, lon - padLon], [lat + padLat, lon + padLon]);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO · Radar: RainViewer · Alerts: NWS/NOAA',
  }).addTo(map);

  // ---- animated radar (RainViewer) --------------------------------------------------
  var frames = [];          // [{time, path}]
  var frameLayers = {};     // index -> L.tileLayer (lazy)
  var cur = -1;
  var animTimer = null;
  var clockEl = document.getElementById('clock');

  function frameUrl(host, path) {
    return host + path + '/256/{z}/{x}/{y}/4/1_1.png';
  }
  function showFrame(host, i) {
    if (!frames.length) return;
    if (!frameLayers[i]) {
      // RainViewer radar data tops out at native zoom 7; upscale beyond that
      // instead of requesting unavailable ("zoom level not supported") tiles.
      frameLayers[i] = L.tileLayer(frameUrl(host, frames[i].path), { opacity: 0, zIndex: 200, maxNativeZoom: 7, maxZoom: 19 }).addTo(map);
    }
    var next = frameLayers[i];
    next.setOpacity(0.78);
    if (cur !== -1 && cur !== i && frameLayers[cur]) frameLayers[cur].setOpacity(0);
    cur = i;
    var d = new Date(frames[i].time * 1000);
    clockEl.textContent = 'Radar ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function animate(host) {
    if (animTimer) clearInterval(animTimer);
    var i = frames.length - 1;
    showFrame(host, i);
    animTimer = setInterval(function () {
      i = (i + 1) % frames.length;
      showFrame(host, i);
    }, 650);
  }
  function loadRadar() {
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var host = d.host;
        var past = (d.radar && d.radar.past) || [];
        if (!past.length) return;
        // drop stale layers if the frame set changed
        Object.keys(frameLayers).forEach(function (k) { map.removeLayer(frameLayers[k]); });
        frameLayers = {}; cur = -1;
        frames = past;
        animate(host);
      })
      .catch(function (e) { /* keep the basemap; try again next cycle */ if (window.console) console.warn('radar load failed', e && e.message); });
  }

  // ---- live NWS warning polygons ----------------------------------------------------
  var warnLayer = null;
  var drawn = [];        // features actually on the map, each stamped with __b bounds
  var chipsEl = document.getElementById('chips');

  function shortHeadline(h) { h = h || ''; return h.length > 90 ? h.slice(0, 87) + '…' : h; }

  function renderChips(counts) {
    chipsEl.innerHTML = '';
    var any = false;
    events.forEach(function (ev) {
      var n = counts[ev] || 0;
      if (!n) return;
      any = true;
      var c = document.createElement('span');
      c.className = 'chip';
      c.style.background = colorFor(ev);
      c.textContent = n + '× ' + ev;
      chipsEl.appendChild(c);
    });
    if (!any) {
      var none = document.createElement('span');
      none.className = 'chip none';
      none.textContent = 'No active warnings in view';
      chipsEl.appendChild(none);
    }
  }

  function alertUrls() {
    if (states.length) return states.map(function (s) { return 'https://api.weather.gov/alerts/active?area=' + encodeURIComponent(s); });
    return ['https://api.weather.gov/alerts/active?point=' + encodeURIComponent(lat.toFixed(4) + ',' + lon.toFixed(4))];
  }

  function loadWarnings() {
    Promise.allSettled(alertUrls().map(function (u) {
      return fetch(u, { headers: { Accept: 'application/geo+json' } }).then(function (r) { return r.json(); });
    })).then(function (results) {
      // Slightly larger than homeFrame: fitBounds padding can push the viewport a hair
      // past it, and a polygon popping in blank at the edge looks like a bug.
      var reachable = homeFrame.pad(0.3);
      var seen = {}, feats = [];
      results.forEach(function (res) {
        if (res.status !== 'fulfilled' || !res.value || !res.value.features) return;
        res.value.features.forEach(function (f) {
          var p = f.properties || {}, g = f.geometry;
          if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
          if (events.indexOf(p.event) === -1) return;
          var id = p.id || (f.id || JSON.stringify(g).slice(0, 40));
          if (seen[id]) return; seen[id] = 1;
          // The map can never travel outside homeFrame, so a warning that misses it is not
          // merely off-screen now — it is unreachable. Don't draw it and don't count it.
          var b = boundsOf(f);
          if (!b || !b.intersects(reachable)) return;
          f.__b = b;
          feats.push(f);
        });
      });
      drawn = feats;
      if (warnLayer) { map.removeLayer(warnLayer); warnLayer = null; }
      if (feats.length) {
        warnLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
          style: function (f) {
            var ev = (f.properties || {}).event;
            return { color: colorFor(ev), weight: 3, opacity: 0.95, fillColor: colorFor(ev), fillOpacity: 0.12 };
          },
          onEachFeature: function (f, layer) {
            var p = f.properties || {};
            layer.bindTooltip('<b>' + (p.event || 'Warning') + '</b><br>' + shortHeadline(p.headline), { sticky: true });
          },
        }).addTo(map);
        // TV-style auto-framing: fit the view to the warning polygon(s) so the boxes
        // fill the frame. Only re-fit when the warning set changes (so the 60s refresh
        // doesn't jitter the view); cap zoom so a single small box stays readable.
        var fitKey = feats.map(function (f) { return (f.properties || {}).id; }).sort().join('|');
        if (fitKey !== loadWarnings._fitKey) {
          loadWarnings._fitKey = fitKey;
          // Padding is small on purpose: the frame is already the answer, and 70px of inset
          // on a PiP-sized overlay throws away a third of the width on each side.
          try {
            var frame = frameFor(warnLayer.getBounds());
            if (frame) map.fitBounds(frame, { padding: [24, 24], maxZoom: 9 });
            else map.setView([lat, lon], zoom);
          } catch (e) {}
        }
      } else {
        // Warnings cleared: go back to the configured view instead of staying parked on
        // wherever the last storm happened to be.
        if (loadWarnings._fitKey) map.setView([lat, lon], zoom);
        loadWarnings._fitKey = null;
      }
      // After framing, not before: fitBounds/setView change what "in view" means, and
      // moveend fires once the view settles.
      refreshChips();
    }).catch(function (e) { if (window.console) console.warn('warnings load failed', e && e.message); });
  }

  // The zoom set by framing decides what "in view" means, and fitBounds settles
  // asynchronously — so retally once the map stops moving rather than guessing.
  map.on('moveend zoomend', refreshChips);

  // ---- go ---------------------------------------------------------------------------
  loadRadar();
  loadWarnings();
  setInterval(loadRadar, 4 * 60 * 1000);
  setInterval(loadWarnings, 60 * 1000);

  // legend (built from nodes: the event names come from the URL, so they are text, never markup)
  (function () {
    var el = document.getElementById('legend');
    el.textContent = '';
    events.forEach(function (ev) {
      var row = document.createElement('div');
      row.className = 'row';
      var sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = colorFor(ev);
      row.appendChild(sw);
      row.appendChild(document.createTextNode(ev));
      el.appendChild(row);
    });
  })();
})();
