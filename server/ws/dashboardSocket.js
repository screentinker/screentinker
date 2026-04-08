const heartbeat = require('../services/heartbeat');
const { verifyToken } = require('../middleware/auth');

module.exports = function setupDashboardSocket(io) {
  const dashboardNs = io.of('/dashboard');
  const deviceNs = io.of('/device');

  // Authenticate dashboard WebSocket connections
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

  // Verify the user owns the device or is admin/superadmin
  function checkDeviceOwnership(socket, device_id) {
    if (['admin', 'superadmin'].includes(socket.userRole)) return true;
    const { db } = require('../db/database');
    const device = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(device_id);
    if (!device) return false;
    return device.user_id === socket.userId;
  }

  dashboardNs.on('connection', (socket) => {
    console.log(`Dashboard client connected: ${socket.id} (user: ${socket.userId})`);

    // Request screenshot from a device
    socket.on('dashboard:request-screenshot', (data) => {
      const { device_id } = data;
      if (!checkDeviceOwnership(socket, device_id)) return;
      const conn = heartbeat.getConnection(device_id);
      if (conn) {
        deviceNs.to(device_id).emit('device:screenshot-request', {});
      }
    });

    // Remote control: touch forwarding
    socket.on('dashboard:remote-touch', (data) => {
      const { device_id, x, y, action } = data;
      if (!checkDeviceOwnership(socket, device_id)) return;
      deviceNs.to(device_id).emit('device:remote-touch', { x, y, action });
    });

    // Remote control: key forwarding
    socket.on('dashboard:remote-key', (data) => {
      const { device_id, keycode } = data;
      if (!checkDeviceOwnership(socket, device_id)) return;
      console.log(`Remote key: ${keycode} -> ${device_id}`);
      deviceNs.to(device_id).emit('device:remote-key', { keycode });
    });

    // Start remote screenshot streaming
    socket.on('dashboard:remote-start', (data) => {
      const { device_id } = data;
      if (!checkDeviceOwnership(socket, device_id)) return;
      const room = deviceNs.adapter.rooms.get(device_id);
      console.log(`Remote start for ${device_id}, room has ${room?.size || 0} socket(s)`);
      deviceNs.to(device_id).emit('device:remote-start', {});
      console.log(`Remote session started for device ${device_id}`);
    });

    // Stop remote screenshot streaming
    socket.on('dashboard:remote-stop', (data) => {
      const { device_id } = data;
      if (!checkDeviceOwnership(socket, device_id)) return;
      deviceNs.to(device_id).emit('device:remote-stop', {});
      console.log(`Remote session stopped for device ${device_id}`);
    });

    // Send command to device (reboot, refresh, etc.)
    socket.on('dashboard:device-command', (data) => {
      const { device_id, type, payload } = data;
      if (!checkDeviceOwnership(socket, device_id)) return;
      deviceNs.to(device_id).emit('device:command', { type, payload });
      console.log(`Command sent to device ${device_id}: ${type}`);
    });

    socket.on('disconnect', () => {
      console.log(`Dashboard client disconnected: ${socket.id}`);
    });
  });

  return dashboardNs;
};
