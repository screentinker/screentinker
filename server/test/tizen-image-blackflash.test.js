'use strict';

// #187 Tizen image black-flash verification test. Loads the REAL tizen/js/player.js into a
// node:vm context with a minimal hand-rolled DOM element shim (modeled on pip-overlay.test.js —
// the repo has NO jsdom; CI is plain `node --test --test-concurrency=2`).
//
// THE BUG (#187): the Tizen player black-flashed between IMAGE items because playCurrent() called
// clearStage() (stage.innerHTML='') BEFORE renderImage() set img.src, so #stage was empty (black)
// for the entire decode duration of the incoming image.
//
// THE FIX (already applied to tizen/js/player.js — this test only VERIFIES it): images now get a
// decode-gated one-ahead double buffer (mirrors the video preloader). renderImage takes a
// pre-decoded <img> (preloadImage/_takePreloadImage) or decodes a fresh detached <img>, and ONLY
// THEN clearStage()+appendChild — a SWAP, never clear-then-load. HTMLImageElement.decode() is
// feature-detected with an onload/complete fallback (Tizen 5.0 / SSSP6 may lack decode()). An
// onerror / decode-reject routes to skipSoon().
//
// THE INVARIANT PROVEN HERE: across an image->image transition, #stage is NEVER without a mounted
// <img> — the OLD <img> stays mounted until the NEW image's decode()/onload resolves, then it's
// swapped. A real black flash is a GPU/timing artifact that will not render headlessly, so we assert
// this DOM ordering invariant instead — it is the exact condition whose absence caused the flash.
//
// HOW THE TEST HAS TEETH (distinguishes swap-after-decode from the old clear-then-load): we wrap
// player.clearStage() and record the #stage <img> count at the instant it is called. Under the FIX,
// clearStage() is NOT called at all between "advance issued" and "new image decoded"; it fires
// exactly once, at swap time, with the OLD image (count 1) still mounted. Under the OLD ordering
// clearStage() fired in playCurrent() BEFORE the decode, so (a) clearLog would grow at advance time,
// and (b) the mounted element right after advance would be the undecoded NEW image (or empty), not
// the old one — both of which these assertions reject. (Proven to fail against a reverted copy in a
// /tmp scratch run during development; see the report.)
//
// ---------------------------------------------------------------------------------------------
// MANUAL ON-PANEL SIGN-OFF (Samsung OM55B / SSSP — headless proves the DOM invariant, but real
// decode-HW timing needs the panel):
//   1. Build + sideload the new .wgt onto the OM55B (Tizen CLI 6.1, ScreenTinker signing profile).
//   2. Assign a playlist of SEVERAL LARGE PNG stills (e.g. 4-6 full-res 1080p+ PNGs, short dwell
//      ~5-8s each so transitions come often).
//   3. Watch 10+ consecutive image->image transitions closely for ANY black/blank frame between
//      stills. Expected: each new still replaces the previous with no intervening black.
//   4. Confirm the OTHER item types still transition normally: add a video, a YouTube item, and a
//      widget/remote_url item to the playlist and watch image->video, video->image, image->widget,
//      widget->image handoffs — none should regress (only the image path changed; every other type
//      keeps the pre-dispatch clearStage()).
//   5. Optional: reboot the panel and re-watch to catch cold-decode timing.
//   Note: headless proves "old <img> stays mounted until the new one is decode-ready"; it CANNOT
//   prove the GPU actually paints the new frame before the swap — that is what the panel confirms.
// ---------------------------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Drain the host microtask queue (decode() promises resolve on the real microtask queue, independent
// of the sandbox's captured setTimeout). setImmediate fires after all pending microtasks.
const flush = () => new Promise((res) => setImmediate(res));

// --- minimal DOM element shim: extends pip-overlay's shim with what the fixed renderImage/preloadImage
// use on an <img>: settable src, onload/onerror handler props, complete + naturalWidth, and a
// test-controllable decode() Promise. Tracks parent/child links so appendChild/removeChild/parentNode/
// querySelector and innerHTML='' clearing all behave. ---
function makeEl() {
  const el = {
    tag: '', style: { cssText: '' }, className: '', attrs: {}, children: [], parentNode: null,
    _html: '', _src: '', _text: '',
    onload: null, onerror: null, complete: false, naturalWidth: 0,
    _decodeDeferreds: [],   // pending decode() controllers (test resolves/rejects them on demand)
    appendChild(c) { c.parentNode = this; this.children.push(c); this._html = '<children>'; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; },
    querySelector(sel) { return this.children.find(c => c.tag === sel) || null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {}, pause() {}, play() { return { catch() {} }; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; if (v === '') { this.children.forEach(c => { c.parentNode = null; }); this.children = []; } },
  });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
  return el;
}

// Give an <img> element a test-controllable decode() (only when decode() is "supported" for the run).
function attachDecode(el) {
  el.decode = function () {
    return new Promise((resolve, reject) => { el._decodeDeferreds.push({ resolve, reject }); });
  };
}

