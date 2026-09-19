'use strict';

/*
 * What one node is allowed to see of another.
 *
 * ⚠️ DATA CATEGORIES, NOT READ/WRITE. This is the distinction a client's security review actually
 * turns on. "Read" as a single permission would mean device names, LAN and public WAN addresses,
 * content metadata and screenshots all travelling together into someone else's database — and a
 * client who wants their MSP to see that screens are alive, but not what is playing on them or where
 * they are, would have no way to say so. Every category below is separately grantable and separately
 * deniable.
 *
 * The vocabulary comes from the Phase −1 inventory (docs/mesh-telemetry-inventory.md), which counted
 * what is actually collected rather than what the schema declares. Two consequences of that audit are
 * baked in here:
 *
 *   - PUBLIC/WAN ADDRESS IS ITS OWN CATEGORY, split from LAN. It is populated for 509 of 509
 *     production devices and it locates a client's premises. A "health only" grant that still shipped
 *     the public IP of every screen would fail the review this exists for.
 *   - THERE IS NO wifi-ssid CATEGORY, because that field is being dropped. 94% of it was not an SSID
 *     and the remainder was geolocatable customer network names.
 *
 * ⚠️ EVERY CATEGORY DEFAULTS TO DENIED. An empty grant is a valid grant that yields nothing but the
 * fact that the node exists. There is no "all" shorthand and no wildcard — a grant is an explicit
 * list, so adding a category in a later version cannot retroactively widen an existing edge. That is
 * the single most important property in this file.
 *
 * ⚠️ ENFORCED AT THE SOURCE (invariant I10). The node that owns the data decides what leaves it. A
 * denied category is never sent — not sent-and-filtered, not sent-and-hidden. The receiving node is
 * never trusted to police what it was given, because the whole point is that it belongs to someone
 * else.
 */

/**
 * READ categories — implemented in 2.0.
 * `implies` is documentation of consequence, not a widening: granting `identity` does not
 * auto-grant anything. It records what an operator is really agreeing to.
 */
const READ_CATEGORIES = Object.freeze({
  'health': {
    summary: 'Whether screens are alive and how they are coping',
    fields: 'uptime, storage, RAM, CPU, battery, Wi-Fi signal strength',
    consequence: 'Shows that a screen is up or down. Says nothing about what it is showing.',
  },
  'identity': {
    summary: 'What each screen is called and what it runs',
    fields: 'device name, hardware model, serial, app and OS version',
    consequence: 'Without this, devices appear as opaque ids and are NOT searchable by name. ' +
                 'The empty state must say so, or a health-only grant reads as a broken search.',
  },
  'network-lan': {
    summary: 'Private addresses on the local network',
    fields: 'LAN IPv4/IPv6 address',
    consequence: 'Useful for on-site support. Does not identify the site to an outsider.',
  },
  'network-wan': {
    summary: 'The public internet address the screens appear from',
    fields: 'public/WAN address',
    consequence: '⚠️ Locates the premises. A public IP is geolocatable to a town or building. ' +
                 'Deliberately separate from network-lan so it can be denied on its own.',
  },
  'display': {
    summary: 'What the screen hardware is doing',
    fields: 'attached display, video mode, orientation, resolution',
    consequence: 'Hardware state only. Does not include screenshots — see display-capture.',
  },
  'display-capture': {
    summary: 'Actual images of what is on screen',
    fields: 'screenshots',
    consequence: '⚠️ Reveals the content itself, including anything incidentally on screen. ' +
                 'The most sensitive read category; separate from display for that reason.',
  },
  'content-metadata': {
    summary: 'What is scheduled to play',
    fields: 'playlist and content names, schedules, assignment',
    consequence: 'Reveals campaign and tenant names, which are commercially sensitive on their own.',
  },
  'proof-of-play': {
    summary: 'Evidence that specific content played at specific times',
    fields: 'play logs',
    consequence: 'The billing artifact for advertising. ⚠️ Must not be downsampled at any depth ' +
                 '(see Phase 4): an averaged proof-of-play is worthless as evidence.',
  },
  'diagnostics': {
    summary: 'Why something went wrong',
    fields: 'device events, status log with offline reason, debug logs',
    consequence: 'Can contain error text and URLs from the running content.',
  },
  /*
   * Scale-out (docs/scale-out-design.md §3). A faithful copy, so the projection is "every column
   * EXCEPT the blocklist" in lib/mesh/replication.js — the one delete-based filter in the mesh, and
   * a schema test (test_replication_blocklist_covers_every_secret_column) is what keeps a secret
   * column added later from shipping by omission.
   */
  'workspace-replication': {
    summary: 'A full, kept-current copy of the shared workspaces for a read-only dashboard',
    fields: 'every configuration and state row of the shared workspaces: content, playlists, ' +
            'schedules, layouts, devices, groups, activity, play history, members',
    consequence: 'The other server holds a complete copy of these workspaces and keeps it current. ' +
                 'Passwords, tokens and secrets are never copied.',
    implies: ['health', 'identity', 'content-metadata', 'proof-of-play', 'diagnostics'],
  },
});

