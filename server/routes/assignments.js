const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2j: workspace-aware access. Underlying tables (devices, playlists)
// already carry workspace_id from Phase 1; this route can use them even
// though playlists.js itself isn't yet workspace-filtered.
const { accessContext } = require('../lib/tenancy');
const { zoneInLayout } = require('../lib/zone-validate');

// Mark playlist as draft (called after any item mutation)
function markDraft(playlistId) {
  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
}

// Hardening (#widget zero-duration loop): a non-positive duration — especially
// duration_sec=0 on a widget — makes the player schedule a 0ms auto-advance, which
// self-loops and black-screens the TV. Never STORE a bad value: floor any missing/
// invalid/<1 duration to the 10s default so it can't reach a device.
function normalizeDuration(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

// Hardening (#zone-orphan): a zone_id only renders if it belongs to the layout the
// device is actually showing. Assigning a zone from a DIFFERENT layout (e.g. after a
// layout switch/duplicate) creates an item that the players can't place. We CLEAR a
// stale zone_id to null here (-> "unassigned", which the players route sensibly) rather
// than reject, so this can't break a caller; the cleared write is logged. NOTE for
// review: switch to a 400 reject if you'd rather surface the bad zone to the operator.
// Returns the zone_id to persist (the given one, or null if it isn't in the device's
// active layout). deviceLayoutId may be null (device on fullscreen) -> any zone_id is
// stale, so cleared.
function validZoneForLayout(zoneId, deviceLayoutId, ctx) {
  if (!zoneId) return null;
  if (zoneInLayout(zoneId, deviceLayoutId)) return zoneId;
  console.warn(`[assign] cleared stale zone_id ${zoneId} (not in active layout ${deviceLayoutId || 'none'})${ctx ? ' ' + ctx : ''}`);
  return null;
}

// Phase 2.2j: workspace-aware device access check. Returns access context
// (with workspaceRole/actingAs) or null. Caller decides if read or write.
function checkDeviceAccess(req, res, paramName = 'deviceId', requireWrite = true) {
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(req.params[paramName]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return { device, ctx };
}

// Ensure device has a playlist; auto-create one if missing.
// Phase 2.2j: stamps workspace_id on the auto-created playlist so it remains
// visible once playlists.js migrates. Mirrors the 2.2i fix in device-groups.js.
function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id, workspace_id, name FROM devices WHERE id = ?').get(deviceId);
  if (device?.playlist_id) return device.playlist_id;

  const playlistId = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
    .run(playlistId, userId, device?.workspace_id || null, `${device?.name || 'Display'} playlist`);
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Standard item query with joined content/widget info
const ITEM_SELECT = `
  SELECT pi.id, pi.playlist_id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
         pi.created_at, pi.updated_at,
         COALESCE(c.filename, w.name) as filename,
         c.mime_type, c.filepath, c.thumbnail_path,
         c.duration_sec as content_duration, c.file_size, c.remote_url,
         w.name as widget_name, w.widget_type, w.config as widget_config
  FROM playlist_items pi
  LEFT JOIN content c ON pi.content_id = c.id
  LEFT JOIN widgets w ON pi.widget_id = w.id
`;

// Get assignments (playlist items) for a device
router.get('/device/:deviceId', (req, res) => {
  if (!checkDeviceAccess(req, res, 'deviceId', false)) return;
  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const items = db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
});

// Add content or widget to device playlist.
// Phase 2.2j: closes 2 pre-existing cross-tenant leaks:
//   1. Content gate: today checks content.user_id == caller. A workspace_admin
//      who happens to own content in another workspace could push it into a
//      device in this workspace. Now: content must be in device's workspace
//      (or be a platform-template, workspace_id IS NULL).
//   2. Widget gate: today checks ONLY existence - any user could attach any
//      widget UUID to their own device's playlist. Now: widget must be in
//      device's workspace (or be a platform-template).
router.post('/device/:deviceId', (req, res) => {
  const access = checkDeviceAccess(req, res, 'deviceId', true);
  if (!access) return;
  const { content_id, widget_id, zone_id, sort_order } = req.body;
  const duration_sec = normalizeDuration(req.body.duration_sec);

  if (!content_id && !widget_id) return res.status(400).json({ error: 'content_id or widget_id required' });

  if (content_id) {
    const content = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(content_id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    if (content.workspace_id && content.workspace_id !== access.device.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this device\'s workspace' });
    }
  }
  if (widget_id) {
    const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (widget.workspace_id && widget.workspace_id !== access.device.workspace_id) {
      return res.status(403).json({ error: 'Widget is not in this device\'s workspace' });
    }
  }

  const playlistId = ensureDevicePlaylist(req.params.deviceId, req.user.id);

  // Hardening: clear a zone_id that isn't in THIS device's active layout (prevents new orphans).
  const devLayout = db.prepare('SELECT layout_id FROM devices WHERE id = ?').get(req.params.deviceId);
  const effZone = validZoneForLayout(zone_id, devLayout?.layout_id, `on add to device ${req.params.deviceId}`);

  let order = sort_order;
  if (order === undefined || order === null) {
    const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
      .get(playlistId);
    order = (max.max_order || 0) + 1;
  }

  try {
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(playlistId, content_id || null, widget_id || null, effZone, order, duration_sec);

    markDraft(playlistId);

    const item = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(result.lastInsertRowid);
    res.status(201).json(item);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Content already in playlist' });
    }
    throw err;
  }
});

