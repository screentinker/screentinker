'use strict';

// 3.0.1: the dashboard half of two preview fixes, without a browser (the helpers are evaluated from
// the real module sources, imports stripped; the page-level wiring is checked against the source).
//   - Simple view home cards take a live screenshot (dashboard:screenshot-ready) the server asked
//     for after pairing / new content (server/lib/preview-refresh.js), instead of keeping the
//     pairing-code frame until someone presses Screenshot.
//   - "Find feeds": a picture the image proxy cannot serve becomes the placeholder, not a broken image.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function load(file, names, ctx = {}) {
  const src = read(file)
    .replace(/^import [\s\S]*?from '[^']+';\n/gm, '')
    .replace(/^export (const|function|async function|let) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/gm, '');
  const box = { module: {}, URL, console, ...ctx };
  vm.runInNewContext(`${src}\nmodule.exports = { ${names.join(', ')} };`, box);
  return box.module.exports;
}

// The least DOM applyScreenshot needs: cards found by [data-shot="<id>"], an optional <img> inside.
function fakeDom() {
  const made = [];
  const document = { createElement: (tag) => { const el = { tag, src: '', alt: null }; made.push(el); return el; } };
  const card = (id, withImg) => {
    const el = { id, img: withImg ? { tag: 'img', src: '/api/devices/x/screenshot?t=1' } : null, textContent: withImg ? '' : '📺' };
    el.querySelector = (sel) => (sel === 'img' ? el.img : null);
    el.appendChild = (child) => { el.img = child; };
    return el;
  };
  const cards = [card('dev-1', true), card('dev-2', false), card('dev-3', true)];
  const host = {
    querySelectorAll: (sel) => {
      const m = sel.match(/^\[data-shot="(.+)"\]$/);
      return m ? cards.filter((c) => c.id === m[1]) : [];
    },
  };
  return { document, host, cards, made };
}

test('a live screenshot replaces that card\'s picture, and only that card\'s', () => {
  const dom = fakeDom();
  const { applyScreenshot } = load('views/simple-home.js', ['applyScreenshot'], { document: dom.document, CSS: { escape: (s) => s } });
  const n = applyScreenshot(dom.host, { device_id: 'dev-1', image_data: 'data:image/jpeg;base64,AAAA' });
  assert.equal(n, 1);
  assert.equal(dom.cards[0].img.src, 'data:image/jpeg;base64,AAAA');
  assert.equal(dom.cards[2].img.src, '/api/devices/x/screenshot?t=1', 'another screen keeps its picture');
});

test('a card that had no picture yet gets one', () => {
  const dom = fakeDom();
  const { applyScreenshot } = load('views/simple-home.js', ['applyScreenshot'], { document: dom.document, CSS: { escape: (s) => s } });
  assert.equal(applyScreenshot(dom.host, { device_id: 'dev-2', image_data: 'data:image/jpeg;base64,BBBB' }), 1);
  assert.equal(dom.cards[1].textContent, '', 'the placeholder icon is gone');
  assert.equal(dom.cards[1].img.src, 'data:image/jpeg;base64,BBBB');
  assert.equal(dom.cards[1].img.alt, '');
});

test('only an inline image the server relayed is used; anything else is ignored', () => {
  const dom = fakeDom();
  const { applyScreenshot } = load('views/simple-home.js', ['applyScreenshot'], { document: dom.document, CSS: { escape: (s) => s } });
  for (const bad of [null, {}, { device_id: 'dev-1' }, { device_id: 'dev-1', image_data: 'javascript:alert(1)' },
    { device_id: 'dev-1', image_data: 'https://evil.example/x.png' }, { device_id: 7, image_data: 'data:image/jpeg;base64,A' }]) {
    assert.equal(applyScreenshot(dom.host, bad), 0, JSON.stringify(bad));
  }
  assert.equal(dom.cards[0].img.src, '/api/devices/x/screenshot?t=1');
  assert.equal(applyScreenshot(null, { device_id: 'dev-1', image_data: 'data:image/jpeg;base64,A' }), 0);
});

test('the home page listens for screenshots while it is open, and stops when it is left', () => {
  const src = read('views/simple-home.js');
  assert.match(src, /^import \{[^}]*\bon\b[^}]*\boff\b[^}]*\} from '\.\.\/socket\.js';$/m);
  const home = src.slice(src.indexOf('async function renderHome'), src.indexOf('\n}\n', src.indexOf('async function renderHome')));
  assert.match(home, /data-shot="\$\{esc\(d\.id\)\}"/, 'each home card is findable by its screen');
  assert.match(home, /on\('screenshot-ready', onShot\)/);
  assert.match(home, /cleanupFns\.push\(\(\) => off\('screenshot-ready', onShot\)\)/);
});

test('"Find feeds": every list of pictures it draws turns a failed picture into the placeholder', () => {
  const src = read('components/news-feed-picker.js');
  assert.match(src, /function placeholderOnError\(root\)/);
  assert.match(src, /addEventListener\('error'/, 'a listener, not an inline onerror (the CSP refuses those)');
  assert.ok(!/onerror=/.test(src));
  // Both places that draw itemsHtml() wire it up.
  assert.match(src, /preview\.innerHTML = `<div class="news-picker-preview">[^\n]*\n\s*placeholderOnError\(preview\);/);
  assert.match(src, /results\.innerHTML = html;\n\s*placeholderOnError\(results\);/);
});