/**
 * WRITE categories — grantable ONLY by the node being written to.
 *
 * ⚠️ THE ASYMMETRY WITH READS IS THE WHOLE DESIGN. A read grant is authored by the parent when it
 * mints a pairing code, and the child stores that answer verbatim; every read category is read-only
 * by construction, so the worst case is that the child gave away more visibility than it meant to
 * and can see exactly what. A write grant authored by the parent would be the parent writing its own
 * permission into the child's database — and the child would then enforce it faithfully, which is
 * worse than not enforcing at all, because it looks correct.
 *
 * So these are refused by `validateGrant()` — the function every wire path uses — and accepted only
 * by `validateWriteConsent()`, which is reachable solely from an authenticated operator request on
 * the granting node. There is no path from a peer's message to a stored write category.
 */
const WRITE_CATEGORIES = Object.freeze({
  'content-push': {
    summary: 'Send content and playlists downward',
    /*
     * ⚠️ Says BOTH things it costs, because the second one is easy to miss. Changing what plays is
     * the obvious consequence; storing the files that play is the one an operator only discovers
     * when a disk fills. The specific byte figure is appended by the consent route, which knows it.
     */
    consequence: 'This hub will be able to change what plays on your screens, and to store files ' +
                 'on this server up to the limit you set.',
  },
  'device-command': {
    summary: 'Reboot, reload, change settings on screens',
    /*
     * ⚠️ ENUMERATES, because the sentence IS the boundary. lib/device-command.js permits a subset
     * of what an operator may send from their own dashboard, and the excluded ones are excluded
     * precisely because nobody grants remote shell or software installation by ticking a box that
     * says "reboot and change settings". If that subset ever grows, this sentence grows with it in
     * the same commit.
     */
    consequence: 'This hub will be able to restart your screens, turn them on and off, relaunch ' +
                 'the player, and change volume, brightness, screen timeout, clock and status bar. ' +
                 'It will NOT be able to run commands on them, install software, or change what ' +
                 'the person standing at the screen can do.',
    /*
     * ⚠️ WAS "defined but not implemented" AND IS NOW REAL. Kept for the record, because the shape
     * of the fix matters: the answer was not to allowlist the command surface under the existing
     * sentence, but to permit the subset that sentence actually describes and enumerate it.
     *
     * The original note follows.
     *
     * Every rule in write-proxy.WRITABLE requires 'content-push'; there is no rule any
     * device-command grant could satisfy, and the hub-side action name ('command-devices') is
     * never checked anywhere either. So an operator could read this consequence, tick the box,
     * and grant a permanent no-op — believing they had allowed something they had not, which is
     * the worse direction for a consent screen to be wrong in.
     *
     * Device commands travel over the socket rather than the HTTP surface the allowlist covers, so
     * this is a feature to build, not a line to add. Until then it is refused at the door and
     * rendered unavailable, per the note in client-roles.js: a capability that does not exist
     * reads as a promise the product does not keep.
     */
  },
  /*
   * Scale-out C2 (docs/scale-out-design.md §6). Set on the PRIMARY, by the primary's operator, for
   * the edge to a replica that declared `terminates-players`. It is the I2 accounting for a player
   * event arriving over the wire: a write at the data owner, permitted only because the owner's
   * operator ticked this. Scope is the workspaces whose screens may report through that replica.
   */
  'player-events': {
    summary: 'Let screens connect through the other server and report back here',
    consequence: 'Screens that connect to the other server will be verified here and their ' +
                 'reports — online/offline, health, what played, command results — will be ' +
                 'written to this server as if they were connected directly. Commands you send ' +
                 'those screens travel through the other server. A screen\'s token never leaves ' +
                 'this server.',
  },
});

