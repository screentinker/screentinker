'use strict';

/*
 * What a hub user may do with one client.
 *
 * ⚠️ THE OBVIOUS MODEL IS WRONG FOR 2.0. "Read-only on Acme, full on Contoso" sounds like a
 * read/write split, but a hub cannot write to a client's screens at all in 2.0 — invariant I2 makes
 * the mesh upward-only, and there is no downward command handler to authorise. A "full access" role
 * would grant a capability that does not exist, which is worse than no role at all: it reads as a
 * promise the product does not keep, and an operator would reasonably assume their tech can act on a
 * screen when they cannot.
 *
 * So the axis that genuinely differs per client today is not read versus write on the CLIENT'S DATA.
 * It is read versus control of the RELATIONSHIP:
 *
 *   viewer   — see this client's mirrored data, bounded by whatever the client granted
 *   manager  — additionally change the edge itself: retention, token rotation, disenrollment,
 *              and which nodes belong to this client
 *
 * That is a real and consequential distinction. A tech who can view Acme's screens is a very
 * different risk from one who can sever Acme's edge or shorten what is retained about them — and the
 * second is exactly the sort of thing a client asks about when they ask who at the MSP can do what.
 *
 * ⚠️ THE THIRD ROLE ARRIVED WITH PHASE 5, and the note that used to sit here — "deliberately not
 * modelled, because a role is local and adding one later is purely additive" — turned out to be
 * exactly right. `publisher` was added when its semantics could be pinned to something real, and
 * nothing stored before it needed changing.
 *
 * ⚠️ ROLE AND GRANT ARE A CONJUNCTION, AND NEITHER SUBSTITUTES FOR THE OTHER.
 *
 *   the CHILD's grant is the ceiling  — what may be done to that node at all (lib/mesh/grants.js,
 *                                       set by the child's own operator, enforced on the child)
 *   the HUB's role is who may spend it — which of OUR people may ask (this file)
 *
 * The child cannot see hub roles and must never be told to trust them (I10), so the role check is a
 * hub-side pre-filter that stops a request leaving; the child re-checks its own grant regardless. A
 * hub that skipped the role check would merely be rude to its own staff. A child that skipped the
 * grant check would have handed control of its screens to whoever asked.
 *
 * ⚠️ TWO WRITE ACTIONS, NOT ONE. `push-content` and `command-devices` are separate so a tech can
 * reload a stuck screen without also being able to change what it shows. They are different
 * conversations with a client and they should be different permissions.
 */

const ROLES = Object.freeze({
  viewer: {
    rank: 1,
    summary: 'See this client\'s screens and health',
    can: Object.freeze(['view-mirrored-data']),
  },
  manager: {
    rank: 2,
    summary: 'See this client, and manage the connection to them',
    can: Object.freeze([
      'view-mirrored-data',
      'manage-edge',        // retention, tombstone purge, TLS verification, token rotation
      'disenroll',          // sever the edge from this side
      'assign-nodes',       // move a node into or out of this client
    ]),
  },
  /*
   * ⚠️ RANKED ABOVE manager, and that ordering is a claim worth defending.
   *
   * A manager can sever an edge — disruptive, visible immediately, and undone by re-pairing. A
   * publisher changes what is on a client's screens, which is the thing their customers actually
   * see, and which nobody at the MSP may notice is wrong. "Can break the connection" is a smaller
   * power than "can put anything on a hospital wall".
   *
   * It still cannot do anything the client has not granted: without content-push on the child's
   * edge, holding this role changes nothing at all.
   */
  publisher: {
    rank: 3,
    summary: 'See this client, manage the connection, and change what plays on their screens',
    can: Object.freeze([
      'view-mirrored-data',
      'manage-edge',
      'disenroll',
      'assign-nodes',
      'push-content',       // playlists and the content they reference
      'command-devices',    // reload / screen power — NOT the same conversation as content
    ]),
  },
});

const ROLE_NAMES = Object.freeze(Object.keys(ROLES));
const DEFAULT_ROLE = 'viewer';

/** Every action a client role can gate. Named so a caller cannot invent one silently. */
const ACTIONS = Object.freeze([
  'view-mirrored-data', 'manage-edge', 'disenroll', 'assign-nodes',
  // Phase 5. Separate on purpose — see the note on `publisher`.
  'push-content', 'command-devices',
]);

