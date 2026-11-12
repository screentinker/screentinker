// Render-blocking theme primer. Loaded as a synchronous same-origin <script> in <head>, before
// the stylesheets paint, so the chosen theme is on <html> from the first frame and the page never
// flashes the default one. The list of themes lives in js/lib/themes.js; this file only needs the
// names, because an unknown or stale value must fall back to the default rather than to nothing.
(function () {
  try {
    var t = localStorage.getItem('st_theme');
    // Broadcast view is always the production gallery; the chosen theme is for the other views.
    try { if ((JSON.parse(localStorage.getItem('user') || '{}') || {}).ui_mode === 'broadcast') t = 'control-room'; } catch (e2) { /* no cached account */ }
    if (t === 'light' || t === 'classic' || t === 'control-room') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var bar = { light: '#f3f4f6', classic: '#111827', 'control-room': '#0a0b0c' }[t] || '#15171a';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bar);
  } catch (e) { /* storage blocked: the default theme */ }
})();

// Control room theme: the gallery clock under the logo runs as timecode (HH:MM:SS:FF at 25 frames
// a second, local time). One timer for the life of the page; it does nothing in any other theme
// or while the tab is hidden.
(function () {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  setInterval(function () {
    if (document.hidden || document.documentElement.getAttribute('data-theme') !== 'control-room') return;
    var el = document.getElementById('galleryClock');
    if (!el) return;
    var d = new Date();
    el.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ':' + pad(Math.floor(d.getMilliseconds() / 40));
  }, 40);
})();
