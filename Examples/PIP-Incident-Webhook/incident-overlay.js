// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the incident fields from the URL query string and paints the card.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };

  var color = '#' + (get('color').replace(/[^0-9a-fA-F]/g, '') || 'CC0000');
  document.getElementById('band').style.background = color;

  var sev = (get('severity') || 'alert');
  document.getElementById('level').textContent = (get('level') || 'INCIDENT').toUpperCase();
  document.getElementById('badge').textContent = sev.toUpperCase();

  document.getElementById('title').textContent = get('title') || 'Service incident';
  document.getElementById('detail').textContent = get('detail') || '';
  document.getElementById('source').textContent = get('source') || '';

  var updated = get('updated');
  if (updated) {
    var d = new Date(updated);
    document.getElementById('updated').textContent = isNaN(d) ? ('· ' + updated) : ('· ' + d.toLocaleString());
  }
})();
