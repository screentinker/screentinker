const express = require('express');
const router = express.Router();

// A folder rule includes subfolders, so moving or deleting a folder can change what a smart
// playlist selects (lib/smart-playlist.js debounces and republishes only real changes).
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => { if (res.statusCode < 400) require('../lib/smart-playlist').notifyContentChanged(req.workspaceId); });
  }
  next();
});
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES } = require('../middleware/auth');
// Phase 2.2c: workspace-aware access. Mirrors devices.js / content.js.
const { resourceAccess } = require('../lib/tenancy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-workspace folder cap. The route has no rate limit (multer doesn't go
// through the global API limiter chain), so without a count cap a workspace
// could insert millions of rows. 100 is generous for a real org hierarchy.
const MAX_FOLDERS_PER_WORKSPACE = 100;

// Resolve a folder and the caller's access to its workspace. Returns:
//   { row, ctx }              - access granted; ctx.workspaceRole / ctx.actingAs available
//   { row: { id: null } }     - root (no folder id supplied) - always accessible
//   null                      - folder not found or no access
//
// Platform-template folders (workspace_id IS NULL) are readable by anyone.
// Writable only by platform_admin (same shape as content.js).
function accessibleFolder(req, folderId, requireWrite = false) {
  if (!folderId) return { row: { id: null }, ctx: null };
  if (!UUID_RE.test(folderId)) return null;
  const row = db.prepare('SELECT * FROM content_folders WHERE id = ?').get(folderId);
  if (!row) return null;

  // Platform-template path
  if (!row.workspace_id) {
    if (requireWrite && !PLATFORM_ROLES.includes(req.user.role)) return null;
    return { row, ctx: null };
  }

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(row.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) return null;
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') return null;
  return { row, ctx };
}

// List folders accessible to the caller in their current workspace.
// Includes platform-template folders (workspace_id IS NULL) for everyone.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const rows = db.prepare(
    'SELECT * FROM content_folders WHERE (workspace_id = ? OR workspace_id IS NULL) ORDER BY name COLLATE NOCASE'
  ).all(req.workspaceId);
  res.json(rows);
});

// Create a folder in the caller's current workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating folders.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'name too long' });

  // Per-workspace cap. Platform_admin exempt (cross-workspace admin tooling).
  if (!PLATFORM_ROLES.includes(req.user.role)) {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM content_folders WHERE workspace_id = ?').get(req.workspaceId);
    if (count >= MAX_FOLDERS_PER_WORKSPACE) {
      return res.status(429).json({
        error: `Folder limit reached (${MAX_FOLDERS_PER_WORKSPACE}). Delete unused folders before creating more.`
      });
    }
  }

  const parentId = req.body.parent_id || null;
  if (parentId) {
    const parent = accessibleFolder(req, parentId, true);
    if (!parent || parent.row.id === null) return res.status(400).json({ error: 'Invalid parent_id' });
    // Parent must be in the same workspace as the new folder.
    if (parent.row.workspace_id !== req.workspaceId) {
      return res.status(400).json({ error: 'Parent folder is in a different workspace' });
    }
  }

  const id = uuidv4();
  db.prepare(
    'INSERT INTO content_folders (id, user_id, workspace_id, parent_id, name) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.user.id, req.workspaceId, parentId, name);

  res.status(201).json(db.prepare('SELECT * FROM content_folders WHERE id = ?').get(id));
});

// Rename / move a folder.
router.put('/:id', (req, res) => {
  const access = accessibleFolder(req, req.params.id, true);
  if (!access || access.row.id === null) return res.status(404).json({ error: 'Folder not found' });
  const folder = access.row;

  const updates = [];
  const values = [];

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    if (name.length > 100) return res.status(400).json({ error: 'name too long' });
    updates.push('name = ?');
    values.push(name);
  }

  if (req.body.parent_id !== undefined) {
    const newParent = req.body.parent_id || null;
    if (newParent === folder.id) return res.status(400).json({ error: 'Folder cannot be its own parent' });
    if (newParent) {
      const parent = accessibleFolder(req, newParent, true);
      if (!parent || parent.row.id === null) return res.status(400).json({ error: 'Invalid parent_id' });
      // New parent must be in the same workspace as this folder.
      if (parent.row.workspace_id !== folder.workspace_id) {
        return res.status(400).json({ error: 'Cannot move folder to a parent in another workspace' });
      }
      // Reject cycles: walk up from the new parent and ensure we never hit this folder.
      let cursor = parent.row;
      const seen = new Set([folder.id]);
      while (cursor && cursor.parent_id) {
        if (seen.has(cursor.parent_id)) {
          return res.status(400).json({ error: 'Move would create a cycle' });
        }
        seen.add(cursor.parent_id);
        cursor = db.prepare('SELECT * FROM content_folders WHERE id = ?').get(cursor.parent_id);
      }
    }
    updates.push('parent_id = ?');
    values.push(newParent);
  }

  if (updates.length === 0) return res.json(folder);

  values.push(folder.id);
  db.prepare(`UPDATE content_folders SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM content_folders WHERE id = ?').get(folder.id));
});

// Delete a folder. Content inside it falls back to root via ON DELETE SET NULL.
// Subfolders cascade-delete; if the user wants to keep them they should move them first.
router.delete('/:id', (req, res) => {
  const access = accessibleFolder(req, req.params.id, true);
  if (!access || access.row.id === null) return res.status(404).json({ error: 'Folder not found' });

  db.prepare('DELETE FROM content_folders WHERE id = ?').run(access.row.id);
  res.json({ success: true });
});

module.exports = router;
