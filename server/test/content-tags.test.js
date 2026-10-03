'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeTags, normalizeMeta, parseTags, parseMeta } = require('../lib/content-tags');
const { conditionOk, itemShouldPlay } = require('../lib/schedule-eval');

const ROOT = path.join(__dirname, '..', '..');

test('normalizeTags lowercases, dedupes, and drops junk', () => {
  assert.deepEqual(normalizeTags('Promo, lobby, PROMO, bad tag!'), ['promo', 'lobby']);
  assert.deepEqual(normalizeTags(['A', 'a', 'b_1']), ['a', 'b_1']);
  assert.deepEqual(normalizeTags(''), []);
  assert.equal(normalizeTags(1), false);
});

test('normalizeMeta parses key=value lines', () => {
  assert.deepEqual(normalizeMeta('dept=sales\nlanguage=en'), { dept: 'sales', language: 'en' });
  assert.deepEqual(normalizeMeta({ Dept: 'x' }), { Dept: 'x' });
  assert.equal(normalizeMeta([1]), false);
});

test('parseTags / parseMeta tolerate bad JSON', () => {
  assert.deepEqual(parseTags('["a"]'), ['a']);
  assert.deepEqual(parseTags('nope'), []);
  assert.deepEqual(parseMeta('{"k":"v"}'), { k: 'v' });
  assert.deepEqual(parseMeta('nope'), {});
});

test('play_when type=tag has/lacks, tags live on the item not the DS bag', () => {
  const has = { type: 'tag', op: 'has', value: 'promo' };
  const lacks = { type: 'tag', op: 'lacks', value: 'promo' };
  assert.equal(conditionOk(has, null, { tags: ['promo'] }), true);
  assert.equal(conditionOk(has, null, { tags: ['lobby'] }), false);
  assert.equal(conditionOk(has, { temp: 1 }, { tags: [] }), false);
  assert.equal(conditionOk(lacks, null, { tags: ['lobby'] }), true);
  assert.equal(conditionOk(lacks, null, { tags: ['promo'] }), false);
  assert.equal(itemShouldPlay({ play_when: has, tags: ['promo'] }, '2026-06-12T00:00:00Z', 'UTC'), true);
  assert.equal(itemShouldPlay({ play_when: has, tags: [] }, '2026-06-12T00:00:00Z', 'UTC'), false);
});

test('play_when type=meta compares a content key', () => {
  const when = { type: 'meta', path: 'dept', op: 'eq', value: 'sales' };
  assert.equal(conditionOk(when, null, { meta: { dept: 'sales' } }), true);
  assert.equal(conditionOk(when, { dept: 'sales' }, { meta: { dept: 'hr' } }), false); // item.meta wins
  assert.equal(conditionOk(when, null, { meta: {} }), false);
});

test('schema, snapshot, and content PUT carry tags / meta / playback_order / weight', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8');
  const playlists = fs.readFileSync(path.join(ROOT, 'server/routes/playlists.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT, 'server/routes/content.js'), 'utf8');
  const sock = fs.readFileSync(path.join(ROOT, 'server/ws/deviceSocket.js'), 'utf8');
  assert.match(schema, /tags\s+TEXT/);
  assert.match(schema, /playback_order\s+TEXT NOT NULL DEFAULT 'sequential'/);
  assert.match(schema, /weight\s+INTEGER NOT NULL DEFAULT 1/);
  assert.match(playlists, /normalizePlaybackOrder/);
  assert.match(playlists, /published_playback_order/);
  assert.match(playlists, /content_tags/);
  assert.match(content, /normalizeTags/);
  assert.match(sock, /playback_order/);
});

test('playlist editor has Order dropdown, weight, and tag/meta condition types', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'frontend/js/views/playlists.js'), 'utf8');
  const lib = fs.readFileSync(path.join(ROOT, 'frontend/js/views/content-library.js'), 'utf8');
  assert.match(ui, /playlistOrder/);
  assert.match(ui, /playback_order/);
  assert.match(ui, /item-weight/);
  assert.match(ui, /type: 'tag'/);
  assert.match(ui, /type: 'meta'/);
  assert.match(lib, /editTags/);
  assert.match(lib, /editMeta/);
});

test('Tizen schedule-eval still matches the canonical module after tag/meta', () => {
  const a = fs.readFileSync(path.join(ROOT, 'server/lib/schedule-eval.js'));
  const b = fs.readFileSync(path.join(ROOT, 'tizen/js/schedule-eval.js'));
  assert.ok(a.equals(b), 'tizen/js/schedule-eval.js drifted — re-copy it');
});
