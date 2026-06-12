const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2i: workspace-aware access. Same pattern as devices/content/widgets.
const { accessContext } = require('../lib/tenancy');
// #public-api: operational fleet commands (reboot/shutdown/...) need the 'full' token
// scope. No-op for JWT sessions; for tokens a read/write scope is rejected.
const { requireScope } = require('../middleware/apiToken');

const VALID_COLOR = /^#[0-9A-Fa-f]{6}$/;
const ALLOWED_COMMANDS = ['screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown'];

// Phase 2.2i: split read/write access checks. Both attach req.group on success.
function loadGroupAccessCtx(req, res) {
  const group = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(req.params.id);
  if (!group) { res.status(404).json({ error: 'group not found' }); return null; }
  if (!group.workspace_id) { res.status(403).json({ error: 'Group not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(group.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return { group, ctx };
}

function requireGroupRead(req, res, next) {
  const access = loadGroupAccessCtx(req, res);
  if (!access) return;
  req.group = access.group;
  next();
}

function requireGroupWrite(req, res, next) {
  const access = loadGroupAccessCtx(req, res);
  if (!access) return;
  if (!access.ctx.actingAs && access.ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  req.group = access.group;
  next();
}

// List groups in the caller's current workspace.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const groups = db.prepare(`
    SELECT g.*, COUNT(dgm.device_id) as device_count
    FROM device_groups g
    LEFT JOIN device_group_members dgm ON g.id = dgm.group_id
    WHERE g.workspace_id = ?
    GROUP BY g.id
    ORDER BY g.name ASC
  `).all(req.workspaceId);
  res.json(groups);
});

// Create group in the caller's current workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating groups.' });
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (color && !VALID_COLOR.test(color)) return res.status(400).json({ error: 'invalid color format, use #RRGGBB' });
  const id = uuidv4();
  db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, color) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name, color || '#3B82F6');
  res.status(201).json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id));
});

// Update group
router.put('/:id', requireGroupWrite, (req, res) => {
  const { name, color } = req.body;
  if (color && !VALID_COLOR.test(color)) return res.status(400).json({ error: 'invalid color format, use #RRGGBB' });
  if (name) db.prepare('UPDATE device_groups SET name = ? WHERE id = ?').run(name, req.params.id);
  if (color) db.prepare('UPDATE device_groups SET color = ? WHERE id = ?').run(color, req.params.id);
  res.json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(req.params.id));
});

// Delete group — converts group schedules to per-device schedules first
router.delete('/:id', requireGroupWrite, (req, res) => {
  const groupId = req.params.id;

  const convert = db.transaction(() => {
    // Find group schedules that need conversion
    const groupSchedules = db.prepare('SELECT * FROM schedules WHERE group_id = ?').all(groupId);

    // Find current group members
    const members = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(groupId);

    let converted = 0;

    if (groupSchedules.length > 0 && members.length > 0) {
      const insert = db.prepare(`
        INSERT INTO schedules (id, user_id, device_id, group_id, zone_id, content_id,
          widget_id, layout_id, playlist_id, title, start_time, end_time, timezone,
          recurrence, recurrence_end, priority, enabled, color, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const schedule of groupSchedules) {
        for (const member of members) {
          insert.run(
            uuidv4(), schedule.user_id, member.device_id,
            schedule.zone_id, schedule.content_id, schedule.widget_id,
            schedule.layout_id, schedule.playlist_id, schedule.title,
            schedule.start_time, schedule.end_time, schedule.timezone,
            schedule.recurrence, schedule.recurrence_end, schedule.priority,
            schedule.enabled, schedule.color, schedule.created_at, schedule.updated_at
          );
        }
        converted++;
      }
    }

    // Delete group schedules explicitly (before group delete turns group_id to NULL via ON DELETE SET NULL)
    db.prepare('DELETE FROM schedules WHERE group_id = ?').run(groupId);

    // Delete the group (cascades to device_group_members)
    db.prepare('DELETE FROM device_groups WHERE id = ?').run(groupId);

    return { converted, devices: members.length };
  });

  const result = convert();
  res.json({ success: true, schedules_converted: result.converted, devices: result.devices });
});

