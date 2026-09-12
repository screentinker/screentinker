'use strict';

const playerCapabilities = require('./player-capabilities');

/*
 * DELIVERING ONE COMMAND TO ONE SCREEN — the single definition.
 *
 * This existed three times: the dashboard socket handler, the group fan-out route, and (once the
 * mesh needed it) a third. Each did the same four things — check the panel can honour the command,
 * find its room, emit or queue, report which — and they had already drifted: the socket path queues
 * for an offline device and the group path does not. That is the shape the fan-out helper
 * (lib/devices-playing.js) was extracted for, arriving in a different corner of the same codebase.
 */

/**
 * Everything an operator may send from this server's own UI or API.
 *
 * ⚠️ Includes `shell` and `install_apk`, which are remote code execution and remote software
 * installation. They are legitimate for an operator acting on their OWN fleet through their own
 * dashboard; see MESH_COMMANDS for why that does not extend to another server.
 */
const ALLOWED_COMMANDS = Object.freeze([
  'screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown',
  // #161 Tier-2 (owner-gated on the panel; STPolicy no-ops off-tier so a stray send is inert):
  'power_menu', 'lock_now', 'kiosk_lock', 'kiosk_unlock',
  'set_time', 'set_timezone', 'status_bar', 'block_uninstall', 'unblock_uninstall',
  // #161 device-owner tooling: remote shell (app-UID diagnostics) + push/install an APK from a URL.
  'shell', 'install_apk',
  // #160 Track-A system control (no device owner): media volume + per-window brightness (Tier 0),
  // system brightness + screen-off timeout (Tier 1 / WRITE_SETTINGS). Panel no-ops if unsupported.
  'set_volume', 'set_brightness', 'set_system_brightness', 'set_screen_timeout',
  // #312 follow-up: rewrite the device's stored server URL, so a relocated server can be pointed at
  // from the dashboard instead of visiting every panel. The panel VERIFIES the new address is
  // reachable before committing and rolls back if not (a fat-fingered URL must not strand a fleet),
  // which is why it is gated on remote.set_server_url — a player only declares it once it does that.
  'set_server_url',
]);

/*
 * ⚠️ WHAT ANOTHER SERVER MAY SEND — A SUBSET, AND THE CONSENT TEXT IS WHY.
 *
 * The device-command grant says, in the words the customer reads before ticking it: "Reboot,
 * reload, change settings on screens." It does not say "and run shell commands on them, and install
 * software from a URL." Allowlisting the full command set under that sentence would make the
 * consent screen a lie — and a consent screen that overstates what it grants is worse than no
 * consent screen, because it is believed.
 *
 * So the mesh gets the commands the sentence actually describes. Excluded, deliberately:
 *
 *   shell, install_apk    — remote code execution and remote software installation. Nobody grants
 *                           these by ticking a box that says "reboot and change settings", and no
 *                           wording would make them a reasonable default for a third party.
 *   power_menu, lock_now, kiosk_lock, kiosk_unlock, block_uninstall, unblock_uninstall
 *                         — device-owner controls. These change what the person STANDING AT the
 *                           panel can do, which is a different kind of power from changing what it
 *                           displays, and it belongs to whoever owns the hardware.
 *   update                — triggers an OTA install. A hub deciding when a customer's estate takes
 *                           new software is a scheduling decision with an outage attached, and the
 *                           OTA machinery already has its own opt-in per display.
 *
 * ⚠️ If this list ever grows, the consequence text in lib/mesh/grants.js grows with it, in the same
 * commit. That pairing is the entire point.
 */
const MESH_COMMANDS = Object.freeze([
  'screen_on', 'screen_off', 'reboot', 'launch',
  'set_volume', 'set_brightness', 'set_system_brightness', 'set_screen_timeout',
  'set_time', 'set_timezone', 'status_bar',
]);

function isMeshCommand(type) {
  return MESH_COMMANDS.includes(type);
}

/**
 * Deliver one command, or say precisely why it did not go.
 *
 * ⚠️ Refuses a command the panel cannot honour BEFORE sending it, with the missing capability
 * named. Hiding a button is not enforcement: this arrives from a socket that is reachable directly,
 * from group sends that fan out across mixed-platform fleets, and from dashboard tabs left open
 * long enough to be rendering controls the panel no longer declares. A command delivered and
 * silently ignored is the failure the capability mechanism exists to end.
 *
 * @returns {{status:'sent'|'queued'|'offline'|'unsupported', capability?:string}}
 */
function deliverCommand(deviceNs, device, type, payload) {
  const verdict = playerCapabilities.commandAllowed(device, type);
  if (!verdict.ok) return { status: 'unsupported', capability: verdict.capability };

  const room = deviceNs.adapter.rooms.get(device.id);
  if (room && room.size > 0) {
    deviceNs.to(device.id).emit('device:command', { type, payload: payload || {} });
    return { status: 'sent' };
  }

  /*
   * Offline: try to queue. Lazily required so that reverting the queue commit cannot break this
   * one — a MODULE_NOT_FOUND on the first attempt is cached by Node's loader, which gives a
   * consistent queued=false on every call afterwards rather than an intermittent throw.
   */
  let queued = false;
  try {
    queued = require('./command-queue').queueCommand(device.id, type, payload);
  } catch (e) { /* queue module absent — the command is simply lost, and says so */ }
  return { status: queued ? 'queued' : 'offline' };
}

/**
 * Payload validation for the commands that carry one that can do harm if malformed. Checked ONCE
 * per operator request, before any fan-out, so a bad `set_server_url` is refused at the door rather
 * than pushed to a fleet. Commands with no dangerous payload pass through.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateCommand(type, payload) {
  if (type === 'set_server_url') {
    const url = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!url) return { ok: false, error: 'set_server_url requires payload.url' };
    let u;
    try { u = new URL(url); } catch (_) { return { ok: false, error: 'payload.url is not a valid URL' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'payload.url must be http or https' };
    }
    if (!u.hostname) return { ok: false, error: 'payload.url must have a host' };
  }
  return { ok: true };
}

module.exports = { ALLOWED_COMMANDS, MESH_COMMANDS, isMeshCommand, deliverCommand, validateCommand };
