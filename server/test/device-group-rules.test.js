'use strict';

// The rule half of dynamic device groups (lib/device-group-rules.js): what a rule set may say,
// and which screens it selects. Membership itself is covered end to end in
// device-tags-dynamic-groups.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dgr-'));
const R = require('../lib/device-group-rules');

test('a rule set is normalised: tags lower-cased, match defaults to all', () => {
  assert.deepEqual(R.normalizeRules({ rules: [{ field: 'tag', op: 'has', value: '  Lobby ' }] }),
    { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'lobby' }] });
  assert.deepEqual(R.normalizeRules(JSON.stringify({ match: 'any', rules: [{ field: 'name', op: 'contains', value: 'till' }] })),
    { match: 'any', rules: [{ field: 'name', op: 'contains', value: 'till' }] });
});

test('undefined leaves rules alone, null or empty clears them', () => {
  assert.equal(R.normalizeRules(undefined), undefined);
  assert.equal(R.normalizeRules(null), null);
  assert.equal(R.normalizeRules(''), null);
});

test('anything malformed is refused rather than stored as a group that matches nothing', () => {
  for (const bad of [
    {}, { rules: [] }, { rules: 'x' }, { match: 'some', rules: [{ field: 'tag', op: 'has', value: 'a' }] },
    { rules: [{ field: 'owner', op: 'eq', value: 'a' }] },          // unknown field
    { rules: [{ field: 'tag', op: 'contains', value: 'a' }] },      // op not allowed for the field
    { rules: [{ field: 'tag', op: 'has', value: '' }] },            // empty value
    { rules: [{ field: 'tag', op: 'has', value: 'two words' }] },   // not a valid tag
    { rules: Array.from({ length: R.MAX_RULES + 1 }, () => ({ field: 'tag', op: 'has', value: 'a' })) },
    '{not json', 42, [],
  ]) {
    assert.equal(R.normalizeRules(bad), false, JSON.stringify(bad));
  }
});

test('matching: all vs any, has vs lacks, and the non-tag fields', () => {
  const lobby = { name: 'Lobby North', tags: '["lobby","portrait"]', platform: 'android', timezone: 'Europe/London' };
  const till = { name: 'Till 1', tags: '["retail"]', platform: 'tizen', timezone: 'UTC' };
  const rules = (match, ...rs) => ({ match, rules: rs });
  const tag = (op, value) => ({ field: 'tag', op, value });

  assert.ok(R.deviceMatches(lobby, rules('all', tag('has', 'lobby'), tag('has', 'portrait'))));
  assert.ok(!R.deviceMatches(till, rules('all', tag('has', 'lobby'))));
  assert.ok(R.deviceMatches(till, rules('any', tag('has', 'lobby'), tag('has', 'retail'))));
  assert.ok(R.deviceMatches(till, rules('all', tag('lacks', 'lobby'))));
  assert.ok(R.deviceMatches(lobby, rules('all', { field: 'name', op: 'starts_with', value: 'lobby' })), 'name is case-insensitive');
  assert.ok(R.deviceMatches(lobby, rules('all', { field: 'platform', op: 'eq', value: 'Android' })));
  assert.ok(R.deviceMatches(till, rules('all', { field: 'timezone', op: 'neq', value: 'Europe/London' })));
  assert.ok(!R.deviceMatches({ name: 'x', tags: 'not json' }, rules('all', tag('has', 'lobby'))), 'unreadable tags match nothing');
  assert.ok(!R.deviceMatches(lobby, null));
});
