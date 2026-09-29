'use strict';

/*
 * INTERACTIVE TERMINAL RELAY — a PTY on a player, driven from one dashboard tab.
 *
 * The one-shot `shell` command runs one line and sends back its output. This is the other thing: a
 * real pseudo-terminal on the device (today the native Raspberry Pi player; gated on the
 * `system.pty` capability), with the server passing raw bytes both ways and understanding none of
 * them.
 *
 *   dashboard -> server   dashboard:pty-open {device_id, cols, rows}
 *                         dashboard:pty-input {session_id, data}        data = base64 of raw bytes
 *                         dashboard:pty-resize {session_id, cols, rows}
 *                         dashboard:pty-close {session_id}
 *   server -> device      device:pty-open / -input / -resize / -close   (same fields, to the device room)
 *   device -> server      device:pty-data {session_id, data}            data = base64
 *                         device:pty-exit {session_id, code, reason?}
 *   server -> dashboard   dashboard:pty-opened {device_id, session_id}
 *                         dashboard:pty-data {device_id, session_id, data}
 *                         dashboard:pty-exit {device_id, session_id, code, reason}
 *                         dashboard:pty-error {device_id, error}
 *
 * ⚠️ THE OUTPUT GOES TO ONE SOCKET, NEVER TO A ROOM. Every other device->dashboard relay in this
 * codebase fans out to the device's workspace room (emitToDeviceWorkspace), which is right for a
 * status badge and exactly wrong here: a terminal echoes what is typed into it, passwords for `sudo`
 * and `su` included, and a workspace room contains every viewer in that workspace. The session is
 * bound to the dashboard socket that opened it and the bytes go to that socket id only.
 *
 * ⚠️ SESSIONS ARE CHECKED IN BOTH DIRECTIONS. A session id is a bearer token for a root-capable
 * shell, so knowing one is not enough: pty-input/resize/close are honoured only from the dashboard
 * socket that opened the session, and pty-data/exit only from the device the session is on. Anything
 * else is dropped silently — an error would tell a prober which ids are live.
 *
 * ⚠️ NOT A MESH COMMAND, AND NOT RELAYED ACROSS ONE. No peer server can open a PTY on our screens
 * (the mesh consent text is "reboot, reload, change settings" — see device-command.js MESH_COMMANDS;
 * a shell is not a setting), and a session is only opened to a device whose socket is attached to
 * THIS process. A replica-attached screen or a copied workspace is refused rather than tunnelled,
 * because a tunnel through the command-relay would be a keystroke channel that no audit row on this
 * node describes.
 *
 * AUDIT: open and close are written to activity_log (who, which screen, how long, why it ended).
 * Keystrokes are NOT: recording them would store every password typed into the session in a table
 * that is replicated, exported and shown to workspace admins. That trade-off is why system.pty is a
 * separate capability from system.shell — see player-capabilities.js.
 */

const crypto = require('crypto');

const MAX_PER_DEVICE = 2;
const MAX_PER_USER = 4;
const MAX_FRAME_B64 = 64 * 1024;          // one base64 frame, either direction
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function clampDim(v, dflt, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return dflt;
  return Math.min(n, max);
}

function isFrame(data) {
  return typeof data === 'string' && data.length <= MAX_FRAME_B64;
}

/**
 * @param {object} deps
 * @param {() => {deviceNs: object, dashboardNs: object}} deps.namespaces
 * @param {(socket, deviceId) => boolean} deps.authorize        same gate as sending `shell`
 * @param {(deviceId) => object|null} deps.getDevice            the devices row
 * @param {(device) => boolean} deps.canPty                     supports(device, 'system.pty')
 * @param {(deviceId) => string|null} deps.deviceSocketId       the LOCAL socket holding the screen
 * @param {(device) => string|null} [deps.refuseReason]         e.g. copied workspace -> 'replica'
 * @param {(entry) => void} [deps.audit]
 * @param {() => number} [deps.now]
 * @param {number} [deps.idleMs]
 */