// Get devices in a group
router.get('/:id/devices', requireGroupRead, (req, res) => {
  const devices = db.prepare(`
    SELECT d.* FROM devices d
    JOIN device_group_members dgm ON d.id = dgm.device_id
    WHERE dgm.group_id = ?
    ORDER BY d.name ASC
  `).all(req.params.id);
  res.json(devices);
});

// Add device to group. If the group has a playlist set (via the assign-playlist
// dropdown on the dashboard), the new device inherits it — both for drag-drop
// onto the group section and for the Manage modal's checkboxes, which both
// hit this endpoint. Without this, joining a group never auto-assigned the
// group's playlist, leaving the new device on whatever it had before.
//
// Phase 2.2i: closes a pre-existing cross-tenant leak. Today the gate only
// checked device.user_id == caller; a workspace_admin who happened to own a
// device in another workspace could add it to a group in this workspace.
// Now: the device must belong to the same workspace as the group.
router.post('/:id/devices', requireGroupWrite, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.workspace_id !== req.group.workspace_id) {
    return res.status(403).json({ error: 'Device is not in this group\'s workspace' });
  }
  try {
    db.prepare('INSERT OR IGNORE INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(device_id, req.params.id);

    // Sync device's playlist to the group's: a defined playlist is inherited,
    // a group with no playlist clears the device's. The user's mental model
    // is "joining a group means using its playlist (or none)" — staying on a
    // stale playlist after joining a no-playlist group was the bug we just hit.
    const group = db.prepare('SELECT playlist_id FROM device_groups WHERE id = ?').get(req.params.id);
    const newPlaylist = group?.playlist_id || null;
    db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(newPlaylist, device_id);
    pushPlaylistToDevice(req, device_id);
    res.status(201).json({ success: true, playlist_id: newPlaylist });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Remove device from group. Sync the device's playlist to whatever its
// current group membership implies — symmetric with the join sync above.
// - No remaining groups → clear playlist (Ungrouped).
// - Remaining group with a playlist → adopt that playlist.
// - Remaining group(s) but none have a playlist → clear playlist.
// Without this, a device dragged out of a group keeps stale playlist state
// from the group it just left.
router.delete('/:id/devices/:deviceId', requireGroupWrite, (req, res) => {
  const deviceId = req.params.deviceId;
  db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id = ?').run(deviceId, req.params.id);

  const remaining = db.prepare(`
    SELECT g.playlist_id FROM device_groups g
    JOIN device_group_members dgm ON g.id = dgm.group_id
    WHERE dgm.device_id = ?
    ORDER BY g.playlist_id IS NULL, g.name ASC
    LIMIT 1
  `).get(deviceId);
  const newPlaylist = remaining?.playlist_id || null;
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(newPlaylist, deviceId);
  pushPlaylistToDevice(req, deviceId);

  res.json({ success: true });
});

// Ensure a device has a playlist; auto-create one if missing.
// Phase 2.2i: pre-emptive loop-closer for the future playlists.js migration.
// The auto-created playlist lives in the same workspace as the device, so
// once playlists.js scopes by workspace_id this helper's rows remain visible.
function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id, workspace_id, name FROM devices WHERE id = ?').get(deviceId);
  if (device?.playlist_id) return device.playlist_id;
  const playlistId = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
    .run(playlistId, userId, device?.workspace_id || null, `${device?.name || 'Display'} playlist`);
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Mark playlist as draft (called after any item mutation)
function markDraft(playlistId) {
  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
}

// Push playlist update to a device (used by assign-playlist which doesn't modify items)
function pushPlaylistToDevice(req, deviceId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), deviceId, buildPlaylistPayload);
  } catch (e) { /* silent */ }
}

