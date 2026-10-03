'use strict';

const crypto = require('node:crypto');

/*
 * Executing a mesh write THE SAME WAY A LOCAL OPERATOR WOULD.
 *
 * ⚠️ THIS IS THE WHOLE DESIGN BRIEF, AND IT IS WHY THIS IS A LOOPBACK REQUEST RATHER THAN A
 * FUNCTION CALL. A mesh write goes back through this server's own HTTP API, over the loopback
 * interface, authenticated as an ordinary workspace-bound API token. It therefore passes every
 * guard a local request passes — tenancy resolution, the scope gate, the draft/publish flow, the
 * fan-out helper, zone validation, upload sniffing — with no second implementation to keep in step.
 *
 * A parallel write engine would have been quicker and would have drifted within a release. Every
 * rule that has been discovered the hard way in this codebase — a fan-out that forgets a case, a
 * column a writer never heard about, a publish that restarts every screen — lives in those routes.
 * Re-entering them is how a mesh write inherits all of it for free.
 *
 * ⚠️ THE TOKEN IS EPHEMERAL, WORKSPACE-BOUND AND REVOKED IMMEDIATELY. It exists for the duration of
 * one request. api_tokens is used because it already has exactly the properties needed and they are
 * already tested: it forces the effective platform role to 'user', so every platform/elevated check
 * downstream evaluates false; it drops a caller-supplied X-Workspace-Id in favour of the bound one;
 * and mount-by-exclusion means it cannot reach admin, auth, billing, provisioning or workspaces at
 * all. A mesh write is strictly weaker than a workspace member, by construction rather than by
 * remembering to check.
 */

const TOKEN_PREFIX = 'st_mesh_';

/**
 * Create the executor a child uses to apply an authorised mesh write.
 *
 * @param {object} db
 * @param {object} config       needs `port`
 * @param {object} [deps]       `fetch` override for tests
 */
function createLocalApply(db, config, deps = {}) {
  const doFetch = deps.fetch || global.fetch;

  /**
   * ⚠️ The principal is a synthetic user owned by this node, never a human.
   *
   * playlists.user_id is NOT NULL REFERENCES users(id) and foreign keys are on, so a pushed
   * playlist genuinely cannot exist without one — this is not bookkeeping. It also means the audit
   * trail attributes the change to "the mesh", not to whichever operator happened to enrol the
   * link, which is the answer their customer actually needs.
   */
  function meshPrincipal() {
    const existing = db.prepare("SELECT id FROM users WHERE email = 'mesh@localhost.invalid'").get();
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO users (id, email, name, password_hash, role)
                VALUES (?, 'mesh@localhost.invalid', 'Another server (mesh)', NULL, 'user')`).run(id);
    return id;
  }

  /*
   * ⚠️ AND IT NEEDS TO BE A MEMBER, OR EVERY MESH WRITE IS A 403.
   *
   * The token is workspace-bound and the middleware forces the platform role to 'user', but
   * tenancy asks a second question: accessContext() returns null unless the caller has a
   * workspace_members row, an org role, or is platform staff. The principal had none of those, so
   * every write this feature exists to perform was refused by the child's own API — the whole
   * feature inert behind a generic "Access denied", exactly the shape of the constructor bug that
   * would have made the entire mesh inert behind one warn line.
   *
   * Granted per workspace, at the moment a write is authorised for it, and never wider: the
   * workspace here has already been resolved from THIS node's rows and checked against the
   * operator's own write_scope. Membership is left in place rather than added and removed around
   * each request — a half-written pair on a crash is worse than a standing row, the principal has
   * no password and cannot sign in, and it makes the audit trail read correctly.
   */
  function ensureMeshMembership(userId, workspaceId) {
    const existing = db.prepare(
      'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, userId);
    if (existing) return;
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')",
    ).run(workspaceId, userId);
  }

  return async function applyLocally({ path, method, body, workspaceId, edge }) {
    if (!doFetch) throw new Error('no fetch available to apply the write');
    if (!workspaceId) throw new Error('a write must resolve to a workspace before it is applied');

    const principal = meshPrincipal();
    ensureMeshMembership(principal, workspaceId);

    const secret = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const tokenId = crypto.randomUUID();

    db.prepare(`INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at)
                VALUES (?,?,?,?,?,?, 'write', strftime('%s','now'))`)
      .run(tokenId, hash, secret.slice(0, 12),
           `mesh write (${(edge && edge.peer_node_id) || 'peer'})`, principal, workspaceId);

    try {
      /*
       * ⚠️ THE ORIGIN COMES FROM THE SERVER, NOT FROM config.port, AND REDIRECTS ARE AN ERROR.
       *
       * config.port is the API only when TLS is off; with certs present the API moves to httpsPort
       * and config.port serves a 301-redirect app. fetch follows redirects by default and rewrites
       * POST to GET, dropping the body — so the call returned 200 for a request the API never saw,
       * and applyWrite recorded that invented success and replayed it for ever. `redirect: 'error'`
       * means a redirect can never again be mistaken for an applied write, whatever the origin.
       */
      const origin = deps.apiOrigin || global.__localApiOrigin || `http://127.0.0.1:${config.port}`;
      const res = await doFetch(`${origin}${path}`, {
        method,
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        ...(body === undefined || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }

      if (!res.ok) {
        /*
         * ⚠️ The local API's own refusal is passed through, not replaced. If a route rejects a
         * cross-tenant zone id or an unpublished trigger target, the hub should see that sentence —
         * it is more useful than "that change could not be applied", and it is the same answer a
         * local operator would have got.
         */
        const e = new Error((parsed && parsed.error) || `local API returned ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return { status: res.status, result: parsed };
    } finally {
      // Revoked whatever happened. A token that outlives its request is standing access.
      db.prepare('UPDATE api_tokens SET revoked_at = strftime(\'%s\',\'now\') WHERE id = ?').run(tokenId);
    }
  };
}

module.exports = { createLocalApply, TOKEN_PREFIX };
