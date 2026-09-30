/*
 * Weather — animated. ScreenTinker community template. MIT.
 *
 * The server injects everything: ST.values (the operator's settings) and ST.data.weather (the flat
 * keys of the chosen Weather data source: temperature, condition, code, units, day1_high, ...).
 * Nothing is fetched, so the manifest declares no network hosts. All text is written with
 * textContent and every icon is built with createElementNS — no innerHTML, no eval.
 */
(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';

  function el(name, attrs, parent) {
    var e = document.createElementNS(SVG, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function div(cls, parent, text) {
    var e = document.createElement('div');
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function has(v) { return v !== undefined && v !== null && v !== ''; }
  function n(v) { var x = Number(v); return has(v) && isFinite(x) ? x : null; }
  function t(v) { return has(v) ? String(v) : '–'; }

  /* WMO weather code → one of seven scenes. */
  function group(code) {
    var c = n(code);
    if (c === null) return 'cloudy';
    if (c <= 1) return 'clear';
    if (c === 2) return 'partly';
    if (c === 3) return 'cloudy';
    if (c === 45 || c === 48) return 'fog';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
    if (c >= 95) return 'storm';
    return 'rain';
  }

  var SKY = {
    clear:  ['#1D6FD8', '#74C3FF'], clearN: ['#0A1636', '#233A78'],
    partly: ['#2F6CBF', '#93BCE3'], partlyN: ['#101B3A', '#34466E'],
    cloudy: ['#44546A', '#8D9BAE'], fog: ['#66707C', '#AEB6BE'],
    rain:   ['#1F3146', '#4F657C'], snow: ['#56718F', '#B9CCE0'], storm: ['#11161F', '#39424F'],
  };

  /* ---------- icons (viewBox 0 0 100 100) ---------- */
  var CLOUD = 'M30 72 H72 A14 14 0 0 0 72 44 A20 20 0 0 0 34 40 A16 16 0 0 0 30 72 Z';

  function sun(g, cx, cy, r, accent) {
    var rays = el('g', { 'class': 'spin' }, g);
    for (var i = 0; i < 12; i++) {
      var a = (i * Math.PI) / 6;
      el('line', {
        x1: (cx + Math.cos(a) * (r + 6)).toFixed(2), y1: (cy + Math.sin(a) * (r + 6)).toFixed(2),
        x2: (cx + Math.cos(a) * (r + (i % 2 ? 11 : 15))).toFixed(2), y2: (cy + Math.sin(a) * (r + (i % 2 ? 11 : 15))).toFixed(2),
        stroke: accent, 'stroke-width': 3.2, 'stroke-linecap': 'round',
      }, rays);
    }
    el('circle', { cx: cx, cy: cy, r: r, fill: accent }, g);
    el('circle', { cx: cx - r * 0.3, cy: cy - r * 0.3, r: r * 0.45, fill: '#fff', opacity: 0.25 }, g);
  }
  function moon(g, cx, cy, r) {
    el('path', {
      d: 'M' + (cx + r * 0.2) + ' ' + (cy - r) + ' A' + r + ' ' + r + ' 0 1 0 ' + (cx + r) + ' ' + (cy + r * 0.35)
        + ' A' + (r * 0.8) + ' ' + (r * 0.8) + ' 0 0 1 ' + (cx + r * 0.2) + ' ' + (cy - r) + ' Z',
      fill: '#F4F1DE',
    }, g);
  }
  function cloud(g, shade, dx, dy, scale) {
    var c = el('g', { transform: 'translate(' + (dx || 0) + ' ' + (dy || 0) + ') scale(' + (scale || 1) + ')' }, g);
    var b = el('g', { 'class': 'bob' }, c);
    el('path', { d: CLOUD, fill: shade || '#F3F6FA' }, b);
    return c;
  }

  function icon(kind, accent, night, animated) {
    var svg = el('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    var g = el('g', {}, svg);
    if (kind === 'clear') {
      if (night) moon(g, 50, 50, 24); else sun(g, 50, 50, 20, accent);
    } else if (kind === 'partly') {
      if (night) moon(g, 62, 34, 16); else sun(g, 64, 36, 14, accent);
      cloud(g, '#F3F6FA', -4, 8, 1);
    } else if (kind === 'cloudy') {
      cloud(g, '#C9D2DD', 12, -10, 0.8);
      cloud(g, '#F3F6FA', -4, 4, 1);
    } else if (kind === 'fog') {
      cloud(g, '#DCE2E8', 0, -8, 1);
      for (var f = 0; f < 3; f++) {
        el('line', { 'class': 'fogline', x1: 20 + f * 4, y1: 74 + f * 8, x2: 80 - f * 6, y2: 74 + f * 8,
          stroke: '#E8ECF0', 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.85,
          style: 'animation-delay:' + (-f * 1.3) + 's' }, g);
      }
    } else if (kind === 'rain' || kind === 'storm') {
      var drops = el('g', {}, g);
      for (var d = 0; d < 4; d++) {
        el('line', { 'class': 'drop', x1: 36 + d * 10, y1: 72, x2: 33 + d * 10, y2: 82,
          stroke: '#8FD0FF', 'stroke-width': 3.4, 'stroke-linecap': 'round',
          style: 'animation-delay:' + (-d * 0.27) + 's' }, drops);
      }
      cloud(g, kind === 'storm' ? '#9AA5B4' : '#E3E9F0', 0, -6, 1);
      if (kind === 'storm') {
        el('polygon', { 'class': 'bolt', points: '52,58 42,78 51,78 46,94 62,70 53,70 58,58', fill: accent }, g);
      }
    } else if (kind === 'snow') {
      var flakes = el('g', {}, g);
      for (var s = 0; s < 5; s++) {
        el('circle', { 'class': 'fl', cx: 32 + s * 9, cy: 72 + (s % 2) * 6, r: 2.4, fill: '#fff',
          style: 'animation-delay:' + (-s * 0.5) + 's' }, flakes);
      }
      cloud(g, '#F3F6FA', 0, -6, 1);
    }
    return svg;
  }

  /* ---------- the background scene ---------- */
  function scene(kind, night, animated) {
    var fx = document.getElementById('fx');
    while (fx.firstChild) fx.removeChild(fx.firstChild);
    var W = window.innerWidth || 1920;
    function rnd(a, b) { return a + Math.random() * (b - a); }
    if (kind === 'clear' && !night) div('glow', fx);
    if (kind === 'partly' || kind === 'cloudy' || kind === 'rain' || kind === 'storm' || kind === 'fog') {
      var count = kind === 'partly' ? 3 : 5;
      for (var i = 0; i < count; i++) {
        var d = div('drift', fx);
        var w = rnd(28, 55);
        d.style.width = w + 'vw';
        d.style.top = rnd(-12, 45) + 'vh';
        d.style.animationDuration = rnd(90, 160) + 's';
        d.style.animationDelay = (-rnd(0, 160)) + 's';
        var s = el('svg', { viewBox: '10 15 80 60' }, d);
        el('path', { d: CLOUD, fill: kind === 'storm' ? '#8A94A3' : '#FFFFFF' }, s);
      }
    }
    if (kind === 'rain' || kind === 'storm') {
      var drops = Math.round(W / 16);
      for (var r = 0; r < drops; r++) {
        var st = div('streak', fx);
        st.style.left = rnd(0, 118) + 'vw';
        st.style.opacity = rnd(0.35, 0.9).toFixed(2);
        st.style.animationDuration = rnd(0.55, 0.95).toFixed(2) + 's';
        st.style.animationDelay = (-rnd(0, 1)).toFixed(2) + 's';
      }
    }
    if (kind === 'storm') div('flash', fx);
    if (kind === 'snow') {
      var flakes = Math.round(W / 14);
      for (var f = 0; f < flakes; f++) {
        var fl = div('flake', fx);
        var size = rnd(0.4, 1.3);
        fl.style.width = fl.style.height = size + 'vh';
        fl.style.left = rnd(-5, 105) + 'vw';
        fl.style.opacity = rnd(0.5, 1).toFixed(2);
        fl.style.animationDuration = rnd(9, 18).toFixed(1) + 's';
        fl.style.animationDelay = (-rnd(0, 18)).toFixed(1) + 's';
      }
    }
    if (!animated) document.body.classList.add('still');
  }

  ST.ready(function () {
    var v = ST.values || {};
    var w = (ST.data && ST.data.weather) || {};
    var root = document.documentElement;
    var accent = v.accent || '#FFD166';
    root.style.setProperty('--accent', accent);
    if (v.background) root.style.setProperty('--solid', v.background);
    var animated = v.animate !== false;

    /* clock + date */
    function fmt(opts) {
      var o = {}; for (var k in opts) o[k] = opts[k];
      if (v.timezone) o.timeZone = v.timezone;
      try { return new Intl.DateTimeFormat(v.locale || undefined, o); } catch (e) {
        delete o.timeZone;
        try { return new Intl.DateTimeFormat(undefined, o); } catch (e2) { return null; }
      }
    }
    var tf = fmt({ hour: '2-digit', minute: '2-digit' });
    var df = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
    var hf = fmt({ hour: 'numeric', hourCycle: 'h23' });
    var clock = document.getElementById('clock');
    var date = document.getElementById('date');
    function tick() {
      var now = new Date();
      if (v.show_clock !== false && tf) clock.textContent = tf.format(now);
      if (df) date.textContent = df.format(now);
    }
    tick(); setInterval(tick, 1000);

    document.getElementById('place').textContent = String(v.location || '').trim() || t(w.location);

    if (!has(w.temperature)) {
      document.body.classList.add('nodata');
      document.getElementById('waiting').hidden = false;
      if (!String(v.location || '').trim()) document.getElementById('place').textContent = 'Weather';
      scene('cloudy', false, animated);
      return;
    }

    var hour = 12;
    try { hour = parseInt(hf ? hf.format(new Date()) : new Date().getHours(), 10); } catch (e) { hour = new Date().getHours(); }
    var night = hour < 6 || hour >= 20;
    var kind = group(w.code);

    /* sky */
    if (v.theme === 'solid') document.body.classList.add('solid');
    var sky = SKY[kind + (night ? 'N' : '')] || SKY[kind] || SKY.cloudy;
    if (night && !SKY[kind + 'N']) sky = [shade(sky[0], -0.45), shade(sky[1], -0.45)];
    root.style.setProperty('--top', sky[0]);
    root.style.setProperty('--bottom', sky[1]);
    scene(kind, night, animated && v.theme !== 'solid');

    /* now */
    document.getElementById('bigicon').appendChild(icon(kind, accent, night, animated));
    document.getElementById('temp').textContent = t(w.temperature);
    document.getElementById('unit').textContent = has(w.units) ? String(w.units) : '';
    document.getElementById('cond').textContent = t(w.condition);
    var chips = document.getElementById('chips');
    function chip(label, value) {
      if (!has(value)) return;
      var c = div('chip', chips);
      c.appendChild(document.createTextNode(label + ' '));
      var b = document.createElement('b'); b.textContent = value; c.appendChild(b);
    }
    var wind = w.units === 'F' ? ' mph' : ' km/h';
    chip('Feels like', has(w.apparent_temperature) ? w.apparent_temperature + '°' : '');
    chip('Humidity', has(w.humidity) ? w.humidity + '%' : '');
    chip('Wind', has(w.wind_speed) ? w.wind_speed + wind : '');
    chip(kind === 'snow' ? 'Snow' : 'Rain', has(w.day0_precip_prob) ? w.day0_precip_prob + '%' : '');

    /* five days: day1..day5, each with a bar placed on the week's own temperature scale */
    var days = document.getElementById('days');
    var lo = Infinity, hi = -Infinity;
    for (var d = 1; d <= 5; d++) {
      var a = n(w['day' + d + '_low']), b = n(w['day' + d + '_high']);
      if (a !== null) lo = Math.min(lo, a);
      if (b !== null) hi = Math.max(hi, b);
    }
    var span = hi > lo ? hi - lo : 1;
    for (var i = 1; i <= 5; i++) {
      if (!has(w['day' + i + '_name'])) continue;
      var card = div('day', days);
      card.style.animationDelay = (0.15 + i * 0.09) + 's';
      div('dname', card, t(w['day' + i + '_name']));
      var ic = div('dicon', card);
      ic.appendChild(icon(group(w['day' + i + '_code']), accent, false, animated));
      var row = div('hl', card);
      var l = document.createElement('span'); l.className = 'lo'; l.textContent = t(w['day' + i + '_low']) + '°'; row.appendChild(l);
      var rg = document.createElement('span'); rg.className = 'range'; row.appendChild(rg);
      var h = document.createElement('span'); h.className = 'hi'; h.textContent = t(w['day' + i + '_high']) + '°'; row.appendChild(h);
      var dl = n(w['day' + i + '_low']), dh = n(w['day' + i + '_high']);
      if (dl !== null && dh !== null) {
        var fill = document.createElement('i');
        fill.style.left = ((dl - lo) / span * 100).toFixed(1) + '%';
        fill.style.right = ((hi - dh) / span * 100).toFixed(1) + '%';
        rg.appendChild(fill);
      }
      if (has(w['day' + i + '_precip_prob'])) div('rain', card, w['day' + i + '_precip_prob'] + (group(w['day' + i + '_code']) === 'snow' ? '% snow' : '% rain'));
    }
  });

  function shade(hex, amt) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var c = parseInt(h.substr(i * 2, 2), 16);
      c = Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
      out += ('0' + Math.max(0, Math.min(255, c)).toString(16)).slice(-2);
    }
    return out;
  }
})();
