'use strict';

/*
 * #796: library folders for widgets, playlists and schedules (routes/library-folders.js).
 *
 * Folders live in library_folders (one table, a `kind` column), and where an item is filed lives in
 * library_folder_items (kind, item_id) -> folder_id. No row means the item is at the root, so every
 * widget, playlist and schedule that existed before this feature is simply "at the root" and shows in
 * All with nothing to migrate.
 *
 * ⚠️ Nothing in this file writes widgets, playlists, schedules or playlist_items. Filing is metadata
 * about an item, kept beside it, never a change to it. See the migration in db/database.js.
 */

const KINDS = Object.freeze({
  // 'cap_alert' widgets are the hidden cards of emergency feeds, not library widgets (routes/widgets.js GET /).
  widget: { table: 'widgets', extra: "AND widget_type != 'cap_alert'" },
  playlist: { table: 'playlists', extra: '' },
  schedule: { table: 'schedules', extra: '' },
});

const MAX_FOLDERS_PER_KIND = 200;
// "Recently added" is the Content Library's own window, so the four libraries agree on what "recent" means.
const { RECENT_DAYS } = require('./content-library');

function hasTable(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name); } catch (_) { return false; }
}

/** The ids among `ids` that are rows of this kind in this workspace (never a platform template). */
function ownedIds(db, kind, workspaceId, ids) {
  const k = KINDS[kind];
  const out = new Set();
  if (!k || !workspaceId || !ids.length) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = db.prepare(`SELECT id FROM ${k.table} WHERE workspace_id = ? ${k.extra} AND id IN (${chunk.map(() => '?').join(',')})`)
      .all(workspaceId, ...chunk);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** File `ids` into `folderId` (null = the root). The caller checked ownership and the folder. */
function file(db, kind, workspaceId, ids, folderId) {
  let n = 0;
  if (folderId) {
    const up = db.prepare(`INSERT INTO library_folder_items (kind, item_id, workspace_id, folder_id) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind, item_id) DO UPDATE SET folder_id = excluded.folder_id, workspace_id = excluded.workspace_id, filed_at = strftime('%s','now')`);
    for (const id of ids) n += up.run(kind, id, workspaceId, folderId).changes ? 1 : 0;
  } else {
    const del = db.prepare('DELETE FROM library_folder_items WHERE kind = ? AND item_id = ?');
    for (const id of ids) { del.run(kind, id); n += 1; }
  }
  return n;
}

/** Forget where a deleted item was filed. Called by the item's own DELETE route; never throws. */
function forget(db, kind, itemId) {
  try { db.prepare('DELETE FROM library_folder_items WHERE kind = ? AND item_id = ?').run(kind, String(itemId)); } catch (_) { /* table absent on an old schema */ }
}

/*
 * How many distinct things reference each item, for the Unused view and the usage filter. Each
 * reference is counted once ("playlist:<id>", "schedule:<id>", "screen:<id>"...), so a widget that is
 * both in a playlist's draft and in its published copy is one use, not two.
 *
 * ⚠️ "Unused" must mean NOTHING references it (the Content Library's rule, lib/content-library.js):
 * an item called Unused gets deleted, so every place that can put one on a screen is checked. Each
 * source is guarded on its own so an older schema (no walls, no resolved view) still answers.
 */
function usage(db, kind, workspaceId) {
  const refs = new Map();
  const q = (prefix, sql, ...args) => {
    try {
      for (const r of db.prepare(sql).all(...args)) {
        if (!r.id || r.ref == null) continue;
        if (!refs.has(r.id)) refs.set(r.id, new Set());
        refs.get(r.id).add(prefix + ':' + r.ref);
      }
    } catch (_) { /* source absent on this schema */ }
  };
  if (kind === 'widget') {
    q('playlist', `SELECT pi.widget_id AS id, pi.playlist_id AS ref FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
        WHERE p.workspace_id = ? AND pi.widget_id IS NOT NULL`, workspaceId);
    // What screens play is the PUBLISHED copy: a widget taken out of a draft is still on air until publish.
    q('playlist', `SELECT w.id AS id, p.id AS ref FROM widgets w JOIN playlists p ON p.workspace_id = w.workspace_id
        AND p.published_snapshot LIKE '%' || w.id || '%' WHERE w.workspace_id = ?`, workspaceId);
    q('schedule', 'SELECT widget_id AS id, id AS ref FROM schedules WHERE workspace_id = ? AND widget_id IS NOT NULL', workspaceId);
    q('screen', `SELECT a.widget_id AS id, a.device_id AS ref FROM assignments a JOIN devices d ON d.id = a.device_id
        WHERE d.workspace_id = ? AND a.widget_id IS NOT NULL`, workspaceId);
    q('slot', `SELECT cs.fallback_widget_id AS id, cs.id AS ref FROM corporate_slots cs JOIN playlists p ON p.id = cs.playlist_id
        WHERE p.workspace_id = ? AND cs.fallback_widget_id IS NOT NULL`, workspaceId);
  } else if (kind === 'playlist') {
    // Screens that play it, inherited through a group or a wall included.
    if (hasTable(db, 'device_resolved_playlist')) {
      q('screen', `SELECT r.playlist_id AS id, r.device_id AS ref FROM device_resolved_playlist r JOIN playlists p ON p.id = r.playlist_id
          WHERE p.workspace_id = ?`, workspaceId);
    }
    q('screen', 'SELECT playlist_id AS id, id AS ref FROM devices WHERE workspace_id = ? AND playlist_id IS NOT NULL', workspaceId);
    q('group', 'SELECT playlist_id AS id, id AS ref FROM device_groups WHERE workspace_id = ? AND playlist_id IS NOT NULL', workspaceId);
    q('wall', 'SELECT playlist_id AS id, id AS ref FROM video_walls WHERE workspace_id = ? AND playlist_id IS NOT NULL', workspaceId);
    q('schedule', 'SELECT playlist_id AS id, id AS ref FROM schedules WHERE workspace_id = ? AND playlist_id IS NOT NULL', workspaceId);
    // Nested in another playlist.
    q('playlist', `SELECT pi.child_playlist_id AS id, pi.playlist_id AS ref FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
        WHERE p.workspace_id = ? AND pi.child_playlist_id IS NOT NULL`, workspaceId);
    // Store content for head office's local slots, and a smart folder sync's target.
    q('slot', 'SELECT fill_playlist_id AS id, id AS ref FROM corporate_slot_fills WHERE workspace_id = ? AND fill_playlist_id IS NOT NULL', workspaceId);
    q('slot', `SELECT cs.playlist_id AS id, cs.id AS ref FROM corporate_slots cs JOIN playlists p ON p.id = cs.playlist_id
        WHERE p.workspace_id = ?`, workspaceId);
    q('sync', 'SELECT playlist_id AS id, id AS ref FROM cloud_folders WHERE workspace_id = ? AND playlist_id IS NOT NULL', workspaceId);
  }
  const out = {};
  for (const [id, set] of refs) out[id] = set.size;
  return out;
}

/** Everything the library page needs besides the items themselves, in one read. */
function snapshot(db, kind, workspaceId) {
  const k = KINDS[kind];
  const folders = db.prepare('SELECT id, workspace_id, kind, parent_id, name, created_at, updated_at FROM library_folders WHERE workspace_id = ? AND kind = ? ORDER BY name COLLATE NOCASE')
    .all(workspaceId, kind);
  // Only placements of items that still exist here: a row left by an item deleted some other way (a
  // purge, an import) is ignored rather than counted.
  const rows = db.prepare(`SELECT f.item_id, f.folder_id FROM library_folder_items f
      JOIN ${k.table} t ON t.id = f.item_id AND t.workspace_id = f.workspace_id
     WHERE f.workspace_id = ? AND f.kind = ?`).all(workspaceId, kind);
  const known = new Set(folders.map((f) => f.id));
  const placements = {};
  const counts = new Map();
  for (const r of rows) {
    if (!known.has(r.folder_id)) continue;
    placements[r.item_id] = r.folder_id;
    counts.set(r.folder_id, (counts.get(r.folder_id) || 0) + 1);
  }
  for (const f of folders) f.count = counts.get(f.id) || 0;
  return { folders, placements, usage: kind === 'schedule' ? {} : usage(db, kind, workspaceId) };
}

module.exports = { KINDS, MAX_FOLDERS_PER_KIND, RECENT_DAYS, ownedIds, file, forget, usage, snapshot };