// Helper: load a playlist item and check write access via the parent
// playlist's workspace. Returns the item row or null after sending 403/404.
function checkItemWrite(req, res) {
  const item = db.prepare('SELECT pi.*, p.workspace_id AS pl_workspace_id FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id WHERE pi.id = ?').get(req.params.id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return null; }
  if (!item.pl_workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(item.pl_workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return item;
}

// #129 + mute-fix: per-item mute has to do TWO things, because the device plays from
// playlists.published_snapshot (deviceSocket.buildPlaylistPayload), NOT the draft
// playlist_items the toggle writes:
//   (1) LIVE — tell every device on this playlist to silence the matching currently-playing
//       item NOW (device matches by content_id/widget_id). Mutes the in-progress playthrough.
//   (2) PERSIST — patch the matching item's `muted` inside the published_snapshot the device
//       actually plays, then re-push the playlist. Without this the snapshot kept muted=0, so
//       every loop/reload re-applied full volume — the "icon red but audio plays across 3
//       playthroughs" bug (Android re-loads each loop; web's native <video> loop masked it).
// We patch the snapshot SURGICALLY (just the muted field of matching items) rather than calling
// publishPlaylist, so a mute toggle can't prematurely publish other pending draft edits or flip
// the playlist's draft/published status. muted is written as 0/1 to match buildSnapshotItems'
// format (the player reads it via optInt). playlist_items.muted is still updated by the caller,
// so a later full publish stays consistent.
function emitMuteChanged(req, item, muted) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const deviceNs = io.of('/device');
    const m = !!muted;

    // (2) PERSIST: patch the published snapshot the device reads from.
    const pl = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(item.playlist_id);
    if (pl && pl.published_snapshot) {
      let snap = null;
      try { snap = JSON.parse(pl.published_snapshot); } catch (e) { snap = null; }
      if (Array.isArray(snap)) {
        let changed = false;
        for (const s of snap) {
          const match = item.content_id ? s.content_id === item.content_id
            : (item.widget_id ? s.widget_id === item.widget_id : false);
          if (match && (s.muted ? 1 : 0) !== (m ? 1 : 0)) { s.muted = m ? 1 : 0; changed = true; }
        }
        if (changed) {
          db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
            .run(JSON.stringify(snap), item.playlist_id);
        }
      }
    }

    // (1) LIVE toggle + re-deliver the patched snapshot so loops re-apply the correct flag.
    // Lazy require (matches playlists.pushToDevices) to avoid a route<->ws circular import.
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const devices = db.prepare('SELECT id FROM devices WHERE playlist_id = ?').all(item.playlist_id);
    const payload = { content_id: item.content_id || null, widget_id: item.widget_id || null, muted: m };
    for (const d of devices) {
      deviceNs.to(d.id).emit('device:mute-changed', payload);                        // current playthrough
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, buildPlaylistPayload);  // future loads (no reload of current item)
    }
    console.log(`[mute] item ${item.id} (content ${item.content_id || item.widget_id}) -> ${m ? 'MUTED' : 'unmuted'}; snapshot patched + notified ${devices.length} device(s)`);
  } catch (e) { /* best-effort; playlist_items.muted is still updated for the next full publish */ }
}

