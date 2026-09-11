const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const enrolKey = require('../lib/enrol-key');   // #313
const { resolveDevicePlaylist, resolvedLayoutId } = require('../lib/resolve-device-playlist');
const { PLATFORM_ROLES, ELEVATED_ROLES, isPlatformStaff } = require('../middleware/auth');
// Phase 2.2a: workspace-aware access. accessContext returns { workspaceRole, actingAs }
// or null based on the caller's reach into a specific workspace.
const { accessContext } = require('../lib/tenancy');
// requireScope gates by API-token scope; the workspace WRITE gate is checkDeviceOwnership, which
// already rejects workspace_viewer — the same check requireFleetWrite performs in routes/triggers.js.
const { requireScope } = require('../middleware/apiToken');
const { ALLOWED_COMMANDS, deliverCommand } = require('../lib/device-command');
const { stripDeviceSecrets, stripDeviceSecretsForList, stripSecretsForTokens } = require('../lib/device-sanitize');
const { layoutZones, orphanCountsByDevice } = require('../lib/zone-validate');
const deviceSettings = require('../lib/device-settings'); // #150 delete+re-pair settings preservation
const playerCapabilities = require('../lib/player-capabilities');

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
      t.ram_free_mb, t.ram_total_mb, t.wifi_rssi, t.uptime_seconds, t.local_ip, t.local_ip6, t.attached_display, t.video_mode,
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
  // #zone-orphan: lightweight per-device count of playlist items whose zone_id isn't in
  // the device's active layout, so the dashboard can flag screens that need attention.
  const orphanCounts = orphanCountsByDevice(devices.map(d => d.id));
  // The RESOLVED capability set, the same shape GET /:id returns. The raw column shipped here
  // before: a JSON *string* ('[]') or null, which every consumer would have had to parse — and
  // `Array.isArray("[]")` is false, so the dashboard's `can()` helper reads a device that declared
  // "I can do nothing" as "pre-capability server, show everything". Resolving it here means the
  // fleet views (device cards, the wall panel list) can hide a control the panel cannot honour
  // instead of offering it and having the socket drop it.
  res.json(devices.map(d => ({
    ...stripDeviceSecretsForList(d),
    capabilities: playerCapabilities.capabilitiesFor(d),
    orphan_count: orphanCounts[d.id] || 0,
  })));
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

