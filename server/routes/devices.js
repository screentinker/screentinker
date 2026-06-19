const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES, isPlatformStaff } = require('../middleware/auth');
// Phase 2.2a: workspace-aware access. accessContext returns { workspaceRole, actingAs }
// or null based on the caller's reach into a specific workspace.
const { accessContext } = require('../lib/tenancy');
const { stripDeviceSecrets } = require('../lib/device-sanitize');

// List devices in the caller's current workspace.
// Phase 2.2a: filter by workspace_id instead of user_id. The caller's current
// workspace is resolved by resolveTenancy middleware from JWT or query/header
// override. Platform_admin and org_owner/admin see whichever workspace they
// are currently switched into (cross-workspace visibility comes from
// switch-workspace, not from a special list filter).
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const devices = db.prepare(`
    SELECT d.*,
      t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
      t.ram_free_mb, t.ram_total_mb, t.wifi_ssid, t.wifi_rssi, t.uptime_seconds,
      t.cpu_usage,
      s.filepath as screenshot_path, s.captured_at as screenshot_at,
      u.email as owner_email, u.name as owner_name
    FROM devices d
    LEFT JOIN users u ON d.user_id = u.id
    LEFT JOIN (
      SELECT dt.* FROM device_telemetry dt
      INNER JOIN (SELECT device_id, MAX(reported_at) as max_at FROM device_telemetry GROUP BY device_id) latest
      ON dt.device_id = latest.device_id AND dt.reported_at = latest.max_at
    ) t ON d.id = t.device_id
    LEFT JOIN (
      SELECT sc.* FROM screenshots sc
      INNER JOIN (SELECT device_id, MAX(captured_at) as max_at FROM screenshots GROUP BY device_id) latest
      ON sc.device_id = latest.device_id AND sc.captured_at = latest.max_at
    ) s ON d.id = s.device_id
    WHERE d.workspace_id = ?
    ORDER BY d.sort_order ASC, d.created_at ASC
    LIMIT ? OFFSET ?
  `).all(req.workspaceId, limit, offset);
  res.json(devices.map(stripDeviceSecrets));
});

// #106: reorder display tiles (cosmetic, within-section). Writes devices.sort_order
// = position in the given id array. Workspace-scoped: the UPDATE matches WHERE
// workspace_id = the caller's current workspace, so a forged id from another
// workspace is silently a no-op (can't reorder or probe devices you can't see).
// Write-gated: workspace_viewer (non-acting) is read-only. Ordering affects ONLY the
// dashboard listing — nothing the device/player reads (grouping/pairing/playback
// are independent). Mirrors the playlist items reorder.
router.post('/reorder', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace' });
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of device IDs' });
  const stmt = db.prepare("UPDATE devices SET sort_order = ?, updated_at = strftime('%s','now') WHERE id = ? AND workspace_id = ?");
  const tx = db.transaction(() => {
    order.forEach((id, index) => stmt.run(index, id, req.workspaceId));
  });
  tx();
  res.json({ success: true });
});

