// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the fundraiser fields from the URL query string and fills the thermometer.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };

  var pct = Math.max(0, Math.min(100, parseFloat(get('pct')) || 0));
  var pctLabel = get('pctLabel') || (Math.round(pct) + '%');
  var done = pct >= 100;

  document.getElementById('campaign').textContent = get('campaign') || 'Fundraiser';
  document.getElementById('raised').textContent = get('raised') || '0';
  document.getElementById('goal').textContent = get('goal') || '0';

  var pctEl = document.getElementById('pct');
  pctEl.textContent = pctLabel;
  if (done) pctEl.classList.add('done');

  var footer = document.getElementById('footer');
  if (done) {
    footer.className = 'footer done-banner';
    footer.textContent = 'Goal reached! 🎉';
  } else {
    footer.textContent = 'Thank you for your support';
  }

  // Animate the fill from 0 to pct after first paint.
  var fill = document.getElementById('fill');
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { fill.style.height = pct + '%'; });
  });
})();
