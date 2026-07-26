// Render-blocking branding primer (#38). Loaded as a synchronous same-origin
// <script> right after the sidebar logo, so it runs DURING parse, before first
// paint — applying the current workspace's CACHED white-label so the page paints
// branded instead of flashing the "SwiftDisplay" default. branding.js then
// refreshes it from the server and re-writes the cache. Plain script (not a
// module) so it's not deferred; keyed by workspace so a switch shows the right
// brand (or the neutral default for a workspace we haven't cached yet).
(function () {
  try {
    var token = localStorage.getItem('token');
    if (!token) return;
    var ws = 'none';
    try {
      var seg = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      ws = (JSON.parse(atob(seg)) || {}).current_workspace_id || 'none';
    } catch (e) { /* malformed token -> treat as no workspace */ }

    var wl = JSON.parse(localStorage.getItem('rd_branding_' + ws) || 'null');
    if (!wl) {
      // #76: no per-workspace cache yet (e.g. a never-visited org). Fall back to
      // the server-injected instance / custom-domain branding so the page paints
      // the configured brand instead of flashing the SwiftDisplay default;
      // branding.js then fetches and caches the workspace-specific brand.
      try {
        var ssr = document.querySelector('meta[name="ssr-brand"]');
        if (ssr && ssr.content) wl = JSON.parse(ssr.content);
      } catch (e) { /* ignore */ }
    }
    if (!wl) return;

    var root = document.documentElement;
    if (wl.primary_color) root.style.setProperty('--accent', wl.primary_color);
    if (wl.bg_color) {
      root.style.setProperty('--bg-primary', wl.bg_color);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', wl.bg_color);
    }
    if (wl.brand_name) {
      document.title = wl.brand_name;
      var span = document.getElementById('brandName');
      if (span) span.textContent = wl.brand_name;
    }
    if (wl.favicon_url) {
      var links = document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]');
      for (var i = 0; i < links.length; i++) links[i].setAttribute('href', wl.favicon_url);
    }
    if (wl.custom_css) {
      var s = document.createElement('style');
      s.id = 'wl-custom-css';
      s.textContent = wl.custom_css;
      document.head.appendChild(s);
    }
  } catch (e) { /* never let branding break boot */ }
})();
