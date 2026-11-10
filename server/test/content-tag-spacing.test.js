'use strict';

/*
 * A TAG SOMEONE TYPED IS A TAG THAT IS SAVED.
 *
 * Tags are single labels (letters, digits, _ . : -) because screens, group rules and filters match
 * on them. The editor shows a chip the moment a tag is typed and says "Content updated" on save,
 * but a tag with a space in it, "front desk", failed the label pattern and was dropped without a
 * word: chip shown, success toast, tag gone on reload.
 *
 * The invariant: spaces inside a typed tag do not lose it. They become hyphens, which is the
 * label the same person would have had to type, and what comes back is what is shown.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTags } = require('../lib/content-tags');

test('a tag with a space is kept, hyphenated', () => {
  assert.deepEqual(normalizeTags(['front desk']), ['front-desk']);
  assert.deepEqual(normalizeTags('lobby, front desk'), ['lobby', 'front-desk']);
  assert.deepEqual(normalizeTags(['  Main   Hall  2 ']), ['main-hall-2'], 'runs of spaces are one hyphen, ends are trimmed');
  assert.deepEqual(normalizeTags(['#front desk']), ['front-desk']);
});

test('it is the same tag as the hyphenated one, so it is not stored twice', () => {
  assert.deepEqual(normalizeTags(['front desk', 'front-desk', 'Front  Desk']), ['front-desk']);
});

test('everything that was a valid tag before is unchanged', () => {
  assert.deepEqual(normalizeTags(['lobby', 'Zone_2', 'a.b', 'k:v', 'x-y', '#promo', 'café', '大堂']), ['lobby', 'zone_2', 'a.b', 'k:v', 'x-y', 'promo', 'café', '大堂']);
  assert.deepEqual(normalizeTags(''), []);
  assert.equal(normalizeTags(5), false);
  assert.equal(normalizeTags(undefined), undefined);
});

test('a label with characters that are not allowed is still left out', () => {
  assert.deepEqual(normalizeTags(['<b>', 'ok', 'a/b', 'semi"quote']), ['ok']);
});