// #150: "previously removed devices" — fingerprint-keyed settings snapshots for the caller's
// current workspace, for the operator re-adopt flow (changed-fingerprint case). MUST be
// declared before GET '/:id' or Express matches 'removed' as an :id. Read-scoped to workspace.
router.get('/removed', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  res.json(deviceSettings.listRemoved(req.workspaceId));
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
  // SELECT d.* now carries trigger_secret. A read-scoped token must not be able to turn "list my
  // screens" into "inject content on any of them" — see lib/device-sanitize.js.
  stripSecretsForTokens(device, req.viaToken);

  const telemetry = db.prepare(
    'SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 20'
  ).all(req.params.id);

  const screenshot = db.prepare(
    'SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1'
  ).get(req.params.id);

  /*
   * ⚠️ Show what the screen ACTUALLY plays, which is the resolved playlist, not devices.playlist_id.
   *
   * The two differ the moment a device inherits: clearing an override now sets both the id and the
   * source to NULL and lets the group's playlist take over, so reading the raw column would leave
   * this page reporting "no playlist" while the screen plays the group's. A dashboard that
   * disagrees with the wall is worse than one that says nothing.
   *
   * playlist_source is echoed so the UI can distinguish "chosen here" from "inherited" and offer
   * the revert — the distinction the old copy-on-assign erased.
   */
  const resolved = resolveDevicePlaylist(req.params.id);
  device.playlist_id = resolved.playlist_id;
  device.playlist_source = resolved.source;
  // The NAME of whatever it inherits from. "Inherited" alone sends the operator hunting for which
  // group or wall did it; naming it is the difference between an explanation and a shrug.
  device.playlist_source_name = resolved.source === 'wall'
    ? db.prepare('SELECT name FROM video_walls WHERE id = ?').get(device.wall_id)?.name || null
    : resolved.source === 'group'
      ? db.prepare(`SELECT g.name FROM device_groups g
                      JOIN device_group_members m ON m.group_id = g.id
                     WHERE m.device_id = ? AND g.playlist_id = ?
                     ORDER BY g.priority DESC, g.created_at ASC, g.id ASC LIMIT 1`)
          .get(req.params.id, resolved.playlist_id)?.name || null
      : null;

  let assignments = [];
  let playlist_status = null;
  let playlist_has_published = false;
  if (device.playlist_id) {
    assignments = db.prepare(`
      SELECT pi.id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
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

  // #zone-orphan: flag any item whose zone_id isn't a zone in the device's ACTIVE layout
  // (same rule as lib/zone-validate). The dashboard shows a per-item "reassign" warning;
  // active_layout_zones ships the zone list here too so the inline reassign dropdown needs
  // no separate /api/layouts round-trip. Informational only — playback uses the fallback.
  // Resolved layout, so the zone-orphan check is run against the layout the screen is ACTUALLY
  // using — which, while a schedule is active, is the schedule's rather than the device's own.
  const active_layout_zones = layoutZones(resolvedLayoutId(req.params.id) ?? device.layout_id);
  const activeZoneIdSet = new Set(active_layout_zones.map(z => z.id));
  for (const a of assignments) a.orphan = !!a.zone_id && !activeZoneIdSet.has(a.zone_id);

  // Uptime timeline: get status change events for last 24 hours
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  let statusLog = [];
  try {
    statusLog = db.prepare(
      'SELECT status, reason, detail, timestamp FROM device_status_log WHERE device_id = ? AND timestamp > ? ORDER BY timestamp ASC'
    ).all(req.params.id, dayAgo);
  } catch (_) {}

  // Offline-cause log: the unified incident feed (offline-cause + display/sleep + crash +
  // reboot), most-recent first. Best-effort — an old DB without the table just yields [].
  let deviceEvents = [];
  try {
    deviceEvents = db.prepare(
      'SELECT id, type, reason, detail, timestamp FROM device_events WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT 50'
    ).all(req.params.id);
  } catch (_) {}

  // Also get telemetry timestamps as heartbeat proof (fills gaps between status events)
  const uptimeData = db.prepare(
    'SELECT reported_at FROM device_telemetry WHERE device_id = ? AND reported_at > ? ORDER BY reported_at ASC'
  ).all(req.params.id, dayAgo).map(r => r.reported_at);

  // The RESOLVED capability set, not the raw column. The dashboard hides controls a panel cannot
  // honour, and it must not have to know about the baseline fallback — a legacy device declaring
  // nothing has to arrive at the dashboard looking exactly like one that declared its baseline,
  // or ~440 existing displays lose their controls the moment this ships.
  const capabilities = playerCapabilities.capabilitiesFor(device);

  // Parsed on READ, not on receipt. The raw block stays the stored truth, so adding a field later
  // is a server deploy rather than re-collecting from every panel in the field. Null for a device
  // that never reported one, or whose block is unreadable — the card simply does not render.
  const edid = require('../lib/edid').parseEdid(device.hardware_edid);

  res.json({ ...stripDeviceSecrets(device), capabilities, edid, telemetry, screenshot, assignments, active_layout_zones, playlist_status, playlist_has_published, uptimeData, statusLog, deviceEvents });
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
// Clear a device's playlist — the "No playlist" option in the dashboard picker.
//
// There was no way to do this. PUT /devices/:id ignores playlist_id (it always has), and
// POST /playlists/:id/assign can only ever SET one, so the picker carried a guard that
// silently discarded the selection: `if (!newPlaylistId) return; // Don't allow deselecting`.
// The option was offered, selecting it did nothing, and no error said so — reported on #234
// as "I selected No playlist and it still showed the same video". It did.
//
// Device-scoped rather than playlist-scoped because there is no playlist to authorize
// against when clearing; ownership is checked the same way every other device mutation
// checks it. Clearing an already-clear device is a no-op success, so the button is safe to
// press twice.
router.delete('/:id/playlist', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  /*
   * ⚠️ Clearing an override means "stop being special", not "go dark".
   *
   * playlist_source is cleared alongside the id, so the resolver falls back to the device's wall or
   * group. Writing playlist_id = NULL alone used to strand the screen on nothing — a destructive
   * action wearing the costume of an undo, and the reason "revert to group" could not be offered.
   */
  db.prepare('UPDATE devices SET playlist_id = NULL, playlist_source = NULL, updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), req.params.id);

  // Push whatever the device now resolves to — its group's or wall's playlist if it has one, an
  // empty payload if it does not — rather than leaving the old content up until something else
  // happens to update it. (This used to say "the now-empty playlist"; since clearing falls back to
  // inherited, empty is no longer the only outcome.)
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), req.params.id, buildPlaylistPayload);
    }
  } catch (e) { /* silent — the DB is the source of truth, the push is best-effort */ }

  res.json({ success: true });
});

