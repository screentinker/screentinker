'use strict';

const { db } = require('../db/database');

/*
 * "Which devices are actually playing X?" — in ONE place.
 *
 * ⚠️ This question has been got wrong five separate times, always the same way: a hand-written
 * `JOIN playlist_items pi ON pi.playlist_id = d.playlist_id`. There is even a comment in
 * routes/playlists.js noting it was "the THIRD time this exact shape has bitten" — sitting directly
 * above a fourth instance of it. A fan-out that forgets a case is the recurring bug in this
 * codebase, so this is a shared helper rather than a sixth thing to remember.
 *
 * Two cases every caller must handle and most did not:
 *
 * 1. **Inheritance.** devices.playlist_id is NULL for a screen that inherits from its group or
 *    wall — the copies were removed when the resolver landed. Joining on the raw column silently
 *    skips exactly those screens, so a widget edit or a replaced video never reaches them.
 *
 * 2. **Nesting.** A playlist's rows hold a CHILD REFERENCE, not the child's items. A widget or a
 *    content file living inside a nested playlist does not appear in the parent's playlist_items at
 *    all, even though the parent's flattened snapshot plays it. Depth is capped at 1
 *    (MAX_NEST_DEPTH), so one hop is exhaustive.
 */

// Devices whose RESOLVED playlist is this one. Inheritance-aware by construction.
function devicesOnPlaylist(playlistId) {
  return db.prepare('SELECT device_id AS id FROM device_resolved_playlist WHERE playlist_id = ?')
    .all(playlistId).map((r) => r.id);
}

/*
 * Shared shape: devices whose resolved playlist contains `column = ?`, directly or one level down —
 * plus devices that can only reach it through a TRIGGER.
 *
 * ⚠️ The trigger case is the third one every hand-written version forgot. A device whose trigger
 * targets a playlist plays that playlist's items when the trigger fires, so it is showing this
 * widget or this file even though its base playlist has never mentioned either. pushToDevices in
 * routes/playlists.js already learned this the hard way; there is no reason for the widget and
 * content pushes to learn it separately.
 */
function devicesPlayingItem(column, value) {
  const ids = new Set(db.prepare(`
    SELECT DISTINCT d.id AS id
      FROM devices d
      JOIN device_resolved_playlist r ON r.device_id = d.id
      JOIN playlist_items top ON top.playlist_id = r.playlist_id
      LEFT JOIN playlist_items nested ON nested.playlist_id = top.child_playlist_id
     WHERE top.${column} = ? OR nested.${column} = ?
  `).all(value, value).map((x) => x.id));

  try {
    const { devicesForTriggerTarget } = require('./device-triggers');
    // Which playlists hold this item at all — those are the ones a trigger could be pointing at.
    for (const p of db.prepare(`SELECT DISTINCT playlist_id FROM playlist_items WHERE ${column} = ?`).all(value)) {
      for (const devId of devicesForTriggerTarget(db, p.playlist_id)) ids.add(devId);
    }
  } catch (e) { console.warn(`[devices-playing] trigger fan-out failed: ${e && e.message}`); }

  /*
   * ⚠️ CORPORATE — the fourth and fifth cases, same rule: kept in this helper, not a new call site.
   *   (a) STORE SLOT CONTENT. A fill playlist is never any screen's resolved playlist: mandated
   *       screens resolve to head office's playlist and play the fill spliced into it. So a widget
   *       or file inside a store's slot content reaches no screen through the join above.
   *   (b) SLOT FALLBACKS. A fallback lives on the slot row (corporate_slots), not in playlist_items.
   * Head office's own items need nothing extra: the resolved playlist IS the corporate one.
   */
  try {
    const fillsLib = require('./corporate/fills');
    for (const f of db.prepare(`SELECT DISTINCT f.fill_playlist_id FROM corporate_slot_fills f
        JOIN playlist_items pi ON pi.playlist_id = f.fill_playlist_id WHERE pi.${column} = ?`).all(value)) {
      for (const devId of fillsLib.devicesPlayingFill(db, f.fill_playlist_id)) ids.add(devId);
    }
    const fb = column === 'content_id' ? 'fallback_content_id' : 'fallback_widget_id';
    for (const s of db.prepare(`SELECT DISTINCT playlist_id FROM corporate_slots WHERE ${fb} = ?`).all(value)) {
      for (const devId of devicesOnPlaylist(s.playlist_id)) ids.add(devId);
    }
  } catch (e) { /* no corporate tables (a hand-built fixture) */ }

  return [...ids];
}

const devicesPlayingWidget = (widgetId) => devicesPlayingItem('widget_id', widgetId);
const devicesPlayingContent = (contentId) => devicesPlayingItem('content_id', contentId);

module.exports = { devicesOnPlaylist, devicesPlayingWidget, devicesPlayingContent };
