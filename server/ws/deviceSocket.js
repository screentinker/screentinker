const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, pruneTelemetry, pruneScreenshots } = require('../db/database');
const config = require('../config');
const heartbeat = require('../services/heartbeat');
const liveness = require('../lib/liveness'); // v4 core pass: pure ack/liveness/identity helpers
const commandQueue = require('../lib/command-queue');
const reconnectThrottle = require('../lib/reconnect-throttle');
const contentAckLimiter = require('../lib/content-ack-limiter');
const statusLogWriter = require('../lib/status-log-writer');
const { protectSocket } = require('../lib/safe-socket');
const flapLimiter = require('../lib/flap-limiter');
const sessionSettle = require('../lib/session-settle');   // #148 patch2: eviction-storm debounce
const { resolveIdentity } = require('../lib/device-identity');
const logCoalescer = require('../lib/log-coalescer');
const loopLag = require('../services/loop-lag');
const deviceSettings = require('../lib/device-settings'); // #150 delete+re-pair settings restore
const incidentClassify = require('../lib/incident-classify'); // offline-cause log: disconnect-reason + connectivity classification

// Debounce window for marking a device offline on socket disconnect. Brief
// flap (Wi-Fi blip, Engine.IO ping miss, server-side eviction-then-reconnect)
// shouldn't toggle the dashboard. If a fresh register lands within this
// window, the pending offline transition is cancelled. Per-device timer is
// stored here; cleared by the register handlers and by stale-disconnect
// guards. In-memory only - the heartbeat checker is the safety net for
// server-restart-during-grace-window edge cases (any 'online' rows whose
// last_heartbeat is older than heartbeatTimeout get marked offline by the
// next checker sweep within heartbeatInterval).
const pendingOfflines = new Map();
const OFFLINE_DEBOUNCE_MS = 5000;

// #146: socket ids we force-disconnected via evictPriorSocket because a NEWER socket
// took over the device. evictPriorSocket runs at register time BEFORE the new socket
// is put in the connection map (registerConnection is later in the same handler), so
// the evicted socket's disconnect handler would see the still-old map entry, pass the
// stale-disconnect guard, and ARM a fresh offline timer — re-marking the device that
// just reconnected offline (the self-reset race). Tagging the id here lets that
// disconnect handler bail out instead of arming a timer. Drained on consumption.
const evictedSockets = new Set();

// Proof-of-play write throttle. A player stuck in a tight loop (e.g. a playlist
// with 0-second item durations) fires device:play-event 'play_start' several
// times per second; unthrottled this once bloated play_logs to ~900k rows
// (~3 inserts/sec from a single web player). Cap proof-of-play inserts to at
// most one per device per PLAY_LOG_MIN_GAP_MS. The live dashboard progress
// event is still forwarded every time, so the UI is unaffected. In-memory only.
const lastPlayLogAt = new Map();
const PLAY_LOG_MIN_GAP_MS = 2000;

// #142 dedup + #143 per-device rate budget + global loop-lag valve for content-acks
// all live in one control: lib/content-ack-limiter.js (required above as
// contentAckLimiter). Kept out of this file so there is a single limiter on the path.

// #143 fingerprint-reclaim deferral log throttle: deviceId -> last-logged ms, so a
// device retrying reclaim every ~2s logs at most once per reclaimRejectLogWindowMs.
const lastReclaimRejectLogAt = new Map();
const { getUserPlan, getUserDeviceCount } = require('../middleware/subscription');
// Phase 2.3: deviceRoom() resolves a device_id to its workspace room so
// dashboardNs.emit can be scoped instead of broadcast platform-wide.
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');

function emitToDeviceWorkspace(dashboardNs, deviceId, event, payload) {
  emitToWorkspace(dashboardNs, deviceRoom(deviceId), event, payload);
}

// In-memory store for latest screenshot per device (avoids disk writes during streaming)
let lastScreenshots = {};

// Generate a random device token
// Persist the panel-reported device_info onto the devices row. Shared by device:register and the
// lightweight #160 device:info event (which re-reports after a volume/brightness change so the
// dashboard reflects it without a full re-register / playlist push). Older APKs omit newer fields.
function applyDeviceInfo(deviceId, di) {
  const num = (v) => (typeof v === 'number' ? v : null);
  // Upgrade incident: if the reported app_version differs from what we had stored, log it
  // (old → new) in the incident feed. Server-side, so it covers every client (Android/Tizen/web)
  // with no client change. Only when we HAD a prior version (a fresh pair isn't an "upgrade").
  try {
    if (di.app_version) {
      const prev = db.prepare('SELECT app_version FROM devices WHERE id = ?').get(deviceId);
      if (prev && prev.app_version && prev.app_version !== di.app_version) {
        db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, 'upgrade', 'upgrade', ?)")
          .run(deviceId, `${prev.app_version} → ${di.app_version}`);
      }
    }
  } catch (_) { /* incident feed is best-effort */ }
  db.prepare(`UPDATE devices SET android_version = ?, app_version = ?, screen_width = ?, screen_height = ?, render_width = ?, render_height = ?,
    ota_status = ?, ota_target_version = ?, ota_attempts = ?, tier = ?, foreign_device_owner = ?,
    can_write_settings = ?, accessibility_enabled = ?, overlay_granted = ?,
    media_volume = ?, system_brightness = ?, window_brightness = ?, screen_off_timeout_ms = ?, ota_updated_at = strftime('%s','now') WHERE id = ?`)
    .run(di.android_version, di.app_version, di.screen_width, di.screen_height, di.render_width ?? null, di.render_height ?? null,
      di.ota_status ?? 'none', di.ota_target_version ?? null, di.ota_attempts ?? 0,
      Number.isInteger(di.tier) ? di.tier : 0, di.foreign_device_owner ? 1 : 0,
      di.can_write_settings ? 1 : 0, di.accessibility_enabled ? 1 : 0, di.overlay_granted ? 1 : 0,
      num(di.media_volume), num(di.system_brightness), num(di.window_brightness), num(di.screen_off_timeout_ms),
      deviceId);
}

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Validate device_id + device_token pair. Returns true if valid.
function validateDeviceToken(deviceId, token) {
  if (!deviceId || !token) return false;
  const row = db.prepare('SELECT device_token FROM devices WHERE id = ?').get(deviceId);
  if (!row || !row.device_token) return false;
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(row.device_token), Buffer.from(token));
  } catch {
    return false;
  }
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

// #146: route status transitions through the batched, coalescing writer instead of
// an immediate INSERT-per-transition. A flapping device no longer writes a row per
// flap (the table-bloat feedback loop); the per-device age prune now lives in the
// writer and uses config.statusLogRetentionDays (was a hardcoded 7 days here — one
// source of truth). devices.status is still updated immediately by callers; only
// this audit log is deferred to the next flush.
function logDeviceStatus(deviceId, status, reason, detail) {
  statusLogWriter.record(deviceId, status, reason, detail);
}


// Build playlist payload with layout and zones
// Reads from published_snapshot (Phase 3) so draft edits don't affect live devices
// #group-sync: membership is the device_group_members m2m table (a device can be in several
// groups). Sync-eligible members = the group's members whose playlist MATCHES the group's shared
// playlist. A member on a different playlist is ignored (never synced) — index sync would be
// meaningless. Ordered by id for a stable auto-election.
function groupSyncMembers(group) {
  if (!group || !group.playlist_id) return [];
  return db.prepare(`
    SELECT d.id, d.status FROM devices d
    JOIN device_group_members dgm ON dgm.device_id = d.id
    WHERE dgm.group_id = ? AND d.playlist_id = ? ORDER BY d.id
  `).all(group.id, group.playlist_id);
}

// Elect the group's sync leader: the pinned leader if it's an online, playlist-matching member;
// else the first online matching member; else the first matching member (stable id while all
// offline). null if the group has no eligible members.
function resolveGroupLeader(group) {
  const members = groupSyncMembers(group);
  if (!members.length) return null;
  const online = members.filter(m => m.status === 'online');
  if (group.leader_device_id && online.some(m => m.id === group.leader_device_id)) return group.leader_device_id;
  if (online.length) return online[0].id;
  return members[0].id;
}

// The device's sync group: a sync-enabled group it belongs to (m2m) whose shared playlist THIS
// device is on. Deterministic pick if it's somehow in several. Returns the group row or null.
function deviceSyncGroup(deviceId, devicePlaylistId) {
  if (!devicePlaylistId) return null;
  return db.prepare(`
    SELECT g.id, g.sync_enabled, g.playlist_id, g.leader_device_id
    FROM device_groups g JOIN device_group_members dgm ON dgm.group_id = g.id
    WHERE dgm.device_id = ? AND g.sync_enabled = 1 AND g.playlist_id = ?
    ORDER BY g.name ASC, g.id ASC LIMIT 1
  `).get(deviceId, devicePlaylistId) || null;
}

