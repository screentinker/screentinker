'use strict';

/*
 * Scale-out C2, PRIMARY side (docs/scale-out-design.md §6): a server-to-player message for a screen
 * that is connected to a REPLICA, not here. deliverCommand finds no local socket, reads
 * devices.attached_node_id, and hands the message to this module, which sends `command-relay` UP
 * the edge to that node. The replica delivers it to the socket it holds; the player's answer comes
 * back as an ordinary player-event.
 *
 * ⚠️ Permitted because the REPLICA's operator declared terminates-players for the edge — a parent
 * acting on its child's upward message. It reaches only the screens this node owns AND that node
 * has attached: the replica checks both on arrival (lib/mesh/player-termination.js deliverRelay).
 * The edge is looked up by the stored attachment; nothing in a request names the node.
 */

/** Which replica a screen is attached through, or null when it is connected here / nowhere. */
function attachedNodeOf(db, deviceId) {
  try {
    const row = db.prepare('SELECT attached_node_id FROM devices WHERE id = ?').get(deviceId);
    return (row && row.attached_node_id) || null;
  } catch (e) { return null; }
}

/**
 * Send one message to a replica-attached screen. Returns true when it was handed to a live (or
 * reconnecting) uplink, false when there is no such link — the caller then treats the screen as
 * offline, exactly as it would with no socket.
 */
const relayedTo = new Map();   // nodeId -> command-relays handed to the uplink (NOC counter)
function relayToAttached(db, deviceId, event, payload, uplinks = global.__meshUplinks) {
  const nodeId = attachedNodeOf(db, deviceId);
  if (!nodeId || !uplinks || typeof uplinks.sendTo !== 'function') return false;
  const ok = uplinks.sendTo(nodeId, 'command-relay', { device_id: deviceId, event, payload: payload == null ? {} : payload });
  if (ok) relayedTo.set(nodeId, (relayedTo.get(nodeId) || 0) + 1);
  return ok;
}
function relayedCount(nodeId) { return relayedTo.get(nodeId) || 0; }

module.exports = { attachedNodeOf, relayToAttached, relayedCount };