function createPtyRelay(deps) {
  const now = deps.now || Date.now;
  const idleMs = deps.idleMs || IDLE_MS;
  const audit = deps.audit || (() => {});
  const sessions = new Map();   // session_id -> { device_id, dashboardSocketId, userId, deviceSocketId, openedAt, lastActivity, ip }

  const ns = () => deps.namespaces();
  const toDashboard = (socketId, event, payload) => {
    const { dashboardNs } = ns();
    if (dashboardNs) dashboardNs.to(socketId).emit(event, payload);
  };
  const toDevice = (deviceId, event, payload) => {
    const { deviceNs } = ns();
    if (deviceNs) deviceNs.to(deviceId).emit(event, payload);
  };
  const count = (pred) => { let n = 0; for (const s of sessions.values()) if (pred(s)) n++; return n; };

  function end(sessionId, { code = null, reason, notifyDevice, notifyDashboard }) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    sessions.delete(sessionId);
    if (notifyDevice) toDevice(s.device_id, 'device:pty-close', { session_id: sessionId });
    if (notifyDashboard) {
      toDashboard(s.dashboardSocketId, 'dashboard:pty-exit', { device_id: s.device_id, session_id: sessionId, code, reason });
    }
    audit({
      action: 'device_pty_close', userId: s.userId, deviceId: s.device_id, ip: s.ip,
      details: `session=${sessionId.slice(0, 8)} reason=${reason}${code != null ? ` code=${code}` : ''} duration=${Math.round((now() - s.openedAt) / 1000)}s`,
    });
    return true;
  }

  /*
   * Open. Every refusal answers on dashboard:pty-error (and the optional ack), naming the reason in
   * the vocabulary the other remote-control handlers use, so the Terminal tab can say WHY.
   */
  function open(socket, data, ack) {
    const deviceId = data && typeof data.device_id === 'string' ? data.device_id : null;
    const refuse = (error) => {
      if (deviceId) toDashboard(socket.id, 'dashboard:pty-error', { device_id: deviceId, error });
      if (typeof ack === 'function') ack({ ok: false, error });
      return null;
    };
    if (!deviceId) return refuse('invalid');
    if (!deps.authorize(socket, deviceId)) return refuse('forbidden');
    const device = deps.getDevice(deviceId);
    if (!device) return refuse('forbidden');
    const special = deps.refuseReason ? deps.refuseReason(device) : null;
    if (special) return refuse(special);
    if (!deps.canPty(device)) return refuse('unsupported');
    const deviceSocketId = deps.deviceSocketId(deviceId);
    if (!deviceSocketId) return refuse('offline');
    if (count((s) => s.device_id === deviceId) >= MAX_PER_DEVICE) return refuse('too_many_sessions_device');
    if (count((s) => s.userId === socket.userId) >= MAX_PER_USER) return refuse('too_many_sessions_user');

    const sessionId = crypto.randomBytes(16).toString('hex');
    const cols = clampDim(data.cols, DEFAULT_COLS, 500);
    const rows = clampDim(data.rows, DEFAULT_ROWS, 300);
    const t = now();
    const ip = (socket.handshake && socket.handshake.address) || null;
    sessions.set(sessionId, {
      device_id: deviceId, dashboardSocketId: socket.id, userId: socket.userId,
      deviceSocketId, openedAt: t, lastActivity: t, ip,
    });
    toDevice(deviceId, 'device:pty-open', { session_id: sessionId, cols, rows });
    toDashboard(socket.id, 'dashboard:pty-opened', { device_id: deviceId, session_id: sessionId });
    audit({ action: 'device_pty_open', userId: socket.userId, deviceId, ip, details: `session=${sessionId.slice(0, 8)} ${cols}x${rows}` });
    if (typeof ack === 'function') ack({ ok: true, session_id: sessionId });
    return sessionId;
  }

  // The owning dashboard socket's session, or null. Anything else is dropped without a word.
  function owned(socket, data) {
    const sid = data && typeof data.session_id === 'string' ? data.session_id : null;
    const s = sid && sessions.get(sid);
    if (!s || s.dashboardSocketId !== socket.id) return null;
    return { sid, s };
  }

  function input(socket, data) {
    const o = owned(socket, data);
    if (!o || !isFrame(data.data)) return false;
    o.s.lastActivity = now();
    toDevice(o.s.device_id, 'device:pty-input', { session_id: o.sid, data: data.data });
    return true;
  }

  function resize(socket, data) {
    const o = owned(socket, data);
    if (!o) return false;
    o.s.lastActivity = now();
    toDevice(o.s.device_id, 'device:pty-resize', {
      session_id: o.sid, cols: clampDim(data.cols, DEFAULT_COLS, 500), rows: clampDim(data.rows, DEFAULT_ROWS, 300),
    });
    return true;
  }

  function close(socket, data) {
    const o = owned(socket, data);
    if (!o) return false;
    return end(o.sid, { reason: 'closed_by_user', notifyDevice: true, notifyDashboard: true });
  }

  // The tab closed or the socket dropped. The device is told to kill the shell — an orphaned PTY is
  // a root-capable process nobody can see.
  function dashboardGone(socket) {
    for (const [sid, s] of [...sessions]) {
      if (s.dashboardSocketId === socket.id) end(sid, { reason: 'dashboard_disconnected', notifyDevice: true, notifyDashboard: false });
    }
  }

  function fromDeviceData(deviceId, data) {
    const sid = data && typeof data.session_id === 'string' ? data.session_id : null;
    const s = sid && sessions.get(sid);
    if (!s || s.device_id !== deviceId || !isFrame(data.data)) return false;
    s.lastActivity = now();
    toDashboard(s.dashboardSocketId, 'dashboard:pty-data', { device_id: deviceId, session_id: sid, data: data.data });
    return true;
  }

  function fromDeviceExit(deviceId, data) {
    const sid = data && typeof data.session_id === 'string' ? data.session_id : null;
    const s = sid && sessions.get(sid);
    if (!s || s.device_id !== deviceId) return false;
    const code = Number.isInteger(data.code) ? data.code : null;
    const reason = typeof data.reason === 'string' && data.reason ? data.reason.slice(0, 64) : 'exited';
    return end(sid, { code, reason, notifyDevice: false, notifyDashboard: true });
  }

  /*
   * The device's socket went away. Scoped to sessions opened on THAT socket: a screen that
   * reconnects (eviction by its own newer socket) must not have a session opened on the new socket
   * torn down by the old one's late disconnect. The device room is still told to close each ended
   * session, so a PTY that survived the reconnect on the device side is not left running unowned.
   */
  function deviceGone(deviceId, socketId) {
    for (const [sid, s] of [...sessions]) {
      if (s.device_id !== deviceId) continue;
      if (socketId && s.deviceSocketId !== socketId) continue;
      end(sid, { reason: 'device_offline', notifyDevice: true, notifyDashboard: true });
    }
  }

  function sweep() {
    const t = now();
    for (const [sid, s] of [...sessions]) {
      if (t - s.lastActivity > idleMs) end(sid, { reason: 'idle_timeout', notifyDevice: true, notifyDashboard: true });
    }
  }

  let timer = null;
  function startSweep() {
    if (timer) return;
    timer = setInterval(sweep, SWEEP_MS);
    if (timer.unref) timer.unref();
  }

  return {
    open, input, resize, close, dashboardGone, fromDeviceData, fromDeviceExit, deviceGone, sweep, startSweep,
    _sessions: sessions,
  };
}

