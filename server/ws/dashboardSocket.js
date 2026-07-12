const heartbeat = require('../services/heartbeat');
const { verifyToken } = require('../middleware/auth');
const { db } = require('../db/database');
const { accessContext, accessibleWorkspaceIds } = require('../lib/tenancy');
const { workspaceRoom } = require('../lib/socket-rooms');
const { protectSocket } = require('../lib/safe-socket');

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
    try {
      const decoded = verifyToken(token);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
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

    socket.on('dashboard:request-screenshot', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'read')) return;
      const conn = heartbeat.getConnection(device_id);
      if (conn) deviceNs.to(device_id).emit('device:screenshot-request', {});
    });

    socket.on('dashboard:remote-touch', (data) => {
      const { device_id, x, y, x2, y2, duration, action } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      // #159: a swipe/drag carries an end point + duration (for scrolling); tap is just x/y.
      deviceNs.to(device_id).emit('device:remote-touch', { x, y, x2, y2, duration, action });
    });

    socket.on('dashboard:remote-key', (data) => {
      const { device_id, keycode } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      console.log(`Remote key: ${keycode} -> ${device_id}`);
      deviceNs.to(device_id).emit('device:remote-key', { keycode });
    });

    // Track which devices THIS dashboard socket has a live remote (screenshot-stream) session on, so
    // we can stop them if the tab closes / the socket drops — an orphaned stream keeps the device
    // capturing every second and can starve a weak panel's decoder (the black-screen we hit).
    socket.remoteSessions = new Set();

    socket.on('dashboard:remote-start', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      const room = deviceNs.adapter.rooms.get(device_id);
      console.log(`Remote start for ${device_id}, room has ${room?.size || 0} socket(s)`);
      socket.remoteSessions.add(device_id);
      deviceNs.to(device_id).emit('device:remote-start', {});
      console.log(`Remote session started for device ${device_id}`);
    });

    socket.on('dashboard:remote-stop', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      socket.remoteSessions.delete(device_id);
      deviceNs.to(device_id).emit('device:remote-stop', {});
      console.log(`Remote session stopped for device ${device_id}`);
    });

    socket.on('dashboard:device-command', (data, ack) => {
      const { device_id, type, payload } = data;
      if (!canActOnDevice(socket, device_id, 'write')) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'forbidden' });
        return;
      }
      const room = deviceNs.adapter.rooms.get(device_id);
      if (room && room.size > 0) {
        deviceNs.to(device_id).emit('device:command', { type, payload });
        console.log(`Command delivered to device ${device_id}: ${type}`);
        if (typeof ack === 'function') ack({ delivered: true });
        return;
      }
      // Device offline at emit time. Try to queue (lazy require so reverting
      // the queue commit doesn't break this commit - MODULE_NOT_FOUND on the
      // first try gets cached by Node's module loader, giving consistent
      // queued=false behavior on every subsequent call).
      let queued = false;
      try {
        const queue = require('../lib/command-queue');
        queued = queue.queueCommand(device_id, type, payload);
      } catch (e) { /* command-queue module absent; fall through to lost */ }
      console.log(`Command for offline device ${device_id}: ${type} (queued=${queued})`);
      if (typeof ack === 'function') ack({ delivered: false, queued, reason: 'offline' });
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