// List unclaimed provisioning devices (admin only).
// #13: read-only, so platform_operator may view the pool too (cross-org staff
// troubleshooting). Claiming a device is a separate workspace-scoped mutation.
router.get('/unassigned', (req, res) => {
  if (!ELEVATED_ROLES.includes(req.user.role) && !isPlatformStaff(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const devices = db.prepare(`
    SELECT id, pairing_code, status, ip_address, android_version, app_version,
      screen_width, screen_height, render_width, render_height, created_at, last_heartbeat
    FROM devices WHERE user_id IS NULL
    ORDER BY created_at DESC
  `).all();
  res.json(devices);
});

// Get single device with telemetry history
router.get('/:id', (req, res) => {
  const device = db.prepare('SELECT d.*, u.email as owner_email, u.name as owner_name FROM devices d LEFT JOIN users u ON d.user_id = u.id WHERE d.id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Phase 2.2a: workspace-aware read check. accessContext returns null when
  // the caller has no path (direct member, org-level acting-as, or platform_admin)
  // to the device's workspace.
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (ctx.workspaceRole) device._workspaceRole = ctx.workspaceRole; // Pass to frontend
  if (ctx.actingAs) device._actingAs = true;

  const telemetry = db.prepare(
    'SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 20'
  ).all(req.params.id);

  const screenshot = db.prepare(
    'SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1'
  ).get(req.params.id);

  // Get playlist items and status if device has an assigned playlist
  let assignments = [];
  let playlist_status = null;
  let playlist_has_published = false;
  if (device.playlist_id) {
    assignments = db.prepare(`
      SELECT pi.id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
             pi.created_at, pi.updated_at,
             COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.thumbnail_path,
             c.duration_sec as content_duration, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config
      FROM playlist_items pi
      LEFT JOIN content c ON pi.content_id = c.id
      LEFT JOIN widgets w ON pi.widget_id = w.id
      WHERE pi.playlist_id = ?
      ORDER BY pi.sort_order ASC
    `).all(device.playlist_id);
    const pl = db.prepare('SELECT status, published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (pl) {
      playlist_status = pl.status;
      playlist_has_published = pl.published_snapshot !== null;
    }
  }

  // Uptime timeline: get status change events for last 24 hours
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  let statusLog = [];
  try {
    statusLog = db.prepare(
      'SELECT status, timestamp FROM device_status_log WHERE device_id = ? AND timestamp > ? ORDER BY timestamp ASC'
    ).all(req.params.id, dayAgo);
  } catch (_) {}

  // Also get telemetry timestamps as heartbeat proof (fills gaps between status events)
  const uptimeData = db.prepare(
    'SELECT reported_at FROM device_telemetry WHERE device_id = ? AND reported_at > ? ORDER BY reported_at ASC'
  ).all(req.params.id, dayAgo).map(r => r.reported_at);

  res.json({ ...stripDeviceSecrets(device), telemetry, screenshot, assignments, playlist_status, playlist_has_published, uptimeData, statusLog });
});

// Helper: check device write access via the workspace the device belongs to.
// Phase 2.2a: replaces user_id + team_members check. Allows: platform_admin,
// org_owner/admin of the device's org (acting-as), workspace_admin/editor of
// the device's workspace. Denies workspace_viewer and non-members.
function checkDeviceOwnership(req, res) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  // ctx.actingAs covers platform_admin and org_owner/admin paths (always writable).
  // Direct workspace members: workspace_viewer is read-only.
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return device;
}

// #104: device-manager preview payload. Returns the device's CURRENT payload exactly
// as the device renders it — its OWN layout/orientation/wall from the device row and
// its published items — built by the same buildPlaylistPayload the device socket uses.
// Device-bound layout (the correct side of the layout seam); derivePreviewLayout is
// playlist-only and never touches this path. wall_config is forced null in v1: a wall
// FOLLOWER would otherwise freeze waiting for leader wall:sync that a socket-free
// preview can't deliver, so wall members preview full-frame. Device-READ gated
// (mirrors GET /:id — viewers allowed); NOT requirePlaylistRead, NOT the write gate.
router.get('/:id/preview-payload', (req, res) => {
  const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  const { buildPlaylistPayload } = require('../ws/deviceSocket');
  const payload = buildPlaylistPayload(req.params.id);
  payload.wall_config = null; // v1: wall members preview full-frame (no socket-free follower freeze)
  res.json(payload);
});

// Update device
router.put('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const { name, notes, timezone, orientation, default_content_id, layout_id } = req.body;
  // Whitelist allowed fields to prevent SQL injection via field names
  const ALLOWED_FIELDS = ['name', 'notes', 'timezone', 'orientation', 'default_content_id'];
  const updates = [];
  const values = [];
  Object.entries({ name, notes, timezone, orientation, default_content_id }).forEach(([key, val]) => {
    if (val !== undefined && ALLOWED_FIELDS.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  });
  // #public-api: allow setting the device's layout here too (symmetry with
  // PUT /api/layouts/device/:id). Validate it's a template or in the device's
  // workspace; null clears it (fullscreen).
  if (layout_id !== undefined) {
    if (layout_id !== null) {
      const layout = db.prepare('SELECT id FROM layouts WHERE id = ? AND (is_template = 1 OR workspace_id = ?)').get(layout_id, device.workspace_id);
      if (!layout) return res.status(400).json({ error: 'layout_id not found in this workspace' });
    }
    updates.push('layout_id = ?'); values.push(layout_id || null);
  }
  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE devices SET ${updates.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  res.json(stripDeviceSecrets(updated));
});

// Delete device
router.delete('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  // Clean up related data (playlist is NOT deleted — may be shared with other devices)
  db.prepare('DELETE FROM schedules WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM screenshots WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM device_telemetry WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM video_wall_devices WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);

  // Notify dashboard in real-time. Phase 2.3: scope to the device's
  // (now-deleted but still-known) workspace room. `device.workspace_id`
  // came from checkDeviceOwnership() above.
  const io = req.app.get('io');
  if (io) {
    const { workspaceRoom, emitToWorkspace } = require('../lib/socket-rooms');
    emitToWorkspace(io.of('/dashboard'), workspaceRoom(device.workspace_id), 'dashboard:device-removed', { device_id: req.params.id });
  }

  res.json({ success: true });
});

module.exports = router;
