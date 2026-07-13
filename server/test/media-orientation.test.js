'use strict';

// #170: portrait media was stored with swapped W/H because ingest read CODED dimensions and
// ignored rotation (video Display-Matrix / rotate tag; image EXIF orientation) -> wrong aspect
// + blue letterbox bar on the player. These bites pin the display-dimension logic that fixes it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  rotationSwapsWH, videoRotationDegrees, videoDisplayDims, exifSwapsWH, imageDisplayDims,
} = require('../lib/media-orientation');

test('#170 rotationSwapsWH: only odd quarter-turns swap', () => {
  assert.equal(rotationSwapsWH(0), false);
  assert.equal(rotationSwapsWH(90), true);
  assert.equal(rotationSwapsWH(180), false);
  assert.equal(rotationSwapsWH(270), true);
  assert.equal(rotationSwapsWH(360), false);
  assert.equal(rotationSwapsWH(-90), true);   // normalizes to 270
  assert.equal(rotationSwapsWH(450), true);   // normalizes to 90
  assert.equal(rotationSwapsWH(91), false);   // not a clean quarter-turn
  assert.equal(rotationSwapsWH(undefined), false);
});

test('#170 videoRotationDegrees: reads tag and Display Matrix, normalizes sign', () => {
  assert.equal(videoRotationDegrees({ tags: { rotate: '90' } }), 90);
  assert.equal(videoRotationDegrees({ tags: { rotate: '-90' } }), 270, 'negative tag normalized');
  assert.equal(videoRotationDegrees({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }), 270);
  assert.equal(videoRotationDegrees({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }), 90);
  // Display Matrix wins over a (possibly stale) legacy tag
  assert.equal(videoRotationDegrees({ tags: { rotate: '0' }, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }), 270);
  assert.equal(videoRotationDegrees({}), 0, 'no rotation info -> 0');
  assert.equal(videoRotationDegrees(null), 0);
});

test('#170 videoDisplayDims: portrait video (coded landscape + 90 rotation) reads portrait', () => {
  assert.deepEqual(
    videoDisplayDims({ width: 1920, height: 1080, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }),
    { width: 1080, height: 1920 }, 'the blue-bar case: stored landscape -> display portrait');
  assert.deepEqual(videoDisplayDims({ width: 1920, height: 1080 }), { width: 1920, height: 1080 }, 'no rotation -> unchanged');
  assert.deepEqual(videoDisplayDims({ width: 1080, height: 1920, tags: { rotate: '180' } }), { width: 1080, height: 1920 }, '180 does not swap');
  assert.deepEqual(videoDisplayDims(null), { width: null, height: null });
  assert.deepEqual(videoDisplayDims({ width: null, height: null }), { width: null, height: null });
});

test('#170 exifSwapsWH: EXIF 5..8 imply a quarter-turn', () => {
  for (const o of [1, 2, 3, 4]) assert.equal(exifSwapsWH(o), false, `orientation ${o} no swap`);
  for (const o of [5, 6, 7, 8]) assert.equal(exifSwapsWH(o), true, `orientation ${o} swaps`);
  assert.equal(exifSwapsWH(undefined), false, 'no EXIF -> no swap');
});

test('#170 imageDisplayDims: portrait photo with EXIF 6 reads portrait', () => {
  assert.deepEqual(imageDisplayDims({ width: 4032, height: 3024, orientation: 6 }), { width: 3024, height: 4032 });
  assert.deepEqual(imageDisplayDims({ width: 3024, height: 4032, orientation: 1 }), { width: 3024, height: 4032 });
  assert.deepEqual(imageDisplayDims({ width: 3024, height: 4032 }), { width: 3024, height: 4032 }, 'no orientation tag -> unchanged');
  assert.deepEqual(imageDisplayDims(null), { width: null, height: null });
});
