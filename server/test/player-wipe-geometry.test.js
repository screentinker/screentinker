'use strict';
/*
 * A wipe is drawn in the stage's OWN box, turned as the stage is.
 *
 * A portrait panel rotates #playerContainer with a CSS transform (server/lib/orientation-style.js). A
 * transform does not move the layout box: clientWidth/clientHeight are the box the <img> is fitted
 * into, and getBoundingClientRect() is the rotated, axis-aligned envelope, so on a portrait panel each
 * is the other's transpose. The GL wipe fitted both frames into the envelope and painted them on a
 * fixed, unrotated overlay, so every transition on a portrait screen jumped to landscape framing at
 * its start and back at its end. Measured across the boundary with grid slides on a local server:
 * 5 dB PSNR, where a 4 px shift scores 19 dB. Fourteen glitch effects hid it; a plain crossfade could
 * not, which is how it was found.
 *
 * Source-level, like the hardware-plane guards, because the property is an absence: nothing in the
 * transition path may frame from the envelope, and every frame a wipe composites must come from the
 * one helper that knows the stage's box and placement.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function extract(name) {
  const at = PLAYER.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found`);
  let i = PLAYER.indexOf('{', at), depth = 0, end = i;
  for (; end < PLAYER.length; end++) {
    if (PLAYER[end] === '{') depth++;
    else if (PLAYER[end] === '}' && --depth === 0) { end++; break; }
  }
  return PLAYER.slice(at, end);
}

const PLACEMENT = ['left', 'top', 'transform', 'transformOrigin'];

test('stageGeometry reads the layout box and the computed placement, never the rotated envelope', () => {
  const geo = extract('stageGeometry');
  assert.match(geo, /clientWidth/); assert.match(geo, /clientHeight/);
  assert.match(geo, /getComputedStyle/, 'computed: the wipe follows whatever placed the stage rather than re-deriving it');
  for (const prop of PLACEMENT) assert.match(geo, new RegExp(`\\b${prop}\\b`), `${prop} must be part of the geometry`);
  assert.doesNotMatch(geo, /getBoundingClientRect/, 'the rect is the rotated envelope, not the box the image is fitted into');
});

test('the wipe canvas takes the stage box AND its placement: size, left, top, transform, origin', () => {
  const wipe = extract('runGlWipe');
  assert.match(wipe, /stageGeometry\(\)/);
  assert.doesNotMatch(wipe, /getBoundingClientRect/);
  for (const prop of PLACEMENT) {
    assert.match(wipe, new RegExp(`canvas\\.style\\.${prop} = \\w+\\.${prop}`),
      `canvas.style.${prop} must be copied from the stage geometry, or a portrait wipe lands in the wrong place`);
  }
});

test('a stage with no box is a hard cut, not a 2x2 wipe', () => {
  assert.match(extract('stageGeometry'), /return null/);
  assert.match(extract('runGlWipe'), /if \(!\w+\) \{ hardCut\(\); return; \}/);
});

test('both video snapshots are fitted to the same box as the wipe', () => {
  for (const name of ['currentTexturableFrame', 'renderVideoBuffered']) {
    const fn = extract(name);
    assert.match(fn, /stageGeometry\(\)/, `${name} must frame its snapshot from the stage box`);
    assert.doesNotMatch(fn, /getBoundingClientRect/, `${name} must not frame from the rotated envelope`);
    assert.match(fn, /fitToCanvas\(\w+, \w+\.w, \w+\.h\)/, `${name} fits to the geometry's box`);
  }
});
