'use strict';

/*
 * The folder select's model (frontend/js/lib/folder-select-model.js) — what the schedule dialog's
 * screen, playlist and content pickers show when browsed by folder or group.
 *
 * The shapes that matter, each a way to lose an item an operator can see elsewhere:
 *   - NESTED folders: picking a parent shows everything beneath it, and counts it.
 *   - MULTI-MEMBERSHIP: a screen in two groups is listed under both, but counted ONCE where both
 *     are inside the same view (All).
 *   - ORPHANS: an item filed into a folder that no longer exists is still reachable (as unfiled).
 *   - A LONG list is capped for rendering and SAYS how many more matched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

let M;
test('load the model module', async () => {
  M = await import('../../frontend/js/lib/folder-select-model.js');
  assert.ok(M.buildModel);
});

// Content-style tree:  Lobby › (Winter, Summer)   Menus   (Empty)
const FOLDERS = [
  { id: 'lobby', parent_id: null, name: 'Lobby' },
  { id: 'winter', parent_id: 'lobby', name: 'Winter' },
  { id: 'summer', parent_id: 'lobby', name: 'Summer' },
  { id: 'menus', parent_id: null, name: 'Menus' },
  { id: 'empty', parent_id: null, name: 'Empty' },
];
const ITEMS = [
  { id: 'a', label: 'snow.png', folderIds: ['winter'] },
  { id: 'b', label: 'sun.png', folderIds: ['summer'] },
  { id: 'c', label: 'welcome.mp4', folderIds: ['lobby'] },
  { id: 'd', label: 'breakfast.png', folderIds: ['menus'] },
  { id: 'e', label: 'stray.png', folderIds: [] },
  { id: 'f', label: 'orphan.png', folderIds: ['deleted-folder'] },
];

test('a parent folder holds its whole subtree, and counts it', () => {
  const m = M.buildModel(FOLDERS, ITEMS);
  assert.equal(M.countIn(m, 'lobby'), 3, 'Lobby = its own file + Winter + Summer');
  assert.deepEqual(M.itemsIn(m, 'lobby').shown.map((i) => i.id).sort(), ['a', 'b', 'c']);
  assert.equal(M.countIn(m, M.ALL), 6);
});

test('unfiled covers no folder AND a folder that no longer exists', () => {
  const m = M.buildModel(FOLDERS, ITEMS);
  assert.deepEqual(M.itemsIn(m, M.UNFILED).shown.map((i) => i.id).sort(), ['e', 'f']);
  assert.equal(M.unfiledCount(m), 2);
});

test('a level offers only folders that hold something, and says how many empty ones it left out', () => {
  const m = M.buildModel(FOLDERS, ITEMS);
  assert.deepEqual(M.foldersAt(m, M.ALL).map((x) => [x.folder.name, x.count]), [['Lobby', 3], ['Menus', 1]]);
  assert.equal(M.emptyFoldersAt(m, M.ALL), 1);
  assert.deepEqual(M.foldersAt(m, 'lobby').map((x) => x.folder.name), ['Summer', 'Winter']);
});

test('breadcrumb and the trigger\'s place label follow the path', () => {
  const m = M.buildModel(FOLDERS, ITEMS);
  assert.deepEqual(M.breadcrumb(m, 'winter').map((f) => f.name), ['Lobby', 'Winter']);
  assert.equal(M.placeLabel(m, 'a'), 'Lobby › Winter');
  assert.equal(M.placeLabel(m, 'e'), '');
});

test('search matches labels within the current folder, and finds folders anywhere', () => {
  const m = M.buildModel(FOLDERS, ITEMS);
  assert.deepEqual(M.itemsIn(m, 'lobby', 'SUN').shown.map((i) => i.id), ['b']);
  assert.deepEqual(M.itemsIn(m, 'menus', 'sun').shown, []);
  assert.deepEqual(M.matchingFolders(m, 'win').map((h) => h.path), ['Lobby › Winter']);
  assert.deepEqual(M.matchingFolders(m, 'empty'), [], 'an empty folder is not offered');
});

test('groups: a screen in two groups shows in both, and is counted once in All', () => {
  const groups = [{ id: 'g1', name: 'Floor 1' }, { id: 'g2', name: 'Reception' }];
  const screens = [
    { id: 's1', label: 'Screen 1', folderIds: ['g1', 'g2'] },
    { id: 's2', label: 'Screen 2', folderIds: ['g1'] },
    { id: 's3', label: 'Screen 3', folderIds: [] },
  ];
  const m = M.buildModel(groups, screens);
  assert.equal(M.countIn(m, 'g1'), 2);
  assert.equal(M.countIn(m, 'g2'), 1);
  assert.equal(M.countIn(m, M.ALL), 3, 'distinct screens, not memberships');
  assert.deepEqual(M.itemsIn(m, 'g2').shown.map((i) => i.id), ['s1']);
  assert.deepEqual(M.itemsIn(m, M.UNFILED).shown.map((i) => i.id), ['s3']);
  assert.equal(M.placeLabel(m, 's1'), 'Floor 1, Reception');
});

test('a long list is capped and reports the rest; order is natural ("2" before "10")', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, label: `Screen ${i + 1}`, folderIds: [] }));
  const m = M.buildModel([], many);
  const r = M.itemsIn(m, M.ALL, '', 200);
  assert.equal(r.shown.length, 200);
  assert.equal(r.hidden, 50);
  assert.deepEqual(r.shown.slice(0, 3).map((i) => i.label), ['Screen 1', 'Screen 2', 'Screen 3']);
  assert.equal(r.shown[9].label, 'Screen 10');
});

test('a folder cycle in the data does not hang', () => {
  const m = M.buildModel([{ id: 'p', parent_id: 'q', name: 'P' }, { id: 'q', parent_id: 'p', name: 'Q' }],
    [{ id: 'i', label: 'x', folderIds: ['p'] }]);
  assert.ok(M.countIn(m, 'p') >= 1);
  assert.ok(Array.isArray(M.breadcrumb(m, 'p')));
});
