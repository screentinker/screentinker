// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the alert fields from the URL query string and populates the card.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };

  var color = '#' + (get('color').replace(/[^0-9a-fA-F]/g, '') || 'CC0000');
  document.getElementById('band').style.background = color;
  document.getElementById('level').textContent = (get('level') || 'Alert').toUpperCase();
  document.getElementById('headline').textContent = get('headline') || 'Emergency alert in your area';
  document.getElementById('agency').textContent = get('agency') || '';

  var meta = [];
  if (get('area')) meta.push('<b>Area:</b> ' + escapeHtml(get('area')));
  if (get('status')) meta.push('<b>Status:</b> ' + escapeHtml(get('status')));
  document.getElementById('meta').innerHTML = meta.join('');

  var updated = get('updated');
  if (updated) {
    var d = new Date(updated);
    document.getElementById('updated').textContent = isNaN(d) ? ('· ' + updated) : ('· updated ' + d.toLocaleString());
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
