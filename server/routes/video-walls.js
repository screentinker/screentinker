const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { clearInheritedCopy } = require('../lib/resolve-device-playlist');
// Phase 2.2l: workspace-aware access. Drops the previous listVisibleWalls /
// userCanAccessWall helpers - the admin/team_members branches there were
// dead code after the Phase 2.1 role rename (no users carry role='admin'
// anymore; team_members is a vestigial table from the pre-workspace model).
const { resourceAccess } = require('../lib/tenancy');
// #236: per-panel mounting rotation. Normalised on the way IN as well as out, so a bad value from a
// scripted API caller is rejected at the door instead of persisting and confusing every later read.
const { normalizeWallRotation } = require('../lib/wall-geometry');
const { requireScope } = require('../middleware/apiToken');

// Load a wall + access context. Returns the wall row or null after sending
// 403/404. requireWrite=true also denies workspace_viewer.
function loadWallAccess(req, res, requireWrite) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(req.params.id);
  if (!wall) { res.status(404).json({ error: 'Wall not found' }); return null; }
  if (!wall.workspace_id) { res.status(403).json({ error: 'Wall not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wall.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  req.wall = wall;
  req.wallCtx = ctx;
  return wall;
}

function requireWallRead(req, res, next) {
  if (!loadWallAccess(req, res, false)) return;
  next();
}

function requireWallWrite(req, res, next) {
  if (!loadWallAccess(req, res, true)) return;
  next();
}

// List walls (with attached devices). Phase 2.2l: scoped to caller's
// current workspace.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const walls = db.prepare('SELECT * FROM video_walls WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);

  const devStmt = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd
    JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `);
  walls.forEach(w => { w.devices = devStmt.all(w.id); });

  res.json(walls);
});

// Notify dashboard clients to re-fetch walls/devices. Phase 2.3: scoped to
// the wall's workspace room so other tenants don't get a stray refresh ping.
function notifyDashboards(req, workspaceId) {
  try {
    const io = req.app.get('io');
    if (!io || !workspaceId) return;
    const { workspaceRoom, emitToWorkspace } = require('../lib/socket-rooms');
    emitToWorkspace(io.of('/dashboard'), workspaceRoom(workspaceId), 'dashboard:wall-changed', null);
  } catch (e) { /* silent */ }
}

function loadWallWithDevices(id) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(id);
  if (!wall) return null;
  wall.devices = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
  `).all(id);
  return wall;
}

// Push a fresh wall-aware playlist payload to one device.
function pushWallPayloadToDevice(req, deviceId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), deviceId, buildPlaylistPayload);
  } catch (e) { /* silent */ }
}

function pushToWallMembers(req, wallId) {
  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId);
  for (const m of members) pushWallPayloadToDevice(req, m.device_id);
}

// Get wall with devices
router.get('/:id', requireWallRead, (req, res) => {
  res.json(loadWallWithDevices(req.wall.id));
});

// Create wall. Phase 2.2l: stamps workspace_id; closes pre-existing leak
// where playlist_id was accepted with NO cross-tenant check (caller could
// embed a foreign workspace's playlist into a wall they create).
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, playlist_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  if (playlist_id) {
    const pl = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(playlist_id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: 'Playlist is not in this workspace' });
    }
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, playlist_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, req.workspaceId, name, grid_cols || 2, grid_rows || 1,
    bezel_h_mm || 0, bezel_v_mm || 0, playlist_id || null);

  const wall = loadWallWithDevices(id);
  notifyDashboards(req, req.workspaceId);
  res.status(201).json(wall);
});

/*
 * ⚠️ CORPORATE: a video wall head office's playlist plays on. Its members, geometry and playlist
 * are the organization's admins' to change: a geometry edit can push a panel off the canvas without
 * changing any mandate (so the mandate-loss guard cannot see it), and a membership change splits or
 * moves the mandate. Returns the mandate (truthy) when the actor may NOT touch the wall.
 */
