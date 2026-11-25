/*
 * The pure half of the folder select (components/folder-select.js): which items a folder shows,
 * how many it holds, and which folders to offer at a level — for a pick-ONE list that is too long to
 * read as one flat <select>.
 *
 * ⚠️ WHY THIS IS NOT folder-tree.js's countIn. That one counts items with ONE `folder_id`. Here an
 * item may sit in SEVERAL folders at once: a screen belongs to every device group it is a member of,
 * so a group "folder" and a nested content folder must share one model. An item carries
 * `folderIds` (zero, one or many), and every count is of DISTINCT items, or a screen in two groups
 * under the same parent would be counted twice.
 *
 * The tree itself (nesting, orphans, cycles) is folder-tree.js's, unchanged, so the schedule dialog
 * and the playlist's Add Content picker can never disagree about where a folder sits.
 *
 * Kept free of the DOM so it can be tested against real shapes (server/test/folder-select-model.test.js).
 */
import { buildFolderTree, childrenOf, subtreeIds, pathTo } from './folder-tree.js';

/** `''` = every item, `UNFILED` = items in no folder, anything else is a folder id. */
export const ALL = '';
export const UNFILED = '__unfiled__';

/**
 * @param {Array<{id, parent_id?, name}>} folders
 * @param {Array<{id, label, folderIds?: string[]}>} items
 */
export function buildModel(folders, items) {
  const tree = buildFolderTree(folders || []);
  const list = (items || []).filter((i) => i && i.id != null).map((i) => ({
    ...i,
    // An id that names no folder (deleted, another workspace) is treated as unfiled for counting
    // and filtering — the item must still be reachable, never lost behind a dead folder.
    folderIds: (Array.isArray(i.folderIds) ? i.folderIds : []).filter((f) => f && tree.byId.has(f)),
  }));
  const subtrees = new Map();
  const subtreeOf = (id) => {
    if (!subtrees.has(id)) subtrees.set(id, subtreeIds(tree, id));
    return subtrees.get(id);
  };
  return { tree, items: list, subtreeOf };
}

/** Does `item` belong in `where` (ALL, UNFILED or a folder id — its whole subtree)? */
export function inFolder(model, item, where) {
  if (where === ALL) return true;
  if (where === UNFILED) return item.folderIds.length === 0;
  const sub = model.subtreeOf(where);
  return item.folderIds.some((f) => sub.has(f));
}

/** Distinct items under `where`. */
export function countIn(model, where) {
  let n = 0;
  for (const it of model.items) if (inFolder(model, it, where)) n += 1;
  return n;
}

export const unfiledCount = (model) => countIn(model, UNFILED);

/**
 * What to show: items under `where` whose label matches `query` (case-insensitive substring),
 * sorted by label with numbers in order ("Screen 2" before "Screen 10"), capped at `limit`.
 * Returns { shown, hidden } so the caller can SAY how many more matched rather than hide them.
 */
export function itemsIn(model, where, query = '', limit = 200) {
  const q = String(query || '').trim().toLowerCase();
  const matched = model.items
    .filter((it) => inFolder(model, it, where))
    .filter((it) => !q || String(it.label || '').toLowerCase().includes(q)
      || String(it.sub || '').toLowerCase().includes(q))
    .sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true, sensitivity: 'base' }));
  return { shown: matched.slice(0, limit), hidden: Math.max(0, matched.length - limit) };
}

/** The folders directly inside `parent` that hold something, with their counts. Empty ones are left out. */
export function foldersAt(model, parent) {
  const at = parent === ALL || parent === UNFILED ? '' : parent;
  return childrenOf(model.tree, at)
    .map((f) => ({ folder: f, count: countIn(model, f.id) }))
    .filter((x) => x.count > 0);
}

/** How many folders directly inside `parent` are empty (so the bar can say they were left out). */
export function emptyFoldersAt(model, parent) {
  const at = parent === ALL || parent === UNFILED ? '' : parent;
  return childrenOf(model.tree, at).filter((f) => countIn(model, f.id) === 0).length;
}

/** Folders anywhere in the tree whose name matches `query`, with their path — search finds folders too. */
export function matchingFolders(model, query, limit = 40) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const f of model.tree.byId.values()) {
    if (!String(f.name || '').toLowerCase().includes(q)) continue;
    const count = countIn(model, f.id);
    if (count > 0) out.push({ folder: f, count, path: pathTo(model.tree, f.id).map((x) => x.name).join(' › ') });
  }
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return out.slice(0, limit);
}

/** The breadcrumb to a folder, root first. */
export const breadcrumb = (model, where) => (where === ALL || where === UNFILED ? [] : pathTo(model.tree, where));

/** A readable "where it lives" for the trigger: folder path(s) of the item, joined. */
export function placeLabel(model, id) {
  const it = model.items.find((x) => String(x.id) === String(id));
  if (!it || !it.folderIds.length) return '';
  return it.folderIds.map((f) => pathTo(model.tree, f).map((x) => x.name).join(' › ')).join(', ');
}
