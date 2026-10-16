'use strict';

/*
 * #649: the bundle-skip rules every JS player runs (web, legacy web, Tizen; BrightSign and Vega run
 * the web player), held to shared/bundle-skip-vectors.json — the same file Android's
 * BundleSkipVectorsTest and the native player's tests/test_bundle_skip.py read.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'bundle-skip-vectors.json'), 'utf8'));
const BundleSkip = require('../lib/bundle-skip');

test('the constants are the contract', () => {
  assert.equal(BundleSkip.MESSAGE_TYPE, 'screentinker:skip');
  assert.equal(BundleSkip.MIN_RUN_MS, V.minRunMs);
  assert.equal(BundleSkip.REASON_MAX, V.reasonMax);
});

for (const c of V.message) {
  test(`message: ${c.name}`, () => assert.equal(BundleSkip.isSkipMessage(c.data), c.expect));
}

for (const c of V.reason) {
  test(`reason: ${c.name}`, () => {
    const got = BundleSkip.sanitizeReason(c.raw);
    if (c.expectCodePoints != null) {
      assert.equal(Array.from(got).length, c.expectCodePoints);
      assert.ok(Array.from(c.raw).slice(0, c.expectCodePoints).join('') === got, 'a prefix of the original, whole code points');
    } else {
      assert.equal(got, c.expect);
    }
  });
}

for (const c of V.guard) {
  test(`guard: ${c.name}`, () => {
    const g = new BundleSkip.Guard(V.minRunMs);
    c.steps.forEach((s, i) => {
      if (s.ended != null) { g.ended(s.ended); return; }
      const got = g.decide(s.skip, s.canAdvance !== false, !!s.sync);
      assert.equal(got, s.expect, `step ${i}: skip ${s.skip}`);
    });
  });
}

test('the browser global is set even where `module` exists (BrightSign nodejs_enabled)', () => {
  const src = fs.readFileSync(require.resolve('../lib/bundle-skip.js'), 'utf8');
  const self = {};
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('self', 'module', src)(self, module);
  assert.equal(typeof self.BundleSkip.Guard, 'function');
  assert.equal(typeof module.exports.Guard, 'function');
});
