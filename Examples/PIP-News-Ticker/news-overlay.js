// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the headline string from the query and scrolls it right-to-left, seamlessly.
(function () {
  var q = new URLSearchParams(location.search);
  var text = (q.get('text') || '').trim();
  var label = (q.get('label') || 'NEWS').trim();
  var sep = q.get('sep') || ' • ';

  document.getElementById('label').textContent = label;

  var track = document.getElementById('track');
  var viewport = track.parentNode;

  // Build one "run" of the content (separator-joined headlines). Splitting on the
  // separator lets us colour the dividers without trusting feed markup (textContent only).
  function buildRun(container) {
    var parts = text.length ? text.split(sep) : ['(no headlines)'];
    parts.forEach(function (p, i) {
      if (i > 0) {
        var s = document.createElement('span');
        s.className = 'sep';
        s.textContent = sep;
        container.appendChild(s);
      }
      var span = document.createElement('span');
      span.textContent = p;
      container.appendChild(span);
    });
  }

  // Two identical runs back-to-back → when the first scrolls fully off, reset by one
  // run width for a seamless loop.
  buildRun(track);
  var gap = document.createElement('span');
  gap.textContent = sep;
  gap.className = 'sep';
  track.appendChild(gap);
  var runWidth = 0;

  function measureAndStart() {
    runWidth = track.scrollWidth;       // width of a single run (+ trailing sep)
    buildRun(track);                    // append the second copy for the wrap
    var x = viewport.clientWidth;       // start just off the right edge
    var speed = 90;                     // px/sec
    var last = null;
    function frame(ts) {
      if (last == null) last = ts;
      var dt = (ts - last) / 1000; last = ts;
      x -= speed * dt;
      if (x <= -runWidth) x += runWidth; // wrap by exactly one run
      track.style.transform = 'translateX(' + x + 'px)';
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Wait a tick so fonts/layout settle before measuring.
  if (document.readyState === 'complete') measureAndStart();
  else window.addEventListener('load', measureAndStart);
})();
