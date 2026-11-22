'use strict';

/*
 * ⚠️ THE PREVIEW BANNER MUST NEVER PARSE ITS LINES AS HTML.
 *
 * renderPreviewBanner() shows the operator which layout is being previewed and which items are
 * orphaned onto a fallback zone. Every line carries names an editor typed (layout name, item names,
 * zone name). The player runs on the dashboard origin and reads the operator's token from
 * localStorage, so `el.innerHTML = lines.join('<br>')` was stored XSS: an editor names an item
 * `<img src=x onerror=...>` and it runs as the admin who clicks Playlist Preview.
 *
 * Checked in both builds (legacy.html is generated from index.html by build-legacy-player.js),
 * at source level and by running the extracted function against a minimal fake DOM.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLAYERS = ['index.html', 'legacy.html'];

function bannerFn(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player', file), 'utf8');
  const start = src.indexOf('function renderPreviewBanner()');
  assert.ok(start >= 0, `${file}: renderPreviewBanner not found`);
  // The function ends at the first closing brace at its own indentation.
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  const end = src.indexOf('\n' + indent + '}', start);
  assert.ok(end > start, `${file}: end of renderPreviewBanner not found`);
  return src.slice(start, end + indent.length + 2);
}

function codeOnly(fn) {
  return fn.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('renderPreviewBanner never assigns HTML in either player build', () => {
  for (const file of PLAYERS) {
    const code = codeOnly(bannerFn(file));
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      `${file}: renderPreviewBanner must build text nodes, its lines carry editor-controlled names`);
  }
});

function fakeDom() {
  const byId = {};
  function node(tag) {
    return {
      tagName: tag, children: [], style: {}, id: '', _text: '',
      set id(v) { this._id = v; byId[v] = this; }, get id() { return this._id; },
      set textContent(v) { this.children = []; this._text = String(v); },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set innerHTML(v) { this._html = String(v); },
      appendChild(c) { this.children.push(c); return c; },
      remove() { delete byId[this._id]; },
    };
  }
  const document = {
    body: node('BODY'),
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => node(tag.toUpperCase()),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  };
  return document;
}

test('renderPreviewBanner renders hostile names as text in both builds', () => {
  const evil = '<img src=x onerror=alert(1)>';
  for (const file of PLAYERS) {
    const document = fakeDom();
    const ctx = {
      document, PREVIEW_MODE: true, VIEWER_MODE: false,
      previewBannerParts: { layout: 'Previewing dominant layout "' + evil + '"', orphans: 'items: ' + evil },
    };
    vm.runInNewContext(bannerFn(file) + '\nrenderPreviewBanner();', ctx);
    const el = document.getElementById('previewBanner');
    assert.ok(el, `${file}: banner not created`);
    assert.equal(el._html, undefined, `${file}: banner wrote innerHTML`);
    const kinds = el.children.map((c) => (c.nodeType === 3 ? 'text' : c.tagName));
    assert.deepEqual(kinds, ['text', 'BR', 'text'], `${file}: expected text, <br>, text`);
    assert.ok(el.children[0].textContent.includes(evil), `${file}: name must survive as literal text`);
  }
});
