const heartbeat = require('../services/heartbeat');
const { resolveSessionUser } = require('../middleware/auth');
const { db } = require('../db/database');
const { accessContext, accessibleWorkspaceIds } = require('../lib/tenancy');
const { workspaceRoom } = require('../lib/socket-rooms');
const { protectSocket } = require('../lib/safe-socket');
const playerCapabilities = require('../lib/player-capabilities');
const { deliverCommand, validateCommand } = require('../lib/device-command');
const bsSnapshotQueue = require('../lib/brightsign-snapshot-queue');
// Server-side framebuffer capture, for a BrightSign whose player cannot capture itself.
const bsCapture = require('../lib/brightsign-capture');
const bsDeviceSocketRef = require('./deviceSocket');
const go2rtc = require('../lib/go2rtc');
const orgWebrtc = require('../lib/org-webrtc');   // #talk: per-org talk flag + ICE override
const appConfig = require('../config');

// Phase 2.3: workspace-scoped socket rooms + per-command permission gates.
// Replaces the previous flat dashboardNs.emit broadcast (which leaked every
// device's status/screenshot/playback events to every connected dashboard)
// and the legacy admin/superadmin role bypass (dead code post-Phase-1
// rename - admin -> user, superadmin -> platform_admin).
//
// On connect: enumerate the user's accessible workspace_ids and socket.join
// a room per workspace. Outbound broadcasts route via dashboardNs.to(room).
// Inbound commands check permission against the target device's workspace.

// Permission gate for inbound socket commands. Read tier = workspace_viewer+;
// write tier = workspace_editor+. Platform_admin and org_owner/admin always
// pass via actingAs.
function canActOnDevice(socket, deviceId, tier /* 'read' | 'write' */) {
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.workspace_id) return false;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  if (!ws) return false;
  const ctx = accessContext(socket.userId, socket.userRole, ws);
  if (!ctx) return false;
  if (ctx.actingAs) return true; // platform_admin or org admin
  if (tier === 'read') return !!ctx.workspaceRole; // viewer/editor/admin all OK
  // write tier: workspace_editor or workspace_admin
  return ctx.workspaceRole === 'workspace_editor' || ctx.workspaceRole === 'workspace_admin';
}

