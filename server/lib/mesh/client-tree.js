'use strict';

/*
 * Nesting clients, and resolving who can see what through the nesting.
 *
 * An MSP with regional structure thinks "West Region → Acme, Contoso" and wants to name a tech on the
 * region rather than on each client as it is won. Without inheritance, nesting is purely decorative
 * and the tech has to be re-named on every new client — which in practice means somebody eventually
 * grants everyone everything to stop doing it.
 *
 * ⚠️ INHERITANCE COLLIDES WITH DEFAULT-DENY-BY-ABSENCE, AND THE COLLISION IS THE WHOLE DESIGN.
 *
 * client-roles.js guarantees that a newly created client is invisible until somebody is explicitly
 * named on it. Inheritance breaks that guarantee by construction: place a new client under West
 * Region and everyone holding West Region can see it, without anyone naming them.
 *
 * Both properties are worth having, so the resolution is NOT to pick one. It is that inherited access
 * must never be SILENT:
 *
 *   - `resolveAccess` always reports WHERE access came from (`direct` vs `inherited`, and via which
 *     ancestor). A caller cannot obtain a role without also being handed its provenance.
 *   - `whoGainsAccess` answers "who is about to be able to see this" BEFORE a client is placed under
 *     a parent, so the UI can say "3 users will gain access to Acme through West Region" and the
 *     operator agrees to it rather than discovering it.
 *
 * The dangerous property was never inheritance. It was inheritance nobody was told about.
 */

/*
 * ⚠️ DEPTH IS CAPPED, and the cap is not arbitrary caution.
 *
 * Permission resolution walks this chain on every check, so unbounded depth is unbounded work on a
 * hot path, plus a pathological case if anyone builds a 500-deep chain by script. Four levels covers
 * every real org chart anyone has described — holding company → MSP → region → client — and the
 * directive's instinct throughout is against unbounded recursion (it rejects nested playlists in
 * Phase 5 for the same reason).
 *
 * If this ever needs raising, the cost is a number here plus a hard look at the resolution path, not
 * a redesign.
 */
const MAX_CLIENT_DEPTH = 4;

/**
 * The chain from a client up to its root, starting with the client itself.
 *
 * ⚠️ Defends against a cycle in the DATA rather than trusting validation to have prevented one. A row
 * edited by hand, or written before the check existed, would otherwise spin here forever — and this
 * runs inside permission checks, so it would hang a request rather than fail one.
 */
function ancestorChain(clientId, getParentId, limit = MAX_CLIENT_DEPTH + 1) {
  const chain = [];
  const seen = new Set();
  let cur = clientId;
  while (cur && chain.length < limit) {
    if (seen.has(cur)) break;          // cycle in stored data — stop, do not spin
    seen.add(cur);
    chain.push(cur);
    cur = getParentId(cur) || null;
  }
  return chain;
}

function depthOf(clientId, getParentId) {
  return ancestorChain(clientId, getParentId).length;
}

/**
 * May `childId` be placed under `parentId`?
 *
 * @param {string} childId
 * @param {string|null} parentId  null un-parents the client (always allowed)
 * @param {(id: string) => string|null} getParentId
 * @param {(id: string) => number} subtreeDepthBelow  deepest chain BELOW this client, 0 for a leaf
 */
function validateParent(childId, parentId, getParentId, subtreeDepthBelow = () => 0) {
  if (parentId === null || parentId === undefined) return { ok: true, parentId: null };

  if (parentId === childId) {
    return { ok: false, reason: 'A client cannot be its own parent.' };
  }

  // ⚠️ Cycle refusal by REACHABILITY, the same reasoning as mesh invariant I3: walk the proposed
  // parent's chain and refuse if the child is already in it. A prefix or one-level check would miss
  // grandparent cycles, which are exactly what happens when someone reorganises a tree by dragging.
  const parentChain = ancestorChain(parentId, getParentId);
  if (parentChain.includes(childId)) {
    return {
      ok: false,
      reason: `"${parentId}" is already below "${childId}", so this would make a loop in the client ` +
              `hierarchy. Move it out from under this client first.`,
    };
  }

  // Depth is measured for the DEEPEST leaf under the child, not for the child itself — attaching a
  // whole subtree can breach the cap even when the client being moved would not.
  const resulting = parentChain.length + 1 + subtreeDepthBelow(childId);
  if (resulting > MAX_CLIENT_DEPTH) {
    return {
      ok: false,
      reason: `Client hierarchies are limited to ${MAX_CLIENT_DEPTH} levels, and this would make ` +
              `${resulting}. Flatten part of the structure, or group the clients differently.`,
    };
  }

  return { ok: true, parentId };
}

