'use strict';

/*
 * #796: library folders for widgets, playlists and schedules.
 *
 * The Content Library's folder model (routes/folders.js), for the other three libraries. Mounted at
 * /api/library-folders with resolveTenancy (config/api-surface.js), so every handler acts on the
 * caller's CURRENT workspace and nothing else.
 *
 *   GET    /:kind                     folders (with direct counts), where each item is filed, usage
 *   POST   /:kind/folders             create { name, parent_id? }
 *   PUT    /:kind/folders/:id         rename / move { name?, parent_id? }
 *   DELETE /:kind/folders/:id         delete; its subfolders and items move up to its parent
 *   POST   /:kind/move                file items { ids: [...], folder_id: <id> | null (root) }
 *
 * ⚠️ ORGANISATIONAL ONLY. Filing an item writes library_folder_items and nothing else: no column of
 * widgets / playlists / schedules / playlist_items is read for update or written here. That is the
 * whole guarantee that moving a widget does not bump its revision (widgets.updated_at reloads every
 * screen showing it), that a playlist's publish state and snapshot are untouched, and that a
 * schedule's timing, recurrence, priority and targets stay exactly as they were.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { denyReadOnly } = require('../lib/tenancy');
const lib = require('../lib/library-folders');

const MAX_FOLDERS_PER_KIND = lib.MAX_FOLDERS_PER_KIND;
const MAX_MOVE = 500;
const MAX_NAME = 100;

router.param('kind', (req, res, next, kind) => {
  if (!lib.KINDS[kind]) return res.status(404).json({ error: 'Unknown library' });
  req.libraryKind = kind;
  next();
});

// A folder of THIS kind in THIS workspace, or null. Every folder lookup goes through here, so an id
// from another workspace (or another library) reads exactly like one that does not exist.
function folderInWorkspace(req, id) {
  if (!id || typeof id !== 'string') return null;
  return db.prepare('SELECT * FROM library_folders WHERE id = ? AND workspace_id = ? AND kind = ?')
    .get(id, req.workspaceId, req.libraryKind) || null;
}

function cleanName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return { error: 'name is required' };
  if (name.length > MAX_NAME) return { error: 'name too long' };
  return { name };
}

router.get('/:kind', (req, res) => {
  const kind = req.libraryKind;
  if (!req.workspaceId) return res.json({ kind, folders: [], placements: {}, usage: {}, recent_days: lib.RECENT_DAYS });
  res.json({ kind, ...lib.snapshot(db, kind, req.workspaceId), recent_days: lib.RECENT_DAYS });
});

router.post('/:kind/folders', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating folders.' });
  if (denyReadOnly(req, res)) return;
  const kind = req.libraryKind;
  const n = cleanName(req.body && req.body.name);
  if (n.error) return res.status(400).json({ error: n.error });
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM library_folders WHERE workspace_id = ? AND kind = ?').get(req.workspaceId, kind);
  if (count >= MAX_FOLDERS_PER_KIND) {
    return res.status(429).json({ error: `Folder limit reached (${MAX_FOLDERS_PER_KIND}). Delete unused folders before creating more.` });
  }
  const parentId = (req.body && req.body.parent_id) || null;
  if (parentId && !folderInWorkspace(req, parentId)) return res.status(400).json({ error: 'Invalid parent_id' });
  const id = uuidv4();
  db.prepare('INSERT INTO library_folders (id, workspace_id, kind, parent_id, name, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.workspaceId, kind, parentId, n.name, req.user ? req.user.id : null);
  res.status(201).json({ ...db.prepare('SELECT * FROM library_folders WHERE id = ?').get(id), count: 0 });
});

router.put('/:kind/folders/:id', (req, res) => {
  if (!req.workspaceId) return res.status(404).json({ error: 'Folder not found' });
  if (denyReadOnly(req, res)) return;
  const folder = folderInWorkspace(req, req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const body = req.body || {};
  const updates = [];
  const values = [];
  if (body.name !== undefined) {
    const n = cleanName(body.name);
    if (n.error) return res.status(400).json({ error: n.error === 'name is required' ? 'name cannot be empty' : n.error });
    updates.push('name = ?'); values.push(n.name);
  }
  if (body.parent_id !== undefined) {
    const newParent = body.parent_id || null;
    if (newParent === folder.id) return res.status(400).json({ error: 'Folder cannot be its own parent' });
    if (newParent) {
      const parent = folderInWorkspace(req, newParent);
      if (!parent) return res.status(400).json({ error: 'Invalid parent_id' });
      // Walk up from the new parent: reaching this folder means the move would make a loop.
      const seen = new Set();
      for (let cur = parent; cur; cur = cur.parent_id ? folderInWorkspace(req, cur.parent_id) : null) {
        if (cur.id === folder.id || seen.has(cur.id)) return res.status(400).json({ error: 'Move would create a cycle' });
        seen.add(cur.id);
      }
    }
    updates.push('parent_id = ?'); values.push(newParent);
  }
  if (!updates.length) return res.json(folder);
  updates.push("updated_at = strftime('%s','now')");
  db.prepare(`UPDATE library_folders SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...values, folder.id, req.workspaceId);
  res.json(db.prepare('SELECT * FROM library_folders WHERE id = ?').get(folder.id));
});

/*
 * Deleting a folder never deletes what is in it. Its subfolders and its items move up one level (to
 * its parent, or the root), explicitly and in one transaction: nothing here leans on a cascade.
 */
router.delete('/:kind/folders/:id', (req, res) => {
  if (!req.workspaceId) return res.status(404).json({ error: 'Folder not found' });
  if (denyReadOnly(req, res)) return;
  const folder = folderInWorkspace(req, req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const result = db.transaction(() => {
    const up = folder.parent_id || null;
    const folders = db.prepare('UPDATE library_folders SET parent_id = ? WHERE parent_id = ? AND workspace_id = ? AND kind = ?')
      .run(up, folder.id, req.workspaceId, folder.kind).changes;
    const items = up
      ? db.prepare('UPDATE library_folder_items SET folder_id = ? WHERE folder_id = ? AND workspace_id = ?').run(up, folder.id, req.workspaceId).changes
      : db.prepare('DELETE FROM library_folder_items WHERE folder_id = ? AND workspace_id = ?').run(folder.id, req.workspaceId).changes;
    db.prepare('DELETE FROM library_folders WHERE id = ? AND workspace_id = ?').run(folder.id, req.workspaceId);
    return { folders, items, moved_to: up };
  })();
  res.json({ success: true, ...result });
});

router.post('/:kind/move', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  if (denyReadOnly(req, res)) return;
  const kind = req.libraryKind;
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x) => typeof x === 'string' && x))] : null;
  if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (ids.length > MAX_MOVE) return res.status(400).json({ error: `At most ${MAX_MOVE} items per move` });
  const folderId = body.folder_id || null;
  if (folderId && !folderInWorkspace(req, folderId)) return res.status(400).json({ error: 'Invalid folder_id for this workspace' });

  // Every item must be this workspace's own. A platform template (workspace_id NULL) is shared by
  // every workspace, so no one workspace can file it; another workspace's id reads as not found.
  const owned = lib.ownedIds(db, kind, req.workspaceId, ids);
  const missing = ids.filter((id) => !owned.has(id));
  if (missing.length) return res.status(404).json({ error: `Not found in this workspace: ${missing.join(', ')}`, missing });

  const moved = db.transaction(() => lib.file(db, kind, req.workspaceId, ids, folderId))();
  res.json({ success: true, moved, folder_id: folderId });
});

module.exports = router;
