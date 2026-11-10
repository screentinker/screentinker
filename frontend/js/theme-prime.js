// Render-blocking theme primer. Loaded as a synchronous same-origin <script> in <head>, before
// the stylesheets paint, so the chosen theme is on <html> from the first frame and the page never
// flashes the default one. The list of themes lives in js/lib/themes.js; this file only needs the
// names, because an unknown or stale value must fall back to the default rather than to nothing.
(function () {
  try {
    var t = localStorage.getItem('st_theme');
    if (t === 'light' || t === 'classic') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var bar = { light: '#f3f4f6', classic: '#111827' }[t] || '#15171a';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bar);
  } catch (e) { /* storage blocked: the default theme */ }
})();
