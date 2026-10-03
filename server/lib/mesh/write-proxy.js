'use strict';

const grantsLib = require('./grants');
const deviceCommand = require('../device-command');

/*
 * Exactly what a parent may CHANGE on this node, and nothing else.
 *
 * ⚠️ THIS IS A SEPARATE FILE FROM read-proxy.js ON PURPOSE. There is a test that greps read-proxy
 * for HTTP verbs and asserts none appear — `!== 'GET'` is present, `'POST':` is not. That guard is
 * worth keeping exactly as it is: the read surface should stay provably read-only, and mixing
 * writes into it would delete a property in order to add a feature.
 *
 * The shape mirrors READABLE deliberately — an exact path, the grant it needs, and matching that is
 * segment-exact — because the failure modes are the same ones and the read proxy already learned
 * them. What differs is that a write rule also pins its METHOD, and that authorization has a second
 * axis: the workspace. A read grant degrades gracefully when it is too narrow (you see less); a
 * write applied to the wrong target is the wrong content on somebody's screen.
 *
 * ⚠️ NOTHING THAT TOUCHES BYTES IS HERE. Media files do not fit this transport (the envelope caps a
 * batch at 512 KB against a 500 MB upload limit) and they are not going to arrive by accident
 * through a JSON path. Content distribution is its own channel and its own decision.
 *
 * ⚠️ NOTHING PRIVILEGED IS HERE, and it is an allowlist rather than a blocklist so that a route
 * added to this server later is refused until somebody deliberately adds it. Never reachable, by
 * construction: users, roles, workspace membership, API tokens, SSO, billing, org settings, the
 * node's own mesh state (a hub that could widen its own grant has defeated the entire design), and
 * anything at the server level — restart, update, config, log retention.
 */
const WRITABLE = Object.freeze([
  // Playlist composition. The hub manages what plays; it does not upload what plays.
  { pattern: '/api/playlists',                     method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id',                 method: 'PUT',    grant: 'content-push' },
  { pattern: '/api/playlists/:id/items',           method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id/items/selection', method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id/items/:itemId',   method: 'PUT',    grant: 'content-push' },
  { pattern: '/api/playlists/:id/items/:itemId',   method: 'DELETE', grant: 'content-push' },
  { pattern: '/api/playlists/:id/publish',         method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id/assign',          method: 'POST',   grant: 'content-push' },

  /*
   * Commanding screens. A separate grant, and the customer ticks it separately: changing what
   * plays and restarting the hardware are different powers, and somebody may reasonably want to
   * hand over the first and not the second.
   *
   * ⚠️ THE PATH IS NOT ENOUGH HERE, WHICH IS WHY THESE CARRY A BODY CHECK.
   *
   * Everywhere else on this list, the path names the action. `POST /command` does not: the same
   * URL carries `reboot`, and `shell`, and `install_apk` — remote code execution and remote
   * software installation. The consent text the customer reads says "Reboot, reload, change
   * settings on screens", so the grant must permit exactly that and no more, and no path rule can
   * express the difference. lib/device-command.js holds the subset and the reasoning for each
   * exclusion.
   */
  { pattern: '/api/devices/:id/command',           method: 'POST', grant: 'device-command',
    body: meshCommandAllowed },
  { pattern: '/api/device-groups/:id/command',     method: 'POST', grant: 'device-command',
    body: meshCommandAllowed },
]);

/**
 * ⚠️ Fails CLOSED on anything it does not recognise. A body with no type, a non-string type, or a
 * command outside the mesh subset is refused — never passed through on the assumption that the
 * route beyond will catch it. The route's allowlist is the OPERATOR's; this one is the customer's,
 * and it is deliberately smaller.
 */
function meshCommandAllowed(body) {
  const type = body && body.type;
  if (typeof type !== 'string') return false;
  return deviceCommand.isMeshCommand(type);
}

/*
 * ⚠️ NORMALISE FIRST, AND SEND WHAT YOU MATCHED. THIS IS THE WHOLE GUARD.
 *
 * The allowlist is the entire security boundary of mesh write, and it was defeated by a backslash.
 * The matcher validated by splitting on '/', so `..\..\..\devices\D1` was ONE segment: it slotted
 * into :itemId and satisfied `DELETE /api/playlists/:id/items/:itemId`. The executor then handed
 * that same raw string to fetch(), which builds its request-target from `new URL().pathname` — and
 * the WHATWG parser turns backslashes into slashes for special schemes and resolves dot segments.
 * Six segments to the guard, three to the server: the request that arrived was
 * `DELETE /api/devices/D1`. `%2e%2e` did the same through decoding, turning "delete one item" into
 * "delete the whole playlist".
 *
 * That reached every PUT and DELETE on every token-mounted router — devices, groups, triggers,
 * folders, and /api/content, which unlinks media from disk. The claim above that nothing here
 * touches bytes was true of the rules and false of what they permitted.
 *
 * The fix is not a longer list of forbidden characters; it is removing the gap between the two
 * parsers. Resolve the path exactly as the executor will, match THAT, and give the caller back the
 * resolved form so the request that goes out is the request that was authorised. Anything a
 * traversal resolves to is then simply a path the allowlist does not contain.
 */
function normalizeTarget(raw) {
  let u;
  try {
    /*
     * The base is only a parser fixture — nothing is ever dialled from here — but it is written as
     * loopback rather than a placeholder host because the I7 guard asserts that EVERY url in
     * lib/mesh is loopback, and it is right to: a placeholder that nobody dials today is a
     * placeholder somebody edits into a real host later. It also happens to be the address the
     * executor genuinely uses, so the two cannot drift apart.
     */
    u = new URL(String(raw || ''), 'http://127.0.0.1');
  } catch (e) {
    return null;
  }
  if (!u.pathname || !u.pathname.startsWith('/')) return null;
  return { path: u.pathname, search: u.search || '', full: u.pathname + (u.search || '') };
}

/*
 * ⚠️ Segment-exact, and copied from read-proxy rather than shared — because the day someone
 * loosens one matcher, the other must not loosen with it. `.` and `..` are refused explicitly:
 * they are legal path segments that satisfy "some non-empty value", which is how a matcher gets
 * walked out of its own rule. They cannot survive normalisation, and are kept as defence in depth
 * for any future caller that reaches matchPath with an already-parsed path.
 */
function matchPath(path, method) {
  const norm = normalizeTarget(path);
  if (!norm) return null;
  const got = norm.path.split('/');
  const verb = String(method || '').toUpperCase();
  for (const rule of WRITABLE) {
    if (rule.method !== verb) continue;
    const want = rule.pattern.split('/');
    if (want.length !== got.length) continue;
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(':')) {
        const v = got[i];
        if (!v || v === '.' || v === '..' || v.includes('%2f') || v.includes('%2F')) { ok = false; break; }
      } else if (want[i] !== got[i]) { ok = false; break; }
    }
    if (ok) return rule;
  }
  return null;
}