// Bulk assign content to all devices in a group (adds to each device's playlist).
// Phase 2.2i: closes a pre-existing cross-tenant leak. Today the gate only
// checked content.user_id == caller; the content could live in any workspace
// the caller had any reach into. Now: content must live in the group's
// workspace (or be a platform-template content row, workspace_id IS NULL).
router.post('/:id/assign-content', requireGroupWrite, (req, res) => {
  const { content_id, duration_sec } = req.body;
  if (!content_id) return res.status(400).json({ error: 'content_id required' });

  // Verify content lives in the same workspace as the group (or is a
  // platform-template row).
  const content = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(content_id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (content.workspace_id && content.workspace_id !== req.group.workspace_id) {
    return res.status(403).json({ error: 'Content is not in this group\'s workspace' });
  }

  const members = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(req.params.id);

  const transaction = db.transaction(() => {
    for (const m of members) {
      const playlistId = ensureDevicePlaylist(m.device_id, req.user.id);
      const max = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM playlist_items WHERE playlist_id = ?').get(playlistId);
      db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)')
        .run(playlistId, content_id, max.next, duration_sec || 10);
      markDraft(playlistId);
    }
  });
  transaction();

  res.json({ success: true, devices_updated: members.length });
});

// Assign an existing playlist to all devices in a group, and persist the
// choice on the group itself so future joiners inherit it (see POST /:id/devices).
//
// Phase 2.2i: closes a pre-existing cross-tenant leak. Today the gate only
// checked playlist.user_id == caller; the playlist could live in any
// workspace the caller could reach. Now: playlist must live in the group's
// workspace. Playlists don't currently have a NULL/template path - playlists.js
// migration is deferred, so this check uses the raw workspace_id column that
// 2.2i's ensureDevicePlaylist loop-closer also writes to.
router.post('/:id/assign-playlist', requireGroupWrite, (req, res) => {
  const { playlist_id } = req.body;
  if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });

  const playlist = db.prepare('SELECT id, workspace_id FROM playlists WHERE id = ?').get(playlist_id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  if (playlist.workspace_id && playlist.workspace_id !== req.group.workspace_id) {
    return res.status(403).json({ error: 'Playlist is not in this group\'s workspace' });
  }

  const members = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(req.params.id);

  const stmt = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
  const transaction = db.transaction(() => {
    db.prepare('UPDATE device_groups SET playlist_id = ? WHERE id = ?').run(playlist_id, req.params.id);
    for (const m of members) stmt.run(playlist_id, m.device_id);
  });
  transaction();

  for (const m of members) pushPlaylistToDevice(req, m.device_id);
  res.json({ success: true, devices_updated: members.length });
});

// Send command to all devices in a group (reboot/shutdown/screen on/off etc.)
router.post('/:id/command', requireScope('full'), requireGroupWrite, (req, res) => {
  const { type, payload } = req.body;
  if (!type) return res.status(400).json({ error: 'command type required' });
  if (!ALLOWED_COMMANDS.includes(type)) return res.status(400).json({ error: 'invalid command type' });

  const devices = db.prepare(`
    SELECT d.id, d.name, d.status FROM devices d
    JOIN device_group_members dgm ON d.id = dgm.device_id
    WHERE dgm.group_id = ?
  `).all(req.params.id);

  const deviceNs = req.app.get('io').of('/device');
  const results = [];

  for (const device of devices) {
    const room = deviceNs.adapter.rooms.get(device.id);
    if (room && room.size > 0) {
      deviceNs.to(device.id).emit('device:command', { type, payload: payload || {} });
      results.push({ device_id: device.id, name: device.name, status: 'sent' });
    } else {
      results.push({ device_id: device.id, name: device.name, status: 'offline' });
    }
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const offline = results.filter(r => r.status === 'offline').length;
  console.log(`Group command '${type}' sent to group '${req.group.name}': ${sent} sent, ${offline} offline`);
  res.json({ success: true, sent, offline, total: devices.length, results });
});

module.exports = router;