module.exports = function setupDashboardSocket(io) {
  const dashboardNs = io.of('/dashboard');
  const deviceNs = io.of('/device');

  dashboardNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    let session;
    try {
      // Same resolver as requireAuth, so the socket inherits the pre-TOTP refusal and the
      // forced-password-change gate that the HTTP surface enforces.
      session = resolveSessionUser(token);
    } catch (err) {
      if (err.code === 'mfa_required') return next(new Error('mfa_required'));
      if (err.code === 'password_change_required') return next(new Error('password_change_required'));
      return next(new Error('Invalid token'));
    }
    // Break-glass identities have no users row and no workspace membership, so
    // canActOnDevice -> accessContext already denied them every command. Refuse the
    // handshake rather than hold open a socket that can do nothing.
    if (session.viaRecovery) return next(new Error('Invalid token'));
    socket.userId = session.user.id;
    // Role + existence come from the LIVE users row, not the token claim: a deleted or
    // demoted user no longer keeps fleet control for the remainder of a 7-day JWT.
    socket.userRole = session.user.role;
    next();
  });

  dashboardNs.on('connection', (socket) => {
    // #146: same per-connection fail-fast as the device namespace — a throwing
    // dashboard handler disconnects only that client, never crashes the server.
    protectSocket(socket, () => socket.userId);
    // Note on workspace-switch lifecycle: the switcher (Phase 3 MVP) calls
    // window.location.reload() after switching, which forces a new socket
    // connection with fresh JWT claims. So workspace memberships are
    // re-evaluated at connect time and we don't need to re-evaluate per-emit.
    const wsIds = accessibleWorkspaceIds(socket.userId, socket.userRole);
    for (const wsId of wsIds) socket.join(workspaceRoom(wsId));
    console.log(`Dashboard client connected: ${socket.id} (user: ${socket.userId}, rooms: ${wsIds.length})`);

    /*
     * The capability gate for the remote-view handlers.
     *
     * dashboard:device-command below has always checked this; these four did not, and the
     * reasoning that justifies it there applies here word for word — this socket is reachable
     * directly, and a dashboard tab left open still renders the controls the panel had when the
     * page was drawn. Measured: a display declaring `[]` still received screenshot-request,
     * remote-touch, remote-key and remote-start, silently, and the operator got a toast saying
     * the screenshot was on its way.
     *
     * The ack is OPTIONAL by design: the current dashboard senders (frontend/js/socket.js) pass
     * no callback, and a newer one that does gets told which capability is missing instead of
     * watching a spinner. Refusing loudly is the whole point of the mechanism.
     */
    // Silent by design, unlike the command path: the fleet view asks EVERY visible card for a
    // screenshot every 30s, so a log line per refusal would be hundreds every half-minute on a
    // real fleet. The ack carries the reason to anyone who asked for one.
    function capabilityRefused(device_id, cap, ack) {
      const devRow = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
      if (playerCapabilities.supports(devRow, cap)) return false;
      if (typeof ack === 'function') ack({ delivered: false, reason: 'unsupported', capability: cap });
      return true;
    }

    socket.on('dashboard:request-screenshot', (data, ack) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'read')) return;
      if (capabilityRefused(device_id, 'remote.screenshot', ack)) return;
      const conn = heartbeat.getConnection(device_id);
      if (conn) deviceNs.to(device_id).emit('device:screenshot-request', {});
      // BrightSign additionally leaves the request where its HOST can collect it. The page there
      // can capture only the graphics plane — video lives on a hardware plane the DOM cannot read —
      // and it cannot forward the request to the host either, because page->host messaging is dead
      // after load on that platform. So the host polls for this over HTTP, the one direction that
      // works. See lib/brightsign-snapshot-queue.js.
      try {
        const row = db.prepare('SELECT platform, ip_address FROM devices WHERE id = ?').get(device_id);

        /*
         * ⚠️ THIS GATE HAS NEVER MATCHED A REAL BRIGHTSIGN, and that is worth knowing before
         * trusting it. A BrightSign runs the web player inside a Chromium widget, so it reports
         * `platform = "Chrome 148"` — not "brightsign". Verified on an XT245. So the queue below
         * has never been populated for any BrightSign, on either build shape. It is left as-is
         * rather than widened because nothing collects that queue either (neither autorun polls
         * the two endpoints built for it), so changing it would swap one inert path for another.
         * Fix the collector and this gate together, or delete both.
         */
        if (row && String(row.platform || '').toLowerCase() === 'brightsign') {
          bsSnapshotQueue.request(device_id, { width: 960, height: 540 });
        }

        /*
         * ⚠️ CAPTURE FROM THIS PROCESS, GATED ON WHAT WE CAN ACTUALLY DO — not on what the device
         * calls itself. `bsCapture.available()` is true only when THIS server can load
         * @brightsign/screenshot, which is exactly the condition under which capturing here is
         * possible; a self-reported browser string is neither necessary nor sufficient, as the
         * "Chrome 148" above proves.
         *
         * ⚠️ AND ONLY FOR A DEVICE ON THIS BOARD. We capture OUR framebuffer, so sending it for a
         * device somewhere else would be a picture of the wrong screen, labelled convincingly. On a
         * server-on-a-player the local player connects over loopback, which is the one property
         * that actually distinguishes it from a mesh child or a panel across the room.
         *
         * Why this is needed at all: that build creates its widget WITHOUT nodejs_enabled, so the
         * page has no `require` and cannot capture; and brightsign/server/autorun.brs has no
         * snapshot code, so the host cannot either. Best-effort and additive — if another path does
         * answer, the newest frame simply wins.
         */
        if (bsCapture.isLoopback(row && row.ip_address) && bsCapture.available()) {
          bsCapture.capture({ width: 960, height: 540 })
            .then((b64) => { if (b64) bsDeviceSocketRef.ingestScreenshot(device_id, b64); })
            .catch(() => { /* a capture that fails is a missing picture, never an error path */ });
        }
      } catch (e) { /* the socket path already fired; queueing is the bonus, never the blocker */ }
      if (typeof ack === 'function') ack({ delivered: !!conn, reason: conn ? undefined : 'offline' });
    });

    socket.on('dashboard:remote-touch', (data, ack) => {
      const { device_id, x, y, x2, y2, duration, action } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      if (capabilityRefused(device_id, 'remote.input', ack)) return;
      // #159: a swipe/drag carries an end point + duration (for scrolling); tap is just x/y.
      deviceNs.to(device_id).emit('device:remote-touch', { x, y, x2, y2, duration, action });
      if (typeof ack === 'function') ack({ delivered: true });
    });

    socket.on('dashboard:remote-key', (data, ack) => {
      const { device_id, keycode } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      if (capabilityRefused(device_id, 'remote.input', ack)) return;
      console.log(`Remote key: ${keycode} -> ${device_id}`);
      deviceNs.to(device_id).emit('device:remote-key', { keycode });
      if (typeof ack === 'function') ack({ delivered: true });
    });

    // Track which devices THIS dashboard socket has a live remote (screenshot-stream) session on, so
    // we can stop them if the tab closes / the socket drops — an orphaned stream keeps the device
    // capturing every second and can starve a weak panel's decoder (the black-screen we hit).
    socket.remoteSessions = new Set();

    socket.on('dashboard:remote-start', (data, ack) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      if (capabilityRefused(device_id, 'remote.stream', ack)) return;
      const room = deviceNs.adapter.rooms.get(device_id);
      console.log(`Remote start for ${device_id}, room has ${room?.size || 0} socket(s)`);
      socket.remoteSessions.add(device_id);
      deviceNs.to(device_id).emit('device:remote-start', {});
      console.log(`Remote session started for device ${device_id}`);
    });

    // Deliberately NOT capability-gated, for the same reason set_debug isn't: stopping is the
    // thing you need most when a panel's declaration has changed underneath a live stream, and
    // refusing it would strand that panel capturing forever.
    socket.on('dashboard:remote-stop', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      socket.remoteSessions.delete(device_id);
      deviceNs.to(device_id).emit('device:remote-stop', {});
      console.log(`Remote session stopped for device ${device_id}`);
    });

    // #talk: two-way voice intercom. Ask a player to join (subscribe the downlink + publish its mic
    // to the uplink); the operator side runs in the browser. Write-gated and remote.talk-gated like
    // remote control (it plays audio out of the device and opens its mic), and only relayed when the
    // live-video gate is on and a sidecar is up — talk rides the same go2rtc path. The audio itself
    // never touches this socket; it flows device<->go2rtc<->dashboard over WebRTC.
    socket.on('dashboard:talk-start', (data, ack) => {
      const { device_id } = data || {};
      const duplex = !!(data && data.duplex);   // true = 2-way (device also sends its mic)
      if (!canActOnDevice(socket, device_id, 'write')) return;
      // One-way Talk needs only remote.talk (play). Two-way additionally needs remote.mic (a device
      // microphone) — the dashboard only shows the 2-way control for a device that has one.
      if (capabilityRefused(device_id, 'remote.talk', ack)) return;
      if (duplex && capabilityRefused(device_id, 'remote.mic', ack)) return;
      const on = orgWebrtc.talkEnabledForDevice(device_id);
      if (!on || !go2rtc.enabled()) { if (typeof ack === 'function') ack({ delivered: false, reason: 'talk_unavailable' }); return; }
      const conn = heartbeat.getConnection(device_id);
      deviceNs.to(device_id).emit('device:talk-start', { mode: 'device', duplex, iceServers: orgWebrtc.iceServersForDevice(device_id) });
      if (typeof ack === 'function') ack({ delivered: !!conn, reason: conn ? undefined : 'offline' });
    });

    // Stopping is never capability-gated (same reasoning as remote-stop): a stuck talk session must
    // always be closable. Tears down the device's audio and drops the go2rtc talk streams.
    socket.on('dashboard:talk-stop', (data) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:talk-stop', {});
      try {
        const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(device_id);
        if (d && d.workspace_id) {
          for (const dir of ['dn', 'up']) { const nm = go2rtc.talkStreamName(d.workspace_id, device_id, dir); if (nm) go2rtc.deleteStream(nm); }
        }
      } catch (_) { /* cleanup is never load-bearing */ }
    });

    // #talk broadcast (one-way PA): tell every device in a group/workspace to LISTEN to the shared
    // channel. The operator's mic is published to that channel over HTTP (routes in device-groups /
    // workspaces); this only fans the listen request out to the devices. Each device is filtered by
    // the SAME gates as a per-device talk (write access + remote.talk + its own live-video flags),
    // so a broadcast never makes a device play audio it is not individually cleared for.
    function scopeDevices(kind, id) {
      try {
        if (kind === 'group') {
          return db.prepare(`SELECT d.id, d.workspace_id, d.live_video_enabled FROM devices d
                             JOIN device_group_members dgm ON dgm.device_id = d.id WHERE dgm.group_id = ?`).all(id);
        }
        if (kind === 'workspace') {
          return db.prepare('SELECT id, workspace_id, live_video_enabled FROM devices WHERE workspace_id = ?').all(id);
        }
      } catch (_) {}
      return [];
    }

    socket.on('dashboard:group-talk-start', (data, ack) => {
      const kind = data && data.scope && data.scope.kind;
      const id = data && data.scope && data.scope.id;
      if ((kind !== 'group' && kind !== 'workspace') || !id) { if (typeof ack === 'function') ack({ delivered: false, reason: 'bad_scope' }); return; }
      if (!go2rtc.enabled()) { if (typeof ack === 'function') ack({ delivered: false, reason: 'talk_unavailable' }); return; }
      let sent = 0, skipped = 0;
      for (const d of scopeDevices(kind, id)) {
        // write access to this device, the device declares remote.talk, and live video is on for it
        // at both workspace and device level.
        if (!canActOnDevice(socket, d.id, 'write')) { skipped++; continue; }
        const devRow = db.prepare('SELECT * FROM devices WHERE id = ?').get(d.id);
        if (!playerCapabilities.supports(devRow, 'remote.talk')) { skipped++; continue; }
        if (!orgWebrtc.talkEnabledForDevice(d.id)) { skipped++; continue; }
        deviceNs.to(d.id).emit('device:talk-start', { mode: 'listen', scope: { kind, id }, iceServers: orgWebrtc.iceServersForDevice(d.id) });
        sent++;
      }
      if (typeof ack === 'function') ack({ delivered: sent > 0, sent, skipped });
    });

    socket.on('dashboard:group-talk-stop', (data) => {
      const kind = data && data.scope && data.scope.kind;
      const id = data && data.scope && data.scope.id;
      if ((kind !== 'group' && kind !== 'workspace') || !id) return;
      for (const d of scopeDevices(kind, id)) {
        if (canActOnDevice(socket, d.id, 'write')) deviceNs.to(d.id).emit('device:talk-stop', {});
      }
      try { const nm = go2rtc.broadcastTalkStreamName(kind, id); if (nm) go2rtc.deleteStream(nm); } catch (_) {}
    });

    // #go2rtc: ask a player to PUBLISH its screen into go2rtc so this dashboard can watch it live.
    // Read-gated exactly like a screenshot (watching a screen is a read). Only relayed when live
    // video is enabled at all three levels AND a sidecar is configured; otherwise the dashboard
    // stays on snapshots and there is nothing for the player to publish to. The player needs a
    // user gesture to grant capture, so this is a request, not a guarantee (see the player's
    // device:live-publish handler and the deferred Android publisher).
    socket.on('dashboard:live-publish', (data, ack) => {
      const { device_id, action } = data || {};
      if (!canActOnDevice(socket, device_id, 'read')) return;
      if (action === 'stop') {
        deviceNs.to(device_id).emit('device:live-publish', { action: 'stop' });
        // Clean up the placeholder stream so idle st_<hash> entries do not accumulate in go2rtc's
        // config. Best-effort and fire-and-forget: a failure just leaves an inert stream behind,
        // which the next publish reuses anyway.
        try {
          const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(device_id);
          if (d && d.workspace_id) { const nm = go2rtc.streamName(d.workspace_id, device_id); if (nm) go2rtc.deleteStream(nm); }
        } catch (_) { /* cleanup is never load-bearing */ }
        if (typeof ack === 'function') ack({ delivered: true });
        return;
      }
      const device = db.prepare('SELECT workspace_id, live_video_enabled FROM devices WHERE id = ?').get(device_id);
      const ws = device && device.workspace_id
        ? db.prepare('SELECT live_video_enabled FROM workspaces WHERE id = ?').get(device.workspace_id) : null;
      const on = !!(appConfig.liveVideoEnabled && ws && ws.live_video_enabled && device && device.live_video_enabled);
      if (!on || !go2rtc.enabled()) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'live_disabled' });
        return;
      }
      const conn = heartbeat.getConnection(device_id);
      deviceNs.to(device_id).emit('device:live-publish', { action: 'start', iceServers: orgWebrtc.iceServersForDevice(device_id) });
      if (typeof ack === 'function') ack({ delivered: !!conn, reason: conn ? undefined : 'offline' });
    });

    socket.on('dashboard:device-command', (data, ack) => {
      const { device_id, type, payload } = data;
      if (!canActOnDevice(socket, device_id, 'write')) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'forbidden' });
        return;
      }

      // Hiding the button is not enforcement. This socket is reachable directly, group sends fan
      // out to mixed-platform fleets, and an older dashboard tab left open still renders the old
      // controls. A command the panel cannot honour is refused HERE, with the capability named, so
      // it fails loudly instead of being delivered and silently ignored — which is the failure
      // this whole mechanism exists to end.
      // #312 follow-up: a malformed set_server_url must never reach a panel. Validate before deliver.
      const v = validateCommand(type, payload);
      if (!v.ok) { if (typeof ack === 'function') ack({ delivered: false, reason: 'invalid', error: v.error }); return; }
      const devRow = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
      // ⚠️ One definition of "deliver a command", shared with the group route and the mesh path —
      // see lib/device-command.js for why it was extracted.
      const r = deliverCommand(deviceNs, devRow, type, payload);

      if (r.status === 'unsupported') {
        console.warn(`Command ${type} refused for device ${device_id}: needs ${r.capability}`);
        if (typeof ack === 'function') ack({ delivered: false, reason: 'unsupported', capability: r.capability });
        return;
      }
      if (r.status === 'sent') {
        console.log(`Command delivered to device ${device_id}: ${type}`);
        if (typeof ack === 'function') ack({ delivered: true });
        return;
      }
      console.log(`Command for offline device ${device_id}: ${type} (queued=${r.status === 'queued'})`);
      if (typeof ack === 'function') {
        ack({ delivered: false, queued: r.status === 'queued', reason: 'offline' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Dashboard client disconnected: ${socket.id}`);
      // Stop any remote screenshot streams this socket left running (tab closed / navigated away),
      // so the device isn't left capturing forever.
      for (const device_id of socket.remoteSessions) {
        deviceNs.to(device_id).emit('device:remote-stop', {});
        console.log(`Auto-stopped orphaned remote session for ${device_id} (dashboard socket ${socket.id} gone)`);
      }
      socket.remoteSessions.clear();
    });
  });

  return dashboardNs;
};

