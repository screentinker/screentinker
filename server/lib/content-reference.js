'use strict';

/*
 * Is this content referenced by something a PLAYER is entitled to fetch it for?
 *
 * The public /api/content/:id/{file,thumbnail,bundle} routes serve anonymous players, gated on the
 * content being in use: in a playlist, or in a widget in the content's own workspace (scoped so a
 * user elsewhere cannot unlock it by naming the UUID in a widget of their own).
 *
 * ⚠️ AND AS A DEVICE'S DEFAULT CONTENT. The standby image is sent to players top-level, outside any
 * playlist, and the Android player downloads it through /file like every other local asset so it
 * can show offline. The gate did not know about it, so the download was refused with 403 and the
 * standby never reached an Android screen unless the same image also happened to sit in a
 * playlist. Found while testing the offline fallback on the emulator. Scoped to devices in the
 * content's workspace, for the same reason as the widget lookup.
 */
function isReferencedForPlayers(db, content) {
  if (db.prepare('SELECT 1 FROM playlist_items WHERE content_id = ? LIMIT 1').get(content.id)) return true;
  // Perf note: LIKE scan on widgets.config is O(n) per request. Fine at current scale; revisit with
  // a content_widget_refs join table if this grows.
  if (db.prepare('SELECT 1 FROM widgets WHERE workspace_id = ? AND config LIKE ? LIMIT 1')
    .get(content.workspace_id, `%/api/content/${content.id}/%`)) return true;
  return !!db.prepare('SELECT 1 FROM devices WHERE default_content_id = ? AND workspace_id = ? LIMIT 1')
    .get(content.id, content.workspace_id);
}

module.exports = { isReferencedForPlayers };
