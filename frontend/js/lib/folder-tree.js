/*
 * Content folders as a TREE — the pure half of the playlist picker's folder navigation.
 *
 * ⚠️ WHY THIS IS NOT A FLAT LIST. The first version of the picker's folder filter listed every
 * folder side by side. On the library that prompted it — 39 folders, 30 of them nested, five levels
 * deep — that put "WESTERN AUSTRALIA" and "WEST PERTH" next to each other as peers when one
 * contains the other, offered 39 entries to scroll, and showed a DIRECT count of 100 for a folder
 * that actually holds 204 files once its children are counted. Every one of those is a way to lose
 * a file an operator can plainly see in the library.
 *
 * Kept separate from the view so it can be tested against a real tree rather than a screenshot.
 */

const ROOT = '';

/**
 * Index folders by parent.
 *
 * ⚠️ A folder whose parent is missing — deleted, or belonging to another workspace — is treated as
 * TOP LEVEL rather than dropped. An orphan you can still reach beats content you cannot, and a
 * picker that silently hides a folder is the bug this whole file exists to fix.
 */
export function buildFolderTree(folders) {
  const byId = new Map();
  const children = new Map();
  for (const f of folders || []) if (f && f.id) byId.set(f.id, f);
  for (const f of folders || []) {
    if (!f || !f.id) continue;
    const parent = f.parent_id && byId.has(f.parent_id) ? f.parent_id : ROOT;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(f);
  }
  for (const list of children.values()) {
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  }
  return { byId, children };
}

export function childrenOf(tree, parentId) {
  return tree.children.get(parentId || ROOT) || [];
}

/**
 * Every folder id in this subtree, itself included.
 *
 * ⚠️ Guards against a cycle in the data. A parent chain that loops would otherwise hang the
 * dashboard, and the database does not forbid one — `parent_id` is a plain column.
 */
export function subtreeIds(tree, id) {
  const out = new Set();
  const walk = (fid) => {
    if (out.has(fid)) return;
    out.add(fid);
    for (const c of childrenOf(tree, fid)) walk(c.id);
  };
  walk(id);
  return out;
}

/**
 * How many items are in this folder OR anywhere beneath it.
 *
 * ⚠️ SUBTREE, not direct. Picking a folder means "everything under here" — a direct count makes a
 * grouping folder look nearly empty, which is exactly how the flat version understated
 * "WESTERN AUSTRALIA" as 100 when it holds 204.
 */
export function countIn(tree, id, content) {
  const ids = subtreeIds(tree, id);
  let n = 0;
  for (const c of content || []) if (c.folder_id && ids.has(c.folder_id)) n++;
  return n;
}

/** Ancestors of [id], outermost first, for a breadcrumb. Cycle-safe. */
export function pathTo(tree, id) {
  const out = [];
  const seen = new Set();
  let cur = tree.byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? tree.byId.get(cur.parent_id) : null;
  }
  return out;
}

/** Items with no folder at all — a real place an operator looks for a stray file. */
export function unfiledCount(content) {
  return (content || []).filter((c) => !c.folder_id).length;
}

/**
 * Does this item belong under the current filter?
 *
 * '' = everything, '__root__' = filed nowhere, otherwise anywhere in that folder's subtree.
 */
export function itemMatchesFolder(item, filter, wantedIds) {
  if (!filter) return true;
  if (filter === '__root__') return !item.folder_id;
  return !!item.folder_id && !!wantedIds && wantedIds.has(item.folder_id);
}

export { ROOT };
