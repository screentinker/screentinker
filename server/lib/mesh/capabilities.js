'use strict';

/*
 * What a node does on a given edge.
 *
 * ⚠️ A SET, NEVER AN ENUM. "Hub", "proxy", "site server", "analytics sink" are not types — they are
 * combinations of the capabilities below. #288 already proved the point by making one box a server
 * and a player at once; an enum would have needed a new member for that, and another for the next
 * combination somebody deploys.
 *
 * The test of this design is that adding a node type requires NO schema change and NO new branch in
 * the pairing logic — only a different set. If a future "regional cache that also consumes
 * proof-of-play but does not relay" needs code changes here, this file failed.
 *
 * ⚠️ CAPABILITY IS NOT PERMISSION. `relays-for-subtree` says a node will carry traffic; it says
 * nothing about what it may read. That is the grant, and it is stored separately on the same edge
 * (see grants.js). A hub edge and a proxy edge can hold identical grants and be entirely different
 * machines. Conflating the two is how "it relays for us" silently becomes "it can read everything
 * it relays" — which invariant I5 exists to forbid.
 */

const CAPABILITIES = Object.freeze({
  'accepts-enrollment': {
    summary: 'May mint pairing codes and accept child nodes',
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'relays-for-subtree': {
    summary: 'Forwards payloads on behalf of nodes below it',
    // ⚠️ I5: a relay forwards what it cannot parse, unmodified, and may read the envelope only.
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'consumes-telemetry': {
    summary: 'Stores mirrored health and device state from below',
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  'consumes-proof-of-play': {
    summary: 'Stores play logs from below',
    // ⚠️ Phase 4: proof-of-play must never be downsampled — averaged evidence is not evidence.
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  /*
   * Scale-out (docs/scale-out-design.md). This node holds a full-fidelity ROW COPY of the workspaces
   * a child shares under the `workspace-replication` grant, in its own tables, and serves the
   * dashboard for them read-only. It is still a capability, not a permission: declaring it with a
   * health-only grant gets a fleet page and nothing more. Writes for a copied workspace are never
   * applied here — they are forwarded to the operator-typed PRIMARY_URL or refused (I9, I10).
   */
  'serves-dashboard': {
    summary: 'Serves a read-only dashboard from a copy of the workspaces a server below shares',
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
  /*
   * Scale-out C2 (docs/scale-out-design.md §6). This node accepts PLAYER sockets for the copied
   * workspaces: it authenticates each one by asking the primary (the token never leaves the
   * primary), serves assignments and media from its own mirror, forwards every player event to the
   * primary as a `player-event` write, and delivers the primary's commands to that player when a
   * `command-relay` comes up the edge. Requires serves-dashboard on the same edge — there is no
   * mirror to serve from otherwise. It is still a capability: without the `player-events` WRITE
   * grant set by the PRIMARY's operator, the events have nowhere to go and the replica refuses the
   * player (I2, I10).
   */
  'terminates-players': {
    summary: 'Accepts player connections for the copied workspaces and relays their events to the server that owns them',
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
    requires: ['serves-dashboard'],
  },
  'redistributes-content': {
    summary: 'Keeps media it was sent, so it can pass it on to servers below it',
    /*
     * ⚠️ THIS IS A RESOURCE DECLARATION, NOT AN AUTHORITY. It says this node is willing to spend
     * its disk holding media it was sent so that it can pass it on — nothing more. Whether any
     * particular file may travel further is the CONTENT OWNER's decision, carried per push (see
     * `rl` in the manifest and mesh_content_provenance.relayable), and whether a given server below
     * accepts it is that server's own grant, checked on arrival exactly as any other push is.
     *
     * Two settings held by two parties, and both required. A single flag would put the decision
     * with the operator who BENEFITS from caching rather than the one giving something up, which
     * is the defect the write grant already had once — the parent authored the grant the child
     * enforced, and it took an amendment to I2 to fix. See docs/mesh-relay-design.md.
     */
    requiresFlag: 'MESH_ACCEPT_ENROLLMENT',
  },
});

const ALL = Object.freeze(Object.keys(CAPABILITIES));
const AVAILABLE_NOW = Object.freeze(ALL.filter((c) => !CAPABILITIES[c].phase5));

function isKnown(name) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, name);
}

/**
 * Validate a requested capability set for an edge.
 *
 * Refusal is explicit and readable, for the same reason as in grants.js: a node that quietly drops
 * the capabilities it does not support leaves the operator believing the edge does something it does
 * not, and they find out when the data never arrives.
 *
 * @param {string[]} requested
 * @param {{acceptEnrollment?: boolean}} flags — this node's own feature flags
 */
function validateCapabilities(requested, flags = {}) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, rejected: [], reason: 'An edge must declare at least one capability.' };
  }

  const unknown = requested.filter((c) => !isKnown(c));
  if (unknown.length) {
    return {
      ok: false,
      rejected: unknown,
      reason: `This node does not support ${unknown.map((c) => `"${c}"`).join(', ')}. It may be ` +
              `newer than this node — supported capabilities are: ${AVAILABLE_NOW.join(', ')}.`,
    };
  }

  const notYet = requested.filter((c) => CAPABILITIES[c].phase5);
  if (notYet.length) {
    return {
      ok: false,
      rejected: notYet,
      reason: `${notYet.join(', ')} is not available in this version. Content flows downward only ` +
              `from a later release; this node observes and reports, and cannot be sent content by ` +
              `a parent.`,
    };
  }

  const needsAccept = requested.filter((c) => CAPABILITIES[c].requiresFlag === 'MESH_ACCEPT_ENROLLMENT');
  if (needsAccept.length && !flags.acceptEnrollment) {
    return {
      ok: false,
      rejected: needsAccept,
      reason: `This node is not configured to accept enrollments. Set MESH_ACCEPT_ENROLLMENT=1 on ` +
              `it first — until then it cannot act as a parent for ${needsAccept.join(', ')}.`,
    };
  }

  // A capability that only makes sense on top of another says so, and is refused without it.
  for (const c of requested) {
    const needs = CAPABILITIES[c].requires || [];
    const missing = needs.filter((n) => !requested.includes(n));
    if (missing.length) {
      return {
        ok: false,
        rejected: [c],
        reason: `${c} needs ${missing.join(', ')} on the same edge — it works from the copy that ` +
                `${missing.join(', ')} keeps, and has nothing to serve without it.`,
      };
    }
  }

  return { ok: true, capabilities: [...new Set(requested)] };
}

module.exports = { CAPABILITIES, ALL, AVAILABLE_NOW, isKnown, validateCapabilities };