// Build the group_sync block for a device, or null (the playlist-match guard lives in deviceSyncGroup).
function resolveGroupSync(device, deviceId) {
  const group = deviceSyncGroup(deviceId, device?.playlist_id);
  if (!group) return null;
  const leaderId = resolveGroupLeader(group);
  if (!leaderId) return null;
  return { group_id: group.id, is_leader: leaderId === deviceId };
}

function buildPlaylistPayload(deviceId) {
  const device = db.prepare('SELECT playlist_id, layout_id, orientation, wall_id, timezone, reported_timezone FROM devices WHERE id = ?').get(deviceId);

  let assignments = [];
  if (device?.playlist_id) {
    const playlist = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (playlist?.published_snapshot) {
      try { assignments = JSON.parse(playlist.published_snapshot); } catch (e) { assignments = []; }
    }
  }

  let layout = null;
  if (device?.layout_id) {
    layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
    if (layout) {
      layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
    }
  }

  // Wall membership flips the player into wall mode. The renderer needs two
  // rectangles in canvas-space: this device's screen rect, and the wall's
  // player rect. The intersection is what this screen displays. The leader
  // drives playback; followers track via wall:sync.
  let wall_config = null;
  if (device?.wall_id) {
    const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
    const pos = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?').get(device.wall_id, deviceId);
    if (wall && pos) {
      const baseW = 320, baseH = 180;
      const bezelH = wall.bezel_h_mm || 0;
      const bezelV = wall.bezel_v_mm || 0;

      // Backfill canvas rect from grid math when canvas_* is unset (legacy
      // walls that haven't been touched by the new editor yet). Coords are
      // rounded to integers so sub-pixel drift can't cause two visually
      // identical rects to compute different stage offsets.
      const screenRect = {
        x: Math.round(pos.canvas_x ?? (pos.grid_col * (baseW + bezelH))),
        y: Math.round(pos.canvas_y ?? (pos.grid_row * (baseH + bezelV))),
        w: Math.round(pos.canvas_width ?? baseW),
        h: Math.round(pos.canvas_height ?? baseH),
      };

      // Player rect defaults to the bounding box of all screens on the wall.
      let playerRect;
      if (wall.player_x !== null && wall.player_x !== undefined) {
        playerRect = { x: wall.player_x, y: wall.player_y, w: wall.player_width, h: wall.player_height };
      } else {
        const all = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
        let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of all) {
          const px = p.canvas_x ?? (p.grid_col * (baseW + bezelH));
          const py = p.canvas_y ?? (p.grid_row * (baseH + bezelV));
          const pw = p.canvas_width ?? baseW;
          const ph = p.canvas_height ?? baseH;
          if (px < x) x = px;
          if (py < y) y = py;
          if (px + pw > x2) x2 = px + pw;
          if (py + ph > y2) y2 = py + ph;
        }
        playerRect = isFinite(x)
          ? { x, y, w: x2 - x, h: y2 - y }
          : { x: 0, y: 0, w: baseW, h: baseH };
      }
      // Round the player rect too — same rationale.
      playerRect = {
        x: Math.round(playerRect.x), y: Math.round(playerRect.y),
        w: Math.round(playerRect.w), h: Math.round(playerRect.h),
      };

      wall_config = {
        wall_id: wall.id,
        screen_rect: screenRect,
        player_rect: playerRect,
        is_leader: wall.leader_device_id === deviceId,
        rotation: pos.rotation || 0,
      };
    }
  }

  // #74/#75: the effective IANA timezone the player evaluates schedule blocks in.
  // An explicit (non-default) devices.timezone override wins; otherwise the player's
  // last OS-reported zone; otherwise null = the player trusts its own OS clock.
  const tzOverride = (device?.timezone && device.timezone !== 'UTC') ? device.timezone : null;
  const timezone = tzOverride || device?.reported_timezone || null;
  // #group-sync: synchronized group playback (wall takes precedence — a wall member is never
  // also group-synced). Null unless the device is on a sync-enabled group's matching playlist.
  const group_sync = wall_config ? null : resolveGroupSync(device, deviceId);
  // #104: shared shape + zone-reset tail so the device payload and the dashboard
  // preview payload (GET /api/playlists/:id/preview-payload) can never drift.
  return assemblePayload({ assignments, layout, orientation: device?.orientation || 'landscape', wall_config, group_sync, timezone });
}

// #104: the canonical player payload shape, shared by the device path
// (buildPlaylistPayload) and the device-free dashboard preview.
// Zone reset: if this isn't a real multi-zone layout (single zone or no layout),
// strip any leftover zone_id so content falls back to the fullscreen renderer
// instead of binding to a now-gone left/right zone and never playing.
function assemblePayload({ assignments, layout, orientation, wall_config, group_sync, timezone }) {
  let a = Array.isArray(assignments) ? assignments : [];
  const zoneCount = layout?.zones?.length || 0;
  if (zoneCount < 2) a = a.map(x => (x && x.zone_id != null ? { ...x, zone_id: null } : x));
  return {
    assignments: a,
    layout: layout || null,
    orientation: orientation || 'landscape',
    wall_config: wall_config || null,
    group_sync: group_sync || null,
    timezone: timezone || null,
  };
}

// Check if a device should show trial expired screen
function checkDeviceAccess(deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.user_id) return { allowed: true };

  const plan = getUserPlan(device.user_id);
  if (!plan) return { allowed: true };

  // Check if trial expired and over free limit
  if (plan.trial_started && !plan.trial_active && plan.plan_name === 'free') {
    const deviceCount = getUserDeviceCount(device.user_id);
    // Get this device's position (ordered by created_at)
    const userDevices = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(device.user_id);
    const deviceIndex = userDevices.findIndex(d => d.id === deviceId);

    // Only the first device (within free limit) is allowed
    if (deviceIndex >= plan.max_devices) {
      return {
        allowed: false,
        reason: 'trial_expired',
        message: 'Trial Expired',
        detail: 'Upgrade your plan to continue using this display.',
      };
    }
  }

  // Check if over plan device limit (non-trial)
  if (!plan.trial_started && plan.max_devices > 0) {
    const userDevices = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(device.user_id);
    const deviceIndex = userDevices.findIndex(d => d.id === deviceId);
    if (deviceIndex >= plan.max_devices) {
      return {
        allowed: false,
        reason: 'device_limit',
        message: 'Device Limit Reached',
        detail: 'Upgrade your plan to activate this display.',
      };
    }
  }

  return { allowed: true };
}

// v4 core-pass helpers (module scope; db is a ready singleton at require time).
const _deviceExistsStmt = db.prepare('SELECT 1 FROM devices WHERE id = ?');
function deviceExists(id) { return !!(id && _deviceExistsStmt.get(id)); }
const _identityReadStmt = db.prepare('SELECT client_type, client_version, platform, contract_version FROM devices WHERE id = ?');
const _persistIdentityStmt = db.prepare('UPDATE devices SET client_type = ?, client_version = ?, platform = ?, contract_version = ? WHERE id = ?');
function persistIdentity(deviceId, data) {
  if (!deviceId) return;
  // FIX 3: capture-don't-act; degrades to legacy/unknown for old clients; NEVER breaks register.
  // A1 change-detection: only WRITE when the identity actually changed vs stored. A genuine
  // reconnect with unchanged identity (the common case, incl. flapping / re-pair churn) does a cheap
  // read and NO write — no UPDATE, no WAL churn. First provision (stored NULLs) and a real change
  // (e.g. new client_version after an OTA) still write.
  try {
    const i = liveness.captureIdentity(data);
    if (!liveness.identityChanged(_identityReadStmt.get(deviceId), i)) return; // unchanged — skip the write
    _persistIdentityStmt.run(i.client_type, i.client_version, i.platform, i.contract_version, deviceId);
  } catch (e) { /* identity capture must never break registration */ }
}

