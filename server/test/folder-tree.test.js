'use strict';

/*
 * Content folders as a tree — the playlist picker's folder navigation.
 *
 * ⚠️ THE SHAPE THIS IS BUILT FOR IS REAL, not invented. The library that prompted it has 39
 * folders, 30 of them nested, five levels deep, and 211 files. The first version of the filter
 * flattened all of that into one list, which:
 *   - showed 39 entries where 4 would do,
 *   - put a parent and its own child side by side as peers, and
 *   - reported a DIRECT count of 100 for a folder that holds 204 once its children are counted.
 * Each of those is a way to lose a file the operator can plainly see in the library.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The module is an ES module in the frontend; load it the same way the dashboard does.
let T;
test('load the tree module', async () => {
  T = await import('../../frontend/js/lib/folder-tree.js');
  assert.ok(T.buildFolderTree);
});

/*
 * A miniature of the real structure:
 *   WESTERN AUSTRALIA        (100 direct)
 *     HOSTS                  (0 direct)
 *       IHG                  (0)
 *         HOLIDAY INN        (0)
 *           WEST PERTH       (52)
 *     WA CONTENT             (52)
 *     PERTH CBD              (0, empty subtree)
 *   MISC CONTENT             (3)
 *   EMPTY TOP                (0, empty subtree)
 */
const FOLDERS = [
  { id: 'wa',      name: 'WESTERN AUSTRALIA', parent_id: null },
  { id: 'hosts',   name: 'HOSTS',             parent_id: 'wa' },
  { id: 'ihg',     name: 'IHG',               parent_id: 'hosts' },
  { id: 'hi',      name: 'HOLIDAY INN',       parent_id: 'ihg' },
  { id: 'wp',      name: 'WEST PERTH',        parent_id: 'hi' },
  { id: 'wac',     name: 'WA CONTENT',        parent_id: 'wa' },
  { id: 'cbd',     name: 'PERTH CBD',         parent_id: 'wa' },
  { id: 'misc',    name: 'MISC CONTENT',      parent_id: null },
  { id: 'emptytop', name: 'EMPTY TOP',        parent_id: null },
];
const CONTENT = [
  ...Array.from({ length: 100 }, (_, i) => ({ id: `wa${i}`, folder_id: 'wa' })),
  ...Array.from({ length: 52 }, (_, i) => ({ id: `wp${i}`, folder_id: 'wp' })),
  ...Array.from({ length: 52 }, (_, i) => ({ id: `wac${i}`, folder_id: 'wac' })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, folder_id: 'misc' })),
  { id: 'loose1', folder_id: null },
  { id: 'loose2', folder_id: null },
];

const tree = () => T.buildFolderTree(FOLDERS);

test('the top level is short, however many folders exist', () => {
  // 9 folders in the fixture, 3 at top level — the bar shows 3, not 9. On the real library it is
  // 4 chips instead of 39, which is the entire point of a breadcrumb over a flat list.
  const top = T.childrenOf(tree(), '');
  assert.deepEqual(top.map((f) => f.name), ['EMPTY TOP', 'MISC CONTENT', 'WESTERN AUSTRALIA']);
});

test('⚠️ counts are SUBTREE counts — the flat version understated a folder by half', () => {
  const tr = tree();
  // 100 sit directly in WESTERN AUSTRALIA; 104 more are beneath it.
  assert.equal(T.countIn(tr, 'wa', CONTENT), 204);
  assert.equal(T.countIn(tr, 'hosts', CONTENT), 52, 'a grouping folder with nothing of its own is not empty');
  assert.equal(T.countIn(tr, 'wp', CONTENT), 52);
  assert.equal(T.countIn(tr, 'cbd', CONTENT), 0, 'a genuinely empty subtree is 0 and gets hidden');
});

test('a breadcrumb shows the path the operator built', () => {
  const names = T.pathTo(tree(), 'wp').map((f) => f.name);
  assert.deepEqual(names, ['WESTERN AUSTRALIA', 'HOSTS', 'IHG', 'HOLIDAY INN', 'WEST PERTH']);
  assert.equal(names.length, 5, 'five levels deep, which a flat list cannot express at all');
  assert.deepEqual(T.pathTo(tree(), 'misc').map((f) => f.name), ['MISC CONTENT']);
  assert.deepEqual(T.pathTo(tree(), 'nope'), [], 'an unknown id is empty, not a throw');
});

test('⚠️ every item is reachable by drilling from the top', () => {
  /*
   * The property that matters. If a file is in no top-level subtree and is not unfiled, the bar
   * can never reach it — which is the original bug in a new costume.
   */
  const tr = tree();
  let reachable = 0;
  for (const top of T.childrenOf(tr, '')) reachable += T.countIn(tr, top.id, CONTENT);
  assert.equal(reachable + T.unfiledCount(CONTENT), CONTENT.length);
});

test('filtering by a parent includes everything beneath it', () => {
  const tr = tree();
  const wanted = T.subtreeIds(tr, 'wa');
  const shown = CONTENT.filter((c) => T.itemMatchesFolder(c, 'wa', wanted));
  assert.equal(shown.length, 204);

  const loose = CONTENT.filter((c) => T.itemMatchesFolder(c, '__root__', null));
  assert.equal(loose.length, 2, '"no folder" is its own place, not a synonym for "all"');

  const all = CONTENT.filter((c) => T.itemMatchesFolder(c, '', null));
  assert.equal(all.length, CONTENT.length);
});

test('⚠️ an orphaned folder becomes top level rather than disappearing', () => {
  // Its parent was deleted, or belongs to another workspace. Hiding it would hide its content,
  // which is precisely the failure this feature exists to end.
  const orphaned = [...FOLDERS, { id: 'orph', name: 'ORPHAN', parent_id: 'gone-folder' }];
  const tr = T.buildFolderTree(orphaned);
  assert.ok(T.childrenOf(tr, '').some((f) => f.id === 'orph'), 'reachable from the top level');
});

test('⚠️ a cycle in the data terminates instead of hanging the dashboard', () => {
  // parent_id is a plain column; nothing in the database forbids a loop.
  const cyclic = [
    { id: 'a', name: 'A', parent_id: 'b' },
    { id: 'b', name: 'B', parent_id: 'a' },
  ];
  const tr = T.buildFolderTree(cyclic);
  const t0 = Date.now();
  const ids = T.subtreeIds(tr, 'a');
  const path = T.pathTo(tr, 'a');
  assert.ok(Date.now() - t0 < 1000, 'must not spin');
  assert.ok(ids.size <= 2);
  assert.ok(path.length <= 2);
});

test('junk in, no throw out', () => {
  for (const bad of [null, undefined, [], [null], [{}], [{ id: 'x' }]]) {
    const tr = T.buildFolderTree(bad);
    assert.ok(T.childrenOf(tr, '') instanceof Array);
    assert.equal(T.countIn(tr, 'x', null), 0);
  }
  assert.equal(T.unfiledCount(null), 0);
});