router.put('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const { name, notes, timezone, orientation, background_color, default_content_id, layout_id, ota_enabled, ota_beta, reboot_schedule, live_video_enabled } = req.body;
  // #150: validate orientation against the known enum (previously accepted any string, which
  // let a bad value reach the player -> unknown rotation falls back to landscape silently).
  // #325: a CSS colour that reaches the player's inline style, so it is constrained to a hex
  // literal rather than trusted. Empty string clears it back to the player default.
  if (background_color !== undefined && background_color !== null && background_color !== ''
      && !/^#[0-9a-fA-F]{3,8}$/.test(String(background_color))) {
    return res.status(400).json({ error: 'background_color must be a hex colour such as #202020' });
  }
  if (orientation !== undefined && !deviceSettings.ORIENTATIONS.has(orientation)) {
    return res.status(400).json({ error: `Invalid orientation. Allowed: ${[...deviceSettings.ORIENTATIONS].join(', ')}` });
  }
  // Whitelist allowed fields to prevent SQL injection via field names
  const ALLOWED_FIELDS = ['name', 'notes', 'timezone', 'orientation', 'background_color', 'default_content_id'];
  const updates = [];
  const values = [];
  // #325: an empty colour means "back to the player default", which is NULL in the column rather
  // than an empty string the player would try to apply as a CSS value.
  const bg = background_color === '' ? null : background_color;
  Object.entries({ name, notes, timezone, orientation, background_color: bg, default_content_id }).forEach(([key, val]) => {
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
  // #155/#161: per-device self-update (OTA) toggle. Coerce to 0/1.
  if (ota_enabled !== undefined) {
    updates.push('ota_enabled = ?'); values.push(ota_enabled ? 1 : 0);
  }
  if (ota_beta !== undefined) {
    // Per-display pre-release opt-in (#234 follow-up). Stops a test build being reverted by the
    // next OTA check, which is what a prerelease version sorting below its own release causes.
    updates.push('ota_beta = ?'); values.push(ota_beta ? 1 : 0);
  }
  // #go2rtc: per-device live-video opt-in. Only meaningful when the workspace flag and the server
  // master switch are also on (see liveVideoOn); off by default. Write-gated by checkDeviceOwnership.
  if (live_video_enabled !== undefined) {
    updates.push('live_video_enabled = ?'); values.push(live_video_enabled ? 1 : 0);
  }
  // #12 scheduled reboot: device-local "HH:MM" (null/'' clears -> off). Reset the
  // once-per-day guard on any change so a newly-set time can still fire later today.
  if (reboot_schedule !== undefined) {
    let val = null;
    if (reboot_schedule !== null && reboot_schedule !== '') {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(reboot_schedule))) {
        return res.status(400).json({ error: 'reboot_schedule must be "HH:MM" (24h) or null' });
      }
      val = String(reboot_schedule);
    }
    updates.push('reboot_schedule = ?'); values.push(val);
    updates.push('reboot_last_date = ?'); values.push(null);
  }
  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE devices SET ${updates.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  // ⚠️ stripDeviceSecrets only removes device_token. GET /:id additionally calls
  // stripSecretsForTokens; these two echo paths did not, so a token got the trigger secret
  // back from a rename — the escalation lib/device-sanitize.js exists to prevent.
  res.json(stripSecretsForTokens(stripDeviceSecrets(updated), req.viaToken));
});