const corpGuard = require('../lib/corporate/guard');
function wallLockedFor(req, wallId) {
  const ids = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId).map((r) => r.device_id);
  for (const id of ids) {
    const m = corpGuard.activeMandateFor(db, id);
    if (m && !corpGuard.isOrgAdmin(req, m.organization_id)) return m;
  }
  return null;
}
function refuseWall(req, res, wall) {
  return corpGuard.send(res, corpGuard.err('CORPORATE_MEMBERSHIP', { text: `Head office manages the layout of the video wall "${wall.name}".` },
    { wall_id: wall.id }), req);
}
const WALL_GEOMETRY = ['grid_cols', 'grid_rows', 'bezel_h_mm', 'bezel_v_mm', 'screen_w_mm', 'screen_h_mm',
  'player_x', 'player_y', 'player_width', 'player_height'];

// Update wall (name, grid, bezels, playlist, leader, sync_mode). Phase 2.2l:
// closes pre-existing leaks where playlist_id / content_id / leader_device_id
// were accepted without any cross-tenant check.
router.put('/:id', requireWallWrite, (req, res) => {
  const wall = req.wall;

  if (req.body.playlist_id) {
    const pl = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(req.body.playlist_id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Playlist is not in this workspace' });
    }
  }
  if (req.body.content_id) {
    const c = db.prepare('SELECT workspace_id FROM content WHERE id = ?').get(req.body.content_id);
    if (!c) return res.status(404).json({ error: 'Content not found' });
    if (c.workspace_id && c.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this workspace' });
    }
  }
  // A wall layout: same rule as a device's (a template, or a layout in the wall's workspace).
  if (req.body.layout_id) {
    const l = db.prepare('SELECT is_template, workspace_id FROM layouts WHERE id = ?').get(req.body.layout_id);
    if (!l) return res.status(404).json({ error: 'Layout not found' });
    if (!l.is_template && l.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Layout is not in this workspace' });
    }
  }
  if (req.body.leader_device_id) {
    const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(req.body.leader_device_id);
    if (!d) return res.status(404).json({ error: 'Leader device not found' });
    if (d.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Leader device is not in this workspace' });
    }
  }

  // CORPORATE: geometry and the wall's own playlist/content on a head office wall (see wallLockedFor).
  if ((WALL_GEOMETRY.some((f) => req.body[f] !== undefined) || req.body.playlist_id !== undefined || req.body.content_id !== undefined
      || req.body.layout_id !== undefined)
      && wallLockedFor(req, wall.id)) {
    return refuseWall(req, res, wall);
  }

  const fields = ['name', 'grid_cols', 'grid_rows', 'bezel_h_mm', 'bezel_v_mm',
    'screen_w_mm', 'screen_h_mm', 'sync_mode', 'leader_device_id', 'content_id', 'playlist_id',
    'player_x', 'player_y', 'player_width', 'player_height', 'layout_id'];
  if (req.body.layout_id === '') req.body.layout_id = null;
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE video_walls SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  /*
   * ⚠️ The wall's playlist is no longer propagated onto its members.
   *
   * video_walls.playlist_id plus devices.wall_id is already the whole statement; the resolver reads
   * it. Copying it down is what made a wall edit overwrite whatever an operator had set for an
   * individual panel, with nothing in the row left to say it had been a choice. pushToWallMembers
   * below still runs — what they RESOLVE to has changed even though no device row did.
   */
  pushToWallMembers(req, req.params.id);
  notifyDashboards(req, req.wall.workspace_id);
  res.json(loadWallWithDevices(req.params.id));
});

/*
 * A command to the WHOLE wall, like a screen's: every panel gets it, and the reply counts per panel
 * (same delivery and same per-panel capability check as a group command — a wall can mix players
 * too, and a panel that cannot honour a reboot must not be counted as rebooted).
 */
