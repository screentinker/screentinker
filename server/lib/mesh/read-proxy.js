'use strict';

/*
 * Reading a child's own API from the parent, so a remote org can render with the SAME screens the
 * child would draw rather than a reduced summary of it.
 *
 * ⚠️ THIS CHANGES THE SHAPE OF I2, AND THE CHANGE IS WORTH STATING PLAINLY.
 *
 * I2 was "there is no downward channel", enforced by the absence of a mechanism: the parent listened
 * and never spoke. That is no longer true — the parent can now ASK. What must remain true is that it
 * cannot TELL, and "we only send reads" is a convention, which is exactly the kind of thing that
 * holds until somebody adds one convenient endpoint.
 *
 * So the enforcement is an ALLOWLIST OF EXACT PATHS, checked on the CHILD, with the method pinned to
 * GET. A parent that asked for anything else gets a refusal from the side that owns the data — not
 * from the side that wants it. A blocklist would have been the natural shape and is the wrong one:
 * it fails open for every route added after it was written.
 *
 * ⚠️ IT RUNS OVER THE EXISTING SOCKET, NOT OVER HTTP. The child dialled out precisely because it may
 * sit behind NAT with no inbound route — the deployment shape this whole feature exists for. A parent
 * making an HTTP request to a child would work on a lab bench and fail at every real site.
 */

/**
 * Exactly what a parent may read, and nothing else.
 *
 * ⚠️ Each entry names the grant it needs. A hub with a health-only edge asking for the device list
 * gets health-shaped rows and no names — the same degradation as the mirror, because the grant is
 * the client's decision and a proxy must not become the way around it.
 */
const READABLE = Object.freeze([
  { pattern: '/api/devices',                  grant: 'health',           scope: 'workspace' },
  { pattern: '/api/devices/:id',              grant: 'health',           scope: 'workspace' },
  { pattern: '/api/devices/:id/telemetry',    grant: 'health',           scope: 'workspace' },
  /*
   * ⚠️ ITS OWN GRANT, and the strictest one here. A screenshot is not metadata about a screen — it
   * is a picture of whatever was on it, which may include anything that happened to be visible
   * behind the signage. `display-capture` exists precisely so a client can share health and content
   * without sharing images, and this must never fall back to a weaker grant.
   */
  { pattern: '/api/devices/:id/screenshot',   grant: 'display-capture',  scope: 'workspace',
    binary: true },
  /*
   * ⚠️ WHY A SCREEN IS MISBEHAVING, and it needs its own grant for the same reason a screenshot
   * does. A player's debug log carries the URLs it was loading and the errors it hit — useful to
   * whoever is supporting the site, and more than "is it alive". `diagnostics` exists precisely so
   * a customer can share health without sharing that, and this must never fall back to `health`.
   *
   * Without it an MSP could see that a screen at a customer site was unhealthy and had no way to
   * find out why — the one question support actually needs answered, and the reason someone drives
   * to a site.
   */
  { pattern: '/api/devices/:id/debug',        grant: 'diagnostics',      scope: 'workspace' },
  { pattern: '/api/assignments/device/:id',   grant: 'content-metadata', scope: 'workspace' },
  { pattern: '/api/groups',                   grant: 'identity',         scope: 'workspace' },
  { pattern: '/api/playlists',                grant: 'content-metadata', scope: 'workspace' },
  { pattern: '/api/playlists/:id',            grant: 'content-metadata', scope: 'workspace' },
  /*
   * Scale-out (docs/scale-out-design.md §1.4). The replica's copy is built from these two and
   * nothing else: a bounded page of one table for the initial copy, and the change log after a
   * revision for everything since. Both are answered on the read worker's readonly handle like
   * every other row here. Content BYTES are not on this list: a replica fetches them from
   * PRIMARY_URL over plain HTTP with the requesting user's own token (lib/replica-proxy.js), so the
   * primary's ordinary content authorisation answers, not a mesh grant.
   */
  { pattern: '/api/mesh/snapshot',            grant: 'workspace-replication', scope: 'workspace' },
  { pattern: '/api/mesh/changes',             grant: 'workspace-replication', scope: 'workspace' },
  /*
   * Scale-out C2 (docs/scale-out-design.md §6): "is this device + token hash one of mine?" The
   * ONE read keyed to a WRITE grant, because it exists solely so a replica may terminate players
   * whose events it is permitted to write back: `player-events`, set by THIS node's operator. The
   * answer is yes/no and the device's workspace; the token itself never leaves this node.
   */
  { pattern: '/api/mesh/verify-device',       writeGrant: 'player-events',  scope: 'workspace' },
]);