// #146 Item D: operator BLOCK / UNBLOCK toggle. Writes devices.blocked; the device
// socket re-reads `blocked` on every register, so the block takes effect on the
// device's NEXT register with NO server restart (and, via the #146 identity chain, is
// enforced even if that reconnect arrives without a device_id). Write-gated + workspace-
// scoped by checkDeviceOwnership. OUTAGE PROCEDURE (dashboard down): set it by hand via
// direct SQLite — `UPDATE devices SET blocked = 1 WHERE id = '<device_id>';` (0 to
// unblock) — same column, same next-register effect.
/*
 * Set or rotate the on-device settings PIN.
 *
 * Body: { pin: "123456" } to set explicitly, or { rotate: true } for a fresh random one.
 *
 * Was provisioned once at pairing and never changeable, which made it a shared secret with no
 * expiry: anyone who watched it typed kept it for the life of the panel, and revoking it meant
 * unpairing and re-pairing. Now it can be rotated the moment an installer leaves.
 *
 * Pushed to the panel immediately over its socket. Without that the new PIN would only take effect
 * at the next pairing — so the operator would believe they had revoked access while the old PIN
 * still opened the menu, which is worse than not offering the feature.
 */
/*
 * ⚠️ THE ENABLEMENT HALF OF TRIGGERS. Without this route the feature is INERT: trigger_secret and
 * the accept flags are read by deviceSocket.js and projected to the player, but nothing wrote them,
 * so the secret was always NULL, evaluate() answered bad_secret to every payload, and no listener
 * ever bound. The definitions half shipped and looked complete; a QA pass found the system as a
 * whole could not be switched on.
 *
 * Modelled on POST /:id/settings-pin: rotate-or-set, live push, and the response says whether the
 * panel actually got it rather than implying it.
 */
/*
 * Send one command to one screen.
 *
 * ⚠️ THE GROUP EQUIVALENT HAS EXISTED FOR A LONG TIME and this did not, so commanding a single
 * device was reachable only over the dashboard socket. That was survivable while the only caller
 * was a browser tab; it stopped being survivable when another server needed to ask, because the
 * mesh write channel re-enters this node's own HTTP API precisely so that a remote request passes
 * the same guards a local one does. Without an HTTP surface there was nothing for it to re-enter.
 *
 * Guarded exactly as the group route is: requireScope('full') for API tokens (a fleet-affecting
 * action is not an ordinary write), checkDeviceOwnership for the workspace, the shared command
 * allowlist, and the panel's own declared capabilities.
 */
router.post('/:id/command', requireScope('full'), (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'command type required' });
  if (!ALLOWED_COMMANDS.includes(type)) return res.status(400).json({ error: 'invalid command type' });

  const deviceNs = req.app.get('io')?.of('/device');
  if (!deviceNs) return res.status(503).json({ error: 'The realtime layer is not available.' });

  const r = deliverCommand(deviceNs, device, type, payload);
  if (r.status === 'unsupported') {
    // Named rather than generic: "this panel cannot do that" is actionable, "failed" is not.
    return res.status(400).json({ error: 'That screen cannot do that', capability: r.capability });
  }
  res.json({ success: true, status: r.status, device_id: device.id });
});

