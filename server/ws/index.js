const setupDeviceSocket = require('./deviceSocket');
const setupDashboardSocket = require('./dashboardSocket');

module.exports = function setupWebSockets(io) {
  const deviceNs = setupDeviceSocket(io);
  const dashboardNs = setupDashboardSocket(io);
  return { deviceNs, dashboardNs };
};
