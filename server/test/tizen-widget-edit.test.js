'use strict';

/*
 * Tizen: a widget edited while it is on screen must re-render (3.2.6 emulator pass). The playlist
 * signature includes widget_rev, so an edit is a structural change, and the "current item survives ->
 * keep playing it" path returned without rendering: Tizen kept the old page (old ticker text, old
 * gap) until the playlist was reassigned. The web player re-renders in place.
 * Loads the REAL tizen/js/player.js in a vm with the same DOM shim as pip-overlay.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- minimal DOM element shim: only what PlaylistPlayer.renderImage + PipOverlay use ---
function makeEl() {
  const el = {
    tag: '', style: {}, className: '', attrs: {}, children: [], _html: '', _src: '', _text: '',
    appendChild(c) { this.children.push(c); this._html = '<children>'; return c; },
    querySelector(sel) { return this.children.find(c => c.tag === sel) || null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {}, pause() {}, play() { return { catch() {} }; },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; if (v === '') this.children = []; } });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  // #187: renderImage is now decode-gated (swap-after-decode, never clear-then-load). This shim has
  // no HTMLImageElement.decode() and doesn't fire onload, so mark a src'd <img> already-decoded
  // (complete + naturalWidth>0) — renderImage then takes its synchronous complete-fallback branch and
  // mounts, exactly as the old clear-then-load path did. The decode()/onload timing itself is proven
  // in tizen-image-blackflash.test.js; here we only need the image to land in #stage.
  Object.defineProperty(el, 'complete', { get() { return !!this._src; } });
  Object.defineProperty(el, 'naturalWidth', { get() { return this._src ? 1 : 0; } });
  Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
  return el;
}

function loadPlayerContext() {
  // Controllable timer so the duration teardown is deterministic (no wall-clock waits).
  const timers = {};
  let seq = 0;
  const sandbox = {
    console,
    Date,
    setTimeout: (fn) => { const id = ++seq; timers[id] = fn; return id; },
    clearTimeout: (id) => { delete timers[id]; },
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
  };
  sandbox.document = { createElement: (tag) => { const e = makeEl(); e.tag = tag; return e; } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', p), 'utf8');
  vm.runInContext(read('player.js'), sandbox, { filename: 'player.js' });
  return { sandbox, timers };
}


const frameSrc = (stage) => { const f = stage.children.filter((c) => c.tag === 'iframe').pop(); return f ? f.src : null; };

test('an edited widget on screen re-renders with its new rev; an unrelated change does not', () => {
  const { sandbox } = loadPlayerContext();
  const stage = makeEl();
  const player = new sandbox.PlaylistPlayer(stage, () => 'http://server');
  const widget = (rev) => ({ widget_id: 'w1', widget_type: 'rss', mime_type: 'widget', sort_order: 0, duration_sec: 10, widget_rev: rev });
  const image = { content_id: 'c1', mime_type: 'image/png', sort_order: 1, duration_sec: 10 };

  player.load([widget(100), image]);
  assert.match(frameSrc(stage), /rev=100/);

  player.load([widget(200), image]);
  assert.match(frameSrc(stage), /rev=200/, 'the edited page is shown');
  assert.equal(player.getIndex(), 0, 'still on the widget');

  const framesBefore = stage.children.filter((c) => c.tag === 'iframe').length;
  player.load([widget(200), image, { content_id: 'c2', mime_type: 'image/png', sort_order: 2, duration_sec: 10 }]);
  assert.equal(stage.children.filter((c) => c.tag === 'iframe').length, framesBefore, 'adding another item does not re-render the widget');
});
