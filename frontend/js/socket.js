let dashboardSocket = null;
const listeners = new Map();
let refusalRetryMs = 2000;
// Devices outside the current workspace a page is watching (watchDevice). Declared up here, before
// any handler reads it, so no early event can hit it in its temporal dead zone.
const watchedDevices = new Set();

async function recheckLoginAfterRefusal() {
  let status = 0;
  try {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/auth/me', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    status = res.status;
  } catch (e) { /* offline: retry below */ }
  if (status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    return;
  }
  // Still signed in (MFA/password step pending, a server restart mid-handshake, or offline): try again,
  // backing off to a minute, with the token as it is now.
  setTimeout(() => {
    if (!dashboardSocket || dashboardSocket.connected || dashboardSocket.active) return;
    dashboardSocket.auth = { token: localStorage.getItem('token') };
    dashboardSocket.connect();
  }, refusalRetryMs);
  refusalRetryMs = Math.min(refusalRetryMs * 2, 60000);
}

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
    refusalRetryMs = 2000;
    // A new socket starts in the current workspace's room only; ask again for every device page
    // that is watching a screen elsewhere (see watchDevice).
    for (const id of watchedDevices) dashboardSocket.emit('dashboard:watch-device', { device_id: id });
    updateConnectionStatus(true);
    emit('connected');
  });

  dashboardSocket.on('connect_error', (err) => {
    console.error('Dashboard socket connect error:', err.message);
    // A refusal from the server's auth check (expired or revoked login) is final: Socket.IO does not
    // retry it, so the page would sit on "Disconnected" forever while cached views still load. Ask the
    // API whether the login is still good: a 401 signs out like any other request; otherwise retry.
    if (!dashboardSocket.active) recheckLoginAfterRefusal();
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
  // Screen verification: a screen's verified/blank/frozen/... state changed (lib/screen-verify).
  dashboardSocket.on('dashboard:verification-state', (data) => emit('verification-state', data));
  dashboardSocket.on('dashboard:screenshot-ready', (data) => {
    emit('screenshot-ready', data);
  });

  // Talk session state from the screen itself. The one that matters is `listen_only_no_mic`: the
  // player asked for the microphone when the operator clicked 2-way, did not get one, and carried on
  // one-way. Without this the operator sees a working session that silently is not two-way.
  dashboardSocket.on('dashboard:talk-state', (data) => {
    emit('talk-state', data);
  });

  // #161 device-owner tooling: remote-shell output
  dashboardSocket.on('dashboard:shell-result', (data) => {
    emit('shell-result', data);
  });

  // Interactive terminal (system.pty). The server sends these to THIS socket only — never to a
  // workspace room — because a terminal echoes whatever is typed into it. See server/lib/pty-relay.js.
  dashboardSocket.on('dashboard:pty-opened', (data) => emit('pty-opened', data));
  dashboardSocket.on('dashboard:pty-data', (data) => emit('pty-data', data));
  dashboardSocket.on('dashboard:pty-exit', (data) => emit('pty-exit', data));
  dashboardSocket.on('dashboard:pty-error', (data) => emit('pty-error', data));

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

  // Diagnostic log upload for embedded/fielded devices (#3 / mcu#9)
  dashboardSocket.on('dashboard:embedded-logs', (data) => {
    emit('embedded-logs', data);
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

// Optional callback receives the server-side ack: { delivered, reason, capability }.
// reason is 'offline' (no live connection) or 'unsupported' (this player type can't
// take screenshots). Callers without a callback keep firing-and-forgetting — the
// dashboard grid and the device-detail 5s poll stay silent; only the explicit
// Screenshot button asks for the verdict.
export function requestScreenshot(deviceId, callback) {
  console.log('requestScreenshot:', deviceId, 'socket connected:', dashboardSocket?.connected);
  if (!dashboardSocket) return;
  if (typeof callback === 'function') {
    dashboardSocket.timeout(5000).emit('dashboard:request-screenshot', { device_id: deviceId }, (err, ack) => {
      if (err) callback({ delivered: false, reason: 'no_ack' });
      else callback(ack || { delivered: false, reason: 'no_ack' });
    });
  } else {
    dashboardSocket.emit('dashboard:request-screenshot', { device_id: deviceId });
  }
}

/*
 * The socket only joins the CURRENT workspace's room (server/lib/socket-rooms.js roomsForDashboard).
 * A device page can show a screen from another workspace (a platform or organization admin acting
 * as), so it asks for that screen's room too; otherwise its screenshots, logs and status would
 * never arrive. Remembered, so a reconnect asks again. The server applies the same read check as
 * the HTTP API.
 */
export function watchDevice(deviceId) {
  if (!deviceId) return;
  watchedDevices.add(deviceId);
  if (dashboardSocket && dashboardSocket.connected) dashboardSocket.emit('dashboard:watch-device', { device_id: deviceId });
}

export function startRemote(deviceId) {
  console.log('startRemote:', deviceId, 'socket connected:', dashboardSocket?.connected);
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-start', { device_id: deviceId });
}

export function stopRemote(deviceId) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-stop', { device_id: deviceId });
}

// #talk: ask a device to join / leave the two-way voice intercom. Server-relayed and gated like
// remote control; the audio itself flows over WebRTC (see lib/talk-client.js), not this socket.
export function startTalk(deviceId, duplex, cb) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:talk-start', { device_id: deviceId, duplex: !!duplex }, cb);
}
export function stopTalk(deviceId) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:talk-stop', { device_id: deviceId });
}

// #talk broadcast: tell every device in a group/workspace to LISTEN to the shared channel. scope is
// { kind: 'group'|'workspace', id }. The operator's mic is published separately (BroadcastTalkClient).
export function startGroupTalk(scope, cb) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:group-talk-start', { scope }, cb);
}
export function stopGroupTalk(scope) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:group-talk-stop', { scope });
}

// #go2rtc: ask a player to start/stop publishing its screen live. Best-effort — the server only
// relays it when live video is enabled for the device, and the player needs a user gesture to
// grant screen capture, so a delivered ack means the request reached the panel, not that a stream
// is up. The viewer tile re-polls the live descriptor to find out.
export function requestLivePublish(deviceId, callback) {
  if (!dashboardSocket) return;
  if (callback) {
    dashboardSocket.timeout(5000).emit('dashboard:live-publish', { device_id: deviceId, action: 'start' }, (err, ack) => {
      callback(err ? { delivered: false, reason: 'timeout' } : ack);
    });
  } else {
    dashboardSocket.emit('dashboard:live-publish', { device_id: deviceId, action: 'start' });
  }
}
export function stopLivePublish(deviceId) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:live-publish', { device_id: deviceId, action: 'stop' });
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

// Interactive terminal. `data` is base64 of the raw bytes, in both directions.
export function ptyOpen(deviceId, cols, rows, cb) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:pty-open', { device_id: deviceId, cols, rows }, cb);
}
export function ptyInput(sessionId, data) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:pty-input', { session_id: sessionId, data });
}
export function ptyResize(sessionId, cols, rows) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:pty-resize', { session_id: sessionId, cols, rows });
}
export function ptyClose(sessionId) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:pty-close', { session_id: sessionId });
}

export function getSocket() { return dashboardSocket; }