function isWritable(path, method) {
  return !!matchPath(path, method);
}

/**
 * May this edge perform this write, on this workspace?
 *
 * ⚠️ `workspaceId` is resolved BY THE CALLER FROM THIS NODE'S OWN ROWS — it is the workspace the
 * target object actually belongs to, never a value the parent sent. A parent naming its own scope
 * is a parent choosing its own permission, which is the defect this whole design exists to close.
 *
 * @param {object}   edge         the edge the request arrived on (child side)
 * @param {string}   path
 * @param {string}   method
 * @param {string[]} writeGrant   the edge's stored write categories
 * @param {string[]} writeScope   the edge's stored workspace scope
 * @param {string}   workspaceId  the workspace the TARGET belongs to, resolved locally
 */
/*
 * ⚠️ ONE refusal string for every "no", and it is exported so the executor uses the identical one.
 *
 * A target that does not exist and a target that is not yours must be indistinguishable, or the
 * write door becomes an oracle: a parent could enumerate which playlists exist on someone else's
 * server purely by telling two refusals apart. Deliberately does not say WHICH half of the grant
 * failed either — "you have the category but not this workspace" tells a caller how to probe for
 * the scope. The operator on this node can see the whole grant on their own page, which is the
 * only place that answer belongs.
 */
const REFUSED = 'That is not something this connection may change. Write access is granted by this ' +
                "server's operator, per workspace — ask them if you believe it should be allowed.";

function authorizeWrite(edge, path, method, writeGrant, writeScope, workspaceId, body) {
  const norm = normalizeTarget(path);
  const rule = norm && matchPath(norm.full, method);
  if (!rule) {
    // Same refusal for "no such route" and "not permitted": a parent has no business mapping this
    // server's API surface, and only needs to know the answer is no.
    return { ok: false, reason: REFUSED };
  }
  /*
   * ⚠️ The body check runs BEFORE the grant check and returns the same refusal. A caller must not
   * be able to tell "you may not command screens at all" from "you may, but not that command" —
   * the second answer is a map of which verbs are worth trying.
   */
  if (typeof rule.body === 'function' && !rule.body(body)) {
    return { ok: false, reason: REFUSED };
  }
  if (!grantsLib.writeAllows(writeGrant, writeScope, rule.grant, workspaceId)) {
    /*
     * Deliberately does not say WHICH half failed. "You have the category but not this workspace"
     * tells a caller how to probe for the scope; the operator on this node can see the whole grant
     * on their own page, which is the only place that answer belongs.
     */
    return { ok: false, reason: REFUSED };
  }
  /*
   * ⚠️ `path` comes back NORMALISED, and the executor must send this one rather than what arrived.
   * Authorising one string and transmitting another is exactly how the backslash bypass worked.
   */
  return { ok: true, rule, path: norm.full };
}

module.exports = { WRITABLE, REFUSED, matchPath, isWritable, authorizeWrite, normalizeTarget };