// Update playlist item
router.put('/:id', (req, res) => {
  const item = checkItemWrite(req, res);
  if (!item) return;

  const { sort_order, duration_sec, zone_id, muted } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (duration_sec !== undefined) { updates.push('duration_sec = ?'); values.push(normalizeDuration(duration_sec)); }
  // zone_id can be null (clear the zone) - treat undefined as "no change",
  // any other value (including null) as "write this".
  if (zone_id !== undefined) {
    // Hardening: if this playlist is bound to exactly ONE device with a layout, clear a
    // zone_id that isn't in that layout (prevents new orphans). Multi-device / fullscreen
    // playlists can't be bound to one layout here, so we leave those to the player fallback.
    let effZone = zone_id || null;
    if (effZone) {
      const devs = db.prepare('SELECT layout_id FROM devices WHERE playlist_id = ? AND layout_id IS NOT NULL').all(item.playlist_id);
      if (devs.length === 1) effZone = validZoneForLayout(effZone, devs[0].layout_id, `on update of item ${req.params.id}`);
    }
    updates.push('zone_id = ?'); values.push(effZone);
  }
  // #129: per-item mute (coerced to 0/1). Was silently dropped here before, so the
  // dashboard toggle did nothing.
  const mutedChanged = muted !== undefined && (item.muted ? 1 : 0) !== (muted ? 1 : 0);
  if (muted !== undefined) { updates.push('muted = ?'); values.push(muted ? 1 : 0); }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    markDraft(item.playlist_id);
    if (mutedChanged) emitMuteChanged(req, item, muted ? 1 : 0);
  }

  const updated = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(req.params.id);
  res.json(updated);
});

// Delete playlist item
router.delete('/:id', (req, res) => {
  const item = checkItemWrite(req, res);
  if (!item) return;

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.id);
  markDraft(item.playlist_id);

  res.json({ success: true, content_id: item.content_id });
});

// Reorder items for a device's playlist
router.post('/device/:deviceId/reorder', (req, res) => {
  if (!checkDeviceAccess(req, res, 'deviceId', true)) return;
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, device.playlist_id);
    });
  });
  transaction();

  markDraft(device.playlist_id);

  const items = db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
});

// Copy playlist from one device to another.
// Phase 2.2j: closes a pre-existing cross-tenant leak. Today both deviceIds
// only got the user_id ownership check; a caller with reach into a foreign
// workspace could copy that workspace's playlist into a device in their own
// workspace (or vice versa). Now: both devices must be in the same workspace,
// and the caller must have write access there.
router.post('/device/:deviceId/copy-to/:targetDeviceId', (req, res) => {
  const sourceAccess = checkDeviceAccess(req, res, 'deviceId', true);
  if (!sourceAccess) return;
  const targetAccess = checkDeviceAccess(req, res, 'targetDeviceId', true);
  if (!targetAccess) return;
  if (sourceAccess.device.workspace_id !== targetAccess.device.workspace_id) {
    return res.status(403).json({ error: 'Source and target devices must be in the same workspace' });
  }

  const sourceDevice = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!sourceDevice?.playlist_id) return res.status(404).json({ error: 'Source device has no playlist' });

  const sourceItems = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order')
    .all(sourceDevice.playlist_id);
  if (!sourceItems.length) return res.status(404).json({ error: 'Source playlist is empty' });

  const target = db.prepare('SELECT id, user_id FROM devices WHERE id = ?').get(req.params.targetDeviceId);
  if (!target) return res.status(404).json({ error: 'Target device not found' });

  const targetPlaylistId = ensureDevicePlaylist(req.params.targetDeviceId, target.user_id || req.user.id);

  if (req.body.replace) {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(targetPlaylistId);
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?')
    .get(targetPlaylistId).m || 0;
  const stmt = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?, ?)');

  const transaction = db.transaction(() => {
    sourceItems.forEach((a, i) => {
      stmt.run(targetPlaylistId, a.content_id, a.widget_id, a.zone_id || null, maxOrder + i + 1, normalizeDuration(a.duration_sec));
    });
  });
  transaction();

  markDraft(targetPlaylistId);
  res.json({ success: true, copied: sourceItems.length });
});

module.exports = router;
