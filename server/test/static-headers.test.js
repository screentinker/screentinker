'use strict';
/**
 * Static file headers. The case that motivated the module: the og:image every marketing page
 * advertises (/assets/dashboard-preview.png) carried helmet's CORP same-origin, so a directory that
 * shows it by linking straight to it (PitchHut) got a blank white card.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { staticHeaders } = require('../lib/static-headers');

const FE = '/srv/st/frontend';
function headersFor(file, sep = '/', root = FE) {
  const h = {};
  staticHeaders(root, sep)({ setHeader: (k, v) => { h[k] = v; } }, file);
  return h;
}

test('public images under /assets/ may be shown by other sites', () => {
  for (const f of ['assets/dashboard-preview.png', 'assets/icon-512.png', 'assets/guides/kiosk/preview.webp', 'assets/hardware/x.JPG', 'assets/a.svg']) {
    const h = headersFor(`${FE}/${f}`);
    assert.equal(h['Cross-Origin-Resource-Policy'], 'cross-origin', f);
    assert.equal(h['Cache-Control'], 'public, max-age=2592000', f);
  }
});

test('everything else keeps helmet\'s same-origin (no override)', () => {
  for (const f of ['js/app.js', 'css/main.css', 'index.html', 'assets/evil.js', 'assets/page.html', 'assets/x.css',
    'icons/logo.png', 'flash/a.png', 'vendor/pdfjs/pdf.min.mjs', 'assets/fonts/a.woff2']) {
    assert.equal(headersFor(`${FE}/${f}`)['Cross-Origin-Resource-Policy'], undefined, f);
  }
  // A sibling directory whose name merely starts with "assets" is not /assets/.
  assert.equal(headersFor(`${FE}/assets-private/a.png`)['Cross-Origin-Resource-Policy'], undefined);
  // /assets/ inside some other tree is not the frontend's /assets/.
  assert.equal(headersFor('/elsewhere/assets/a.png')['Cross-Origin-Resource-Policy'], undefined);
});

test('the sandboxed-widget vendor libraries still load cross-origin', () => {
  assert.equal(headersFor(`${FE}/vendor/leaflet/leaflet.js`)['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.equal(headersFor(`${FE}/vendor/powerbi/powerbi.min.js`)['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.equal(headersFor(`${FE}/vendor/leaflet/leaflet.js`)['Cache-Control'], 'no-cache');
});

test('Windows paths and a trailing separator on the root work', () => {
  const root = 'C:\\st\\frontend\\';
  const h = headersFor('C:\\st\\frontend\\assets\\dashboard-preview.png', '\\', root);
  assert.equal(h['Cross-Origin-Resource-Policy'], 'cross-origin');
});

test('server.js serves the frontend through staticHeaders', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /express\.static\(config\.frontendDir, \{[\s\S]{0,120}setHeaders: require\('\.\/lib\/static-headers'\)\.staticHeaders\(config\.frontendDir\)/);
});

test('every og:image the site advertises is an /assets/ image that gets cross-origin', () => {
  const feRoot = path.join(__dirname, '..', '..', 'frontend');
  const seen = new Set();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'vendor' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?:og|twitter):image" content="https:\/\/screentinker\.com\/([^"]+)"/g)) seen.add(m[1]);
      }
    }
  })(feRoot);
  assert.ok(seen.size > 0);
  for (const rel of seen) {
    assert.ok(fs.existsSync(path.join(feRoot, rel)), `${rel} exists`);
    assert.equal(headersFor(path.join(feRoot, rel), path.sep, feRoot)['Cross-Origin-Resource-Policy'], 'cross-origin', rel);
  }
});
