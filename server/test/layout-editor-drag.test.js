'use strict';

/*
 * #316: dragging a zone in the layout editor must move the zone you can see.
 *
 * The mousedown handler sets the selection and calls renderZones(), which removes every .zone-el
 * and rebuilds them. From that point the `el` the handler closed over is detached: the drag kept
 * updating z.x_percent (the data object survives) but painted onto an orphan node, so nothing moved
 * under the pointer and the zone only jumped to its new position at the next render — the next time
 * the operator clicked. Reported from Spain as "the squares can't be moved freely, their position
 * updates after clicking again", in both Chrome and Firefox, which is the signature of a DOM bug
 * rather than an input one.
 *
 * Source-level: this is browser code with no DOM here to drive. The property is a relationship —
 * whatever the drag writes to must be re-acquired AFTER the re-render that invalidates it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'layout-editor.js'), 'utf8');

// The move handler: from `el.onmousedown` to the end of its listener wiring.
function moveHandler() {
  const at = SRC.indexOf('el.onmousedown');
  assert.ok(at > 0, 'zone move handler found');
  const end = SRC.indexOf('const handle = document.createElement', at);
  assert.ok(end > at, 'end of the move handler found');
  return SRC.slice(at, end);
}

test('#316: the drag re-acquires the node after renderZones() rebuilt it', () => {
  const fn = moveHandler();
  const renderAt = fn.indexOf('renderZones()');
  assert.ok(renderAt > 0, 'the handler still re-renders on mousedown');
  const reacquireAt = fn.search(/querySelector\(`?\.?['"`]?\.zone-el\[data-index/);
  assert.ok(reacquireAt > 0, 'the handler must look the element up again');
  assert.ok(reacquireAt > renderAt,
    'the lookup must come AFTER renderZones(), or it captures the node that is about to be destroyed');
});

test('#316: the drag never writes position to the pre-render node', () => {
  const fn = moveHandler();
  const onMove = fn.slice(fn.indexOf('const onMove'), fn.indexOf('const onUp'));
  assert.doesNotMatch(onMove, /\bel\.style\.(left|top)\b/,
    'writing to `el` paints a detached node: the zone moves in the data and not on screen');
  assert.match(onMove, /\blive\.style\.left\b/);
  assert.match(onMove, /\blive\.style\.top\b/);
});

test('the zone elements still carry the index the lookup keys on', () => {
  assert.match(SRC, /el\.dataset\.index = i;/,
    'the re-acquire selector matches on [data-index], so it has to be set');
});

test('the resize handle is untouched (it never re-rendered, so it never had the bug)', () => {
  const at = SRC.indexOf('handle.onmousedown');
  assert.ok(at > 0, 'resize handler found');
  const fn = SRC.slice(at, at + 1400);
  assert.doesNotMatch(fn, /renderZones\(\)/,
    'if the resize handler ever starts re-rendering on mousedown it inherits the same bug');
});
