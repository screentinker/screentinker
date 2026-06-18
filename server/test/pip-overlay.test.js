'use strict';

// #109 PiP player-layer test. Loads the REAL tizen/js/player.js + tizen/js/pip-overlay.js
// into a vm context with a minimal DOM shim (the repo has no jsdom; node --test only).
// Proves the overlay shows and auto-dismisses WITHOUT changing the playlist signature
// underneath — i.e. PipOverlay writes only to #pip and never to #stage / PlaylistPlayer.

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
  vm.runInContext(read('pip-overlay.js'), sandbox, { filename: 'pip-overlay.js' });
  return { sandbox, timers };
}

test('pip: overlay shows in #pip and never touches #stage / the playlist signature', () => {
  const { sandbox } = loadPlayerContext();
  const stage = makeEl();
  const pip = makeEl();

  // A 1-item image playlist; capture the signature the renderer computes.
  const player = new sandbox.PlaylistPlayer(stage, () => 'http://server');
  player.load([{ content_id: 'c1', mime_type: 'image/png', sort_order: 0, duration_sec: 10 }]);
  const sigBefore = player.sig;
  const stageChildrenBefore = stage.children.length;
  assert.ok(sigBefore, 'player computed a playlist signature');
  assert.ok(stageChildrenBefore >= 1, 'playlist rendered into #stage');

  const logs = [];
  const overlay = new sandbox.PipOverlay(pip, { document: sandbox.document, log: (lvl, msg) => logs.push([lvl, msg]) });

  overlay.show({ pip_id: 'p1', type: 'image', uri: 'http://img/x.png', position: 'top-right', width: 480, height: 360, duration: 30 });
  assert.equal(pip.children.length, 1, 'overlay box rendered into #pip');
  assert.equal(player.sig, sigBefore, 'playlist signature unchanged by pip show');
  assert.equal(stage.children.length, stageChildrenBefore, '#stage untouched by pip show');
  assert.ok(logs.some(l => l[1].indexOf('pip show') === 0), 'show reported over the log channel');
});

test('pip: duration timer auto-dismisses without disturbing the playlist', () => {
  const { sandbox, timers } = loadPlayerContext();
  const stage = makeEl();
  const pip = makeEl();
  const player = new sandbox.PlaylistPlayer(stage, () => 'http://server');
  player.load([{ content_id: 'c1', mime_type: 'image/png', sort_order: 0, duration_sec: 10 }]);
  const sigBefore = player.sig;

  const overlay = new sandbox.PipOverlay(pip, { document: sandbox.document });
  overlay.show({ pip_id: 'p1', type: 'image', uri: 'http://img/x.png', duration: 5 });
  assert.equal(pip.children.length, 1, 'overlay shown');

  // Fire the scheduled duration timer (deterministic: the sandbox setTimeout captured it).
  const ids = Object.keys(timers);
  assert.equal(ids.length, 1, 'a single duration timer was scheduled');
  timers[ids[0]]();

  assert.equal(pip.children.length, 0, 'overlay auto-dismissed at duration');
  assert.equal(player.sig, sigBefore, 'playlist signature still unchanged after dismiss');
});

test('pip: web type renders an iframe; last-show-wins; targeted clear is id-aware', () => {
  const { sandbox } = loadPlayerContext();
  const pip = makeEl();
  const overlay = new sandbox.PipOverlay(pip, { document: sandbox.document });

  overlay.show({ pip_id: 'web1', type: 'web', uri: 'https://example.com', duration: 0 });
  assert.equal(pip.children.length, 1);
  const box = pip.children[0];
  assert.ok(box.children.some(c => c.tag === 'iframe'), 'web overlay uses an <iframe>');
  assert.equal(box.children.find(c => c.tag === 'iframe').attrs.allow, '', 'web audio muted by default (empty allow)');

  // last-show-wins: a second show replaces the first (still a single slot).
  overlay.show({ pip_id: 'web2', type: 'image', uri: 'http://img/y.png', duration: 0 });
  assert.equal(pip.children.length, 1, 'single overlay slot after a replacing show');

  // a clear for a STALE pip_id is a no-op; the matching id clears.
  overlay.clear('web1');
  assert.equal(pip.children.length, 1, 'stale-id clear ignored');
  overlay.clear('web2');
  assert.equal(pip.children.length, 0, 'matching-id clear tore down the overlay');
});

test('pip: a malformed payload cannot wedge the layer', () => {
  const { sandbox } = loadPlayerContext();
  const pip = makeEl();
  const overlay = new sandbox.PipOverlay(pip, { document: sandbox.document });

  // doc.createElement throws -> show must swallow it, tear down, and stay usable.
  const boom = { createElement: () => { throw new Error('boom'); } };
  const broken = new sandbox.PipOverlay(pip, { document: boom });
  broken.show({ pip_id: 'x', type: 'image', uri: 'http://img/x.png', duration: 0 });
  assert.equal(pip.children.length, 0, 'no half-built overlay left behind');

  // the healthy overlay still works afterwards
  overlay.show({ pip_id: 'ok', type: 'image', uri: 'http://img/ok.png', duration: 0 });
  assert.equal(pip.children.length, 1, 'layer still usable after a malformed payload');
});
