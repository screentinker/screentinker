'use strict';

/*
 * Values from a URL, a form field or the server that used to reach an HTML or URL sink unescaped.
 *
 * The BrightSign offline page is executed for real (it is a plain ES5 IIFE, so a vm with a stub
 * document is the whole environment). The dashboard and player views need a browser to execute,
 * so for those this pins the escaping at the sink in the source: the regression it guards against
 * is someone "simplifying" the escape back out.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function runOffline(search) {
  const html = read('brightsign/offline.html');
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const fetched = [];
  const location = { search, href: 'file:///offline.html' };
  const ctx = {
    location,
    Date,
    RegExp,
    decodeURIComponent,
    document: { getElementById: (id) => (els[id] = els[id] || { textContent: '' }) },
    fetch: (url) => { fetched.push(url); return Promise.resolve({ ok: true, status: 200 }); },
    setTimeout: () => 0,
  };
  vm.runInNewContext(src, ctx);
  return { els, fetched, location };
}

test('offline page: a javascript: server is not a server', async () => {
  const r = runOffline('?server=' + encodeURIComponent('javascript:alert(document.domain)'));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.fetched.length, 0);
  assert.equal(r.els.status.textContent, 'No server configured on this card.');
  assert.equal(r.location.href, 'file:///offline.html');
});

test('offline page: an http(s) server is probed and navigated to unchanged', async () => {
  const r = runOffline('?server=' + encodeURIComponent('http://10.0.0.5:8181/'));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.fetched.length, 1);
  assert.match(r.fetched[0], /^http:\/\/10\.0\.0\.5:8181\/api\/status\?probe=\d+$/);
  assert.equal(r.els.server.textContent, 'http://10.0.0.5:8181/');
  // No host bridge in the stub, so the page falls back to navigating to the server itself.
  assert.equal(r.location.href, 'http://10.0.0.5:8181/');
});

test('offline page: an upper-case scheme still counts as http(s)', async () => {
  const r = runOffline('?server=' + encodeURIComponent('HTTPS://signage.example.com'));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.fetched.length, 1);
  assert.match(r.fetched[0], /^https:\/\/signage\.example\.com\/api\/status/);
});

test('kiosk editor encodes the page id taken from location.hash', () => {
  const s = read('frontend/js/views/kiosk.js');
  assert.match(s, /const pageId = encodeURIComponent\(rawPageId\);/);
});

test('dashboard no longer parses translations as markup', () => {
  const s = read('frontend/js/app.js');
  assert.doesNotMatch(s, /querySelectorAll\('\[data-i18n-html\]'\)/);
});

test('content library escapes option values and the YouTube frame source', () => {
  const s = read('frontend/js/views/content-library.js');
  assert.match(s, /<option value="\$\{esc\(v\)\}"/);
  assert.match(s, /<option value="\$\{esc\(state\.sort\)\}"/);
  assert.match(s, /<option value="\$\{esc\(f\.id\)\}"/);
  assert.match(s, /lib-nav-count">\$\{esc\(count\)\}/);
  assert.match(s, /src="\$\{esc\(\(\(\) => \{/);
  assert.match(s, /u\.protocol !== 'https:' && u\.protocol !== 'http:'\) return 'about:blank'/);
});

test('Tizen info overlay escapes its values', () => {
  const s = read('tizen/js/app.js');
  assert.match(s, /\(val == null \|\| val === '' \? '—' : esc\(val\)\)/);
});

test('radar example builds its legend from text nodes', () => {
  const s = read('Examples/PIP-Weather-Radar/radar-overlay.js');
  assert.doesNotMatch(s, /legend[\s\S]{0,80}\.innerHTML/);
  assert.match(s, /createTextNode\(ev\)/);
});
