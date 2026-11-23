'use strict';
const path = require('path');

/*
 * Headers for the frontend's static files (the express.static setHeaders hook in server.js).
 *
 * JS/CSS/HTML: no-cache (always revalidate, uses ETag/304).
 * Images/fonts/icons: long cache for Cloudflare + browser.
 *
 * Cross-Origin-Resource-Policy: helmet sends same-origin on everything, which is right for the app.
 * Two kinds of static file must load from another origin, so they get cross-origin:
 *  - The Power BI client and Leaflet, loaded by widget pages (bi-dashboard, radar) that a player
 *    frames in a sandboxed (opaque-origin) iframe.
 *  - Images under /assets/: the public marketing and guide pictures every page advertises as its
 *    og:image / twitter:image. Directories and aggregators (PitchHut, for one) show that picture by
 *    linking straight to it, and same-origin made the browser refuse it there: a blank white card.
 *    They are public by design, so nothing is exposed. Scripts, styles and HTML under /assets/ keep
 *    same-origin, as does everything outside it (uploads are served by other routes).
 */
const IMAGE_RE = /\.(png|jpg|jpeg|gif|svg|ico|webp|avif)$/i;
const CACHE_RE = /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|mp4|webm)$/i;

function isUnder(filePath, frontendDir, sub, sep) {
  const root = frontendDir.endsWith(sep) ? frontendDir : frontendDir + sep;
  return filePath.startsWith(root + sub + sep);
}

function staticHeaders(frontendDir, sep = path.sep) {
  return (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (CACHE_RE.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
    }
    if (filePath.includes(`${sep}vendor${sep}powerbi${sep}`) || filePath.includes(`${sep}vendor${sep}leaflet${sep}`)
      || (IMAGE_RE.test(filePath) && isUnder(filePath, frontendDir, 'assets', sep))) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  };
}

module.exports = { staticHeaders };
