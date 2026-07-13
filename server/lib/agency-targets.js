'use strict';

// #73: the single query behind GET /api/agency/playlists. Returns ONLY this token's
// designated playlists, in its bound workspace. The WHERE clause IS the confinement and is
// the thing to bite-test:
//   t.token_id = ?      -> this token's targets, never another token's
//   (JOIN api_token_targets) -> only allowlisted playlists, never one outside the allowlist
//   p.workspace_id = ?  -> only the bound workspace, never cross-workspace
// db is passed in (not module-required) so the confinement is unit-testable in isolation.
function listDesignatedPlaylists(db, tokenId, workspaceId) {
  return db.prepare(`
    SELECT p.id, p.name, p.status
    FROM api_token_targets t
    JOIN playlists p ON p.id = t.playlist_id
    WHERE t.token_id = ? AND p.workspace_id = ?
    ORDER BY p.name
  `).all(tokenId, workspaceId);
}

// #73 full-screen guardrail: a playlist is "zoned" if any item targets a layout zone. Agency
// uploads are full-screen and can't safely target a zone, so a zoned playlist can't be shared
// with an agency. Checked at BOTH designation (reject the grant) AND upload (block the add) -
// the upload check is mandatory because auto-publish has no draft step to catch a playlist
// that becomes zoned after designation.
function isZonedPlaylist(db, playlistId) {
  return !!db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND zone_id IS NOT NULL LIMIT 1').get(playlistId);
}

// #158 (Hybrid-C): the folder subtree an agency token may upload into = its bound
// upload_folder_id PLUS every descendant. This one recursive query IS the confinement,
// used by BOTH GET /api/agency/folders (the portal dropdown) and POST /api/agency/content
// (the upload target check) — so the list the agency sees and the set it may write to can
// never drift apart. The anchor row is workspace-guarded; descendants inherit the workspace
// because folders.js forbids a cross-workspace parent, so the whole subtree stays in-workspace.
// Returns [] for a null/foreign/absent root (legacy or root-bound token -> uploads go to root,
// no dropdown). rootFolderId included in the result (an agency can upload to the folder itself).
function folderSubtree(db, rootFolderId, workspaceId) {
  if (!rootFolderId) return [];
  return db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM content_folders WHERE id = ? AND workspace_id = ?
      UNION
      SELECT cf.id FROM content_folders cf JOIN sub ON cf.parent_id = sub.id
    )
    SELECT cf.id, cf.name, cf.parent_id
    FROM content_folders cf JOIN sub ON cf.id = sub.id
    ORDER BY cf.name COLLATE NOCASE
  `).all(rootFolderId, workspaceId);
}

module.exports = { listDesignatedPlaylists, isZonedPlaylist, folderSubtree };