// Settle EVERY pending decode() call recorded on an element (preloadImage and renderImage each call
// decode() on the same warmed element, so there can be more than one). ok=false -> reject.
function settleDecode(el, ok) {
  const ds = el._decodeDeferreds.splice(0);
  ds.forEach(d => (ok ? d.resolve() : d.reject(new Error('decode failed'))));
}

// Fire an element's onload/onerror handler (the decode()-unsupported fallback path).
function fireLoad(el) { if (typeof el.onload === 'function') el.onload(); }
function fireError(el) { if (typeof el.onerror === 'function') el.onerror(); }

function loadPlayerContext(opts) {
  opts = opts || {};
  const decodeSupported = opts.decodeSupported !== false; // default: decode() available
  const created = [];                                     // every element the player creates
  const timers = {};
  let seq = 0;
  const sandbox = {
    console, Date,
    setTimeout: (fn) => { const id = ++seq; timers[id] = fn; return id; },
    clearTimeout: (id) => { delete timers[id]; },
    setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
  };
  sandbox.document = {
    createElement: (tag) => {
      const e = makeEl(); e.tag = tag;
      if (tag === 'img' && decodeSupported) attachDecode(e);
      created.push(e);
      return e;
    },
    getElementById: () => null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', p), 'utf8');
  vm.runInContext(read('player.js'), sandbox, { filename: 'player.js' });
  return { sandbox, timers, created };
}

// Test helpers -------------------------------------------------------------------------------------
function imgItem(id, order) { return { content_id: id, mime_type: 'image/png', sort_order: order, duration_sec: 10 }; }

// Build a player over a fresh stage, instrument clearStage to log the #stage <img> count at call time,
// and return the handles the cases need.
function newPlayer(ctx) {
  const stage = makeEl(); stage.tag = 'div';
  const player = new ctx.sandbox.PlaylistPlayer(stage, () => 'http://server');
  const clearLog = [];                 // #stage <img> count captured at each clearStage() call
  const stageImgs = () => stage.children.filter(c => c.tag === 'img');
  const _clear = player.clearStage.bind(player);
  player.clearStage = function () { clearLog.push(stageImgs().length); return _clear(); };
  const findImg = (frag) => ctx.created.filter(c => c.tag === 'img').find(c => c.src.indexOf(frag) >= 0);
  return { stage, player, clearLog, stageImgs, findImg };
}

// Fire the single pending advance timer (solo playback's duration timer).
function fireOnlyTimer(timers) {
  const ids = Object.keys(timers);
  assert.equal(ids.length, 1, 'exactly one advance timer pending');
  timers[ids[0]]();
}

// CASE 1 — decode() SUPPORTED: image A -> image B swaps only AFTER B decodes; #stage never empties.
test('#187 decode() supported: image->image keeps the old <img> mounted until the new one decodes, then swaps', async () => {
  const ctx = loadPlayerContext({ decodeSupported: true });
  const { player, clearLog, stageImgs, findImg } = newPlayer(ctx);

  player.load([imgItem('A', 0), imgItem('B', 1)]);
  // Initial load: A is decode-gated (pending). This is the FIRST image, so an empty stage here is
  // expected (there is no previous image to hold) — the invariant is about image->image transitions.
  const aImg = findImg('A/file');
  assert.ok(aImg, 'image A element created and decode-gated');
  assert.equal(stageImgs().length, 0, 'A not mounted until its decode resolves');

  settleDecode(aImg, true);
  await flush();
  assert.equal(stageImgs().length, 1, 'A mounted after its decode resolved');
  assert.equal(stageImgs()[0], aImg, 'the mounted <img> is A');

  // Mounting A warmed the NEXT image (B) via preloadImage. Advancing to B must NOT clear the stage
  // until B is decode-ready.
  const clearsBefore = clearLog.length;
  fireOnlyTimer(ctx.timers);                 // duration timer -> advance() -> playCurrent(B) -> renderImage(B)

  // *** THE INVARIANT ***: after the advance is issued but BEFORE B's decode resolves, #stage still
  // holds A's <img> — not empty, not B. And clearStage() has NOT been called (no clear-then-load).
  assert.equal(clearLog.length, clearsBefore, 'clearStage() NOT called before B decodes (no clear-then-load)');
  assert.equal(stageImgs().length, 1, '#stage still has exactly one <img> mid-transition (never 0)');
  assert.equal(stageImgs()[0], aImg, 'the still-mounted <img> is A, not empty and not the undecoded B');

  const bImg = findImg('B/file');
  assert.ok(bImg, 'image B was pre-created (warmed) for the transition');
  assert.notEqual(bImg, aImg, 'B is a distinct element from A');

  settleDecode(bImg, true);                  // B finished decoding -> swap
  await flush();

  // Swap happened: clearStage() fired exactly once, and at that instant A (count 1) was still mounted
  // — proving the stage was never emptied ahead of the decode.
  assert.equal(clearLog.length, clearsBefore + 1, 'clearStage() called exactly once, at swap time');
  assert.equal(clearLog[clearsBefore], 1, 'at the swap-clear, A (count 1) was still mounted — stage never emptied early');
  assert.equal(stageImgs().length, 1, '#stage has exactly one <img> after the swap');
  assert.equal(stageImgs()[0], bImg, 'B is now the mounted <img>');
});

// CASE 2 — decode() UNSUPPORTED (Tizen 5.0 / SSSP6 fallback): same never-empty invariant via onload.
test('#187 decode() unsupported (onload fallback): image->image holds the old <img> until onload, then swaps', async () => {
  const ctx = loadPlayerContext({ decodeSupported: false });
  const { player, clearLog, stageImgs, findImg } = newPlayer(ctx);

  // Sanity: the shim really did NOT expose decode() this run, so we exercise the fallback branch.
  const probe = ctx.sandbox.document.createElement('img');
  assert.notEqual(typeof probe.decode, 'function', 'decode() is unsupported this run (fallback path exercised)');

  player.load([imgItem('A', 0), imgItem('B', 1)]);
  const aImg = findImg('A/file');
  assert.ok(aImg, 'image A element created');
  assert.equal(stageImgs().length, 0, 'A not mounted until onload fires');

  fireLoad(aImg);                            // onload -> mount A (synchronous in the fallback path)
  await flush();
  assert.equal(stageImgs().length, 1, 'A mounted after onload');
  assert.equal(stageImgs()[0], aImg, 'the mounted <img> is A');

  const clearsBefore = clearLog.length;
  fireOnlyTimer(ctx.timers);                 // advance -> renderImage(B); B.onload not yet fired

  // Invariant on the fallback path: A stays mounted while B is still loading; no clear-then-load.
  assert.equal(clearLog.length, clearsBefore, 'clearStage() NOT called before B loads (fallback)');
  assert.equal(stageImgs().length, 1, '#stage still has exactly one <img> mid-transition (never 0)');
  assert.equal(stageImgs()[0], aImg, 'the still-mounted <img> is A');

  const bImg = findImg('B/file');
  assert.ok(bImg, 'image B element created for the transition');
  fireLoad(bImg);                            // B loaded -> swap
  await flush();

  assert.equal(clearLog.length, clearsBefore + 1, 'clearStage() called exactly once, at swap time');
  assert.equal(clearLog[clearsBefore], 1, 'at the swap-clear, A was still mounted — stage never emptied early');
  assert.equal(stageImgs().length, 1, '#stage has exactly one <img> after the swap');
  assert.equal(stageImgs()[0], bImg, 'B is now the mounted <img>');
});

// CASE 3a — a broken incoming image (decode reject) must skipSoon() and must NOT disturb the mounted
// image (fail() never clears the stage), so a bad image causes no black flash either.
test('#187 broken image (decode reject) calls skipSoon and leaves the current image mounted', async () => {
  const ctx = loadPlayerContext({ decodeSupported: true });
  const { player, stageImgs, findImg } = newPlayer(ctx);

  let skips = 0;
  const _skip = player.skipSoon.bind(player);
  player.skipSoon = function () { skips += 1; return _skip(); };

  player.load([imgItem('A', 0), imgItem('B', 1)]);
  const aImg = findImg('A/file');
  settleDecode(aImg, true);
  await flush();
  assert.equal(stageImgs()[0], aImg, 'A mounted');

  fireOnlyTimer(ctx.timers);                 // advance to B
  const bImg = findImg('B/file');
  settleDecode(bImg, false);                 // B's decode REJECTS (broken URL)
  await flush();

  assert.equal(skips, 1, 'a decode-reject routed to skipSoon()');
  assert.equal(stageImgs().length, 1, '#stage still holds an <img> (no black) after a broken image');
  assert.equal(stageImgs()[0], aImg, 'the broken B was NOT mounted; A stays until a good frame is ready');
});

// CASE 3b — same guard on the fallback path: onerror -> skipSoon(), current image untouched.
test('#187 broken image (onerror fallback) calls skipSoon and leaves the current image mounted', async () => {
  const ctx = loadPlayerContext({ decodeSupported: false });
  const { player, stageImgs, findImg } = newPlayer(ctx);

  let skips = 0;
  const _skip = player.skipSoon.bind(player);
  player.skipSoon = function () { skips += 1; return _skip(); };

  player.load([imgItem('A', 0), imgItem('B', 1)]);
  const aImg = findImg('A/file');
  fireLoad(aImg);
  await flush();
  assert.equal(stageImgs()[0], aImg, 'A mounted');

  fireOnlyTimer(ctx.timers);                 // advance to B
  const bImg = findImg('B/file');
  fireError(bImg);                           // B fails to load
  await flush();

  assert.equal(skips, 1, 'an onerror routed to skipSoon()');
  assert.equal(stageImgs().length, 1, '#stage still holds an <img> (no black) after a broken image');
  assert.equal(stageImgs()[0], aImg, 'the broken B was NOT mounted; A stays put');
});
