'use strict';

// Search, filters and bulk selection in the Templates library (frontend/js/lib/template-library-filter.js).
//
// The view only paints what these functions decide, so the behaviour an admin relies on — "Updates
// available" shows exactly the updates, a search finds a translated name, "Install selected" never
// sends something already installed, one failure does not stop the rest — is pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../frontend/js/lib/template-library-filter.js');

const E = (o) => ({ catalog: 'official', compatible: true, installed: null, update_available: false, is_new: false, is_updated: false, tags: [], ...o, key: `official/${o.id}` });
const LIB = [
  E({ id: 'menu-board', name: 'Menu board', description: 'Prices for a café counter', kind: 'html', tags: ['food', 'menu'], orientation: ['landscape', 'portrait'], installed: '1.0.0', update_available: true, latest: '1.1.0' }),
  E({ id: 'holiday-halloween', name: 'Halloween', description: 'Spooky greeting', kind: 'slide', tags: ['holiday'], orientation: ['landscape'], latest: '1.0.0', is_new: true }),
  E({ id: 'holiday-halloween-portrait', name: 'Halloween (portrait)', kind: 'slide', tags: ['holiday'], orientation: ['portrait'], latest: '1.0.0', is_new: true }),
  E({ id: 'world-clocks', name: 'World clocks', kind: 'html', tags: ['time'], orientation: ['landscape'], installed: '1.1.0', latest: '1.1.0' }),
  E({ id: 'future-thing', name: 'Future thing', kind: 'html', latest: '1.0.0', compatible: false }),
  E({ id: 'any-shape', name: 'Any shape', kind: 'slide', latest: '1.0.0' }),
  E({ id: 'wait-times', name: 'Wait times', kind: 'html', latest: '1.0.0', i18n: { de: { name: 'Wartezeiten', description: 'Geschätzte Wartezeit' } } }),
];

test('search: every word must match; accents and case fold; tags, ids and translated names count', async () => {
  const F = await load();
  const ids = (q, lang = 'en') => LIB.filter((e) => F.matchesFilters(e, { q }, lang)).map((e) => e.id);
  assert.deepEqual(ids(''), LIB.map((e) => e.id), 'an empty search shows everything');
  assert.deepEqual(ids('CAFE'), ['menu-board'], 'case- and accent-insensitive, in the description');
  assert.deepEqual(ids('holiday portrait'), ['holiday-halloween-portrait'], 'all words, not any word');
  assert.deepEqual(ids('food'), ['menu-board'], 'tags are searched');
  assert.deepEqual(ids('world-clocks'), ['world-clocks'], 'ids are searched');
  assert.deepEqual(ids('wartezeit', 'de'), ['wait-times'], 'the translated name/description for the dashboard language');
  assert.deepEqual(ids('wait', 'de'), ['wait-times'], 'and the English one still works in another language');
  assert.deepEqual(ids('nothing like this'), []);
});

test('status filters: not installed, updates, installed, new', async () => {
  const F = await load();
  const ids = (status) => LIB.filter((e) => F.matchesFilters(e, { status })).map((e) => e.id);
  assert.deepEqual(ids('updates'), ['menu-board']);
  assert.deepEqual(ids('installed'), ['menu-board', 'world-clocks']);
  assert.deepEqual(ids('new'), ['holiday-halloween', 'holiday-halloween-portrait']);
  assert.ok(!ids('not_installed').includes('menu-board') && ids('not_installed').includes('future-thing'));
  assert.equal(ids('all').length, LIB.length);
  assert.equal(ids('bogus').length, LIB.length, 'an unknown value filters nothing');
});

test('kind, orientation and tag filters combine; no declared orientation passes either', async () => {
  const F = await load();
  const ids = (s) => LIB.filter((e) => F.matchesFilters(e, s)).map((e) => e.id);
  assert.deepEqual(ids({ kind: 'slide', orientation: 'portrait' }), ['holiday-halloween-portrait', 'any-shape']);
  assert.deepEqual(ids({ orientation: 'portrait', kind: 'html' }), ['menu-board', 'future-thing', 'wait-times'], 'made for both shapes, or for none declared');
  assert.deepEqual(ids({ tag: 'holiday', orientation: 'landscape' }), ['holiday-halloween']);
  assert.deepEqual(F.orientationsOf({ orientation: 'portrait' }), ['portrait'], 'a string is read as one orientation');
  assert.deepEqual(F.allTags(LIB), ['food', 'holiday', 'menu', 'time']);
});

test('selection: only entries that can be installed or updated now, in list order', async () => {
  const F = await load();
  assert.equal(F.isActionable(LIB[0]), true, 'an update');
  assert.equal(F.isActionable(LIB[1]), true, 'not installed');
  assert.equal(F.isActionable(LIB[3]), false, 'already on the latest version');
  assert.equal(F.isActionable(LIB[4]), false, 'needs a newer server');
  const sel = new Set(['official/world-clocks', 'official/future-thing', 'official/holiday-halloween', 'official/gone', 'official/menu-board']);
  assert.deepEqual(F.selectionToInstall(LIB, sel).map((e) => e.id), ['menu-board', 'holiday-halloween']);
  assert.deepEqual(F.updatesOf(LIB).map((e) => e.id), ['menu-board']);
});

test('installSequentially: one at a time, a failure does not stop the rest, stop is honoured', async () => {
  const F = await load();
  let running = 0;
  let maxRunning = 0;
  const seen = [];
  const progress = [];
  const r = await F.installSequentially(LIB.slice(0, 4), async (e) => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise((res) => setTimeout(res, 2));
    running--;
    seen.push(e.id);
    if (e.id === 'holiday-halloween') throw new Error('package does not match the index');
  }, (p) => progress.push([p.done, p.total, p.entry && p.entry.id]));
  assert.equal(maxRunning, 1, 'never two installs at once');
  assert.deepEqual(seen, ['menu-board', 'holiday-halloween', 'holiday-halloween-portrait', 'world-clocks']);
  assert.deepEqual(r.ok.map((e) => e.id), ['menu-board', 'holiday-halloween-portrait', 'world-clocks']);
  assert.deepEqual(r.failed.map((f) => [f.entry.id, f.error]), [['holiday-halloween', 'package does not match the index']]);
  assert.deepEqual(progress[0], [0, 4, 'menu-board']);
  assert.deepEqual(progress.at(-1), [4, 4, null]);

  let n = 0;
  const stopped = await F.installSequentially(LIB.slice(0, 4), async () => { n++; }, () => {}, { shouldStop: () => n >= 2 });
  assert.equal(stopped.ok.length, 2, 'stops before starting the next one');
});
