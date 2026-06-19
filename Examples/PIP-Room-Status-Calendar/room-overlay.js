// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the room status from the URL query string and paints the card.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };

  var color = '#' + (get('color').replace(/[^0-9a-fA-F]/g, '') || '1f9d55');
  document.getElementById('band').style.background = color;
  document.getElementById('state').textContent = (get('state') || '—').toUpperCase();
  document.getElementById('room').textContent = get('room') || '';
  document.getElementById('detail').textContent = get('detail') || '';
  document.getElementById('sub').textContent = get('sub') || '';
})();
