'use strict';

const playerCapabilities = require('./player-capabilities');
const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const enrolKey = require('./enrol-key');   // #312/#313: URL-carried identity for a web-player move

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
  /*
   * ⚠️ `refresh` was IMPLEMENTED ON THE PANEL AND UNSENDABLE — MainActivity has handled it for a
   * long time (it reconnects the socket, so the panel re-fetches its playlist) and nothing anywhere
   * on the server could ask for it. Found by the local-API allowlist drift test, which asserts every
   * command that door offers is a command the panel already has: the door wanted `refresh`, and the
   * subset check failed because it was not in this list rather than because the panel lacked it.
   *
   * Ungated deliberately. A new capability sits in no baseline, so gating it would make it refused
   * on every fielded player — i.e. the fix would ship as a no-op. A web player simply ignores it,
   * the same as the other panel-specific commands here.
   */
  'refresh',
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
  /*
   * Display power schedule — the weekly backlight clock (lib/power-window.js). This hands the panel
   * a DEFINITION, not an instruction to go dark now: the panel evaluates it locally and keeps
   * evaluating it with the WAN down, which is the whole reason it is pushed rather than enforced
   * server-side. Gated on display.power_schedule, NOT display.power — see COMMAND_CAPABILITY.
   */
  'set_power_schedule',
  /*
   * Goal B: make the PANEL perform an HTTP request from its own network, so a LAN address — the
   * PLC, the sensor, the local Home Assistant — is reachable at all. Routing it through this
   * server instead would defeat the entire feature: the server is frequently in another country
   * and has no path to the shop's 192.168.x.x.
   *
   * ⚠️ DELIBERATELY NOT A MESH COMMAND. See MESH_COMMANDS below.
   */
  'http_request',
]);

/*
 * ⚠️ WHAT A LAN CALLER MAY ASK FOR — A MUCH SMALLER SUBSET, AND WHO THE CALLER IS IS WHY.
 *
 * Goal B part 3 lets a room control system on the customer's LAN POST to the PANEL directly. This
 * list is not enforced here — the panel enforces it, because the panel is what receives the request
 * and this server is not in the path at all. It exists here so the dashboard and the docs can name
 * the set, and `server/test/local-api-allowlist.test.js` HOLDS IT TO THE KOTLIN, which is the
 * authoritative copy. Two lists that can drift is the trap; a test that fails when they do is the
 * answer, and it is the same device the shared vector files use for the resolvers.
 *
 * Why so much smaller than MESH_COMMANDS, let alone the full set: a dashboard command carries a
 * session or a `full` token held by someone who can already see the whole fleet. This one carries a
 * secret that gets typed into a Crestron program, committed to a site's integration repo, mailed to
 * a subcontractor, and left in place for the life of the building. It is a room-control credential,
 * so it gets the room-control command set — and notably NOT `shell`, `install_apk`, `update`,
 * `set_server_url` (a complete takeover of the screen from inside the LAN), `launch`, `settings`,
 * `kiosk_unlock`, or `http_request` (which would make every panel a request relay whose audit trail
 * names the screen instead of the caller). `reboot` is out of v1 for a different reason: everything
 * on this list is undone by sending its opposite, and a reboot is not — a reboot loop from a stuck
 * automation is a fleet on the floor. Adding it later is one line; taking it back is a site visit.
 *
 * See android/.../net/LocalApi.kt for the per-command reasoning.
 */
