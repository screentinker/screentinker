// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the air-quality fields from the URL query string and populates the widget.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };
  var set = function (id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; };

  var color = '#' + (get('color').replace(/[^0-9a-fA-F]/g, '') || '888888');

  set('loc', get('location') || 'Air Quality');
  set('aqi', get('aqi') !== '' ? get('aqi') : '--');
  set('cat', get('category') || '');

  // Category color drives the AQI number, the left accent, and a pill badge.
  document.getElementById('aqi').style.color = color;
  document.getElementById('card').style.borderLeftColor = color;
  var badge = document.getElementById('badge');
  if (get('category')) { badge.textContent = get('category'); badge.style.background = color; }

  var parts = [];
  if (get('pm25') !== '') parts.push('<b>PM2.5</b> ' + esc(get('pm25')));
  if (get('pm10') !== '') parts.push('<b>PM10</b> ' + esc(get('pm10')));
  if (get('ozone') !== '') parts.push('<b>O₃</b> ' + esc(get('ozone')));
  if (get('no2') !== '') parts.push('<b>NO₂</b> ' + esc(get('no2')));
  document.getElementById('grid').innerHTML = parts.join('');

  var updated = get('updated');
  if (updated) {
    var d = new Date(updated);
    set('updated', isNaN(d) ? ('· ' + updated) : ('· updated ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  }

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
