// Phase 2.3: helpers for resolving socket.io room names per workspace /
// device / wall. Extracted from ws/dashboardSocket.js to break a circular
// dependency: dashboardSocket already requires services/heartbeat, so
// heartbeat can't require dashboardSocket. Everything goes through this
// neutral module instead.
const { db } = require('../db/database');

const ROOM_PREFIX = 'workspace:';

/*
 * Where events about a device that belongs to NO workspace go.
 *
 * deviceRoom() used to return null for such a device and emitToWorkspace() drops a null room, so
 * every live event about it was discarded in silence — all 27 emitToDeviceWorkspace call sites:
 * device-status, screenshot-ready, playback-state/progress, content-ack, shell-result, talk-state
 * and device-log among them. A device is workspace-less for one ordinary reason — it has
 * registered itself and nobody has claimed it yet (POST /api/provision/pair is what assigns the
 * workspace, and it refuses without one) — and a platform operator CAN open that device's detail
 * page. So the operator could tick "Debug logging", the command reached the player, the player
 * streamed its lines back, and the panel stayed empty for ever with nothing logged anywhere.
 *
 * Tenants never join this room: accessibleWorkspaceIds only ever yields real workspace ids, so an
 * unclaimed screen stays invisible to them exactly as before. Only platform roles join it.
 */
const UNCLAIMED_ROOM = ROOM_PREFIX + 'unclaimed';

function workspaceRoom(workspaceId) {
  return workspaceId ? ROOM_PREFIX + workspaceId : null;
}

function deviceRoom(deviceId) {
  if (!deviceId) return null;
  const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  // A row that does not exist still has no room. A row that exists but is unclaimed gets the
  // unclaimed room rather than null — see UNCLAIMED_ROOM above for why null was not survivable.
  if (!d) return null;
  return d.workspace_id ? workspaceRoom(d.workspace_id) : UNCLAIMED_ROOM;
}

function wallRoom(wallId) {
  if (!wallId) return null;
  const w = db.prepare('SELECT workspace_id FROM video_walls WHERE id = ?').get(wallId);
  return w?.workspace_id ? workspaceRoom(w.workspace_id) : null;
}

// Emit to a workspace room with no-op on missing room. Centralized so callers
// don't have to remember the "skip if null room" guard - silent drop is safer
// than the pre-2.3 platform-wide broadcast.
function emitToWorkspace(ns, room, event, payload) {
  if (!room) return;
  ns.to(room).emit(event, payload);
}

/**
 * Every room a dashboard socket should join. Pure (no db, no auth import - this module is the
 * neutral one that breaks the dashboardSocket <-> heartbeat cycle), so it is directly testable:
 * the join is the half of the unclaimed-device fix that a deviceRoom() test cannot see.
 */
function roomsForDashboard(workspaceIds, isPlatform) {
  const rooms = (workspaceIds || []).map(workspaceRoom).filter(Boolean);
  if (isPlatform) rooms.push(UNCLAIMED_ROOM);
  return rooms;
}

module.exports = { workspaceRoom, deviceRoom, wallRoom, emitToWorkspace, roomsForDashboard, UNCLAIMED_ROOM };