/*
 * The process-wide relay. The two socket modules share it: dashboardSocket owns the dashboard
 * half and supplies the authorisation gate (it holds canActOnDevice), deviceSocket feeds the device
 * half. Namespaces are resolved lazily from the io handed to bind(), so require order between the
 * two modules does not matter.
 */
let _io = null;
let _relay = null;
let _authorize = null;
function bind(io, overrides = {}) {
  if (io) _io = io;
  if (_relay) return _relay;
  const { db } = require('../db/database');
  const heartbeat = require('../services/heartbeat');
  const playerCapabilities = require('./player-capabilities');
  _relay = createPtyRelay(Object.assign({
    namespaces: () => ({ deviceNs: _io && _io.of('/device'), dashboardNs: _io && _io.of('/dashboard') }),
    // Supplied by dashboardSocket via setAuthorizer. Until it is, every open is refused — fail CLOSED.
    authorize: (socket, id) => (_authorize ? _authorize(socket, id) : false),
    getDevice: (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id) || null,
    canPty: (device) => playerCapabilities.supports(device, 'system.pty'),
    deviceSocketId: (id) => {
      // ⚠️ Online means a socket on THIS process — not "status = online", which a replica-attached
      // screen also has. The room check is what excludes a screen we could only reach by relay.
      const conn = heartbeat.getConnection(id);
      const deviceNs = _io && _io.of('/device');
      if (!conn || !deviceNs || !deviceNs.sockets.has(conn.socketId)) return null;
      return conn.socketId;
    },
    refuseReason: (device) => {
      try {
        if (device.workspace_id) {
          const ws = db.prepare('SELECT origin_node_id FROM workspaces WHERE id = ?').get(device.workspace_id);
          if (require('./replica-proxy').isCopiedWorkspace(ws)) return 'replica';
        }
      } catch (_) { /* no mesh tables — not a replica */ }
      return null;
    },
    audit: ({ action, userId, deviceId, ip, details }) => {
      require('../services/activity').logActivity(userId, action, details, deviceId, ip);
    },
  }, overrides));
  _relay.startSweep();
  return _relay;
}

function setAuthorizer(fn) { _authorize = fn; }
function relay() { return bind(null); }

module.exports = {
  createPtyRelay, bind, relay, setAuthorizer,
  MAX_PER_DEVICE, MAX_PER_USER, MAX_FRAME_B64, IDLE_MS,
};