const LOCAL_API_COMMANDS = Object.freeze([
  'refresh', 'screen_on', 'screen_off', 'set_volume', 'set_brightness', 'set_system_brightness',
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
  /*
   * set_power_schedule is IN, and the consent sentence already covers it: "change settings on
   * screens". A weekly backlight clock is a setting of exactly the kind set_screen_timeout beside
   * it already is, and it is strictly gentler than the screen_off two lines up — that one blanks a
   * screen NOW with no end, this one blanks it between hours the customer can read back in their
   * own dashboard. The grant's consequence text gained the sentence naming it in this same commit,
   * per the ⚠️ above.
   */
  'set_power_schedule',
  /*
   * ⚠️ http_request IS ABSENT FROM THIS LIST, AND MUST STAY ABSENT.
   *
   * The consent sentence is "Reboot, reload, change settings on screens." Making someone else's
   * panel issue arbitrary HTTP requests from inside their LAN is not a setting — it is using their
   * screen as a foothold on a network the hub cannot otherwise reach, which is the textbook shape
   * of a confused deputy. The panel is by design the one thing standing on the private side of the
   * customer's firewall, and that is precisely why a third-party server must not get to aim it.
   *
   * No wording fixes this. A consent line honest enough to cover it — "this hub may make your
   * screens fetch any address on your network and send it the result" — is one nobody would tick,
   * which is the right answer rather than a copywriting problem.
   */
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
 * @returns {{status:'sent'|'relayed'|'queued'|'offline'|'unsupported', capability?:string, via?:string}}
 */
function deliverCommand(deviceNs, device, type, payload) {
  const verdict = playerCapabilities.commandAllowed(device, type);
  if (!verdict.ok) return { status: 'unsupported', capability: verdict.capability };

  // #312/#313: a web player (browser tab) has origin-scoped storage, so it cannot follow a server
  // move without carrying its identity in the URL. On an operator's set_server_url — and ONLY then,
  // which is why the mint lives on this operator-gated path and not in the device socket — hand the
  // web player an enrol key to redirect with. The native Android app (client_type 'apk') carries
  // its own token, so it needs none. Reuse an existing key rather than rolling one on every send.
  let outPayload = payload || {};

  /*
   * ⚠️ MINT A REQUEST ID FOR http_request, and hand it back to the caller.
   *
   * Without this the panel generates its own UUID when the payload carries none, so the result
   * arrives tagged with an id the caller has never seen. With two requests in flight to one screen
   * — an endpoint poll and an operator pressing "test" — the two answers are indistinguishable,
   * which defeats the point of returning a result at all.
   *
   * Minted HERE rather than in each route so every send path gets it: the REST route, the dashboard
   * socket, and the group and workspace fan-outs, where each device correctly gets its OWN id.
   * A caller that supplies its own id keeps it.
   */
  let requestId = null;
  if (type === 'http_request') {
    requestId = (outPayload.id && String(outPayload.id)) || uuidv4();
    outPayload = Object.assign({}, outPayload, { id: requestId });
  }

  if (type === 'set_server_url' && device.client_type === 'player') {
    let key = null;
    try {
      const row = db.prepare('SELECT enrol_key FROM devices WHERE id = ?').get(device.id);
      key = (row && row.enrol_key) || enrolKey.setEnrolKey(db, device.id);
    } catch (_) { /* if we cannot mint, the redirect falls back to a re-pair on the new origin */ }
    if (key) outPayload = Object.assign({}, outPayload, { enrol_key: key });
  }

  const room = deviceNs.adapter.rooms.get(device.id);
  if (room && room.size > 0) {
    deviceNs.to(device.id).emit('device:command', { type, payload: outPayload });
    return requestId ? { status: 'sent', id: requestId } : { status: 'sent' };
  }

  /*
   * Scale-out C2: no socket here, but the screen is attached to a replica — the command travels UP
   * that edge as a command-relay and the replica emits it to the socket it holds. 'relayed' is a
   * delivery, not a queue: the uplink buffers across a brief reconnect and the relay carries the
   * same TTL discipline the queue does on the far side.
   */
  if (device.attached_node_id) {
    try {
      if (require('./mesh/command-relay').relayToAttached(db, device.id, 'device:command', { type, payload: outPayload })) {
        return requestId ? { status: 'relayed', via: device.attached_node_id, id: requestId }
                         : { status: 'relayed', via: device.attached_node_id };
      }
    } catch (e) { /* fall through to the queue */ }
  }

  /*
   * Offline: try to queue. Lazily required so that reverting the queue commit cannot break this
   * one — a MODULE_NOT_FOUND on the first attempt is cached by Node's loader, which gives a
   * consistent queued=false on every call afterwards rather than an intermittent throw.
   */
  let queued = false;
  try {
    queued = require('./command-queue').queueCommand(device.id, type, outPayload);
  } catch (e) { /* queue module absent — the command is simply lost, and says so */ }
  const out = { status: queued ? 'queued' : 'offline' };
  if (requestId) out.id = requestId;
  return out;
}

/**
 * Payload validation for the commands that carry one that can do harm if malformed. Checked ONCE
 * per operator request, before any fan-out, so a bad `set_server_url` is refused at the door rather
 * than pushed to a fleet. Commands with no dangerous payload pass through.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
/**
 * Methods a screen may be asked to issue.
 *
 * ⚠️ An allowlist, not a denylist. TRACE reflects request headers (including any Authorization the
 * endpoint carries) back into a response body we then store and show, and CONNECT asks the panel
 * to open a tunnel. Neither has a signage use, and "everything except the two we thought of" is
 * the shape that ages badly.
 */
const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

function validateCommand(type, payload) {
  if (type === 'http_request') {
    const p = payload || {};
    /*
     * The SAME guard the panel enforces (shared/http-target-vectors.json), consulted rather than
     * reimplemented. Strict here, forgiving there: an operator who types file:/// deserves a 400
     * naming the problem, not a silent no-op on a screen they cannot see. The panel still checks
     * for itself, because a stored endpoint can be edited in the database.
     */
    const verdict = require('./http-target-guard').check(p.url);
    if (!verdict.allow) {
      return { ok: false, error: `http_request: ${require('./http-target-guard').explain(verdict.reason)}` };
    }
    if (p.method !== undefined && p.method !== null) {
      const m = String(p.method).toUpperCase();
      if (!HTTP_METHODS.includes(m)) {
        return { ok: false, error: `http_request: method must be one of ${HTTP_METHODS.join(', ')}` };
      }
    }
    if (p.headers !== undefined && p.headers !== null
        && (typeof p.headers !== 'object' || Array.isArray(p.headers))) {
      return { ok: false, error: 'http_request: headers must be an object' };
    }
    if (p.timeout_ms !== undefined && p.timeout_ms !== null) {
      const t = Number(p.timeout_ms);
      if (!Number.isFinite(t) || t <= 0 || t > 120000) {
        return { ok: false, error: 'http_request: timeout_ms must be between 1 and 120000' };
      }
    }
    return { ok: true };
  }

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

module.exports = { ALLOWED_COMMANDS, MESH_COMMANDS, LOCAL_API_COMMANDS, HTTP_METHODS, isMeshCommand, deliverCommand, validateCommand };
