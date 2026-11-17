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
// Payload bytes are capped per command and per device (MAX_COMMAND_PAYLOAD_BYTES /
// MAX_DEVICE_QUEUE_BYTES below), so "each ~200 bytes" is a ceiling the queue enforces, not a hope.

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
function queueOrEmitPlaylistUpdate(deviceNs, deviceId, buildPayload, _mirrorHop) {
  if (!deviceNs || !deviceId || typeof buildPayload !== 'function') return { delivered: false };
  /*
   * 3.0 display-link mirrors (lib/mirrors.js): a mirror plays what its original plays, so every
   * push to the original goes to each mirror as well — with the MIRROR's own payload (built per
   * screen, which is what keeps its audience/site-cache fields its own). This is the one place all
   * ~20 push paths meet, so no caller has to know mirrors exist. Lazy and guarded: a lookup failure
   * costs the mirrors an update, never the original.
   */
  if (!_mirrorHop) {
    try {
      for (const m of require('./mirrors').mirrorsOf(deviceId)) queueOrEmitPlaylistUpdate(deviceNs, m.id, buildPayload, true);
    } catch (e) { /* mirrors are best effort */ }
  }
  const room = deviceNs.adapter.rooms.get(deviceId);
  if (room && room.size > 0) {
    const payload = buildPayload(deviceId);
    deviceNs.to(deviceId).emit('device:playlist-update', payload);
    // 3.0.1: when what the screen was told to show CHANGED, refresh its preview once it has drawn
    // it (lib/preview-refresh.js: same-payload re-pushes cost nothing; debounced, a floor per
    // screen, a cap per node). Lazy, never fatal.
    try { require('./preview-refresh').notePush(deviceId, payload); } catch (e) { /* best effort */ }
    return { delivered: true };
  }
  pendingPlaylistUpdate.set(deviceId, { expiresAt: Date.now() + config.commandQueueTtlMs });
  return { delivered: false, queued: true };
}

/*
 * ⚠️ SIZE CAPS. "Last-of-type wins" bounds the COUNT of queued commands per screen (the callers'
 * allowlist is ~30 types), but not their SIZE: payloads were held verbatim and a dashboard socket
 * message may be up to 10 MB, so an editor could park ~30 x 10 MB against every offline screen in
 * their workspace — for 7 days on an embedded panel (ttlForDevice). Every real command payload is
 * well under a kilobyte (a URL, a level, a schedule, an http_request with a modest body), so these
 * limits sit two orders of magnitude above real use. Over a cap the command is NOT queued and the
 * caller reports 'offline' (deliverCommand), which is what happened before for a screen with no
 * queue at all — refused visibly, never silently truncated.
 */
const MAX_COMMAND_PAYLOAD_BYTES = 64 * 1024;
const MAX_DEVICE_QUEUE_BYTES = 256 * 1024;

function payloadBytes(type, payload) {
  try { return Buffer.byteLength(String(type)) + Buffer.byteLength(JSON.stringify(payload || {}) || ''); }
  catch (_) { return Infinity; }   // circular / unserialisable: it could never be emitted anyway
}

// Queue a single command for an offline device. Returns true if accepted, false when it is
// refused (no device/type, or over a size cap above). Used by item 6 in commit D - dashboard
// command handler calls this when the device room is empty.
function queueCommand(deviceId, type, payload, opts = {}) {
  if (!deviceId || !type) return false;
  const bytes = payloadBytes(type, payload);
  if (bytes > MAX_COMMAND_PAYLOAD_BYTES) return false;
  pruneDevice(deviceId);
  let perDevice = pendingCommands.get(deviceId);
  // The entry this one replaces (same type) does not count against the budget.
  let held = 0;
  if (perDevice) for (const [t, e] of perDevice) if (t !== type) held += e.bytes || 0;
  if (held + bytes > MAX_DEVICE_QUEUE_BYTES) return false;
  if (!perDevice) {
    perDevice = new Map();
    pendingCommands.set(deviceId, perDevice);
  }
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : config.commandQueueTtlMs;
  perDevice.set(type, { payload: payload || {}, bytes, expiresAt: Date.now() + ttl });
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
      // The reconnect flush: a baseline for the preview refresh, never an ask (a mass reconnect).
      const payload = buildPayload(deviceId);
      try { require('./preview-refresh').seen(deviceId, payload); } catch (e) { /* best effort */ }
      deviceNs.to(deviceId).emit('device:playlist-update', payload);
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

function peekPendingCommands(deviceId) {
  if (!deviceId) return [];
  pruneDevice(deviceId);
  const cmds = pendingCommands.get(deviceId);
  if (!cmds || cmds.size === 0) return [];
  const out = [];
  for (const [type, entry] of cmds) {
    out.push({ type, payload: entry.payload });
  }
  return out;
}

function popCommand(deviceId, type) {
  if (!deviceId || !type) return null;
  pruneDevice(deviceId);
  const cmds = pendingCommands.get(deviceId);
  if (!cmds || !cmds.has(type)) return null;
  const entry = cmds.get(type);
  cmds.delete(type);
  if (cmds.size === 0) pendingCommands.delete(deviceId);
  return { type, payload: entry.payload };
}

module.exports = {
  queueOrEmitPlaylistUpdate,
  queueCommand,
  flushQueue,
  popPendingCommands,
  peekPendingCommands,
  popCommand,
  ttlForDevice,
  getQueueDepth,
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_DEVICE_QUEUE_BYTES,
  startSweep,
  stopSweep,
  _resetForTests,
};
