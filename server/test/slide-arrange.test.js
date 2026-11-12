'use strict';

// The Slides editor's canvas arithmetic (frontend/js/components/slide-arrange.js): resize by handle,
// align, distribute, layer order, paste identity, slot repair and undo history. Pure, so pinned here;
// the browser half is test/slides-drag-e2e.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'slide-arrange.js')).href);
const R = (x, y, w, h) => ({ x, y, w, h });
const close = (a, b) => { for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} vs ${b[k]}`); };

test('resize: a corner moves only the edges it touches; the opposite corner stays put', async () => {
  const { resizeRect } = await load();
  close(resizeRect(R(10, 10, 20, 10), 'se', 5, 3), R(10, 10, 25, 13));
  close(resizeRect(R(10, 10, 20, 10), 'nw', 5, 3), R(15, 13, 15, 7));
  close(resizeRect(R(10, 10, 20, 10), 'e', 5, 99), R(10, 10, 25, 10));
  close(resizeRect(R(10, 10, 20, 10), 'n', 99, -4), R(10, 6, 20, 14));
});

test('resize: aspect lock keeps w:h at a corner and on a side', async () => {
  const { resizeRect } = await load();
  const r = resizeRect(R(10, 10, 20, 10), 'se', 10, 1, { keepAspect: true });
  assert.ok(Math.abs(r.w / r.h - 2) < 1e-9); close(r, R(10, 10, 30, 15));
  const s = resizeRect(R(10, 10, 20, 10), 'e', 10, 0, { keepAspect: true });
  close(s, R(10, 7.5, 30, 15));   // grows about its vertical centre
});

test('resize: from the centre grows both sides, and never below the minimum', async () => {
  const { resizeRect } = await load();
  close(resizeRect(R(10, 10, 20, 10), 'e', 5, 0, { fromCenter: true }), R(5, 10, 30, 10));
  const tiny = resizeRect(R(10, 10, 20, 10), 'w', 50, 0, { minW: 2 });
  assert.equal(tiny.w, 2); assert.equal(tiny.x, 28);
  const lockedTiny = resizeRect(R(0, 0, 20, 10), 'se', -100, -100, { keepAspect: true, minW: 2, minH: 0.5 });
  assert.ok(lockedTiny.w >= 2 && lockedTiny.h >= 0.5 && Math.abs(lockedTiny.w / lockedTiny.h - 2) < 1e-9);
});

test('align: several align to each other; one aligns to the slide', async () => {
  const { alignRects } = await load();
  const two = [R(10, 10, 10, 10), R(40, 30, 20, 10)];
  assert.deepEqual(alignRects(two, 'left').map((r) => r.x), [10, 10]);
  assert.deepEqual(alignRects(two, 'right').map((r) => r.x), [50, 40]);
  assert.deepEqual(alignRects(two, 'center').map((r) => r.x), [30, 25]);
  assert.deepEqual(alignRects(two, 'bottom').map((r) => r.y), [30, 30]);
  assert.deepEqual(alignRects(two, 'middle').map((r) => r.y), [20, 20]);
  assert.deepEqual(alignRects([R(10, 10, 20, 10)], 'center').map((r) => r.x), [40]);
});

test('distribute: equal gaps, the ends stay, order follows position not selection', async () => {
  const { distributeRects } = await load();
  const out = distributeRects([R(80, 0, 10, 5), R(0, 0, 10, 5), R(20, 0, 20, 5)], 'x');
  assert.deepEqual(out.map((r) => r.x), [80, 0, 35]);   // span 90, sizes 40, gap 25
  assert.deepEqual(distributeRects([R(0, 0, 1, 1), R(5, 0, 1, 1)], 'x').map((r) => r.x), [0, 5]);
});

test('layer order: front, back, forward, backward keep the selection together', async () => {
  const { reorder } = await load();
  assert.deepEqual(reorder(4, [1], 'front'), [0, 2, 3, 1]);
  assert.deepEqual(reorder(4, [2], 'back'), [2, 0, 1, 3]);
  assert.deepEqual(reorder(4, [1], 'forward'), [0, 2, 1, 3]);
  assert.deepEqual(reorder(4, [3], 'forward'), [0, 1, 2, 3]);
  assert.deepEqual(reorder(4, [1, 2], 'backward'), [1, 2, 0, 3]);
  assert.deepEqual(reorder(4, [0], 'backward'), [0, 1, 2, 3]);
});

test('paste: copies get NEW unique slots and ids, carry their words, and land offset', async () => {
  const { copyElements, pasteElements } = await load();
  const slide = { template: { elements: [{ slot: 'a', id: 'el_1', kind: 'head', box: { x: 1, y: 2, w: 3 } }] }, fields: { a: 'Hello' } };
  const clip = copyElements(slide, [0]);
  slide.template.elements[0].box.x = 50;                // the clipboard is a copy, not a reference
  const idx = pasteElements(slide, clip, 2);
  const idx2 = pasteElements(slide, clip, 4);
  const els = slide.template.elements;
  assert.deepEqual([idx, idx2], [[1], [2]]);
  assert.equal(new Set(els.map((e) => e.slot)).size, 3);
  assert.equal(new Set(els.map((e) => e.id)).size, 3);
  assert.equal(slide.fields[els[1].slot], 'Hello');
  assert.deepEqual(els[1].box, { x: 3, y: 4, w: 3 });
});

test('slot repair: twins get a new slot and a copy of the words; nothing else changes', async () => {
  const { repairSlots } = await load();
  const slide = { template: { elements: [
    { slot: 'title', kind: 'head', id: 'x' }, { slot: 'title', kind: 'body', id: 'x' }, { slot: 'other', kind: 'body' },
  ] }, fields: { title: 'Hi', other: 'There' } };
  assert.equal(repairSlots(slide), 2);
  const [a, b, c] = slide.template.elements;
  assert.equal(a.slot, 'title'); assert.notEqual(b.slot, 'title'); assert.equal(c.slot, 'other');
  assert.equal(slide.fields[b.slot], 'Hi'); assert.equal(slide.fields.title, 'Hi');
  assert.notEqual(a.id, b.id);
  assert.equal(repairSlots(slide), 0, 'idempotent');
});

test('history: undo and redo restore exactly; a new edit clears redo; slider bursts coalesce', async () => {
  const { createHistory } = await load();
  const h = createHistory(3);
  h.reset('A');
  h.record('B'); h.record('C');
  assert.equal(h.undo('C'), 'B'); assert.equal(h.undo('B'), 'A'); assert.equal(h.undo('A'), null);
  assert.equal(h.redo('A'), 'B'); assert.equal(h.redo('B'), 'C'); assert.equal(h.redo('C'), null);
  h.undo('C'); h.record('D');
  assert.equal(h.redo('D'), null, 'editing after an undo drops the redo branch');
  h.reset('0');
  h.record('1', { coalesce: 'v', now: 1000 }); h.record('2', { coalesce: 'v', now: 1100 }); h.record('3', { coalesce: 'v', now: 1200 });
  assert.equal(h.undo('3'), '0', 'one slider drag is one step');
  h.reset('a'); for (const s of ['b', 'c', 'd', 'e']) h.record(s);
  let n = 0; let cur = 'e'; while ((cur = h.undo(cur))) n++;
  assert.equal(n, 3, 'bounded');
});

test('history: an unrecorded change is recorded before undoing it', async () => {
  const { createHistory } = await load();
  const h = createHistory();
  h.reset('A');
  assert.equal(h.undo('B'), 'A');
  assert.equal(h.redo('A'), 'B');
});

test('a duplicated slide is a new, unpublished copy placed right after its original', async () => {
  const { duplicateSlide } = await load();
  const original = {
    id: 's_orig', name: 'Lobby', dwell_sec: 17, widget_id: 'w-published',
    template: {
      background: '#123456', background_content_id: 'img1', background_dim: 0.3, audio: { vo: 'a1', vo_volume: 0.5 },
      elements: [
        { id: 'el_a', slot: 'f_a', kind: 'head', box: { x: 5, y: 6, w: 50 }, style: { color: '#FF0000', size_cqw: 7 },
          motion: { animation: 'fade', delay: 0.4, duration: 0.9 } },
        { id: 'el_b', slot: 'f_b', kind: 'image', content_id: 'img2', box: { x: 60, y: 10, w: 30, h: 30 } },
        { slot: 'f_c', kind: 'body', box: { x: 5, y: 70, w: 80 } },
      ],
    },
    fields: { f_a: 'Welcome', f_c: 'Details' },
  };
  const slides = [{ id: 's_first', widget_id: 'w1', template: { elements: [] }, fields: {} }, original,
    { id: 's_last', widget_id: 'w3', template: { elements: [] }, fields: {} }];
  const before = JSON.stringify(original);

  const at = duplicateSlide(slides, 1, 'Lobby (copy)');
  assert.equal(at, 2);
  assert.equal(slides.length, 4);
  assert.deepEqual(slides.map((s) => s.id).filter((id) => id !== slides[2].id), ['s_first', 's_orig', 's_last'],
    'the copy did not land directly after its original');
  const copy = slides[2];

  // Nothing published carries over, and the identity is new.
  assert.equal(copy.widget_id, null, 'the copy kept the original\'s widget_id, so publishing it would overwrite the original');
  assert.notEqual(copy.id, original.id);
  assert.equal(new Set(slides.map((s) => s.id)).size, slides.length, 'slide ids are not unique in the deck');
  assert.equal(copy.name, 'Lobby (copy)');
  const origIds = original.template.elements.map((e) => e.id).filter(Boolean);
  for (const e of copy.template.elements) if (e.id != null) assert.ok(!origIds.includes(e.id), `element id ${e.id} was reused`);
  assert.equal(copy.template.elements[2].id, undefined, 'an element without an id was given one');

  // Everything the author made is the same.
  const strip = (s) => ({ ...s, id: 0, name: 0, widget_id: 0,
    template: { ...s.template, elements: s.template.elements.map((e) => ({ ...e, id: e.id == null ? e.id : 0 })) } });
  assert.deepEqual(strip(copy), strip(original));

  // ...and independent: editing the copy leaves the original untouched.
  copy.fields.f_a = 'Changed'; copy.template.elements[0].box.x = 99; copy.template.audio.vo = 'other';
  assert.equal(JSON.stringify(original), before, 'the copy shares objects with the original');

  assert.equal(duplicateSlide(slides, 9), -1);
  assert.equal(slides.length, 4);
});