/**
 * Resolve a user's access to a client, through the hierarchy.
 *
 * ⚠️ MOST-SPECIFIC-WINS, so a row on the client itself beats a row on its parent. That allows both
 * widening and NARROWING — manager across West Region but viewer on the one client under NDA — which
 * an inherit-the-maximum model could not express, and which is the case an MSP will actually hit.
 *
 * ⚠️ THE RETURN VALUE ALWAYS CARRIES PROVENANCE. There is deliberately no way to ask "what is my
 * role" and get a bare answer: whoever asks is handed where it came from, because a UI that cannot
 * distinguish direct access from inherited access cannot warn anyone about the second.
 *
 * @returns {{role: string|null, source: 'none'|'direct'|'inherited'|'platform-admin', viaClientId: string|null}}
 */
function resolveAccess(clientId, user, getParentId, getAccessRow, roles) {
  const isOwner = !!(user && user.role === 'platform_admin');
  /*
   * ⚠️ manager is the platform_admin FLOOR, NOT A CEILING — and this is the SECOND place that had
   * to learn it. client-roles.effectiveRole had the identical short-circuit and the identical
   * consequence; fixing it there and not here meant the instance owner still could not push content
   * to their own clients, because everything that matters goes through this function instead.
   *
   * Two failures came out of one line. The role was capped at manager, whose capabilities do not
   * include push-content — so an explicit publisher row on an owner was read and discarded. And the
   * source came back 'platform-admin' rather than 'direct', so even an uncapped publisher would
   * have failed requiresDirectAccess, which exists to stop write inheriting down the client tree.
   *
   * Found by standing up three real servers and trying to push a file between them. Nothing in
   * 2,500 tests noticed, because every one of them constructs the access row it wants.
   */
  const owner = () => ({ role: 'manager', source: 'platform-admin', viaClientId: null });

  const chain = ancestorChain(clientId, getParentId);
  for (const id of chain) {
    const row = getAccessRow(id, user && user.id);
    if (!row) continue;
    // An unrecognised role stops the walk rather than being skipped. Continuing would silently hand
    // the user a BROADER inherited role from further up, turning a typo into an escalation.
    if (!roles.isKnownRole(row.role)) {
      return isOwner ? owner() : { role: null, source: 'none', viaClientId: null };
    }
    const source = id === clientId ? 'direct' : 'inherited';
    /*
     * The floor applies only where it raises the answer. A named role at or below manager adds
     * nothing for an owner who already has manager everywhere; a higher one is a deliberate grant
     * and keeps its own source, so a direct publisher row stays DIRECT and passes the write gate.
     */
    if (isOwner && roles.ROLES[row.role].rank <= roles.ROLES.manager.rank) return owner();
    return { role: row.role, source, viaClientId: source === 'direct' ? null : id };
  }
  return isOwner ? owner() : { role: null, source: 'none', viaClientId: null };
}

/** Convenience mirroring client-roles.userMay, but hierarchy-aware. */
function userMayThroughTree(clientId, user, action, getParentId, getAccessRow, roles) {
  const { role } = resolveAccess(clientId, user, getParentId, getAccessRow, roles);
  return role !== null && roles.roleAllows(role, action);
}

/**
 * Who would gain access to `childId` if it were placed under `parentId`?
 *
 * ⚠️ THE DISCLOSURE PRIMITIVE. This is what keeps inheritance from being silent, and it is the reason
 * the collision described at the top of this file is acceptable rather than a hole. The UI is expected
 * to call it before saving and show the answer — "3 users will gain access to Acme through West
 * Region" — so an operator agrees to the consequence instead of discovering it later.
 *
 * Returns only users who do NOT already have direct access, since those are the ones for whom
 * anything changes.
 *
 * @param {(clientId: string) => Array<{user_id: string, role: string}>} listAccessRowsFor
 */
function whoGainsAccess(childId, parentId, getParentId, listAccessRowsFor) {
  if (!parentId) return [];
  const alreadyDirect = new Set(listAccessRowsFor(childId).map((r) => r.user_id));
  const gained = new Map();
  // Walk UP from the proposed parent: everyone anywhere above inherits down to the child.
  for (const ancestorId of ancestorChain(parentId, getParentId)) {
    for (const row of listAccessRowsFor(ancestorId)) {
      if (alreadyDirect.has(row.user_id)) continue;
      // Nearest ancestor wins, so the first one seen walking up is the effective one.
      if (!gained.has(row.user_id)) {
        gained.set(row.user_id, { user_id: row.user_id, role: row.role, viaClientId: ancestorId });
      }
    }
  }
  return [...gained.values()];
}

module.exports = {
  MAX_CLIENT_DEPTH,
  ancestorChain,
  depthOf,
  validateParent,
  resolveAccess,
  userMayThroughTree,
  whoGainsAccess,
};
