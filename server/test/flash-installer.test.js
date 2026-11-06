'use strict';

/*
 * #flash — the ESP32 web-serial firmware installer embedded in the dashboard (frontend/flash/).
 *
 * This is René's esp-web-tools installer, vendored in so a self-hosted / offline instance can flash a
 * Seeed/Elecrow controller from its own dashboard and point the device back at THIS instance. The web
 * part (Web Serial, flashing a real board) can only be tested in a browser with hardware; what this
 * file pins is the integration that makes it work when served from ScreenTinker:
 *   - esp-web-tools is served locally, never from unpkg (the offline requirement);
 *   - the device's server URL is pre-filled with this instance's origin;
 *   - the page is CSP-exempt and reachable at /flash (its inline scripts need the relaxed policy);
 *   - every board's manifest and firmware is actually present;
 *   - the dashboard links to it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FLASH = path.join(ROOT, 'frontend', 'flash');
const read = (p) => fs.readFileSync(p, 'utf8');

const INDEX = read(path.join(FLASH, 'index.html'));
const SERVER = read(path.join(ROOT, 'server', 'server.js'));
const DASHBOARD_HTML = read(path.join(ROOT, 'frontend', 'index.html'));

test('esp-web-tools is vendored locally, not loaded from unpkg/a CDN', () => {
  assert.doesNotMatch(INDEX, /unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare/i, 'no remote CDN — must work offline');
  assert.match(INDEX, /src="vendor\/esp-web-tools\/install-button\.js"/, 'loads the vendored entry module');
  assert.ok(fs.existsSync(path.join(FLASH, 'vendor', 'esp-web-tools', 'install-button.js')), 'the vendored module is present');
  // esp-web-tools ships as hashed ESM chunks that install-button.js imports relatively; the big
  // install dialog is one of them, so a one-file copy would not run.
  const vendor = fs.readdirSync(path.join(FLASH, 'vendor', 'esp-web-tools'));
  assert.ok(vendor.some((f) => /^install-dialog-.*\.js$/.test(f)), 'the full dist/web chunk set was vendored');
});

test('the installer pre-fills the device server URL with THIS instance origin', () => {
  // The hardcoded default from upstream must be gone, and the field defaulted to the serving origin.
  assert.doesNotMatch(INDEX, /id="server"[^>]*value="https?:\/\/\d/, 'no hardcoded IP default remains');
  assert.match(INDEX, /id="server"\s+value=""/, 'the server field starts empty');
  assert.match(INDEX, /document\.getElementById\('server'\)[\s\S]{0,80}window\.location\.origin/,
    'a script fills it with window.location.origin');
});

test('the page still carries the esp-web-tools install button and the board manifests it names', () => {
  assert.match(INDEX, /<esp-web-install-button[^>]*manifest=/, 'the install button is present');
  const manifests = fs.readdirSync(FLASH).filter((f) => /^manifest.*\.json$/.test(f));
  assert.ok(manifests.length >= 9, `expected all board manifests, found ${manifests.length}`);
  for (const m of manifests) {
    const j = JSON.parse(read(path.join(FLASH, m)));
    assert.ok(Array.isArray(j.builds) && j.builds.length, `${m} has builds`);
    for (const part of j.builds[0].parts) {
      assert.ok(fs.existsSync(path.join(FLASH, part.path)), `${m}: firmware part ${part.path} is present`);
    }
  }
});

test('the server reaches the installer with the relaxed (player-style) CSP, not the dashboard policy', () => {
  assert.match(SERVER, /req\.path === '\/flash' \|\| req\.path\.startsWith\('\/flash\/'\)\) return exempt\(\)/,
    'the /flash path is CSP-exempt like /player');
  assert.match(SERVER, /app\.get\(\['\/flash', '\/flash\/'\][\s\S]{0,160}flash['"], ['"]index\.html['"]\)\)/,
    'a route serves the installer at /flash (express.static is index:false)');
});

test('the dashboard Add Display flow links to the installer, opening a top-level tab for Web Serial', () => {
  assert.match(DASHBOARD_HTML, /href="\/flash"[^>]*target="_blank"/, 'Add Display links to /flash in a new tab');
});
