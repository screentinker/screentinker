'use strict';

const { db } = require('../db/database');

/*
 * Per-item mute, kept in sync with what devices actually play. Extracted from routes/assignments.js
 * so the playlist-page route can share it — that route had no mute handling at all, so the toggle
 * worked from the device page and was silently dropped from the playlist page. Same bug as #129,
 * one route over.
 *
 * #129 + mute-fix: per-item mute has to do TWO things, because the device plays from
 * playlists.published_snapshot (deviceSocket.buildPlaylistPayload), NOT the draft playlist_items
 * the toggle writes:
 *   (1) LIVE — tell every device on this playlist to silence the matching currently-playing item
 *       NOW (device matches by content_id/widget_id). Mutes the in-progress playthrough.
 *   (2) PERSIST — patch the matching item's `muted` inside the published_snapshot the device
 *       actually plays, then re-push. Without this the snapshot kept muted=0, so every loop/reload
 *       re-applied full volume — the "icon red but audio plays across 3 playthroughs" bug (Android
 *       re-loads each loop; web's native <video> loop masked it).
 *
 * The snapshot is patched SURGICALLY (just the muted field of matching items) rather than by
 * calling publishPlaylist, so a mute toggle can't prematurely publish other pending draft edits or
 * flip the playlist's draft/published status. muted is written as 0/1 to match buildSnapshotItems'
 * format (the player reads it via optInt). playlist_items.muted is still updated by the caller, so
 * a later full publish stays consistent.
 *
 * ⚠️ (3) ANCESTORS — added with playlist nesting. A parent's snapshot holds a flattened COPY of the
 * child's items, so muting an item inside a nested playlist patched the child's snapshot and left
 * every parent playing the old flag. This is the same tax publishPlaylist pays by republishing
 * ancestors; it has to be paid here too, or mute is silently a no-op for any screen on the parent.
 * Depth is capped at 1, so this is one hop and cannot recurse.
 */
function emitMuteChanged(req, item, muted) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const deviceNs = io.of('/device');
    const m = !!muted;

    // (2) PERSIST: patch the published snapshot the device reads from.
    const patch = (playlistId) => {
      const pl = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId);
      if (!pl || !pl.published_snapshot) return;
      let snap = null;
      try { snap = JSON.parse(pl.published_snapshot); } catch (e) { snap = null; }
      if (!Array.isArray(snap)) return;
      let changed = false;
      for (const s of snap) {
        const match = item.content_id ? s.content_id === item.content_id
          : (item.widget_id ? s.widget_id === item.widget_id : false);
        if (match && (s.muted ? 1 : 0) !== (m ? 1 : 0)) { s.muted = m ? 1 : 0; changed = true; }
      }
      if (changed) {
        // As system: the route already authorised the mute; this keeps head office's flattened copy
        // in step, which the corporate backstop would otherwise judge as a publish by the caller.
        require('./corporate/actor').runAsSystem(() => db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
          .run(JSON.stringify(snap), playlistId));
      }
    };

    // (1) LIVE toggle + re-deliver the patched snapshot so loops re-apply the correct flag.
    // Lazy require (matches playlists.pushToDevices) to avoid a route<->ws circular import.
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const payload = { content_id: item.content_id || null, widget_id: item.widget_id || null, muted: m };
    const notify = (playlistId) => {
      // Resolved: a device that inherits this playlist holds no copy of its id, and would
      // otherwise be the one device a mute toggle silently skipped.
      const devices = db.prepare('SELECT device_id AS id FROM device_resolved_playlist WHERE playlist_id = ?').all(playlistId);
      for (const d of devices) {
        deviceNs.to(d.id).emit('device:mute-changed', payload);                        // current playthrough
        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, buildPlaylistPayload);  // future loads
      }
      return devices.length;
    };

    patch(item.playlist_id);
    let reached = notify(item.playlist_id);

    // (3) ANCESTORS: playlists that include this one as a child hold a flattened copy.
    for (const anc of db.prepare(`
      SELECT DISTINCT p.id FROM playlists p
        JOIN playlist_items pi ON pi.playlist_id = p.id
       WHERE pi.child_playlist_id = ? AND p.status = 'published'
    `).all(item.playlist_id)) {
      patch(anc.id);
      reached += notify(anc.id);
    }

    console.log(`[mute] item ${item.id} (content ${item.content_id || item.widget_id}) -> ${m ? 'MUTED' : 'unmuted'}; snapshot patched + notified ${reached} device(s)`);
  } catch (e) { /* best-effort; playlist_items.muted is still updated for the next full publish */ }
}

module.exports = { emitMuteChanged };
