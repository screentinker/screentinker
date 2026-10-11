// Short-lived per-device queue for events that target a currently-offline
// device. Designed for the TV-flap case where a device disconnects for a few
// seconds (Engine.IO ping miss, Wi-Fi blip, decode stall) and reconnects via
// Socket.IO's auto-reconnect. Without this queue, any device:command or
// device:playlist-update emitted during the disconnect window goes nowhere -
// the room is empty, the emit is silently dropped.
//
// Two structures, both keyed by device_id, both pruned by TTL:
//
//   pendingPlaylistUpdate: Map<deviceId, { expiresAt }>
//     We don't store the payload. On flush we rebuild via buildPlaylistPayload
//     so the device gets the LATEST DB state, not a stale snapshot from when
//     the update was first queued.
//
//   pendingCommands: Map<deviceId, Map<type, { payload, expiresAt }>>
//     One entry per command type per device. Last-of-type wins (the most
//     recent screen_off supersedes any earlier ones). Payloads stored verbatim
//     because commands are stateless declarations.
//
// Memory bounds: worst-case ~6 entries per device (1 playlist marker + 5
// command types), each ~200 bytes. 10,000 offline devices = ~12MB. Sweep
// thread prunes empty per-device records every 30s.

const config = require('../config');

const pendingPlaylistUpdate = new Map();
const pendingCommands = new Map();

let _sweepTimer = null;

// Internal helper - drop expired entries for a single device. Called lazily
// from queue/flush paths AND from the sweep thread.
function pruneDevice(deviceId) {
  const now = Date.now();
  const pu = pendingPlaylistUpdate.get(deviceId);
  if (pu && pu.expiresAt <= now) pendingPlaylistUpdate.delete(deviceId);

  const cmds = pendingCommands.get(deviceId);
  if (cmds) {
    for (const [type, entry] of cmds) {
      if (entry.expiresAt <= now) cmds.delete(type);
    }
    if (cmds.size === 0) pendingCommands.delete(deviceId);
  }
}

// Mark a pending playlist-update for a device. Caller used to call
// deviceNs.to(deviceId).emit('device:playlist-update', buildPlaylistPayload(deviceId));
// directly. Now they call queueOrEmitPlaylistUpdate which checks room presence
// first and queues only if the device is offline.
function queueOrEmitPlaylistUpdate(deviceNs, deviceId, buildPayload) {
  if (!deviceNs || !deviceId || typeof buildPayload !== 'function') return { delivered: false };
  const room = deviceNs.adapter.rooms.get(deviceId);
  if (room && room.size > 0) {
    deviceNs.to(deviceId).emit('device:playlist-update', buildPayload(deviceId));
    return { delivered: true };
  }
  pendingPlaylistUpdate.set(deviceId, { expiresAt: Date.now() + config.commandQueueTtlMs });
  return { delivered: false, queued: true };
}

// Queue a single command for an offline device. Returns true if accepted
// (always true under current logic; reserved for future "rejected because
// stale/full" cases). Used by item 6 in commit D - dashboard command handler
// calls this when the device room is empty.
function queueCommand(deviceId, type, payload, opts = {}) {
  if (!deviceId || !type) return false;
  let perDevice = pendingCommands.get(deviceId);
  if (!perDevice) {
    perDevice = new Map();
    pendingCommands.set(deviceId, perDevice);
  }
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : config.commandQueueTtlMs;
  perDevice.set(type, { payload: payload || {}, expiresAt: Date.now() + ttl });
  return true;
}

/*
 * ⚠️ AN EMBEDDED PANEL IS NOT "BRIEFLY OFFLINE" — it polls over HTTP and deep-sleeps between calls
 * for as long as X-ST-Expires-In told it to, which is 30-60s on a normal dwell and many hours under
 * a power schedule. The 30s socket-reconnect TTL above would expire almost every command before
 * the panel next asked, so the dashboard would say "queued" and nothing would ever happen. Hold an
 * embedded panel's command until it is due back (devices.heartbeat_expected_by) plus a grace, with
 * a floor for a panel that has never told us and a cap so a dead panel's entry does not live on.
 */