/*
 * ⚠️ SEGMENT-EXACT MATCHING, and this is where an allowlist usually springs a leak.
 *
 * A naive `path.startsWith(pattern)` makes `/api/devices/:id` match `/api/devices/123/block` —
 * a write, admitted by a list intended to permit reads. So the segment COUNT must agree, every
 * literal segment must match exactly, and a `:param` segment may not be empty, contain a slash, or
 * be a traversal token. Anything else is refused.
 */
function matchPath(path) {
  const got = String(path || '').split('?')[0].split('/');
  for (const rule of READABLE) {
    const want = rule.pattern.split('/');
    if (want.length !== got.length) continue;
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(':')) {
        const v = got[i];
        // ⚠️ `.` and `..` are refused explicitly. They are legal path segments and would otherwise
        // satisfy "some non-empty value", which is how a matcher gets walked out of its own rule.
        if (!v || v === '.' || v === '..' || v.includes('%2f') || v.includes('%2F')) { ok = false; break; }
      } else if (want[i] !== got[i]) { ok = false; break; }
    }
    if (ok) return rule;
  }
  return null;
}

function isReadable(path) {
  return !!matchPath(path);
}

/**
 * May this edge read this path?
 *
 * @param {object} edge         the edge the request arrived on (child side)
 * @param {string} path
 * @param {string} method
 * @param {string[]} grants     the edge's granted categories
 */
function authorize(edge, path, method, grants) {
  if (String(method || 'GET').toUpperCase() !== 'GET') {
    return {
      ok: false,
      reason: 'This connection can read, and cannot write. Only GET is accepted.',
    };
  }
  if (!matchPath(path)) {
    /*
     * ⚠️ The refusal does not distinguish "no such route" from "not allowed", because a parent has
     * no business mapping this server's API surface. It only needs to know the answer is no.
     */
    return { ok: false, reason: 'That is not something this connection may read.' };
  }
  const rule = matchPath(path);
  if (rule.writeGrant) {
    // Keyed to a WRITE grant: the one this node's operator set, read from this node's own row.
    let wg = [];
    try { wg = JSON.parse((edge && edge.write_grant) || '[]'); } catch (e) { wg = []; }
    if (!Array.isArray(wg) || !wg.includes(rule.writeGrant)) {
      return {
        ok: false,
        reason: `This connection was not granted "${rule.writeGrant}" by this server's operator, so it cannot read that.`,
      };
    }
    return { ok: true, rule };
  }
  if (!grants.includes(rule.grant)) {
    return {
      ok: false,
      reason: `This connection was not granted "${rule.grant}", so it cannot read that.`,
    };
  }
  return { ok: true, rule };
}

/**
 * Narrow a payload to the workspaces this edge may see.
 *
 * ⚠️ APPLIED HERE RATHER THAN TRUSTED FROM THE QUERY. The parent asks for a path, not for a filter —
 * if the parent could pass a workspace id, a parent that asked for the wrong one would be answered,
 * and the scope would be enforced by the side that benefits from ignoring it.
 */
function scopeRows(rows, sharedWorkspaces) {
  if (!Array.isArray(rows)) return rows;
  // null / empty means every workspace, which only the instance owner can have chosen.
  if (!sharedWorkspaces || !sharedWorkspaces.length) return rows;
  return rows.filter((r) => !r || r.workspace_id == null || sharedWorkspaces.includes(r.workspace_id));
}

/**
 * Strip fields the grant does not cover.
 *
 * ⚠️ Built by ADDING what is allowed, never by deleting what is not — the same rule as the mirror
 * projections. A delete-based filter silently starts shipping every column added afterwards, and
 * nobody discovers it until a client asks why their hub knows something they never shared.
 */
function projectRows(rows, grants, projectOne) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => projectOne(r, grants));
}

/*
 * ⚠️ WRITES ARE NOT MERELY ABSENT — the vocabulary for them already exists and is deliberately
 * unused here. grants.js defines WRITE_CATEGORIES (`content-push`, `device-command`), so when a
 * linked server is meant to behave like a local one in both directions, the rule is already
 * expressible: a write path names the write grant it needs, and an edge without it is refused by
 * the same code path that refuses an ungranted read.
 *
 * Until that lands, this function exists to make the answer explicit rather than implied by the
 * absence of a branch — "there is no write handler" is a fact about today's code, and facts about
 * today's code are not a security control.
 */
function writesAllowed() {
  return false;
}

module.exports = { READABLE, isReadable, matchPath, authorize, scopeRows, projectRows, writesAllowed };