const ALL_READ = Object.freeze(Object.keys(READ_CATEGORIES));
const ALL_WRITE = Object.freeze(Object.keys(WRITE_CATEGORIES));

/** Is this a category name we know at all? */
function isKnownCategory(name) {
  return Object.prototype.hasOwnProperty.call(READ_CATEGORIES, name)
      || Object.prototype.hasOwnProperty.call(WRITE_CATEGORIES, name);
}

function isWriteCategory(name) {
  return Object.prototype.hasOwnProperty.call(WRITE_CATEGORIES, name);
}

/**
 * Validate a requested grant.
 *
 * ⚠️ REFUSAL IS EXPLICIT AND OPERATOR-READABLE (directive: "never accept-and-silently-degrade").
 * A node asked for something it will not give says so, in a sentence a person can act on. Quietly
 * dropping the categories it dislikes and accepting the rest is how an operator ends up believing
 * they granted something they did not — or that they granted less than they did.
 *
 * @param {string[]} requested
 * @returns {{ok: true, categories: string[]} | {ok: false, reason: string, rejected: string[]}}
 */
function validateGrant(requested) {
  if (!Array.isArray(requested)) {
    return { ok: false, reason: 'A grant must be a list of data categories.', rejected: [] };
  }

  const unknown = requested.filter((c) => !isKnownCategory(c));
  if (unknown.length) {
    return {
      ok: false,
      rejected: unknown,
      reason: `This node does not recognise the data ${unknown.length === 1 ? 'category' : 'categories'} ` +
              `${unknown.map((c) => `"${c}"`).join(', ')}. It may be newer than this node — ` +
              `known categories are: ${ALL_READ.join(', ')}.`,
    };
  }

  const writes = requested.filter(isWriteCategory);
  if (writes.length) {
    return {
      ok: false,
      rejected: writes,
      reason: `Write access (${writes.join(', ')}) cannot be granted this way. A write permission is ` +
              `chosen by the node being written to, by an operator on that node, after reading what ` +
              `it allows — never by the node requesting it, and never over the wire. Ask this ` +
              `node's operator to grant it from their own Servers page.`,
    };
  }

  // Duplicates are an operator slip, not an attack — normalise rather than refuse.
  return { ok: true, categories: [...new Set(requested)] };
}

/**
 * Does a validated grant permit this category?
 *
 * Deliberately takes the stored list rather than an edge row, so the check is impossible to
 * accidentally perform against the requesting node's copy of the grant. Callers live on the owning
 * node by construction (I10).
 */
function grantAllows(grantedCategories, category) {
  if (!Array.isArray(grantedCategories)) return false;
  // No wildcard on purpose: a future category must never be implicitly included in an old grant.
  return grantedCategories.includes(category);
}

/**
 * Validate write categories offered by an operator ON THE GRANTING NODE.
 *
 * ⚠️ The only function in this file that may return write categories as `ok`. Its caller must be an
 * authenticated request on the node that owns the screens — never anything derived from a peer
 * message. Read categories are refused here for the mirror-image reason writes are refused on the
 * wire: mixing them would make one route able to widen the other's column.
 *
 * @returns {{ok: true, categories: string[]} | {ok: false, reason: string, rejected: string[]}}
 */