router.post('/:id/trigger-config', requireScope('full'), (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  const b = req.body || {};
  const sets = [];
  const vals = {};

  // ⚠️ Same charset as a trigger token (routes/triggers.js TOKEN_RE): printable ASCII, no spaces,
  // because the wire format is space-separated and a space would shift the fields.
  const TOKEN_RE = /^[\x21-\x7E]{1,64}$/;

  if (b.accept_http !== undefined) { sets.push('triggers_accept_http = @accept_http'); vals.accept_http = b.accept_http ? 1 : 0; }
  if (b.accept_udp !== undefined) { sets.push('triggers_accept_udp = @accept_udp'); vals.accept_udp = b.accept_udp ? 1 : 0; }

  for (const [key, col] of [['http_port', 'trigger_http_port'], ['udp_port', 'trigger_udp_port']]) {
    if (b[key] === undefined) continue;
    if (b[key] === null || b[key] === '') { sets.push(`${col} = NULL`); continue; }
    const n = Number(b[key]);
    // Below 1024 needs root on every platform we run on, and 0/65535 are not bindable.
    if (!Number.isInteger(n) || n < 1024 || n > 65534) {
      return res.status(400).json({ error: `${key} must be an integer 1024-65534` });
    }
    sets.push(`${col} = @${key}`); vals[key] = n;
  }

  if (b.multicast_group !== undefined) {
    if (b.multicast_group === null || b.multicast_group === '') {
      sets.push('trigger_multicast_group = NULL');
    } else {
      const g = String(b.multicast_group);
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
      const oct = m && m.slice(1).map(Number);
      // 224.0.0.0/4. Anything else is not a group and would silently never receive: joinGroup on a
      // unicast address fails, and the failure looks exactly like "the integrator sent nothing".
      if (!oct || oct.some((o) => o > 255) || oct[0] < 224 || oct[0] > 239) {
        return res.status(400).json({ error: 'multicast_group must be an IPv4 address in 224.0.0.0/4' });
      }
      sets.push('trigger_multicast_group = @multicast_group'); vals.multicast_group = g;
    }
  }

  if (b.clear_all_token !== undefined) {
    if (b.clear_all_token === null || b.clear_all_token === '') {
      sets.push('trigger_clear_all_token = NULL');
    } else {
      const t = String(b.clear_all_token);
      if (!TOKEN_RE.test(t)) {
        return res.status(400).json({ error: 'clear_all_token must be 1-64 printable ASCII characters with no spaces' });
      }
      /*
       * ⚠️ THE CLEAR-ALL TOKEN SHARES THE TRIGGER TOKEN NAMESPACE, and it is checked FIRST.
       * evaluate() tests clearAllToken before it iterates the device's triggers, so a value equal
       * to some trigger's match_token makes that trigger permanently unfirable on this device —
       * and nothing logs, because from the resolver's point of view the token matched. An
       * emergency overlay that silently cannot fire is the worst failure this feature has.
       */
      const clash = db.prepare(
        'SELECT name FROM triggers WHERE workspace_id = ? AND (match_token = ? OR clear_token = ?)'
      ).get(device.workspace_id, t, t);
      if (clash) {
        return res.status(400).json({
          error: `"${t}" is already used by the trigger "${clash.name}" — the clear-all token is `
            + 'resolved before per-trigger tokens, so it would silently shadow it',
        });
      }
      sets.push('trigger_clear_all_token = @clear_all_token'); vals.clear_all_token = t;
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'nothing to change' });
  db.prepare(`UPDATE devices SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`)
    .run({ id: req.params.id, ...vals });

  // The listeners only bind at player start, so the config change reaches the device now and takes
  // effect when it next loads the player. Said plainly in the response rather than implied.
  let delivered = false;
  try {
    const io = req.app.get('io');
    if (io) {
      const commandQueue = require('../lib/command-queue');
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), req.params.id, buildPlaylistPayload);
      const room = io.of('/device').adapter.rooms.get(req.params.id);
      delivered = !!(room && room.size > 0);
    }
  } catch (e) { console.warn(`[trigger-config] push failed: ${e.message}`); }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  console.log(`[trigger-config] updated ${req.params.id} by user ${req.user && req.user.id}`);
  res.json({
    success: true, delivered,
    trigger_config: {
      accept_http: !!updated.triggers_accept_http,
      accept_udp: !!updated.triggers_accept_udp,
      http_port: updated.trigger_http_port,
      udp_port: updated.trigger_udp_port,
      multicast_group: updated.trigger_multicast_group,
      clear_all_token: updated.trigger_clear_all_token,
      // ⚠️ Deliberately NOT the secret. It is written and read back only through the dedicated
      // rotate route below, and never leaves the server to an API token at all.
      secret_set: !!updated.trigger_secret,
    },
  });
});

/*
 * Generate or set the device's trigger secret.
 *
 * ⚠️ Separate from the config route on purpose. This is the credential that makes an
 * unauthenticated LAN datagram change what a screen shows, so it has exactly one write path, it is
 * never echoed to an API token (lib/device-sanitize.js), and rotating it is a deliberate act rather
 * than a side effect of editing a port number.
 */