router.post('/:id/command', requireScope('full'), requireWallWrite, (req, res) => {
  const { ALLOWED_COMMANDS, deliverCommand, validateCommand } = require('../lib/device-command');
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'command type required' });
  if (!ALLOWED_COMMANDS.includes(type)) return res.status(400).json({ error: 'invalid command type' });
  const v = validateCommand(type, payload);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const devices = db.prepare(`SELECT d.* FROM devices d JOIN video_wall_devices vwd ON vwd.device_id = d.id WHERE vwd.wall_id = ?`).all(req.wall.id);
  const deviceNs = req.app.get('io').of('/device');
  const results = devices.map((device) => ({ device_id: device.id, name: device.name, ...deliverCommand(deviceNs, device, type, payload) }));
  const count = (...st) => results.filter((r) => st.includes(r.status)).length;
  const refused = count('refused');
  res.json({ success: true, sent: count('sent', 'relayed'), offline: count('offline', 'queued'), unsupported: count('unsupported'),
    ...(refused ? { refused } : {}), total: devices.length, results });
});

// Delete wall — clear playlists + wall_id on every former member (matches
// group-dissolve semantics: leaving the wall returns devices to ungrouped).
router.delete('/:id', requireWallWrite, (req, res) => {
  const wallWorkspaceId = req.wall.workspace_id; // capture before the DELETE
  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
  if (wallLockedFor(req, req.params.id)) return refuseWall(req, res, req.wall);
  const tx = db.transaction(() => {
    // Leaving the wall clears the INHERITED copy but never a device's own choice — see
    // clearInheritedCopy. wall_id going NULL is what actually ends the inheritance.
    db.prepare("UPDATE devices SET wall_id = NULL, playlist_id = CASE WHEN playlist_source = 'device' THEN playlist_id ELSE NULL END WHERE wall_id = ?").run(req.params.id);
    db.prepare('DELETE FROM video_walls WHERE id = ?').run(req.params.id);
    require('../lib/corporate/cleanup').removeTargets(db, 'wall', req.params.id);
  });
  // CORPORATE: and the ex-members' head office playlist must not change by this (org admins excepted).
  const ok = corpGuard.guarded(req, res, () => corpGuard.assertNoMandateLoss(req, members.map((m) => m.device_id), () => { tx(); return true; },
    () => `Deleting the video wall "${req.wall.name}" would change what its screens play (head office's playlist). Ask your organization admin to do it.`));
  if (!ok) return;

  // Push fresh (now wall-less, playlist-less) payloads to ex-members so they
  // exit wall mode and clear content immediately.
  for (const m of members) pushWallPayloadToDevice(req, m.device_id);
  notifyDashboards(req, wallWorkspaceId);

  res.json({ success: true });
});

