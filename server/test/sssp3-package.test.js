'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sssp3Cache = require('../lib/sssp3-package-cache');

test('manifest uses the exact ZIP byte count and an integer package version', () => {
  const xml = sssp3Cache.sssp3ConfigXml({ exists: true, version: 1288, size: 256253 });
  assert.equal(Number(/<size>(\d+)<\/size>/.exec(xml)[1]), 256253);
  assert.equal(Number(/<ver>(\d+)<\/ver>/.exec(xml)[1]), 1288);
  assert.match(xml, /<widgetname>ScreenTinkerSSSP3<\/widgetname>/);
  assert.doesNotMatch(xml, /<webtype>/);
});

test('only positive safe integer versions are accepted', () => {
  for (const value of ['1', '1288', 30101]) assert.notEqual(sssp3Cache.positiveInteger(value), null);
  for (const value of ['', '0', '-1', '1.2.3', '12x', Number.MAX_SAFE_INTEGER + 1]) assert.equal(sssp3Cache.positiveInteger(value), null);
});

test('every served ZIP needs an explicit matching version', () => {
  const [operatorZip, repoZip] = sssp3Cache.packageCandidates();
  assert.match(operatorZip, /ScreenTinkerSSSP3\.zip$/);
  const old = process.env.SSSP3_WGT_VER;
  try {
    delete process.env.SSSP3_WGT_VER;
    assert.equal(sssp3Cache.packageVersion(operatorZip), null);
    assert.equal(sssp3Cache.packageVersion(repoZip), null);
    process.env.SSSP3_WGT_VER = '1288';
    assert.equal(sssp3Cache.packageVersion(operatorZip), 1288);
    assert.equal(sssp3Cache.packageVersion(repoZip), 1288);
  } finally {
    if (old === undefined) delete process.env.SSSP3_WGT_VER;
    else process.env.SSSP3_WGT_VER = old;
  }
});
