'use strict';

/*
 * What a child actually sends upward, and what it refuses to.
 *
 * ⚠️ THIS IS WHERE I10 STOPS BEING A PRINCIPLE. "Enforcement lives with the data owner" is easy to
 * agree with and easy to implement backwards: the tempting shape is to send everything and let the
 * parent store only what it was granted. That is filtering at the WRONG END — the data has already
 * crossed the wire into somebody else's process, and the client's only protection is the good
 * behaviour of a machine they do not control.
 *
 * So every projection here is built by taking the grant and adding fields to an EMPTY object. There
 * is no path that builds a full record and removes from it, because a field added to the source row
 * next year would then be shipped by default until somebody noticed.
 *
 * ⚠️ THE FIELD-TO-CATEGORY MAP IS THE PRODUCT OF THE PHASE −1 AUDIT, not a guess. Two splits look
 * fussy and are not: `network-wan` is separate from `network-lan` because a public address locates a
 * client's premises, and `display-capture` is separate from `display` because knowing the video mode
 * is not consent to see what is on screen. wifi_ssid appears nowhere — it is being dropped, and a
 * field with no category cannot be sent by construction.
 */

const { grantAllows } = require('./grants');

/**
 * Which grant category each mirrored field belongs to.
 *
 * ⚠️ A FIELD WITH NO ENTRY IS NEVER SENT. That is the important property: the default for anything
 * new is silence, so adding a column to `devices` does not quietly start exporting it to every hub a
 * client has ever paired with.
 */
const FIELD_CATEGORY = Object.freeze({
  // health
  status: 'health',
  last_heartbeat: 'health',
  uptime_seconds: 'health',
  battery_level: 'health',
  battery_charging: 'health',
  storage_free_mb: 'health',
  storage_total_mb: 'health',
  ram_free_mb: 'health',
  ram_total_mb: 'health',
  cpu_usage: 'health',
  wifi_rssi: 'health',

  // identity
  name: 'identity',
  /*
   * ⚠️ WHICH WORKSPACE A SCREEN BELONGS TO IS IDENTITY, and it degrades the same way. With the
   * grant, remote workspaces appear as separate orgs and each screen files under the right one.
   * Without it you get one flat pool per server — which is the honest degradation, not a bug: the
   * grouping reveals how a client organises their estate, and that is theirs to withhold.
   */
  workspace_id: 'identity',

  hardware_model: 'identity',
  hardware_serial: 'identity',
  app_version: 'identity',
  platform: 'identity',
  client_type: 'identity',

  // network, deliberately split
  local_ip: 'network-lan',
  local_ip6: 'network-lan',
  ip_address: 'network-wan',

  // display state vs. the picture itself
  orientation: 'display',
  screen_width: 'display',
  screen_height: 'display',
  attached_display: 'display',
  video_mode: 'display',
  /*
   * ⚠️ WHAT THE PANEL CAN ACTUALLY DO, and it travelled nowhere until now — not in the mirror, not
   * even over the live read proxy, because a field in no category is a field that never moves.
   *
   * That was survivable while a hub could only look. It stopped being survivable when a hub could
   * COMMAND: an operator can now ask a customer's screen to reboot or change its volume, and
   * without this they cannot see which of those the panel supports. They pick from a list of
   * everything, the child refuses with 'unsupported', and the refusal reads as a fault. The whole
   * point of the capability mechanism is that a command fails loudly BEFORE it is sent.
   *
   * Filed under `display` rather than a category of its own: it describes the screen, it is the
   * same kind of fact as its resolution and orientation, and a customer who shared "display"
   * already agreed to say what their screen is.
   */
  capabilities: 'display',
  screenshot_url: 'display-capture',

  // content
  playlist_name: 'content-metadata',
  playlist_id: 'content-metadata',
  /*
   * ⚠️ WHICH LAYOUT, alongside which playlist. Without it the device page renders a playlist's
   * ITEMS while its selector reads "No playlist" — the contents shared, the pointer to them not.
   * playlist_id was already here; layout_id was the one missing, and I briefly added BOTH, which
   * would have been a duplicate key silently shadowing the original.
   */
  layout_id: 'content-metadata',
  schedule_summary: 'content-metadata',

  // diagnostics
  offline_reason: 'diagnostics',
  offline_detail: 'diagnostics',
});

/**
 * Project one device row for an edge.
 *
 * ⚠️ Built by ADDING to an empty object, never by deleting from a copy. The id is always present —
 * without a stable identifier the parent cannot correlate two reports about the same screen, and a
 * grant of "health only" is meant to hide WHAT a screen is, not that it exists.
 */
function projectDevice(row, grantCategories) {
  const out = { id: row.id };
  for (const [field, category] of Object.entries(FIELD_CATEGORY)) {
    if (row[field] === undefined) continue;
    if (!grantAllows(grantCategories, category)) continue;
    out[field] = row[field];
  }
  return out;
}

/**
 * Node-level health. Always sent — it is the node reporting on ITSELF, which is the minimum any edge
 * exists for, and it contains nothing about the client's screens or content.
 */
function projectNodeHealth(node) {
  return {
    node_id: node.node_id,
    /*
     * ⚠️ UNGATED, like every other field here, and that is deliberate rather than an oversight.
     * projectNodeHealth takes no grant because a node that reports at all has already disclosed
     * that it exists and how many screens it runs; what it calls itself is strictly less than that.
     * The grant governs what a node says about its DEVICES and WORKSPACES, not its own signpost.
     */
    name: node.name || null,
    version: node.version,
    device_count: node.device_count,
    devices_online: node.devices_online,
    reported_at: node.reported_at,
  };
}

/**
 * An alert, projected for an edge.
 *
 * ⚠️ Returns null when the grant does not cover the SUBJECT of the alert. An alert naming a device
 * is a statement about that device, so "screens are offline at Acme" must not travel on an edge that
 * was never granted `identity` — it would leak by description what the grant refused by field.
 */
function projectAlert(alert, grantCategories) {
  if (!grantAllows(grantCategories, 'health')) return null;

  const out = {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    opened_at: alert.opened_at,
    closed_at: alert.closed_at || null,
    subject_count: alert.subject_count,
  };
  // Naming the affected screens is identity, and is dropped without it — the alert still travels, so
  // a hub with a health-only grant learns that something is wrong and not which screen it is.
  if (grantAllows(grantCategories, 'identity') && Array.isArray(alert.subjects)) {
    out.subjects = alert.subjects;
  }
  return out;
}

/**
 * Everything an edge is allowed to carry, by category — for the consent view and for tests.
 *
 * Derived from the same map the projections use, so a documented promise and the enforced behaviour
 * cannot drift apart.
 */
function fieldsAllowedFor(grantCategories) {
  return Object.entries(FIELD_CATEGORY)
    .filter(([, category]) => grantAllows(grantCategories, category))
    .map(([field]) => field)
    .sort();
}

module.exports = { FIELD_CATEGORY, projectDevice, projectNodeHealth, projectAlert, fieldsAllowedFor };