router.post('/:id/trigger-secret', requireScope('full'), (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  const b = req.body || {};
  let secret;
  if (b.rotate || b.secret === undefined) {
    // 32 hex chars from a CSPRNG. The wire format is space-separated, so hex keeps it parseable
    // and keeps the value safe to paste into a control-system string field.
    secret = require('crypto').randomBytes(16).toString('hex');
  } else {
    secret = String(b.secret);
    // 16 is the floor because this is guessable-offline: an attacker on the LAN can try tokens as
    // fast as the rate limiter allows, forever, with no lockout and no audit trail.
    if (!/^[\x21-\x7E]{16,128}$/.test(secret)) {
      return res.status(400).json({ error: 'secret must be 16-128 printable ASCII characters with no spaces' });
    }
  }
  db.prepare("UPDATE devices SET trigger_secret = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(secret, req.params.id);

  let delivered = false;
  try {
    const io = req.app.get('io');
    if (io) {
      const commandQueue = require('../lib/command-queue');
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), req.params.id, buildPlaylistPayload);
      const room = io.of('/device').adapter.rooms.get(req.params.id);
      delivered = !!(room && room.size > 0);
    }
  } catch (e) { console.warn(`[trigger-secret] push failed: ${e.message}`); }

  console.log(`[trigger-secret] rotated for ${req.params.id} by user ${req.user && req.user.id}`);
  /*
   * ⚠️ The secret IS returned here, and only here. A human configuring a Crestron panel has to
   * type it somewhere, and this response is the only place it exists — but a request carrying an
   * API token never gets it, because a read-scoped integration could otherwise turn "may list your
   * screens" into "may put content on any of them".
   */
  if (req.viaToken) {
    return res.json({ success: true, delivered, secret_set: true,
      note: 'the secret is not returned to API tokens — read it from the dashboard' });
  }
  res.json({ success: true, delivered, secret });
});

router.post('/:id/settings-pin', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const pinLib = require('../lib/settings-pin');
  let pin;
  if (req.body && req.body.rotate) {
    pin = pinLib.generatePin();
  } else {
    const v = pinLib.validatePin(req.body && req.body.pin);
    if (!v.ok) return res.status(400).json({ error: v.error });
    pin = v.pin;
  }

  db.prepare("UPDATE devices SET settings_pin = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(pin, req.params.id);

  // Live push. A panel that is offline picks it up on its next pair/reconnect; the response says
  // which happened so the dashboard can tell the operator whether it is in force yet.
  let delivered = false;
  try {
    const io = req.app.get('io');
    if (io) {
      const ns = io.of('/device');
      const room = ns.adapter.rooms.get(req.params.id);
      if (room && room.size > 0) {
        ns.to(req.params.id).emit('device:settings-pin', { settings_pin: pin });
        delivered = true;
      }
    }
  } catch (e) { console.warn(`[settings-pin] push failed: ${e.message}`); }

  // Deliberately NOT logging the PIN itself.
  console.log(`[settings-pin] device ${req.params.id} pin ${req.body && req.body.rotate ? 'rotated' : 'set'} by user ${req.user.id} (delivered=${delivered})`);
  res.json({ success: true, settings_pin: pin, delivered });
});

/*
 * #313 — the enrolment key for a display, and the player URL that carries it.
 *
 * ⚠️ WHY THIS IS A DELIBERATE ACTION AND NOT AUTOMATIC. Nearly every display keeps its own
 * credentials and needs none of this; minting a key for all of them would put a durable secret on
 * rows that never use one. An operator asks for it on the screen that needs it.
 *
 * POST mints or ROLLS it — the same call, because rolling is the recovery when a URL leaks, and an
 * operator reaching for it is not in the mood to hunt for a second button. The old URL stops
 * working at the display's next connect.
 */
