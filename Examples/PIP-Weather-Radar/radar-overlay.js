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

  var EVENT_COLORS = {
    'Tornado Warning': '#FF2D2D',
    'Severe Thunderstorm Warning': '#FFD12E',
    'Flash Flood Warning': '#25D0C0',
    'Flood Warning': '#46C766',
  };
  var DEFAULT_COLOR = '#FF8A1F';
  function colorFor(ev) { return EVENT_COLORS[ev] || DEFAULT_COLOR; }

  document.getElementById('area').textContent = area;

  var map = L.map('map', { zoomControl: false, attributionControl: true, fadeAnimation: false }).setView([lat, lon], zoom);
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
      var seen = {}, feats = [], counts = {};
      results.forEach(function (res) {
        if (res.status !== 'fulfilled' || !res.value || !res.value.features) return;
        res.value.features.forEach(function (f) {
          var p = f.properties || {}, g = f.geometry;
          if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
          if (events.indexOf(p.event) === -1) return;
          var id = p.id || (f.id || JSON.stringify(g).slice(0, 40));
          if (seen[id]) return; seen[id] = 1;
          feats.push(f);
          counts[p.event] = (counts[p.event] || 0) + 1;
        });
      });
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
          try { map.fitBounds(warnLayer.getBounds(), { padding: [70, 70], maxZoom: 9 }); } catch (e) {}
        }
      } else {
        loadWarnings._fitKey = null;
      }
      renderChips(counts);
    }).catch(function (e) { if (window.console) console.warn('warnings load failed', e && e.message); });
  }

  // ---- go ---------------------------------------------------------------------------
  loadRadar();
  loadWarnings();
  setInterval(loadRadar, 4 * 60 * 1000);
  setInterval(loadWarnings, 60 * 1000);

  // legend
  (function () {
    var el = document.getElementById('legend');
    el.innerHTML = events.map(function (ev) {
      return '<div class="row"><span class="sw" style="background:' + colorFor(ev) + '"></span>' + ev + '</div>';
    }).join('');
  })();
})();
