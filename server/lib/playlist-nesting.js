'use strict';

/*
 * The rules for putting one playlist inside another — ONE copy, used by the playlist route and
 * the display route (routes/playlists.js, routes/assignments.js), so a display's playlist can nest
 * exactly what a playlist can and nothing more.
 *
 * ⚠️ DEPTH AND CYCLES ARE BOTH REFUSED AT CREATION, by TYPE rather than by traversal. Refusing a
 * child that itself holds a child caps nesting at one level, and that single rule also makes
 * A→B→A unconstructible: for the loop to close, B would have to hold a child while already being
 * one. The reverse direction is refused too — a playlist already used as a child cannot take one —
 * or A (inside B) could take C, giving B→A→C, two levels built from the far end.
 *
 * Returns null when the nesting is allowed, else { status, error } naming the playlist at fault.
 */
function nestingError(db, parentId, childId, workspaceId) {
  if (childId === parentId) return { status: 400, error: 'a playlist cannot contain itself' };
  const child = db.prepare('SELECT id, name, workspace_id FROM playlists WHERE id = ?').get(childId);
  if (!child) return { status: 404, error: 'Child playlist not found' };
  // A corporate playlist is assigned to stores, never nested: as a child it would be editable
  // through its parent's rules and would carry head office's lock into somebody else's playlist.
  const corporate = require('./corporate/guard').nestingRefusal(db, childId);
  if (corporate) return corporate;
  if (child.workspace_id && child.workspace_id !== workspaceId) {
    return { status: 403, error: 'Child playlist is not in this playlist\'s workspace' };
  }
  const grandchild = db.prepare(`
    SELECT p.name FROM playlist_items pi
      JOIN playlists p ON p.id = pi.child_playlist_id
     WHERE pi.playlist_id = ? LIMIT 1
  `).get(childId);
  if (grandchild) {
    return {
      status: 400,
      error: `"${child.name}" already contains the playlist "${grandchild.name}", and playlists may only nest one level deep`,
    };
  }
  const parent = parentId ? db.prepare(`
    SELECT p.name FROM playlist_items pi
      JOIN playlists p ON p.id = pi.playlist_id
     WHERE pi.child_playlist_id = ? LIMIT 1
  `).get(parentId) : null;
  if (parent) {
    return {
      status: 400,
      error: `this playlist is already used inside "${parent.name}", so it cannot contain another playlist — playlists may only nest one level deep`,
    };
  }
  return null;
}

module.exports = { nestingError };
