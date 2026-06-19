// External overlay script — same-origin so the server CSP (scriptSrc 'self')
// permits it. Reads the card fields from the URL query string. All text is set
// via textContent / element.style, so nothing from the query is ever parsed as
// HTML (XSS-safe).
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };

  var color = '#' + (get('color').replace(/[^0-9a-fA-F]/g, '') || '1F9D55');
  document.getElementById('accent').style.background = color;

  var kind = get('kind');
  document.getElementById('kind').textContent = kind;
  document.getElementById('kind').style.color = color;

  document.getElementById('emoji').textContent = get('emoji') || '👋';
  document.getElementById('greeting').textContent = get('greeting') || 'Welcome';
  document.getElementById('name').textContent = get('name');

  var note = get('note');
  var noteEl = document.getElementById('note');
  if (note) noteEl.textContent = note; else noteEl.style.display = 'none';
})();
