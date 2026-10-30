'use strict';

/*
 * How big an embedded render may be (lib/embedded-profiles.js withinSizeLimit). The limit is the
 * PRESET's, never the profile's: a profile is operator JSON, and `parameterizedDimensions: false`
 * in one used to switch the LED cap off (found reviewing #758). Raw RGB888 output, what an LED
 * controller takes, is held to the LED cap whatever the preset.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProfile, PRESETS, SIZE_LIMITS } = require('../lib/embedded-profiles');

const size = (p) => (p ? `${p.width}x${p.height}` : null);

test('THE BYPASS: a profile cannot switch the LED cap off', () => {
  assert.equal(parseProfile({ preset: 'seeed-xiao-led', parameterizedDimensions: false, width: 10000, height: 10000 }), null);
  assert.equal(parseProfile({ preset: 'seeed-xiao-led', parameterizedDimensions: false, width: 256, height: 128 }), null, '32768 px > 16384');
});

test('raw RGB888 without a preset is held to the LED cap, aliases included', () => {
  assert.equal(parseProfile({ width: 10000, height: 10000, colorDepth: '24bit-rgb888', outputFormat: 'raw' }), null);
  assert.equal(parseProfile({ width: 600, height: 20, colorDepth: 'rgb888', outputFormat: 'raw' }), null, 'a side over 512');
  assert.equal(size(parseProfile({ width: 128, height: 64, colorDepth: '24bit-rgb888', outputFormat: 'raw' })), '128x64');
});

test('LED preset sizes inside the cap still work, exactly as #758 shipped them', () => {
  assert.equal(size(parseProfile({ preset: 'seeed-xiao-led', width: 64, height: 64 })), '64x64');
  assert.equal(size(parseProfile({ preset: 'seeed-xiao-led', width: 512, height: 1 })), '512x1');
  assert.equal(size(parseProfile({ preset: 'seeed-xiao-led', width: 128, height: 128 })), '128x128');
  assert.equal(parseProfile({ preset: 'seeed-xiao-led', width: 513, height: 1 }), null);
  assert.equal(size(parseProfile('seeed-xiao-led')), '5x1');
});

test('any profile: at most a 4K panel, so a JSON profile cannot ask for a 100 MP render', () => {
  assert.equal(parseProfile({ width: 10000, height: 10000 }), null);
  assert.equal(parseProfile({ width: 5000, height: 100 }), null, 'a side over MAX_SIDE');
  assert.equal(parseProfile({ width: 4096, height: 4096 }), null, 'pixels over MAX_PIXELS');
  assert.equal(size(parseProfile({ width: 3840, height: 2160 })), '3840x2160');
  assert.equal(size(parseProfile({ width: 2160, height: 3840 })), '2160x3840');
});

test('every shipped preset fits its own limit', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.ok(parseProfile({ preset: name }), `${name} (${p.width}x${p.height}) must parse`);
    assert.ok(parseProfile(name), name);
  }
  assert.deepEqual(SIZE_LIMITS, { MAX_SIDE: 4096, MAX_PIXELS: 3840 * 2160, LED_MAX_SIDE: 512, LED_MAX_PIXELS: 16384 });
});

test('the rgb888 / mono aliases from #758 become the standard depths', () => {
  assert.equal(parseProfile({ width: 32, height: 8, colorDepth: 'rgb888', outputFormat: 'raw' }).colorDepth, '24bit-rgb888');
  assert.equal(parseProfile({ preset: 'seeed-reterminal-sticky', colorDepth: 'mono' }).colorDepth, '1bit');
  assert.equal(parseProfile({ preset: 'seeed-reterminal-sticky', colorDepth: 'bogus' }).colorDepth, PRESETS['seeed-reterminal-sticky'].colorDepth);
});
