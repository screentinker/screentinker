'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ghcrCheck = require('../lib/ghcr-check');

// =========== extractSemverTags ===========

test('extractSemverTags: returns only valid x.y.z semver tags, pre-release suffixes excluded', () => {
  const input = ['latest', '1.9.4', 'v1.9.4', '1.9.4-beta', '1.10.0', '2.0.0-rc1', '1.0.0-alpha'];
  const result = ghcrCheck.extractSemverTags(input);
  // Pre-release (-beta, -rc1, -alpha) and non-semver (latest, v1.9.4) excluded
  assert.deepEqual(result, ['1.10.0', '1.9.4']);
});

test('extractSemverTags: sorts numeric components correctly (10 > 9)', () => {
  const input = ['1.2.3', '1.10.0', '1.9.4', '1.2.10'];
  const result = ghcrCheck.extractSemverTags(input);
  assert.deepEqual(result, ['1.10.0', '1.9.4', '1.2.10', '1.2.3']);
});

test('extractSemverTags: empty input returns empty array', () => {
  assert.deepEqual(ghcrCheck.extractSemverTags([]), []);
});

test('extractSemverTags: all non-semver tags returns empty array', () => {
  assert.deepEqual(ghcrCheck.extractSemverTags(['latest', 'dev', 'beta']), []);
});

test('extractSemverTags: handles single valid tag', () => {
  assert.deepEqual(ghcrCheck.extractSemverTags(['1.0.0']), ['1.0.0']);
});

// =========== compareVersions ===========

test('compareVersions: equal versions return 0', () => {
  assert.equal(ghcrCheck.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(ghcrCheck.compareVersions('2.5.7', '2.5.7'), 0);
});

test('compareVersions: a < b returns negative', () => {
  assert.ok(ghcrCheck.compareVersions('1.9.4', '1.10.0') < 0, 'minor bump');
  assert.ok(ghcrCheck.compareVersions('1.0.0', '2.0.0') < 0, 'major bump');
  assert.ok(ghcrCheck.compareVersions('1.0.0', '1.0.1') < 0, 'patch bump');
  assert.ok(ghcrCheck.compareVersions('1.0.0', '1.1.0') < 0, 'minor bump 0->1');
});

test('compareVersions: a > b returns positive', () => {
  assert.ok(ghcrCheck.compareVersions('2.0.0', '1.9.4') > 0, 'major larger');
  assert.ok(ghcrCheck.compareVersions('1.10.0', '1.9.4') > 0, 'minor larger');
  assert.ok(ghcrCheck.compareVersions('1.0.1', '1.0.0') > 0, 'patch larger');
});

test('compareVersions: non-semver input returns NaN', () => {
  assert.ok(Number.isNaN(ghcrCheck.compareVersions('abc', '1.0.0')));
  assert.ok(Number.isNaN(ghcrCheck.compareVersions('1.0.0', 'latest')));
  assert.ok(Number.isNaN(ghcrCheck.compareVersions('1.0', '1.0.0')));
});

// =========== getLatestVersion (sync cache read) ===========

test('getLatestVersion: returns null before any poll', () => {
  assert.equal(ghcrCheck.getLatestVersion(), null);
});
