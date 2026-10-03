/*
 * News ticker — ScreenTinker community template. MIT.
 *
 * Everything this reads comes from window.ST (the server injects the operator's values). It writes
 * with textContent only, fetches nothing, and uses no eval — the catalog's review rules.
 */
(function () {
  'use strict';

  function num(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  ST.ready(function () {
    var v = ST.values || {};
    var root = document.documentElement;
    // Colours are validated as #hex by the server before they get here.
    if (v.background) root.style.setProperty('--bg', v.background);
    if (v.accent) root.style.setProperty('--accent', v.accent);
    if (v.text_color) root.style.setProperty('--text', v.text_color);

    var title = String(v.title || '').trim() || 'News';
    document.getElementById('title').textContent = title;
    document.getElementById('label').textContent = title;

    var max = Math.round(num(v.max_items, 1, 30, 12));
    var items = String(v.headlines || '').split(/\r?\n/)
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(function (s) { return s.length > 0; })
      .slice(0, max);
    if (!items.length) {
      document.body.classList.add('empty');
      items = ['Add headlines in the template settings — one per line.'];
    }

    /* ---------- layout mode: a thin zone is a ticker bar and nothing else ---------- */
    function mode() {
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      document.body.classList.toggle('strip', w / h > 3.2);
    }
    mode();

    /* ---------- clock ---------- */
    var showClock = v.show_clock !== false;
    if (!showClock) document.body.classList.add('hide-clock');
    var clockEl = document.getElementById('clock');
    var dateEl = document.getElementById('date');
    function fmt(opts) {
      var o = {};
      for (var k in opts) o[k] = opts[k];
      if (v.timezone) o.timeZone = v.timezone;
      try { return new Intl.DateTimeFormat(v.locale || undefined, o); } catch (e) {
        delete o.timeZone;
        try { return new Intl.DateTimeFormat(undefined, o); } catch (e2) { return null; }
      }
    }
    var tf = fmt({ hour: '2-digit', minute: '2-digit' });
    var df = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
    function tick() {
      var now = new Date();
      if (tf) clockEl.textContent = tf.format(now);
      if (df) dateEl.textContent = df.format(now);
    }
    if (showClock) { tick(); setInterval(tick, 1000); }

    /* ---------- featured headline ---------- */
    var featured = document.getElementById('featured');
    var numEl = document.getElementById('num');
    var bar = document.getElementById('bar');
    document.getElementById('total').textContent = pad2(items.length);
    var every = num(v.rotate_seconds, 4, 60, 8);
    var i = 0;
    function show(n, animate) {
      featured.textContent = items[n];
      numEl.textContent = pad2(n + 1);
      featured.classList.remove('out');
      if (animate) { featured.classList.remove('in'); void featured.offsetWidth; featured.classList.add('in'); }
      bar.classList.remove('run'); void bar.offsetWidth;
      bar.style.animationDuration = every + 's';
      bar.classList.add('run');
    }
    show(0, false);
    if (items.length > 1) {
      setInterval(function () {
        featured.classList.add('out');
        setTimeout(function () { i = (i + 1) % items.length; show(i, true); }, 600);
      }, every * 1000);
    }

    /* ---------- ticker ---------- */
    var track = document.getElementById('track');
    function fill() {
      while (track.firstChild) track.removeChild(track.firstChild);
      // Two identical runs, so the loop point is invisible. Short lists are repeated until one run
      // is wider than the bar.
      var run = document.createElement('div');
      run.style.display = 'flex'; run.style.alignItems = 'center';
      items.forEach(function (t) {
        var s = document.createElement('span'); s.className = 'item'; s.textContent = t; run.appendChild(s);
        var d = document.createElement('span'); d.className = 'sep'; run.appendChild(d);
      });
      track.appendChild(run);
      var guard = 0;
      while (run.scrollWidth < track.parentNode.clientWidth && guard++ < 20) {
        items.forEach(function (t) {
          var s = document.createElement('span'); s.className = 'item'; s.textContent = t; run.appendChild(s);
          var d = document.createElement('span'); d.className = 'sep'; run.appendChild(d);
        });
      }
      track.appendChild(run.cloneNode(true));
      return run;
    }
    var run = fill();
    var pos = 0;
    var last = null;
    var speed = num(v.speed, 20, 400, 120);
    function frame(t) {
      if (last !== null) {
        var dt = Math.min(0.1, (t - last) / 1000);
        var scale = (window.innerHeight || 1080) / 1080;
        if (document.body.classList.contains('strip')) scale = (window.innerHeight || 1080) / 124;
        pos -= speed * scale * dt;
        var w = run.getBoundingClientRect().width;
        if (w > 0 && -pos >= w) pos += w;
        track.style.transform = 'translate3d(' + pos.toFixed(2) + 'px,0,0)';
      }
      last = t;
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);

    window.addEventListener('resize', function () { mode(); run = fill(); pos = 0; });
  });
})();
