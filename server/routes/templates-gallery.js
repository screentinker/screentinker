'use strict';

/**
 * /templates — the public template gallery (marketing). The committed frontend/templates.html is the
 * shell; the cards between its markers come from the official catalog this server last accepted
 * (lib/templates/gallery.js), so a template published to the catalog shows up here on the next
 * catalog poll, with no release and no redeploy.
 *
 * ⚠️ THIS PAGE MUST NEVER FAIL TO SERVE. Anything wrong with the catalog — never fetched, switched
 * off on a self-hosted server, a corrupt row — degrades to the committed shell, whose fallback copy
 * points at the library in the dashboard. Same rule as /certified-hardware.
 *
 * Rendered output is cached in process and keyed on what it is made of (catalog serial + the
 * installed packages' hashes); a request costs two small reads and no rendering.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const gallery = require('../lib/templates/gallery');

const SHELL = path.join(config.frontendDir, 'templates.html');

let cached = null;
let cachedKey = null;

function inputs() {
  const catalog = require('../lib/templates/catalog');
  const store = require('../lib/templates/store');
  const cat = catalog.getCatalog(gallery.OFFICIAL);
  const index = cat && cat.enabled ? catalog.cachedIndex(gallery.OFFICIAL) : null;
  const installed = new Map(store.listInstalled().map((r) => [r.id, r]));
  const key = `${cat ? cat.last_serial : '-'}|${[...installed.values()].map((r) => `${r.id}@${r.sha256}:${r.status}`).join(',')}`;
  return { index, installed, url: cat && cat.url, key };
}

function build() {
  const shell = fs.readFileSync(SHELL, 'utf8');
  try {
    const { index, installed, url, key } = inputs();
    if (cached && key === cachedKey) return cached;
    const list = gallery.cards(index, { installed: (k) => installed.get(k) || null, catalogUrl: url });
    cached = gallery.renderPage(shell, list);
    cachedKey = key;
    return cached;
  } catch (e) {
    console.error('[templates-gallery] serving the committed page:', e && e.message);
    return shell;
  }
}

function page(req, res) {
  if (config.disableHomepage) return res.redirect(302, '/app');
  res.type('html').send(build());
}

module.exports = { page, build, invalidate: () => { cached = null; cachedKey = null; } };
