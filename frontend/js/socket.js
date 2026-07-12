let dashboardSocket = null;
const listeners = new Map();

export function connectSocket() {
  const token = localStorage.getItem('token');
  dashboardSocket = io('/dashboard', {
    auth: { token },
    // Prefer WebSocket; fall back to polling on the same connect attempt.
    // Mirrors the player-side fix in 1aee4f2 - skips the polling->WS upgrade
    // dance that was causing the dashboard socket to flicker on Apply.
    transports: ['websocket', 'polling']
  });

  dashboardSocket.on('connect', () => {
    console.log('Dashboard connected, socket id:', dashboardSocket.id);
    updateConnectionStatus(true);
    emit('connected');
  });

  dashboardSocket.on('connect_error', (err) => {
    console.error('Dashboard socket connect error:', err.message);
  });

  dashboardSocket.on('disconnect', (reason) => {
    console.log('Dashboard disconnected:', reason);
    updateConnectionStatus(false);
    emit('disconnected');
  });

  // Device status updates
  dashboardSocket.on('dashboard:device-status', (data) => {
    emit('device-status', data);
  });

  // Screenshot ready
  dashboardSocket.on('dashboard:screenshot-ready', (data) => {
    emit('screenshot-ready', data);
  });

  // #161 device-owner tooling: remote-shell output
  dashboardSocket.on('dashboard:shell-result', (data) => {
    emit('shell-result', data);
  });

  // Device added
  dashboardSocket.on('dashboard:device-added', (data) => {
    emit('device-added', data);
  });

  // Device removed
  dashboardSocket.on('dashboard:device-removed', (data) => {
    emit('device-removed', data);
  });

  // Playback state
  dashboardSocket.on('dashboard:playback-state', (data) => {
    emit('playback-state', data);
  });

  // Live device debug log line (device-detail screen streams these when the
  // per-device "Debug logging" checkbox is on).
  dashboardSocket.on('dashboard:device-log', (data) => {
    emit('device-log', data);
  });

  // Playback progress (play_start with duration — drives device-card progress bars)
  dashboardSocket.on('dashboard:playback-progress', (data) => {
    emit('playback-progress', data);
  });

  // Wall changed — dashboard refreshes wall cards + device-grouping layout
  dashboardSocket.on('dashboard:wall-changed', () => {
    emit('wall-changed');
  });

  // Content ack
  dashboardSocket.on('dashboard:content-ack', (data) => {
    emit('content-ack', data);
  });

  return dashboardSocket;
}

function updateConnectionStatus(connected) {
  const el = document.getElementById('connectionStatus');
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('span:last-child');
  if (connected) {
    dot.className = 'status-dot online';
    text.textContent = 'Connected';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Disconnected';
  }
}

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(callback);
}

export function off(event, callback) {
  if (!listeners.has(event)) return;
  const cbs = listeners.get(event);
  const idx = cbs.indexOf(callback);
  if (idx > -1) cbs.splice(idx, 1);
}

function emit(event, data) {
  const cbs = listeners.get(event);
  if (cbs) cbs.forEach(cb => cb(data));
}

export function requestScreenshot(deviceId) {
  console.log('requestScreenshot:', deviceId, 'socket connected:', dashboardSocket?.connected);
  if (dashboardSocket) dashboardSocket.emit('dashboard:request-screenshot', { device_id: deviceId });
}

export function startRemote(deviceId) {
  console.log('startRemote:', deviceId, 'socket connected:', dashboardSocket?.connected);
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-start', { device_id: deviceId });
}

export function stopRemote(deviceId) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-stop', { device_id: deviceId });
}

export function sendTouch(deviceId, x, y, action) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-touch', { device_id: deviceId, x, y, action });
}

// #159: a drag → swipe gesture (scroll). Normalized start+end + duration (ms).
export function sendSwipe(deviceId, x1, y1, x2, y2, duration) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-touch', { device_id: deviceId, x: x1, y: y1, x2, y2, duration, action: 'swipe' });
}

export function sendKey(deviceId, keycode) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-key', { device_id: deviceId, keycode });
}

// Optional callback receives the server-side ack: { delivered, queued, reason }.
// Callers without a callback keep firing-and-forgetting (no behavior change).
// With a callback, we use Socket.IO's .timeout() so the callback always fires -
// either with the ack or with an Error if the server doesn't respond in 5s.
export function sendCommand(deviceId, type, payload, callback) {
  if (!dashboardSocket) return;
  if (typeof callback === 'function') {
    dashboardSocket.timeout(5000).emit('dashboard:device-command', { device_id: deviceId, type, payload }, (err, ack) => {
      if (err) callback({ delivered: false, reason: 'no_ack' });
      else callback(ack || { delivered: false, reason: 'no_ack' });
    });
  } else {
    dashboardSocket.emit('dashboard:device-command', { device_id: deviceId, type, payload });
  }
}

export function getSocket() { return dashboardSocket; }
