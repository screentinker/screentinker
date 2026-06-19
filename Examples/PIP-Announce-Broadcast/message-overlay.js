// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the announcement fields from the URL query string and populates the card.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };

  var color = '#' + (get('color').replace(/[^0-9a-fA-F]/g, '') || 'CC0000');

  var title = get('title');
  var band = document.getElementById('band');
  if (title) {
    band.textContent = title.toUpperCase();
    band.style.background = color;
    band.classList.add('show');
  }

  document.getElementById('message').textContent = get('message') || 'Announcement';

  // Footer shows when the overlay was rendered, so a static announcement still
  // reads as "current".
  var now = new Date();
  document.getElementById('updated').textContent = isNaN(now) ? '' : ('posted ' + now.toLocaleString());
})();
