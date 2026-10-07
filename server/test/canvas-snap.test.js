'use strict';

// Snapping for the wall and layout editors (frontend/js/components/snap.js): lining panels and zones
// up by hand to the pixel was the hard part of both. Pure maths, so it is pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'snap.js')).href);
const A = { x: 0, y: 0, w: 1920, h: 1080 };

test('a screen dragged near another snaps edge to edge, level with it, and shows both guides', async () => {
  const { snapMove } = await load();
  const r = snapMove({ x: 1926, y: 5, w: 1920, h: 1080 }, [A], { threshold: 10 });
  assert.equal(r.x, 1920);
  assert.equal(r.y, 0);
  assert.deepEqual(r.guides.map((g) => g.axis).sort(), ['x', 'y']);
});

test('with a bezel gap it snaps to sit exactly one bezel away', async () => {
  const { snapMove } = await load();
  const r = snapMove({ x: 1940, y: 0, w: 1920, h: 1080 }, [A], { threshold: 10, gap: { x: 12, y: 0 } });
  assert.equal(r.x, 1932);
});

test('out of range it does not move, and draws no guide', async () => {
  const { snapMove } = await load();
  const r = snapMove({ x: 1960, y: 300, w: 1920, h: 1080 }, [A], { threshold: 10 });
  assert.equal(r.x, 1960); assert.equal(r.y, 300);
  assert.deepEqual(r.guides, []);
});

test('the nearest target wins when several are in range', async () => {
  const { snapMove } = await load();
  const r = snapMove({ x: 1923, y: 0, w: 100, h: 100 }, [A, { x: 2028, y: 0, w: 10, h: 10 }], { threshold: 10 });
  assert.equal(r.x, 1920);   // right edge 2023 is 5 from 2028; left 1923 is 3 from 1920 — 3 wins
});

test('centres line up too (a zone centred on the canvas)', async () => {
  const { snapMove } = await load();
  const r = snapMove({ x: 47, y: 10, w: 10, h: 10 }, [], { threshold: 2, bounds: { x: 0, y: 0, w: 100, h: 100 } });
  assert.equal(r.x, 45);   // centre 52 → 50
});

test('resizing moves only the dragged edge, and never below the minimum', async () => {
  const { snapResize } = await load();
  const e = snapResize({ x: 1920, y: 0, w: 1914, h: 1080 }, 'e', [{ x: 3840, y: 0, w: 10, h: 10 }], { threshold: 10 });
  assert.equal(e.x, 1920); assert.equal(e.w, 1920);
  const w = snapResize({ x: 1925, y: 0, w: 500, h: 100 }, 'w', [A], { threshold: 10 });
  assert.equal(w.x, 1920); assert.equal(w.w, 505);
  const tiny = snapResize({ x: 0, y: 0, w: 50, h: 50 }, 'e', [{ x: 5, y: 0, w: 1, h: 1 }], { threshold: 50, minW: 40 });
  assert.equal(tiny.w, 50, 'a snap that would shrink below the minimum is refused');
});