/*
 * ⚠️ FULL SCOPE TO MINT, for the same reason the trigger secret needs it — and more so.
 *
 * The default gate is method-based: anything that is not a GET needs only `write`. 2.0.3 stopped an
 * API token from READING an enrolment key off a device, on the grounds that the key lets its holder
 * BE that screen — register as it, take its playlist and its commands, report as it. Leaving the
 * MINT ungated handed the same power back through a different door: a write-scoped integration
 * could roll a key for any display in reach and then adopt that display's identity with it. Revoke
 * is gated for the mirror reason — it is the vMix display's only way back, and taking it away is a
 * denial of service on a screen the token was never given control of.
 */
router.post('/:id/enrol-key', requireScope('full'), (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  const key = enrolKey.setEnrolKey(db, req.params.id);
  const rolled = !!device.enrol_key;
  console.warn(`[enrol] ${rolled ? 'rolled' : 'minted'} enrolment key for device ${req.params.id} (user ${req.user.id})`);
  res.json({
    success: true,
    id: req.params.id,
    enrol_key: key,
    rolled,
    // Built from the request's own origin so it is right on a LAN address, a tunnel or a domain,
    // without the operator having to know which one this instance answers on.
    player_url: enrolKey.playerUrl(`${req.protocol}://${req.get('host')}`, key),
  });
});

/* Withdraw it. The display keeps working — it still holds its own token — but the URL stops
 * enrolling anything, which is what you want when a link has gone somewhere it should not. */
router.delete('/:id/enrol-key', requireScope('full'), (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  enrolKey.clearEnrolKey(db, req.params.id);
  console.warn(`[enrol] revoked enrolment key for device ${req.params.id} (user ${req.user.id})`);
  res.json({ success: true, id: req.params.id, enrol_key: null });
});

router.post('/:id/block', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET blocked = 1, updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  // Mirror onto the saved settings so the block survives a delete + re-pair on purpose rather than
  // by accident of whatever the saved copy happened to hold.
  try { deviceSettings.setBlockedByDevice(req.params.id, true); } catch (e) { console.warn(`[blocked] save mirror failed: ${e.message}`); }
  console.warn(`[blocked] device ${req.params.id} blocked via dashboard (user ${req.user.id})`);
  res.json({ success: true, id: req.params.id, blocked: true });
});
router.post('/:id/unblock', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET blocked = 0, updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  // MUST clear the saved copy too. applyToDevice() restores `blocked` on re-pair, so leaving the
  // saved 1 in place made unblock temporary: the next delete + re-pair silently re-blocked the
  // device, with nothing in the dashboard to explain it and no way for the operator to escape.
  try { deviceSettings.setBlockedByDevice(req.params.id, false); } catch (e) { console.warn(`[blocked] save mirror failed: ${e.message}`); }
  console.log(`[blocked] device ${req.params.id} unblocked via dashboard (user ${req.user.id})`);
  res.json({ success: true, id: req.params.id, blocked: false });
});

// #150: re-adopt — apply a removed device's saved settings onto device :id. For the case the
// fingerprint did NOT auto-match (factory reset / new hardware), so the automatic re-pair
// restore couldn't fire. Auth: caller can write device :id (checkDeviceOwnership) AND the
// snapshot belongs to the SAME workspace as the device (no cross-tenant apply).
router.post('/:id/re-adopt', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  const { fingerprint } = req.body || {};
  if (!fingerprint) return res.status(400).json({ error: 'fingerprint required' });
  const snap = deviceSettings.getByFingerprint(fingerprint);
  if (!snap) return res.status(404).json({ error: 'No saved settings for that fingerprint' });
  if (snap.workspace_id !== device.workspace_id) {
    return res.status(403).json({ error: 'Saved settings belong to a different workspace' });
  }
  deviceSettings.applyToDevice(req.params.id, fingerprint);
  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  console.log(`[#150] re-adopted settings (fp ${fingerprint.slice(0, 8)}…) onto device ${req.params.id} by user ${req.user.id}`);
  // ⚠️ stripDeviceSecrets only removes device_token. GET /:id additionally calls
  // stripSecretsForTokens; these two echo paths did not, so a token got the trigger secret
  // back from a rename — the escalation lib/device-sanitize.js exists to prevent.
  res.json(stripSecretsForTokens(stripDeviceSecrets(updated), req.viaToken));
});