module.exports = function setupDeviceSocket(io) {
  // Expose helpers for use by route handlers
  module.exports.lastScreenshots = lastScreenshots;
  module.exports.buildPlaylistPayload = buildPlaylistPayload;
  module.exports.assemblePayload = assemblePayload;
  module.exports.generateDeviceToken = generateDeviceToken;
  const deviceNs = io.of('/device');
  const dashboardNs = io.of('/dashboard');

  // Disconnect any existing socket that is currently registered for this device_id.
  // Called when a fresh registration comes in for the same device so the old (likely
  // half-dead) socket can't fire its disconnect handler and clobber the new entry.
  function evictPriorSocket(deviceId, exceptSocketId) {
    const prior = heartbeat.getConnection(deviceId);
    if (!prior || prior.socketId === exceptSocketId) return;
    const oldSocket = deviceNs.sockets.get(prior.socketId);
    if (oldSocket) {
      console.log(`Evicting prior socket ${prior.socketId} for device ${deviceId}`);
      // Mark BEFORE disconnect: disconnect(true) fires the old socket's 'disconnect'
      // handler synchronously, so the flag must already be set when it runs.
      evictedSockets.add(prior.socketId);
      try { oldSocket.disconnect(true); } catch (_) { evictedSockets.delete(prior.socketId); }
    }
  }

  deviceNs.on('connection', (socket) => {
    console.log(`Device socket connected: ${socket.id}`);
    let currentDeviceId = null;
    let authenticated = false; // Track whether this socket has been authenticated

    // #146: wrap every handler on THIS socket so a throw disconnects only this device
    // (logged with its id) instead of crashing the whole server. Backstop to the
    // per-site try/catch in the handlers below.
    protectSocket(socket, () => currentDeviceId);

    // Device registers with a pairing code (first time) or device_id + device_token (reconnect)
    socket.on('device:register', (data) => {
      const { pairing_code, device_id, device_token, device_info, fingerprint } = data;

      // #146: resolve identity ONCE via the SNAT-safe chain (device_id -> fingerprint
      // -> token -> global anon), used by BOTH the operator block and the flap limiter.
      const ident = resolveIdentity({ device_id, fingerprint, device_token });

      // #143 operator KILL SWITCH — the FIRST gate, before the fingerprint block, the
      // throttle, any DB writes, or playlist build. #146: resolve the effective
      // device_id via the identity chain (device_id directly, OR fingerprint->device_id)
      // so a blocked device that reconnects WITHOUT a device_id is STILL caught — the
      // old `if (device_id)` gate let a device_id-less reconnect slip past. Settable by
      // DIRECT SQLite during an outage (dashboard down), takes effect on the device's
      // NEXT register with NO restart (the row is re-read every register):
      //   UPDATE devices SET blocked = 1 WHERE id = '<device_id>';   (0 to unblock)
      // Unlike nulling the token (#143: that re-provisioned instead of locking out),
      // `blocked` is an explicit, enforceable lever. Also settable via the dashboard
      // (routes/devices.js POST /:id/block) — same DB write, same next-register effect.
      if (ident.deviceId) {
        const blk = db.prepare('SELECT blocked FROM devices WHERE id = ?').get(ident.deviceId);
        if (blk && blk.blocked) {
          console.warn(`[blocked] refused device ${ident.deviceId} (operator block, via ${ident.kind})`);
          socket.emit('device:auth-error', { error: 'Device blocked' });
          process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
          return;
        }
      }

      // #146 Item B: SUSTAINED flap limiter — BEFORE fingerprint tracking, throttle,
      // DB writes, or playlist build, so a refusal is cheap. Skips same-socket playlist
      // refreshes (currentDeviceId===device_id — a periodic pull, not a new connection).
      // Keyed via the same SNAT-safe identity, NEVER IP.
      const isRefreshConnect = device_id && currentDeviceId === device_id;
      if (!isRefreshConnect) {
        // #148: a paired + AUTHENTICATED device reconnecting is exempt from the flap
        // QUARANTINE (not from the soft cooldown). validateDeviceToken confirms device_id +
        // a matching STORED token (false for missing/mismatch), so a spoofed device_id can't
        // claim the exemption — an attacker without the real token is still quarantinable.
        const paired = !!device_id && validateDeviceToken(device_id, device_token);
        const fv = flapLimiter.check(ident.key, Date.now(), { paired });
        if (!fv.allow) {
          // #146 P0: auto-quarantine is IN-MEMORY + TIME-LIMITED (lib/flap-limiter),
          // never a DB block — a stuck-then-recovered device self-heals. The
          // devices.blocked column is now written ONLY by an operator. Log the
          // quarantine START once; coalesce the repeat refusals.
          if (fv.quarantined) {
            console.warn(`[flap] quarantined ${ident.deviceId || ident.key} for ${Math.round(config.connectRateQuarantineMs / 60000)}m after ${fv.trips} trips`);
          } else {
            logCoalescer.record(`flap-refused:${ident.key}`, `[flap] refused ${ident.kind} ${ident.deviceId || ident.key} reason=${fv.reason}`);
          }
          socket.emit('device:throttled', { retry_after_ms: fv.retryAfterMs, reason: 'connect_rate' });
          process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
          return;
        }
      }

      // Track device fingerprint to prevent reinstall abuse
      if (fingerprint) {
        try {
          const existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
          if (existing) {
            db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now'), device_id = ? WHERE fingerprint = ?")
              .run(device_id || existing.device_id, fingerprint);
            // If this fingerprint was previously registered to a different device, block the new registration
            if (!device_id && existing.device_id && pairing_code) {
              // Someone reinstalled - link them back to existing device
              const oldDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.device_id);
              if (oldDevice) {
                // Fingerprint reclaim guard: a leaked/duplicated fingerprint shouldn't be enough
                // to take over a LIVE device. #143: decide "still alive" from RUNTIME signals —
                // a live socket, OR a genuinely recent heartbeat (within the settle window). The
                // old check used `secondsSince < 24h`, which treated a device merely offline <24h
                // as "active": a legitimately-gone device (liveConn=false, status=offline, stale
                // heartbeat) could never reclaim and retried every ~2s, flooding logs (Bold beta1
                // / 2febcaa9, 1984694c, 139159eb). NOT a missing clear — liveConn IS removed on
                // disconnect + the offline-timeout sweep, and status IS set offline on both; the
                // 24h TIME gate was the cause. A device gone by every runtime signal is reclaimable.
                const liveConn = heartbeat.getConnection(existing.device_id);
                const lastBeat = oldDevice.last_heartbeat || 0;
                const secondsSince = Math.floor(Date.now() / 1000) - lastBeat;
                // Bold 1.9.3->1.9.6 upgrade fix: a reinstalled panel registers with
                // { pairing_code, fingerprint } and NO device_id — it is asking to be
                // PROVISIONED, not to reclaim. The ONLY grounds to reject is a genuinely
                // LIVE socket on the old device row (stops a duplicated fingerprint from
                // hijacking an actively-connected display). The previous guard also rejected
                // on a merely-recent heartbeat (secondsSince < reclaimSettleSeconds), which
                // on an in-place-reinstall upgrade is ALWAYS true — so it returned before the
                // pairing_code INSERT and the code the player was displaying was never created,
                // leaving the dashboard with "code does not exist" until device_fingerprints
                // was cleared by hand. The real security boundary is the operator claiming the
                // code in the dashboard; a cloned fingerprint that falls through only gets an
                // unclaimed, tokenless, content-less row — harmless.
                // Pairing-race (1.9.9): a device mid-DEFERRED-OFFLINE is NOT genuinely live.
                // On disconnect we defer heartbeat.removeConnection() by OFFLINE_DEBOUNCE_MS
                // (anti-flap), so heartbeat.getConnection() keeps returning a ZOMBIE entry for the
                // just-closed socket for the whole grace window. A same-fingerprint reconnect inside
                // that window (this branch is only reached via a device_fingerprints match, so it
                // inherently IS the same physical display) would otherwise hit a FALSE-POSITIVE
                // "active on another connection" reject, and for an unclaimed row the retry then
                // collided on UNIQUE(devices.pairing_code) and wedged the player. Gate the reject on
                // there being NO pending-offline timer for this device.
                //
                // ANTI-HIJACK BOUNDARY (unchanged): a DIFFERENT physical device presenting a CLONED
                // fingerprint while the REAL device is actively connected never disconnected -> no
                // pending-offline timer is armed -> inDeferredOffline is false -> the liveConn reject
                // STILL fires. We ONLY relax the reject when the matched row's OWN connection is in
                // its deferred-offline grace (i.e. it just dropped) — a legitimate reconnect of that
                // same display. Even then, a CLAIMED row is reclaimed only because liveConn (the real
                // anti-hijack check) already passed, and an UNCLAIMED fall-through only ever yields a
                // tokenless, content-less row: the operator claiming the on-screen code stays the
                // real trust boundary, so relaxing this reject grants an attacker nothing.
                const inDeferredOffline = pendingOfflines.has(existing.device_id);
                if (liveConn && !inDeferredOffline) {
                  // Log at most once per device per window so a retrying/stuck device can't flood stdout.
                  const nowMs = Date.now();
                  if (nowMs - (lastReclaimRejectLogAt.get(existing.device_id) || 0) >= config.reclaimRejectLogWindowMs) {
                    lastReclaimRejectLogAt.set(existing.device_id, nowMs);
                    console.warn(`Fingerprint reclaim rejected for ${existing.device_id}: old device has a LIVE socket (status=${oldDevice.status}, ${secondsSince}s since heartbeat)`);
                  }
                  socket.emit('device:auth-error', {
                    error: 'This display is currently active on another connection.'
                  });
                  return;
                }
                // No live socket from here on — the old connection is gone.
                lastReclaimRejectLogAt.delete(existing.device_id);
                if (oldDevice.user_id) {
                  // The old row is CLAIMED. A reinstalled panel (MDM wiped its data, so it presents
                  // only its stable fingerprint — no device_id, no token) must REMATCH to this row —
                  // preserving the claim, name, playlist, and content — instead of provisioning a
                  // stranger the operator has to re-pair across the whole fleet. device:paired below
                  // drives the app off the pairing screen, so the fresh code it was displaying is
                  // irrelevant. We reclaim regardless of the settle window: liveConn (checked above)
                  // is the real anti-hijack boundary; the settle delay only postponed a
                  // fingerprint-only reclaim the server already grants once the window elapses.

                // Fingerprint matched — this is a reinstalled app reconnecting to its old device.
                // Issue a fresh token so the app can authenticate going forward.
                const newToken = generateDeviceToken();
                db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(newToken, existing.device_id);
                console.log(`Fingerprint match: linking reinstalled app to existing device ${existing.device_id} (new token issued)`);
                authenticated = true;
                // Cancel any pending offline timer - device is back in the grace window
                if (pendingOfflines.has(existing.device_id)) {
                  clearTimeout(pendingOfflines.get(existing.device_id));
                  pendingOfflines.delete(existing.device_id);
                }
                evictPriorSocket(existing.device_id, socket.id);
                db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now'), offline_reason = NULL, offline_reason_at = NULL, offline_detail = NULL WHERE id = ?")
                  .run(getClientIp(socket), existing.device_id);
                socket.emit('device:registered', { device_id: existing.device_id, device_token: newToken, status: 'online' });
                // If device was already claimed by a user, tell the player it's paired
                if (oldDevice.user_id) {
                  socket.emit('device:paired', {
                    device_id: oldDevice.id,
                    name: oldDevice.name || 'Display',
                    settings_pin: oldDevice.settings_pin || undefined
                  });
                }
                currentDeviceId = existing.device_id;
                heartbeat.registerConnection(existing.device_id, socket.id);
                heartbeat.recordReconnect(existing.device_id);   // FIX 2: churn signal
                persistIdentity(existing.device_id, data);       // FIX 3: identity capture
                socket.join(existing.device_id);
                logDeviceStatus(existing.device_id, 'online');
                emitToDeviceWorkspace(dashboardNs, existing.device_id, 'dashboard:device-status', { device_id: existing.device_id, status: 'online', liveness: heartbeat.livenessFor(existing.device_id) });
                // Flush any commands/playlist-updates queued while this device was offline.
                commandQueue.flushQueue(deviceNs, existing.device_id, buildPlaylistPayload);
                // Send playlist
                const access = checkDeviceAccess(existing.device_id);
                if (!access.allowed) {
                  socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
                } else {
                  socket.emit('device:playlist-update', buildPlaylistPayload(existing.device_id));
                }
                return;
                }
                // The old row is UNCLAIMED (never paired). Reclaiming it would leave it carrying a
                // stale/null pairing_code while the player shows a fresh one -> "code does not exist".
                // Fall through to the pairing_code path below, which provisions a fresh row with the
                // on-screen code and (#150) relinks the fingerprint to it. reclaimSettleSeconds no
                // longer gates this path — a genuinely live socket (above) is the only rejection.
                //
                // IDEMPOTENCY (pairing-race 1.9.9): EXCEPT when the reconnecting player presents the
                // SAME pairing_code this unclaimed row already holds. That is exactly the zombie case
                // Fix A now lets through: the row is mid-deferred-offline and STILL holds the on-screen
                // code, so the fall-through INSERT below collides on UNIQUE(devices.pairing_code) and
                // wedges the player unclaimed with no content. The stale-code hazard in the comment
                // above applies ONLY when the codes DIFFER; when they MATCH there is no stale code to
                // strand, so ADOPT the existing row (mirror the claimed-reclaim refresh above) instead
                // of re-INSERTing. Deliberately NO device:paired — the row is unclaimed and the
                // operator must still claim the on-screen code (the real trust boundary is untouched).
                if (pairing_code === oldDevice.pairing_code) {
                  const newToken = generateDeviceToken();
                  db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(newToken, existing.device_id);
                  console.log(`Fingerprint match: adopting UNCLAIMED same-code row ${existing.device_id} (code ${pairing_code}) instead of re-provisioning`);
                  authenticated = true;
                  // Cancel any pending offline timer - device is back in the grace window
                  if (pendingOfflines.has(existing.device_id)) {
                    clearTimeout(pendingOfflines.get(existing.device_id));
                    pendingOfflines.delete(existing.device_id);
                  }
                  evictPriorSocket(existing.device_id, socket.id);
                  db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now'), offline_reason = NULL, offline_reason_at = NULL, offline_detail = NULL WHERE id = ?")
                    .run(getClientIp(socket), existing.device_id);
                  socket.emit('device:registered', { device_id: existing.device_id, device_token: newToken, status: 'online' });
                  // No device:paired — the row is unclaimed; the player stays on the pairing screen
                  // showing its (still-valid) code for the operator to claim.
                  currentDeviceId = existing.device_id;
                  heartbeat.registerConnection(existing.device_id, socket.id);
                  heartbeat.recordReconnect(existing.device_id);
                  persistIdentity(existing.device_id, data);
                  socket.join(existing.device_id);
                  logDeviceStatus(existing.device_id, 'online');
                  emitToDeviceWorkspace(dashboardNs, existing.device_id, 'dashboard:device-status', { device_id: existing.device_id, status: 'online', liveness: heartbeat.livenessFor(existing.device_id) });
                  // Flush any commands/playlist-updates queued while this device was offline.
                  commandQueue.flushQueue(deviceNs, existing.device_id, buildPlaylistPayload);
                  // Send playlist
                  const access = checkDeviceAccess(existing.device_id);
                  if (!access.allowed) {
                    socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
                  } else {
                    socket.emit('device:playlist-update', buildPlaylistPayload(existing.device_id));
                  }
                  return;
                }
              }
            }
          } else if (device_id || pairing_code) {
            // device_id can be stale (e.g. a reconnect after the device row was
            // deleted). device_fingerprints.device_id has an FK to devices(id), and
            // INSERT OR IGNORE does NOT suppress FK violations - so null out an
            // unknown id instead of letting it throw (was a caught, noisy error).
            const fpDeviceId = (device_id && db.prepare('SELECT 1 FROM devices WHERE id = ?').get(device_id)) ? device_id : null;
            db.prepare("INSERT OR IGNORE INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)")
              .run(fingerprint, fpDeviceId);
          }
        } catch (e) {
          console.error('Fingerprint tracking error:', e.message);
        }
      }

      if (device_id) {
        // Reconnecting known device — require valid token
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
        if (device) {
          // A re-register on the SAME socket is a playlist REFRESH, not a reconnect: the
          // player re-emits device:register every ~45-60s (requestPlaylistRefresh) to pull a
          // fresh playlist, and the socket never dropped. currentDeviceId is still null on a
          // genuinely new socket and already === device_id on a same-socket refresh. Tracking
          // this stops a healthy device (~2000 re-registers/day) from spamming "Device
          // reconnected" and reading as connection instability (#134 — there were 1415
          // "reconnected" logs against only ~30 real socket connects and 0 heartbeat timeouts).
          const isPlaylistRefresh = currentDeviceId === device_id;
          // #143 AUTH FIX: an already-provisioned device (it has a row — every row,
          // even `provisioning`, is created WITH a token) presenting a null/empty/
          // invalid token is NOT authenticated — reject and disconnect. The old guard
          // `device.device_token && !validate(...)` short-circuited on a NULL stored
          // token, so nulling a device's token RE-PROVISIONED it (auth skipped + a
          // fresh token minted) instead of locking it out (Bold #143 / 75c2a08a).
          // validateDeviceToken already returns false for null-stored/missing/mismatch.
          // First pairing is the pairing_code path below (no device_id) — unaffected.
          if (!validateDeviceToken(device_id, device_token)) {
            console.warn(`Invalid/missing device token for ${device_id} from ${getClientIp(socket)} — received_len=${(device_token || '').length}, has_stored_token=${!!device.device_token}`);
            socket.emit('device:auth-error', { error: 'Invalid device token' });
            return;
          }

          // #142: per-device reconnect throttle. Only GENUINE reconnects (a new
          // socket) count — same-socket playlist refreshes (isPlaylistRefresh) are
          // exempt. This runs BEFORE the heavy register work (DB writes, playlist
          // build) so a single flapping device cannot saturate the event loop. The
          // verdict is per-device; global lag only scales an already-flagged
          // device's backoff, never gates a healthy one.
          if (!isPlaylistRefresh) {
            const verdict = reconnectThrottle.check(device_id);
            if (!verdict.allow) {
              console.warn(`[throttle] device ${device_id} reconnect throttled: reason=${verdict.reason} band=${verdict.band} observed=${verdict.observed}/${verdict.allowed} per ${config.reconnectWindowMs}ms -> backoff ${verdict.retryAfterMs}ms (level ${verdict.level})`);
              socket.emit('device:throttled', { retry_after_ms: verdict.retryAfterMs, reason: 'reconnect_rate' });
              // nextTick disconnect so the throttle notice flushes first.
              process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
              return;
            }
          }

          // #148 patch2: SESSION-SETTLE debounce. A device opening duplicate/rapid sockets
          // must converge on ONE live connection and stay online, not churn through evictions
          // (the reconnect-throttle's 30s post-restart warm-up skips this — this does NOT).
          // If a LIVE incumbent exists and we accepted a socket for this device within the
          // settle window, soft-refuse THIS duplicate and keep the incumbent.
          // LIVENESS SAFEGUARD (load-bearing): only hold when the incumbent socket is actually
          // in the namespace — a dead/half-open incumbent is replaced below, NEVER stranding
          // the device offline. Soft refusal (paired-safe), never a quarantine.
          const priorConn = heartbeat.getConnection(device_id);
          const incumbentAlive = !!(priorConn && priorConn.socketId !== socket.id && deviceNs.sockets.has(priorConn.socketId));
          if (sessionSettle.shouldHold(device_id, incumbentAlive)) {
            logCoalescer.record(`settle:${device_id}`, `[settle] device ${device_id} keeping live incumbent ${priorConn.socketId}; soft-refusing duplicate ${socket.id}`);
            evictedSockets.add(socket.id);   // this refused socket's disconnect must NOT touch device state
            socket.emit('device:throttled', { retry_after_ms: config.sessionSettleWindowMs, reason: 'session_settle' });
            process.nextTick(() => { try { socket.disconnect(true); } catch (_) { evictedSockets.delete(socket.id); } });
            return;
          }

          currentDeviceId = device_id;
          authenticated = true;
          // Cancel any pending offline timer - device is back in the grace window
          if (pendingOfflines.has(device_id)) {
            clearTimeout(pendingOfflines.get(device_id));
            pendingOfflines.delete(device_id);
          }
          evictPriorSocket(device_id, socket.id);
          sessionSettle.accepted(device_id);   // #148 patch2: (re)arm the settle window on an accepted connection
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now'), offline_reason = NULL, offline_reason_at = NULL, offline_detail = NULL WHERE id = ?")
            .run(getClientIp(socket), device_id);

          // #143: past the validateDeviceToken gate above the stored token is
          // guaranteed non-null, so we just echo it back. The old "mint a token for a
          // null-token device" path is removed — that was the re-provisioning vector.
          const tokenToSend = device.device_token;

          if (device_info) applyDeviceInfo(device_id, device_info);

          heartbeat.registerConnection(device_id, socket.id);
          // #134: a same-socket re-register is a playlist REFRESH (~45-60s), NOT a reconnect and NOT
          // a new identity. Match the existing !isPlaylistRefresh gates (:486/:605): don't count it as
          // churn (A2 — else healthy refreshers cross DEGRADED_RECONNECTS and show Degraded) and don't
          // re-write identity (A1 — else a sync UPDATE + WAL churn every ~45-60s per device).
          if (!isPlaylistRefresh) {
            heartbeat.recordReconnect(device_id);     // genuine reconnect only
            persistIdentity(device_id, data);         // change-detected write (see persistIdentity)
          }
          socket.join(device_id);
          socket.emit('device:registered', { device_id, device_token: tokenToSend, status: 'online' });
          // #143: a device paired/claimed server-side (user_id set) that RECONNECTS must be told
          // it's paired — the app leaves the Connect page ONLY on 'device:paired' (web: hides the
          // setup screen; Android ProvisioningActivity.onPaired -> MainActivity). The
          // /api/provision/pair endpoint pushes device:paired to a LIVE socket at pair time
          // (server.js), but a screen paired while disconnected — or that reconnects after pairing
          // — never received it and sat on the Connect page forever showing the URL (Bold #143).
          // Re-send the exact event the client already listens for; no client change needed.
          if (device.user_id) {
            socket.emit('device:paired', { device_id, name: device.name || 'Display', settings_pin: device.settings_pin || undefined });
          }
          logDeviceStatus(device_id, 'online');
          // Flush any commands/playlist-updates queued while this device was offline.
          commandQueue.flushQueue(deviceNs, device_id, buildPlaylistPayload);

          // If this device is part of a wall, re-evaluate leadership.
          // Preferred leader = online member with smallest (canvas_x +
          // canvas_y), falling back to grid 0,0. If the original leader
          // (top-left tile) is back, they reclaim the role and peers re-sync.
          if (device.wall_id) {
            try {
              const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
              if (wall) {
                const candidates = db.prepare(`
                  SELECT vwd.device_id, vwd.canvas_x, vwd.canvas_y, vwd.grid_col, vwd.grid_row
                  FROM video_wall_devices vwd
                  JOIN devices d ON d.id = vwd.device_id
                  WHERE vwd.wall_id = ? AND d.status = 'online'
                `).all(wall.id);
                if (candidates.length > 0) {
                  const score = (c) => (c.canvas_x ?? c.grid_col * 320) + (c.canvas_y ?? c.grid_row * 180);
                  candidates.sort((a, b) => score(a) - score(b));
                  const preferredLeader = candidates[0].device_id;
                  if (wall.leader_device_id !== preferredLeader) {
                    db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(preferredLeader, wall.id);
                    console.log(`Wall ${wall.id} leader reassigned to ${preferredLeader} on reconnect`);
                    // Re-push payload to every member so role flags refresh.
                    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
                    for (const m of members) {
                      if (m.device_id !== device_id) {
                        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.device_id, buildPlaylistPayload);
                      }
                    }
                  }
                }
              }
            } catch (e) { console.error('Wall leader reclaim failed:', e.message); }
          }

          // #group-sync: on (re)connect of a sync-group member, re-push the payload to the OTHER
          // sync-eligible members so their is_leader flag refreshes — this self-heals leadership
          // when the pinned leader returns or a first-online fallback takes over. The effective
          // leader is COMPUTED (resolveGroupLeader), never persisted, so the operator's pin is
          // preserved. The connecting device gets its own payload below.
          try {
            const syncGroups = db.prepare(`
              SELECT g.id, g.sync_enabled, g.playlist_id FROM device_groups g
              JOIN device_group_members dgm ON dgm.group_id = g.id
              WHERE dgm.device_id = ? AND g.sync_enabled = 1 AND g.playlist_id IS NOT NULL
            `).all(device_id);
            for (const group of syncGroups) {
              for (const m of groupSyncMembers(group)) {
                if (m.id !== device_id) commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.id, buildPlaylistPayload);
              }
            }
          } catch (e) { console.error('Group sync re-push failed:', e.message); }

          // Check subscription/trial status before sending playlist
          const access = checkDeviceAccess(device_id);
          if (!access.allowed) {
            socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
          } else {
            socket.emit('device:playlist-update', buildPlaylistPayload(device_id));
          }

          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', { device_id, status: 'online' });
          // Only log a genuine reconnect (new socket). Same-socket periodic refreshes stay
          // quiet so the log reflects real connection events, not the 45s refresh cadence.
          if (!isPlaylistRefresh) logCoalescer.record('device-reconnected', `Device reconnected: ${device_id}`);
          return;
        }

        // Device ID not found in database - tell device to re-provision
        console.log(`Device ${device_id} not found in database, sending unpaired`);
        socket.emit('device:unpaired', { reason: 'not_found' });
        return;
      }

      if (pairing_code) {
        // New device registering with pairing code — generate a device_token
        const id = uuidv4();
        const newToken = generateDeviceToken();

        // #146 scale-hardening: a DB error on this INSERT must reject THIS device's
        // registration, never throw out of the handler. The likely error is a UNIQUE
        // pairing_code collision when many devices provision at once (client-supplied
        // 6-digit codes collide by birthday paradox), but ANY error counts. An
        // unhandled throw in a socket handler escalates to uncaughtException ->
        // logFatalAndExit -> the WHOLE server exits and every device drops — one
        // colliding code crash-looped the fleet in the load test. Catch it, log, and
        // tell just this device to retry. currentDeviceId/authenticated are set only
        // AFTER the row exists, so a failed insert leaves no half-authenticated socket.
        try {
          db.prepare(`
            INSERT INTO devices (id, pairing_code, device_token, status, ip_address, android_version, app_version, screen_width, screen_height, render_width, render_height, last_heartbeat)
            VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
          `).run(
            id, pairing_code, newToken, getClientIp(socket),
            device_info?.android_version || null,
            device_info?.app_version || null,
            device_info?.screen_width || null,
            device_info?.screen_height || null,
            device_info?.render_width || null,
            device_info?.render_height || null
          );
        } catch (e) {
          console.warn(`Provisioning rejected for pairing_code ${pairing_code} from ${getClientIp(socket)}: ${e.message}`);
          socket.emit('device:auth-error', { error: 'Registration failed, please retry.' });
          return;
        }
        currentDeviceId = id;
        authenticated = true;

        // #150: relink the fingerprint to the NEW device row (the fingerprint block above
        // leaves device_id NULL on a post-delete re-pair) so the settings key is reliable,
        // then restore any settings this physical device had at its last deletion —
        // orientation/name/playlist/etc come back automatically instead of resetting. Runs
        // BEFORE the dashboard:device-added emit below so that emit carries restored values.
        if (fingerprint) {
          try {
            db.prepare("INSERT INTO device_fingerprints (fingerprint, device_id, last_seen) VALUES (?, ?, strftime('%s','now')) ON CONFLICT(fingerprint) DO UPDATE SET device_id = excluded.device_id, last_seen = excluded.last_seen")
              .run(fingerprint, id);
            const restored = deviceSettings.applyToDevice(id, fingerprint);
            if (restored) console.log(`[#150] restored saved settings for re-paired device ${id} (fp ${fingerprint.slice(0, 8)}…)`);
          } catch (e) { console.warn(`[#150] settings restore failed for ${id}: ${e.message}`); }
        }

        heartbeat.registerConnection(id, socket.id);
        persistIdentity(id, data);   // FIX 3: capture v4 identity on first provision (degrades for old clients)
        socket.join(id);
        socket.emit('device:registered', { device_id: id, device_token: newToken, status: 'provisioning' });

        // Newly-provisioned devices have no workspace_id yet (they'll get one
        // on pair claim). emitToDeviceWorkspace silently drops when there's no
        // workspace; that's safer than the previous platform-wide broadcast.
        // Dashboards refresh /api/devices/unassigned on poll for the
        // platform_admin pairing view.
        emitToDeviceWorkspace(dashboardNs, id, 'dashboard:device-added', db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
        console.log(`New device registered: ${id} with pairing code: ${pairing_code}`);
      }
    });

    // Require authentication for all events after register
    function requireDeviceAuth() {
      if (!authenticated || !currentDeviceId) {
        socket.emit('device:auth-error', { error: 'Not authenticated. Send device:register first.' });
        return false;
      }
      return true;
    }

    // #160: lightweight device_info refresh (e.g. after a volume/brightness change) — updates the
    // reported fields WITHOUT a full re-register (no playlist re-push / no reconnect side effects).
    socket.on('device:info', (data) => {
      if (!requireDeviceAuth()) return;
      const di = data && data.device_info;
      if (di) { try { applyDeviceInfo(currentDeviceId, di); } catch (e) { /* never crash the socket on a bad info blob */ } }
    });

    // Heartbeat with telemetry
    socket.on('device:heartbeat', (data) => {
      const { device_id, telemetry } = data || {};
      // v4 PRIMARY + FIX 1 — UNIFORM ACK. Emitted from THIS single shared handler for every client
      // type (APK / .wgt / /player hit the same handler = uniform by construction), and BEFORE the
      // auth guard so a KNOWN device's watchdog stays armed even mid-reconnect (before this socket
      // finishes re-registering). Anonymous / never-authenticated sockets are NOT acked (degrade-safe
      // covers them). Old clients simply ignore the ack — harmless.
      if (liveness.ackableHeartbeat(currentDeviceId, device_id, deviceExists)) {
        // #group-sync clock discipline: the server is the time authority. Echo the client's send
        // time (t1) and stamp the server's clock (t2≈t3, synchronous handler) so the client can do
        // NTP-style offset+RTT correction: offset = server_ms - (t1 + t4)/2. The offset is CACHED by
        // the client and used at play-time (local + offset), so schedule-based group sync keeps
        // working through an internet outage. Absent/old clients just ignore the extra fields.
        socket.emit('device:heartbeat-ack', { server_ms: Date.now(), client_ms: data?.client_ms ?? null });
      }
      if (!requireDeviceAuth()) return;
      if (!device_id || device_id !== currentDeviceId) return;

      currentDeviceId = device_id;
      heartbeat.updateHeartbeat(device_id);

      db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), updated_at = strftime('%s','now') WHERE id = ?")
        .run(device_id);

      if (telemetry) {
        db.prepare(`
          INSERT INTO device_telemetry (device_id, battery_level, battery_charging, storage_free_mb, storage_total_mb,
            ram_free_mb, ram_total_mb, cpu_usage, wifi_ssid, wifi_rssi, uptime_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          device_id,
          telemetry.battery_level ?? null,
          telemetry.battery_charging ? 1 : 0,
          telemetry.storage_free_mb ?? null,
          telemetry.storage_total_mb ?? null,
          telemetry.ram_free_mb ?? null,
          telemetry.ram_total_mb ?? null,
          telemetry.cpu_usage ?? null,
          telemetry.wifi_ssid ?? null,
          telemetry.wifi_rssi ?? null,
          telemetry.uptime_seconds ?? null
        );
        pruneTelemetry(device_id);

        // #74/#75: capture the player's reported clock (OS IANA zone + its UTC time)
        // for effective-timezone resolution and the dashboard clock-skew indicator.
        if (telemetry.timezone || telemetry.device_utc != null) {
          db.prepare("UPDATE devices SET reported_timezone = COALESCE(?, reported_timezone), reported_utc = ?, reported_at = strftime('%s','now') WHERE id = ?")
            .run(telemetry.timezone || null, telemetry.device_utc ?? null, device_id);
        }

        emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', {
          device_id,
          status: 'online',
          liveness: heartbeat.livenessFor(device_id), // FIX 2: server-derived 3-state (healthy/degraded/offline)
          telemetry
        });
      }
    });

    // Screenshot received from device - relay via WebSocket, keep latest in memory
    socket.on('device:screenshot', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, image_b64 } = data;
      if (!device_id || device_id !== currentDeviceId || !image_b64) return;
      // Validate screenshot size (max 2MB base64 ≈ 1.5MB image)
      if (image_b64.length > 2 * 1024 * 1024) return;

      // Store latest screenshot in memory (for Now Playing preview and offline snapshot)
      if (!lastScreenshots) lastScreenshots = {};
      lastScreenshots[device_id] = image_b64;

      // Relay directly to dashboard - no disk write
      try {
        emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:screenshot-ready', {
          device_id,
          image_data: `data:image/jpeg;base64,${image_b64}`,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('Screenshot save error:', err);
      }
    });

    // #161 device-owner tooling: relay a remote-shell result back to the operator's dashboard.
    socket.on('device:shell-result', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, cmd, output, exit } = data || {};
      if (!device_id || device_id !== currentDeviceId) return;
      emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:shell-result', {
        device_id, cmd: String(cmd || '').slice(0, 500), output: String(output || '').slice(0, 8000), exit,
      });
    });

    // Content download acknowledgement
    socket.on('device:content-ack', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, content_id, status } = data;
      if (device_id !== currentDeviceId) return;
      // #142 dedup + #143 per-device rate budget + global critical-lag valve, in one
      // control. Anything but 'pass' is dropped BEFORE the log+emit (that per-ack work
      // is the cost we shed). Drops are SILENT except a single line per device per
      // window when rate-shedding STARTS (re-logging per drop would recreate the
      // flood). The valve's open/close is logged once at the band edge in loop-lag.
      const verdict = contentAckLimiter.check(device_id, content_id, status, loopLag.getBand());
      if (verdict.action !== 'pass') {
        if (verdict.action === 'shed-rate' && verdict.logStart) {
          console.warn(`[content-ack] shedding device ${device_id}: ${verdict.observed}/${verdict.budget} per ${config.contentAckRateWindowMs}ms — flood control engaged`);
        }
        return;
      }
      console.log(`Device ${device_id} content ${content_id}: ${status}`);
      emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:content-ack', { device_id, content_id, status });
    });

    // Playback state update
    socket.on('device:playback-state', (data) => {
      if (!requireDeviceAuth()) return;
      // currentDeviceId is the authenticated device for this socket; use it
      // for the workspace lookup since data may not carry device_id consistently.
      emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:playback-state', data);
    });

    // Live debug log line from the player (only sent when debug logging is toggled
    // on for this device). Relayed to the device's workspace dashboard room so the
    // open device-detail screen can stream it. Not persisted.
    socket.on('device:log', (data) => {
      if (!requireDeviceAuth() || !currentDeviceId) return;
      const message = typeof data?.message === 'string' ? data.message.slice(0, 2000) : '';
      if (!message) return;
      emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:device-log', {
        device_id: currentDeviceId,
        tag: typeof data?.tag === 'string' ? data.tag.slice(0, 64) : '',
        level: typeof data?.level === 'string' ? data.level.slice(0, 8) : 'd',
        message,
        ts: Date.now(),
      });
    });

    // #139 Phase 2 (Option B): event-driven OTA status. The device announces a status TRANSITION
    // ('manual_update_required' on enter-backoff, 'none' on clear) so the dashboard badge updates
    // promptly without waiting for a reconnect. The register path still persists these fields too
    // (the reconnect backstop if a transition event is missed). Same columns + ?? defaults.
    socket.on('device:ota-status', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, ota_status, ota_target_version, ota_attempts } = data || {};
      // Unknown / forged / mismatched id -> no-op. WHERE id = ? also makes an unregistered id a
      // 0-row update (never throws), so a stray event can't error the socket.
      if (!device_id || device_id !== currentDeviceId) return;
      db.prepare("UPDATE devices SET ota_status = ?, ota_target_version = ?, ota_attempts = ?, ota_updated_at = strftime('%s','now') WHERE id = ?")
        .run(ota_status ?? 'none', ota_target_version ?? null, ota_attempts ?? 0, device_id);
    });

    // Exit-signal contract v1 — the device's best-effort "last gasp": it announces its manner of death
    // (crashed | clean_exit) as (usually) its final act. We record it; when the device then goes Offline
    // the annotation is applied (else 'silent'). ADDITIVE — never touches offline detection. Cleared on
    // (re)online (the register UPDATEs) so a stale reason can't mislabel a later death. The same canonical
    // shape also arrives via the beacon POST /api/device/exit for reliable-on-unload delivery.
    socket.on('device:exit', (data) => {
      if (!requireDeviceAuth() || !currentDeviceId) return;
      const { device_id, reason, detail } = data || {};
      if (device_id && device_id !== currentDeviceId) return;                 // forged/mismatched -> no-op
      const e = liveness.sanitizeExitReason(reason, detail);                  // unknown -> null -> falls to 'silent'
      if (!e) return;
      db.prepare("UPDATE devices SET offline_reason = ?, offline_reason_at = strftime('%s','now'), offline_detail = ? WHERE id = ?")
        .run(e.reason, e.detail, currentDeviceId);
    });

    // Offline-cause log: a typed incident from the player (display_off/display_on, crash,
    // app_error, ...). Just records a device_events row. Guarded by requireDeviceAuth like
    // every other device event; unknown/forged types are dropped (never inserted).
    socket.on('device:event', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, type, reason, detail } = data || {};
      if (device_id && device_id !== currentDeviceId) return;          // forged/mismatched -> no-op
      if (!incidentClassify.isAllowedEventType(type)) return;          // unknown type -> ignore
      try {
        db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, ?, ?, ?)")
          .run(currentDeviceId, type, reason ? String(reason).slice(0, 64) : null, detail ? String(detail).slice(0, 500) : null);
      } catch (_) { /* incident feed is best-effort; never crash the socket */ }
    });

    // Offline-cause log: the device's ground-truth account of an in-process disconnect it
    // just recovered from (app SURVIVED the gap -> not a reboot unless cold_start). Compose
    // reason+detail per the contract, then UPGRADE the server's earlier guess: flush the
    // status-log writer so the offline row exists, UPDATE that recent offline row's
    // reason/detail, and add a device_events row (type network|reboot).
    socket.on('device:connectivity-report', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id } = data || {};
      if (device_id && device_id !== currentDeviceId) return;          // forged/mismatched -> no-op
      const deviceId = currentDeviceId;
      try {
        const { reason, detail, type } = incidentClassify.classifyConnectivity(data);
        // Ensure any buffered offline transition for this device is on disk before we
        // reach back to annotate it (the writer coalesces on a ~1s interval otherwise).
        statusLogWriter.flushNow();
        // Upgrade the most-recent offline row (server guess) to the device's ground truth.
        db.prepare(`UPDATE device_status_log SET reason = ?, detail = ?
          WHERE id = (
            SELECT id FROM device_status_log
            WHERE device_id = ? AND status IN ('offline','offline_timeout')
              AND timestamp > strftime('%s','now') - 900
            ORDER BY timestamp DESC, id DESC LIMIT 1)`).run(reason, detail, deviceId);
        db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, ?, ?, ?)")
          .run(deviceId, type, reason, detail);
      } catch (_) { /* offline-cause annotation is best-effort; never crash the socket */ }
    });

    // Play event logging (proof-of-play)
    socket.on('device:play-event', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, event, content_id, content_name, zone_id, completed, duration_sec } = data;
      if (device_id !== currentDeviceId) return;
      try {
        if (event === 'play_start') {
          // Throttle proof-of-play inserts per device so a runaway player
          // (0-second items) can't flood play_logs. Skipped cycles simply
          // don't create a row; the dashboard progress event below still fires.
          const nowMs = Date.now();
          const lastMs = lastPlayLogAt.get(device_id) || 0;
          if (nowMs - lastMs >= PLAY_LOG_MIN_GAP_MS) {
            lastPlayLogAt.set(device_id, nowMs);
            db.prepare(`
              INSERT INTO play_logs (device_id, content_id, zone_id, content_name, started_at, trigger_type)
              VALUES (?, ?, ?, ?, strftime('%s','now'), 'playlist')
            `).run(device_id, content_id || null, zone_id || null, content_name || 'Unknown');
          }
          // Forward to dashboard so it can render a per-device progress bar.
          // Server-side timestamp avoids clock-skew between player and dashboard.
          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:playback-progress', {
            device_id,
            content_id: content_id || null,
            content_name: content_name || null,
            duration_sec: typeof duration_sec === 'number' && duration_sec > 0 ? duration_sec : null,
            started_at: Date.now(),
          });
        } else if (event === 'play_end') {
          db.prepare(`
            UPDATE play_logs SET ended_at = strftime('%s','now'),
              duration_sec = strftime('%s','now') - started_at,
              completed = ?
            WHERE id = (
              SELECT id FROM play_logs WHERE device_id = ? AND content_id = ? AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1
            )
          `).run(completed ? 1 : 0, device_id, content_id);
        }
      } catch (err) {
        console.error('Play log error:', err.message);
      }
    });

    // Video wall sync relay. Sender must be a member of the wall it claims —
    // otherwise an authenticated device could inject sync packets into a wall
    // it doesn't belong to (jitter/DoS that wall's playback). Exclusion uses
    // currentDeviceId, never the client-supplied data.device_id.
    socket.on('wall:sync', (data) => {
      if (!requireDeviceAuth()) return;
      if (!data?.wall_id) return;
      const isMember = db.prepare(
        'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
      ).get(data.wall_id, currentDeviceId);
      if (!isMember) return;
      const wallDevices = db.prepare(
        'SELECT device_id FROM video_wall_devices WHERE wall_id = ? AND device_id != ?'
      ).all(data.wall_id, currentDeviceId);
      // Stamp device_id with the authenticated id so followers can trust it.
      const payload = { ...data, device_id: currentDeviceId };
      for (const wd of wallDevices) {
        deviceNs.to(wd.device_id).emit('wall:sync', payload);
      }
    });

    // A follower asks for an immediate position update from the leader.
    // Used on (re)connect so the follower doesn't drift for ~1s waiting on
    // the next periodic wall:sync tick. Server forwards only to the leader,
    // and only when the requester is actually a member of the named wall.
    socket.on('wall:sync-request', (data) => {
      if (!requireDeviceAuth()) return;
      if (!data?.wall_id) return;
      const isMember = db.prepare(
        'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
      ).get(data.wall_id, currentDeviceId);
      if (!isMember) return;
      const wall = db.prepare('SELECT leader_device_id FROM video_walls WHERE id = ?').get(data.wall_id);
      if (!wall?.leader_device_id || wall.leader_device_id === currentDeviceId) return;
      deviceNs.to(wall.leader_device_id).emit('wall:sync-request', {
        wall_id: data.wall_id,
        requested_by: currentDeviceId,
      });
    });

    // #group-sync: leader broadcasts its index+position; relay to the OTHER sync-eligible members
    // (same group_id AND on the group's shared playlist — the playlist-match guard). Mirrors
    // wall:sync. The device_id is stamped with the authenticated id so followers can trust it.
    // Sender must be an eligible member: in the group (m2m) AND on the group's shared playlist.
    function groupSenderEligible(group) {
      if (!group || !group.sync_enabled || !group.playlist_id) return false;
      return !!db.prepare(`
        SELECT 1 FROM device_group_members dgm JOIN devices d ON d.id = dgm.device_id
        WHERE dgm.group_id = ? AND dgm.device_id = ? AND d.playlist_id = ?
      `).get(group.id, currentDeviceId, group.playlist_id);
    }

    socket.on('group:sync', (data) => {
      if (!requireDeviceAuth()) return;
      if (!data?.group_id) return;
      const group = db.prepare('SELECT id, sync_enabled, playlist_id FROM device_groups WHERE id = ?').get(data.group_id);
      if (!groupSenderEligible(group)) return;
      const payload = { ...data, device_id: currentDeviceId };
      for (const m of groupSyncMembers(group)) {
        if (m.id !== currentDeviceId) deviceNs.to(m.id).emit('group:sync', payload);
      }
    });

    // A follower asks the current leader for an immediate position update (on (re)connect, so it
    // doesn't drift a tick). Forwarded only to the group's elected leader, only from an eligible member.
    socket.on('group:sync-request', (data) => {
      if (!requireDeviceAuth()) return;
      if (!data?.group_id) return;
      const group = db.prepare('SELECT id, sync_enabled, playlist_id, leader_device_id FROM device_groups WHERE id = ?').get(data.group_id);
      if (!groupSenderEligible(group)) return;
      const leaderId = resolveGroupLeader(group);
      if (!leaderId || leaderId === currentDeviceId) return;
      deviceNs.to(leaderId).emit('group:sync-request', { group_id: group.id, requested_by: currentDeviceId });
    });

    socket.on('disconnect', (reason) => {
      // Offline-cause log: capture socket.io's disconnect reason (transport_close /
      // ping_timeout / transport_error / ...) and normalize it to a category token now,
      // while it's in scope; the offline transition below (deferred by the debounce
      // timer) uses it as the fallback offline reason when the device sent no explicit
      // exit signal this session. Falls back to 'silent' when absent.
      const socketOfflineReason = incidentClassify.normalizeDisconnectReason(reason);
      // #146: this socket was force-evicted by a newer registration for the same
      // device. The new socket owns the device now (or is mid-register), so this
      // disconnect must NOT arm an offline timer — doing so was the self-reset race
      // that re-marked just-reconnected devices offline. The map-based stale guard
      // below can't catch it because eviction runs before the new socket is in the
      // map. Drain the flag and bail. (delete() returns true iff it was present.)
      if (evictedSockets.delete(socket.id)) return;

      if (!currentDeviceId) return;

      // Stale-disconnect guard: a newer socket already took over this device_id
      // via eviction. Skip the offline transition entirely - don't even start a
      // debounce timer.
      const activeConn = heartbeat.getConnection(currentDeviceId);
      if (activeConn && activeConn.socketId !== socket.id) {
        console.log(`Stale disconnect for ${currentDeviceId} (socket ${socket.id}); active is ${activeConn.socketId}, skipping offline`);
        return;
      }

      const deviceId = currentDeviceId;
      const closingSocketId = socket.id;
      console.log(`Device disconnected: ${deviceId} (offline transition deferred ${OFFLINE_DEBOUNCE_MS}ms)`);

      // Defensive: clear any existing timer for this device. Shouldn't happen
      // (register would have cleared it), but if two disconnects fire in
      // sequence we want the second to refresh the window, not double up.
      if (pendingOfflines.has(deviceId)) clearTimeout(pendingOfflines.get(deviceId));

      pendingOfflines.set(deviceId, setTimeout(() => {
        pendingOfflines.delete(deviceId);
        // Re-check at fire time: did a DIFFERENT socket reclaim during the
        // grace window? If activeConn exists but it's still our (now-closed)
        // socket's entry, the entry is just stale - heartbeat.removeConnection
        // hasn't run yet because we defer it inside this same block. Only
        // abort if a genuinely different socket has registered.
        const activeNow = heartbeat.getConnection(deviceId);
        if (activeNow && activeNow.socketId !== closingSocketId) return;

        // Exit-signal contract (UNCHANGED): devices.offline_reason stays the app's self-reported
        // manner-of-death — 'crashed'/'clean_exit' if it announced one this session, else 'silent'
        // (a violent/abrupt death is 'silent', never a socket-inferred value — Bold-critical).
        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now'), offline_reason = COALESCE(offline_reason, 'silent'), offline_reason_at = COALESCE(offline_reason_at, strftime('%s','now')) WHERE id = ?").run(deviceId);
        heartbeat.removeConnection(deviceId);
        const _off = db.prepare("SELECT offline_reason, offline_detail, client_type FROM devices WHERE id = ?").get(deviceId) || {};
        // The offline-CAUSE log (device_status_log + device_events) gets the richer signal, which is
        // a SEPARATE axis from the exit-signal field: the app's announced reason if it gave one, else
        // the normalized socket transport reason (transport_close/ping_timeout/...). This never touches
        // devices.offline_reason, so the exit-signal 'silent' semantics above are preserved.
        const finalReason = (_off.offline_reason && _off.offline_reason !== 'silent') ? _off.offline_reason : socketOfflineReason;
        logDeviceStatus(deviceId, 'offline', finalReason, null);
        // Offline-cause log: also record the transition in the unified incident feed.
        try { db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, 'offline', ?, NULL)").run(deviceId, finalReason); } catch (_) { /* incident feed is best-effort */ }
        emitToDeviceWorkspace(dashboardNs, deviceId, 'dashboard:device-status', { device_id: deviceId, status: 'offline', liveness: 'offline', offline_reason: _off.offline_reason || 'silent', offline_detail: _off.offline_detail || null, client_type: _off.client_type || null });

        // If this device was leading a wall, reassign leadership to the next
        // online member so playback stays driven.
        try {
          const wall = db.prepare('SELECT id FROM video_walls WHERE leader_device_id = ?').get(deviceId);
          if (wall) {
            const candidates = db.prepare(`
              SELECT vwd.device_id FROM video_wall_devices vwd
              JOIN devices d ON d.id = vwd.device_id
              WHERE vwd.wall_id = ? AND d.status = 'online' AND vwd.device_id != ?
              ORDER BY vwd.grid_row, vwd.grid_col LIMIT 1
            `).all(wall.id, deviceId);
            const newLeader = candidates[0]?.device_id || null;
            db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(newLeader, wall.id);
            const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
            for (const m of members) {
              if (m.device_id !== deviceId) {
                commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.device_id, buildPlaylistPayload);
              }
            }
          }
        } catch (e) { console.error('Wall leader reassign failed:', e.message); }

        // Save last screenshot to disk as offline snapshot
        const lastB64 = lastScreenshots[deviceId];
        if (lastB64) {
          try {
            const filename = `${deviceId}_latest.jpg`;
            const buffer = Buffer.from(lastB64, 'base64');
            fs.writeFileSync(path.join(config.screenshotsDir, filename), buffer);
            const existing = db.prepare('SELECT id FROM screenshots WHERE device_id = ?').get(deviceId);
            if (existing) {
              db.prepare('UPDATE screenshots SET filepath = ?, captured_at = strftime(\'%s\',\'now\') WHERE device_id = ?').run(filename, deviceId);
            } else {
              db.prepare('INSERT INTO screenshots (device_id, filepath) VALUES (?, ?)').run(deviceId, filename);
            }
          } catch (e) {
            console.error('Failed to save offline screenshot:', e.message);
          }
          delete lastScreenshots[deviceId];
        }
      }, OFFLINE_DEBOUNCE_MS));
    });
  });

  return deviceNs;
};

// #146 test hooks — read-only views of the internal offline-timer / eviction state,
// so the cause-1 re-arm race (evicted socket arming an offline timer for a
// just-reconnected device) is test-PROVEN, not just correct-by-construction. Prefixed
// `__` and never used by production code.
module.exports.__hasPendingOffline = (deviceId) => pendingOfflines.has(deviceId);
module.exports.__pendingOfflineCount = () => pendingOfflines.size;
module.exports.__evictedSize = () => evictedSockets.size;
module.exports.__resetTimers = () => {
  for (const t of pendingOfflines.values()) clearTimeout(t);
  pendingOfflines.clear();
  evictedSockets.clear();
};