function validateWriteConsent(requested) {
  if (!Array.isArray(requested)) {
    return { ok: false, reason: 'A write grant must be a list of categories.', rejected: [] };
  }
  const unknown = requested.filter((c) => !isKnownCategory(c));
  if (unknown.length) {
    return {
      ok: false,
      rejected: unknown,
      reason: `Unrecognised ${unknown.length === 1 ? 'category' : 'categories'} ` +
              `${unknown.map((c) => `"${c}"`).join(', ')}. Write categories are: ${ALL_WRITE.join(', ')}.`,
    };
  }
  const reads = requested.filter((c) => !isWriteCategory(c));
  if (reads.length) {
    return {
      ok: false,
      rejected: reads,
      reason: `${reads.join(', ')} ${reads.length === 1 ? 'is a read category' : 'are read categories'} ` +
              `and is set when the connection is made, not here.`,
    };
  }
  /*
   * ⚠️ Refused at the door rather than stored and quietly ignored. A category with no enforcement
   * rule behind it grants nothing, and an operator who ticked it would believe otherwise — the
   * consent screen's only job is to be true.
   */
  const unavailable = requested.filter((c) => WRITE_CATEGORIES[c] && WRITE_CATEGORIES[c].available === false);
  if (unavailable.length) {
    return {
      ok: false,
      rejected: unavailable,
      reason: `${unavailable.join(', ')} cannot be granted yet — this server has no way to act on ` +
              `${unavailable.length === 1 ? 'it' : 'them'}, so granting would permit nothing. ` +
              'Leave it unticked until it is supported.',
    };
  }

  return { ok: true, categories: [...new Set(requested)] };
}

/**
 * May this edge perform this write, on this workspace?
 *
 * ⚠️ Both halves are required and both come from the CHILD's own stored row — never from the
 * request. A scope of NULL or [] denies everything: absent means nothing here, deliberately the
 * opposite of `shared_workspaces`, so that a write grant cannot become total by being unset.
 */
function writeAllows(writeGrant, writeScope, category, workspaceId) {
  if (!Array.isArray(writeGrant) || !writeGrant.includes(category)) return false;
  if (!Array.isArray(writeScope) || writeScope.length === 0) return false;
  if (!workspaceId) return false;
  return writeScope.includes(workspaceId);
}

/**
 * Would accepting `incomingBytes` stay inside what this edge was granted?
 *
 * ⚠️ Checked BEFORE any bytes move, never after four files of six are on disk. A transfer that
 * discovers the limit halfway has already spent the disk it was supposed to protect, and left the
 * operator with a half-populated playlist to reason about.
 *
 * ⚠️ An absent budget denies. NULL is not "unlimited" here for the same reason `write_scope` NULL is
 * not "everywhere": a permission that becomes total by being unset is the failure this whole design
 * is built against.
 */
function budgetAllows(budgetBytes, usedBytes, incomingBytes) {
  if (typeof budgetBytes !== 'number' || !Number.isFinite(budgetBytes) || budgetBytes <= 0) return false;
  const used = typeof usedBytes === 'number' && Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  const want = typeof incomingBytes === 'number' && Number.isFinite(incomingBytes) && incomingBytes > 0
    ? incomingBytes : 0;
  return used + want <= budgetBytes;
}

/** Bytes as something an operator reads without counting zeroes. */
function describeBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 'nothing';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(v < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}

/** Plain-language consequences, for the confirmation UI on the GRANTING node. */
function describeGrant(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return ['This node will be visible, but no data about it will be shared.'];
  }
  return categories
    .filter(isKnownCategory)
    .map((c) => (READ_CATEGORIES[c] || WRITE_CATEGORIES[c]).consequence);
}

module.exports = {
  READ_CATEGORIES,
  WRITE_CATEGORIES,
  ALL_READ,
  ALL_WRITE,
  isKnownCategory,
  isWriteCategory,
  validateGrant,
  validateWriteConsent,
  grantAllows,
  writeAllows,
  budgetAllows,
  describeBytes,
  describeGrant,
};
