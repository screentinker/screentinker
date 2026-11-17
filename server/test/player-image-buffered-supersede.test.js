'use strict';

/*
 * renderImageBuffered had no supersede guard.
 *
 * renderVideoBuffered and renderWallBuffered capture renderSeq and bail if a newer render (or a
 * teardown) moved it. The image path did not: if an emergency alert, a mixer cut_now, a stage change
 * or a DPAD skip ran renderContent while an image was still loading/decoding (the watchdog allows
 * 3 s), the late swap → mountImage → teardownCurrentMedia() removed the NEWER content and armed the
 * old image's dwell, and the watchdog's fail path skipped with scheduleAdvance over the new item's
 * timer. These run the real renderImageBuffered from index.html against fakes.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function harness({ cached = false } = {}) {
  const start = PLAYER.indexOf('    function renderImageBuffered(');
  const end = PLAYER.indexOf('\n    }\n', start) + 7;
  assert.ok(start > 0 && end > start, 'renderImageBuffered is still in index.html');
  const src = PLAYER.slice(start, end);

  const timers = [];
  const calls = { mounted: [], skipped: [], transitions: 0, discarded: 0 };
  const loads = [];
  const img = { complete: true, naturalWidth: 10, decode: () => Promise.resolve() };
  const env = {
    imgSrcFor: () => '/img.png',
    proxySrcFor: () => '/proxy/img.png',
    imgPreloadCache: cached ? { '/img.png': img } : {},
    glTxAbort: null,
    currentTexturableFrame: () => null,
    isMediaReadable: () => true,
    transitionRuntimeReady: () => false,
    runImageTransition: () => { calls.transitions++; },
    mountImage: (el, item) => { calls.mounted.push(item); },
    mediaFailureSkip: (el, label, s) => { calls.skipped.push(s); },
    loadImageCors: (s, proxy, ok, fail) => { loads.push({ ok, fail }); },
    discardPendingSwap: () => { calls.discarded++; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; },
    Promise,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `let renderSeq = 1;\n${src}\nreturn { renderImageBuffered, bump() { renderSeq++; } };`);
  const api = make(...names.map((n) => env[n]));
  return { api, calls, loads, timers, img };
}

const item = { id: 'a', filename: 'a.png', mime_type: 'image/png', duration_sec: 10 };
const flush = () => new Promise((r) => setImmediate(r));

test('a newer render during the load: the late image does not mount over it', async () => {
  const h = harness();
  h.api.renderImageBuffered(item);
  h.api.bump();                                  // renderContent for an emergency alert / skip
  h.loads[0].ok(h.img);
  await flush();
  assert.equal(h.calls.mounted.length, 0, 'the stale image tore down the newer content and armed its dwell');
  assert.equal(h.calls.transitions, 0);
});

test('a newer render during the load: a failed load does not skip over the new item', () => {
  const h = harness();
  h.api.renderImageBuffered(item);
  h.api.bump();
  h.loads[0].fail();
  assert.equal(h.calls.skipped.length, 0, 'the stale failure scheduled an advance over the new item\'s timer');
});

test('a newer render during the load: the watchdog does not skip over the new item', () => {
  const h = harness();
  h.api.renderImageBuffered(item);
  h.api.bump();
  const wd = h.timers.find((t) => t.ms === 3000 && t.live);
  assert.ok(wd, 'the 3 s watchdog is armed');
  wd.fn();
  assert.equal(h.calls.skipped.length, 0);
  assert.equal(h.calls.mounted.length, 0);
});

test('not superseded: the image still mounts, and a failure still skips', async () => {
  const h = harness();
  h.api.renderImageBuffered(item);
  h.loads[0].ok(h.img);
  await flush();
  assert.equal(h.calls.mounted.length, 1);

  const f = harness();
  f.api.renderImageBuffered(item);
  f.loads[0].fail();
  assert.equal(f.calls.skipped.length, 1);
});

test('a pre-decoded image still mounts at once', () => {
  const h = harness({ cached: true });
  h.api.renderImageBuffered(item);
  assert.equal(h.calls.mounted.length, 1);
});

test('a still-loading widget swap is discarded, so it cannot reveal over the image', () => {
  const h = harness();
  h.api.renderImageBuffered(item);
  assert.equal(h.calls.discarded, 1);
});