// Set device grid positions. Replaces the entire member set.
// Devices removed lose their playlist (returned to ungrouped); devices added
// inherit the wall's playlist.
// Phase 2.2l: closes pre-existing leak. Old per-device check ran through
// team_members (legacy table) and role==='admin' (dead since Phase 2.1) -
// effectively only the device.user_id direct-ownership branch was active,
// missing the workspace dimension. Now: every device must be in the wall's
// workspace.
router.put('/:id/devices', requireWallWrite, (req, res) => {
  const { devices } = req.body;
  if (!Array.isArray(devices)) return res.status(400).json({ error: 'devices array required' });

  const wall = req.wall;
  for (const d of devices) {
    const dev = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(d.device_id);
    if (!dev) return res.status(404).json({ error: `Device ${d.device_id} not found` });
    if (dev.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: `Device ${d.device_id} is not in this workspace` });
    }
  }

  // CORPORATE: membership and geometry of a head office wall are the organization's admins'.
  if (wallLockedFor(req, req.params.id)) return refuseWall(req, res, wall);

  const previous = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
  const previousIds = new Set(previous.map(p => p.device_id));
  const incomingIds = new Set(devices.map(d => d.device_id));
  const removedIds = [...previousIds].filter(id => !incomingIds.has(id));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM video_wall_devices WHERE wall_id = ?').run(req.params.id);
    db.prepare("UPDATE devices SET wall_id = NULL WHERE wall_id = ?").run(req.params.id);

    // Removed devices return to ungrouped. Only the inherited copy goes; a panel that had been
    // given its own playlist keeps it, which the old unconditional NULL destroyed.
    for (const id of removedIds) clearInheritedCopy(id);

    const insertPos = db.prepare(`
      INSERT INTO video_wall_devices
        (wall_id, device_id, grid_col, grid_row, rotation, canvas_x, canvas_y, canvas_width, canvas_height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Joining a wall sets wall_id and nothing else: membership IS the assignment.
    const updateDevice = db.prepare("UPDATE devices SET wall_id = ? WHERE id = ?");

    for (const d of devices) {
      insertPos.run(
        req.params.id, d.device_id,
        d.grid_col, d.grid_row, normalizeWallRotation(d.rotation),
        d.canvas_x ?? null, d.canvas_y ?? null,
        d.canvas_width ?? null, d.canvas_height ?? null,
      );
      updateDevice.run(req.params.id, d.device_id);
      // A device joining a wall leaves all of its groups (walls and groups
      // are mutually exclusive concepts in this UX).
      db.prepare('DELETE FROM device_group_members WHERE device_id = ?').run(d.device_id);
    }

    if (devices.length > 0) {
      // Prefer the device whose canvas rect is closest to the wall's top-left
      // (smallest canvas_x + canvas_y), falling back to grid 0,0, then first.
      const leader =
        [...devices].sort((a, b) => ((a.canvas_x ?? 0) + (a.canvas_y ?? 0)) - ((b.canvas_x ?? 0) + (b.canvas_y ?? 0)))[0]
        || devices.find(d => d.grid_col === 0 && d.grid_row === 0)
        || devices[0];
      db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(leader.device_id, req.params.id);
    } else {
      db.prepare('UPDATE video_walls SET leader_device_id = NULL WHERE id = ?').run(req.params.id);
    }
  });
  // CORPORATE: joining (or leaving) the wall must not change any screen's head office playlist —
  // a wall-level mandate gained, a group mandate lost by the implied group exit, in either direction.
  const affected = [...new Set([...previousIds, ...incomingIds])];
  const done = corpGuard.guarded(req, res, () => corpGuard.assertNoMandateLoss(req, affected, () => { tx(); return true; },
    () => `Changing the screens of the video wall "${wall.name}" would change what they play (head office's playlist). Ask your organization admin to do it.`));
  if (!done) return;

  // Push wall-aware payload to current members, and a wall-less payload to
  // ex-members so they exit wall mode.
  for (const id of removedIds) pushWallPayloadToDevice(req, id);
  pushToWallMembers(req, req.params.id);
  notifyDashboards(req, req.wall.workspace_id);

  res.json(loadWallWithDevices(req.params.id));
});

// Set wall content (legacy single-video path — kept for back-compat).
// Phase 2.2l: closes pre-existing leak where content_id was accepted with
// NO cross-tenant check.
router.put('/:id/content', requireWallWrite, (req, res) => {
  const wall = req.wall;
  const { content_id } = req.body;
  if (content_id) {
    const c = db.prepare('SELECT workspace_id FROM content WHERE id = ?').get(content_id);
    if (!c) return res.status(404).json({ error: 'Content not found' });
    if (c.workspace_id && c.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this workspace' });
    }
  }
  db.prepare("UPDATE video_walls SET content_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(content_id || null, req.params.id);
  res.json({ success: true });
});

// Get wall config for a specific device (legacy fetch path)
router.get('/:id/device-config/:deviceId', requireWallRead, (req, res) => {
  const wall = req.wall;

  const position = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?')
    .get(req.params.id, req.params.deviceId);
  if (!position) return res.status(404).json({ error: 'Device not in this wall' });

  res.json({
    wall_id: wall.id,
    grid_cols: wall.grid_cols,
    grid_rows: wall.grid_rows,
    grid_col: position.grid_col,
    grid_row: position.grid_row,
    rotation: normalizeWallRotation(position.rotation),
    bezel_h_px: wall.bezel_h_mm,
    bezel_v_px: wall.bezel_v_mm,
    sync_mode: wall.sync_mode,
    is_leader: wall.leader_device_id === req.params.deviceId,
  });
});

module.exports = router;