// Delete device
router.delete('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  // #150: snapshot this device's settings (keyed by its fingerprint) BEFORE the row dies,
  // so a re-pair of the SAME physical device restores orientation/name/playlist/etc instead
  // of silently resetting to defaults. No-op if the device has no fingerprint link yet.
  try { deviceSettings.snapshot(req.params.id); } catch (e) { console.warn(`[#150] settings snapshot failed for ${req.params.id}: ${e.message}`); }

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

// ── Live video (go2rtc). All READ-gated: watching a screen is a read, exactly like a screenshot.
// The publish path (the player offering video INTO go2rtc) authenticates as a DEVICE, not a user,
// and lives with the player-publisher work; it is deliberately not here. See docs/live-video.md.
const go2rtc = require('../lib/go2rtc');

// Resolve read access to a device via its workspace, the same shape GET /:id uses. Returns the
// device row (with workspace) or null after sending the response.
function checkDeviceRead(req, res) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  device._workspace = ws;
  return device;
}

// Whether live VIDEO is on for this device: the server master gate, the workspace flag, and the
// device flag must all be set. Independent of whether a publisher is actually connected right now.
function liveVideoOn(device) {
  return !!(config.liveVideoEnabled && device._workspace && device._workspace.live_video_enabled && device.live_video_enabled);
}

/*
 * What the dashboard should do to watch this screen right now.
 *
 * mode 'webrtc' only when live video is enabled at all three levels AND go2rtc is healthy AND a
 * stream for this device actually exists (a publisher is connected). Anything short of that is
 * mode 'snapshot' — the existing screenshot path — so the Devices page never breaks when the
 * sidecar is absent, down, or nobody is publishing. The browser signals through signalPath (a
 * proxied ScreenTinker route), never straight to go2rtc, so the admin API stays private.
 */
router.get('/:id/live', async (req, res) => {
  const device = checkDeviceRead(req, res);
  if (!device) return;
  const snapshot = { mode: 'snapshot', fallback: 'snapshot' };
  if (!liveVideoOn(device)) return res.json({ ...snapshot, reason: 'disabled' });
  if (!go2rtc.enabled()) return res.json({ ...snapshot, reason: 'no_sidecar' });
  const name = go2rtc.streamName(device.workspace_id, device.id);
  const [healthy, present] = await Promise.all([go2rtc.healthy(), go2rtc.hasStream(name)]);
  if (!healthy) return res.json({ ...snapshot, reason: 'sidecar_down' });
  if (!present) return res.json({ ...snapshot, reason: 'not_publishing' });
  res.json({
    mode: 'webrtc',
    fallback: 'snapshot',
    // Proxied signaling: the browser POSTs its SDP offer here, the server forwards to go2rtc.
    signalPath: `/api/devices/${device.id}/live/webrtc`,
    iceServers: go2rtc.iceServers(),
    // A viewer URL is not minted; the proxy holds the session. expiresAt bounds how long the
    // dashboard should trust this descriptor before re-asking (a publisher can drop meanwhile).
    expiresAt: Date.now() + 30000,
  });
});

// Proxy one WebRTC SDP exchange for WATCHING. Read-gated, and the requested stream must belong to
// this exact workspace+device: streamBelongsTo recomputes the name, so a caller cannot hand us
// another workspace's stream even with a valid session on their own device.
router.post('/:id/live/webrtc', express.text({ type: ['application/sdp', 'text/plain'], limit: '256kb' }), async (req, res) => {
  const device = checkDeviceRead(req, res);
  if (!device) return;
  if (!liveVideoOn(device) || !go2rtc.enabled()) return res.status(409).json({ error: 'Live video is not available for this device' });
  const name = go2rtc.streamName(device.workspace_id, device.id);
  if (!go2rtc.streamBelongsTo(name, device.workspace_id, device.id)) return res.status(403).json({ error: 'Stream does not belong to this device' });
  const offer = typeof req.body === 'string' ? req.body : '';
  if (!offer) return res.status(400).json({ error: 'SDP offer required' });
  const answer = await go2rtc.webrtcExchange(name, offer, 'sub');
  if (!answer) return res.status(502).json({ error: 'go2rtc did not answer', fallback: 'snapshot' });
  res.type('application/sdp').send(answer.sdp);
});

module.exports = router;
