'use strict';

/*
 * Prerelease ordering.
 *
 * The bug this pins: a plain string compare put every build from alpha10 onward BELOW alpha8,
 * because '1' < '8'. The OTA check then answered `client-newer` and refused to offer the update,
 * so a fleet on alpha8 could not be moved forward — silently, while the server reported the newer
 * build as `latest` in the same response. Two comparators carried the assumption, each with a
 * comment saying lexical was fine "for our naming". It was, until the counter passed 9.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preCmp } = require('../lib/version-precedence');
const { cmp } = require('../lib/ota-breaker');
const bsUpdate = require('../lib/brightsign-update');

const sign = (n) => (n === 0 ? 0 : n < 0 ? -1 : 1);

test('double-digit prereleases outrank single-digit ones', () => {
  // The exact case that stranded the fleet.
  assert.equal(sign(preCmp('alpha11', 'alpha8')), 1, 'alpha11 must be newer than alpha8');
  assert.equal(sign(preCmp('alpha10', 'alpha9')), 1);
  assert.equal(sign(preCmp('beta12', 'beta2')), 1);
  assert.equal(sign(preCmp('rc10', 'rc9')), 1);
  // And the reverse still holds, so nothing was merely inverted.
  assert.equal(sign(preCmp('alpha2', 'alpha10')), -1);
});

test('ordinary alphabetical precedence is unchanged', () => {
  assert.equal(sign(preCmp('beta1', 'alpha11')), 1, 'beta outranks alpha regardless of number');
  assert.equal(sign(preCmp('rc1', 'beta9')), 1, 'rc outranks beta');
  assert.equal(sign(preCmp('alpha8', 'alpha8')), 0);
});

test('semver dot form works too, so the naming can move without another fix', () => {
  assert.equal(sign(preCmp('alpha.11', 'alpha.8')), 1);
  assert.equal(sign(preCmp('alpha', 'alpha.1')), -1, 'fewer identifiers = lower precedence');
  assert.equal(sign(preCmp('alpha.1', 'beta.1')), -1);
});

test('OTA: a device on alpha8 is offered alpha11', () => {
  // Through the real comparator the update check uses, not just the helper.
  assert.equal(cmp('1.9.34-alpha11', '1.9.34-alpha8'), 1);
  assert.equal(cmp('1.9.34-alpha10', '1.9.34-alpha6'), 1);
  // A release still outranks any prerelease of the same core.
  assert.equal(cmp('1.9.34', '1.9.34-alpha11'), 1);
  // And a newer core still wins outright, whatever the prerelease says.
  assert.equal(cmp('1.9.35-alpha1', '1.9.34-alpha11'), 1);
});

test('OTA decide(): alpha8 -> alpha11 is an offer, not client-newer', () => {
  // The end-to-end symptom: the endpoint reported the newer build as `latest` and refused it
  // in the same breath.
  const { decide } = require('../lib/ota-breaker');
  const d = decide('1.9.34-alpha8', '1.9.34-alpha11', 'test-device-precedence');
  assert.equal(d.update_available, true, `expected an offer, got ${d.reason}`);
  assert.notEqual(d.reason, 'client-newer');
});

test('BrightSign host packages order the same way', () => {
  // Same assumption lived here, with the same comment. A BrightSign package update that goes
  // wrong replaces the script that boots the player, so wrong-way ordering matters more here.
  assert.equal(sign(bsUpdate.compareVersions('1.9.34-rc10', '1.9.34-rc9')), 1);
  assert.equal(sign(bsUpdate.compareVersions('1.9.34', '1.9.34-rc10')), 1);
  assert.equal(sign(bsUpdate.compareVersions('1.9.34-alpha2', '1.9.34-alpha10')), -1);
});