const EMBEDDED_GRACE_MS = 10 * 60 * 1000;
const EMBEDDED_FLOOR_MS = 15 * 60 * 1000;
const EMBEDDED_CAP_MS   = 7 * 24 * 3600 * 1000;

function ttlForDevice(device) {
  if (!device || !device.id) return config.commandQueueTtlMs;
  let row = device;
  if (row.client_type === undefined || row.heartbeat_expected_by === undefined) {
    try {
      row = require('../db/database').db
        .prepare('SELECT client_type, heartbeat_expected_by FROM devices WHERE id = ?').get(device.id) || {};
    } catch (_) { row = {}; }
  }
  if (row.client_type !== 'embedded') return config.commandQueueTtlMs;
  const untilDue = (Number(row.heartbeat_expected_by) || 0) * 1000 - Date.now();
  return Math.min(EMBEDDED_CAP_MS, Math.max(EMBEDDED_FLOOR_MS, untilDue + EMBEDDED_GRACE_MS));
}

// Called on device:register success, after heartbeat.registerConnection and
// socket.join. Drains both queues to the just-reconnected device.
//
// buildPayload is the buildPlaylistPayload function from deviceSocket.js,
// passed in to avoid a circular require. We call it at flush time so the
// playlist reflects current DB state, not whatever it was when queued.
function flushQueue(deviceNs, deviceId, buildPayload) {
  if (!deviceNs || !deviceId) return { playlistUpdate: false, commands: 0 };
  pruneDevice(deviceId);

  let playlistUpdate = false;
  let commands = 0;

  const pu = pendingPlaylistUpdate.get(deviceId);
  if (pu) {
    pendingPlaylistUpdate.delete(deviceId);
    if (typeof buildPayload === 'function') {
      deviceNs.to(deviceId).emit('device:playlist-update', buildPayload(deviceId));
      playlistUpdate = true;
    }
  }

  const cmds = pendingCommands.get(deviceId);
  if (cmds) {
    pendingCommands.delete(deviceId);
    for (const [type, entry] of cmds) {
      deviceNs.to(deviceId).emit('device:command', { type, payload: entry.payload });
      commands++;
    }
  }

  if (playlistUpdate || commands > 0) {
    console.log(`Flushed queue for ${deviceId}: playlistUpdate=${playlistUpdate}, commands=${commands}`);
  }
  return { playlistUpdate, commands };
}

function getQueueDepth(deviceId) {
  pruneDevice(deviceId);
  const hasPlaylist = pendingPlaylistUpdate.has(deviceId) ? 1 : 0;
  const cmdCount = pendingCommands.get(deviceId)?.size || 0;
  return hasPlaylist + cmdCount;
}

// Active sweep prunes devices that never come back. Without this, a device
// that goes permanently offline leaves its queue entries in memory until TTL,
// which is fine, but the Map keys themselves linger. Cheap to walk.
function startSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    for (const deviceId of pendingPlaylistUpdate.keys()) pruneDevice(deviceId);
    for (const deviceId of pendingCommands.keys()) pruneDevice(deviceId);
  }, 30000);
  if (_sweepTimer.unref) _sweepTimer.unref();
}

function stopSweep() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}

// Test helpers - reset internal state. Not exported via module.exports for
// production callers; bound below for the test harness only.
function _resetForTests() {
  pendingPlaylistUpdate.clear();
  pendingCommands.clear();
  stopSweep();
}

function popPendingCommands(deviceId) {
  if (!deviceId) return [];
  pruneDevice(deviceId);
  const cmds = pendingCommands.get(deviceId);
  if (!cmds || cmds.size === 0) return [];
  pendingCommands.delete(deviceId);
  const out = [];
  for (const [type, entry] of cmds) {
    out.push({ type, payload: entry.payload });
  }
  return out;
}

module.exports = {
  queueOrEmitPlaylistUpdate,
  queueCommand,
  flushQueue,
  popPendingCommands,
  ttlForDevice,
  getQueueDepth,
  startSweep,
  stopSweep,
  _resetForTests,
};