/*
 * ⚠️ Actions that may NOT be held through inheritance — see lib/mesh/client-tree.js.
 *
 * Read access inherits down the client tree on purpose: naming somebody on every client is toil
 * nobody keeps up with, and `whoGainsAccess` exists so that inheritance is never silent. Write is a
 * different magnitude. Dragging a client under "West Region" would otherwise hand the ability to
 * change a hospital's screens to everyone holding that region, in one drag, with no one named.
 *
 * So a write action requires a row ON THIS CLIENT. It reintroduces exactly the toil inheritance was
 * built to remove — for the one pair of permissions where the toil is worth paying, and where the
 * failure is at least in the recoverable direction.
 */
const DIRECT_ONLY_ACTIONS = Object.freeze(['push-content', 'command-devices']);

/** Is this an action that may only be exercised through a DIRECT grant on the client? */
function requiresDirectAccess(action) {
  return DIRECT_ONLY_ACTIONS.includes(action);
}

function isKnownRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

/**
 * May a user holding `role` on a client perform `action`?
 *
 * ⚠️ Fails CLOSED on anything unrecognised. An unknown role — a typo, a row written by a newer
 * version, a value someone set by hand — grants nothing rather than defaulting to the lowest role,
 * because "lowest role" still means seeing a client's data. An unknown ACTION is refused for the same
 * reason: a caller checking a permission this module has never heard of has almost certainly
 * mistyped it, and answering true would silently wave it through.
 */
function roleAllows(role, action) {
  if (!isKnownRole(role)) return false;
  if (!ACTIONS.includes(action)) return false;
  return ROLES[role].can.includes(action);
}

/**
 * Resolve a user's effective role on a client.
 *
 * ⚠️ DEFAULT DENY BY ABSENCE. No access row means no role and no visibility, so a newly added client
 * is invisible until somebody is named on it. The alternative — visible unless denied — exposes every
 * new client to every tech the moment it is created, which is the wrong direction for a mistake to
 * fail in.
 *
 * ⚠️ platform_admin IS NOT CONTAINED, and this is deliberate rather than an oversight. The instance
 * owner can edit the database, rotate any token and grant themselves any row; pretending otherwise
 * would be security theatre that complicates the code without protecting anyone. What this model DOES
 * deliver is the property a client actually asks about: that an ordinary MSP technician sees the
 * clients they were named on and no others.
 *
 * @param {{role?: string} | null} accessRow  the mesh_client_access row, or null if none
 * @param {{role?: string}} user              the platform user
 * @returns {string|null} effective role, or null for no access
 */
function effectiveRole(accessRow, user) {
  const named = (accessRow && isKnownRole(accessRow.role)) ? accessRow.role : null;

  /*
   * ⚠️ manager is the platform_admin FLOOR, not a ceiling — it used to be a ceiling, and that made
   * the feature unusable by anyone.
   *
   * The short-circuit returned 'manager' and stopped, so an explicit publisher row on a
   * platform_admin was read and discarded. manager.can does not include push-content, so the
   * instance owner — the one person who cannot be locked out of anything here, per the note above —
   * was the one person who could never push content to a client. Every user on every stock install
   * was refused, and not by policy: by an early return.
   *
   * Taking the higher of the two keeps what the floor was for (an owner never loses sight of a
   * client nobody named them on) without capping what an operator deliberately granted.
   */
  if (user && user.role === 'platform_admin') {
    if (named && (ROLES[named].rank > ROLES.manager.rank)) return named;
    return 'manager';
  }
  return named;
}

/** Convenience: the whole question in one call. */
function userMay(accessRow, user, action) {
  const role = effectiveRole(accessRow, user);
  return role !== null && roleAllows(role, action);
}

/** Validate a role being assigned, with an operator-readable refusal. */
function validateRole(role) {
  if (isKnownRole(role)) return { ok: true, role };
  return {
    ok: false,
    reason: `"${role}" is not a client role. Available roles are: ` +
            ROLE_NAMES.map((r) => `${r} (${ROLES[r].summary.toLowerCase()})`).join(', ') + '.',
  };
}

module.exports = {
  DIRECT_ONLY_ACTIONS,
  requiresDirectAccess,
  ROLES, ROLE_NAMES, DEFAULT_ROLE, ACTIONS,
  isKnownRole, roleAllows, effectiveRole, userMay, validateRole,
};
