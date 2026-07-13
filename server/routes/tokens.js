// Public API token management (Phase 1). DASHBOARD-ONLY: this router is mounted
// JWT-only in server.js, so an API token can never manage tokens (no privilege
// self-escalation). A user manages their own tokens, bound to their active workspace.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { generateToken, hashToken, displayPrefix } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');
const { isZonedPlaylist } = require('../lib/agency-targets'); // #73: full-screen-only guardrail
const { isPlatformRole } = require('../middleware/auth');       // #146: billing:read mint gate

// #73: 'agency' is OFF the read/write/full ladder (not in apiToken.js SCOPE_RANK), so a
// tokenScopeGate-mounted router rejects it; it reaches only the AGENCY_ROUTER via agencyGate.
// #146: 'billing:read' is likewise off-ladder — reaches only /api/billing via requireBillingRead.
const SCOPES = ['read', 'write', 'full', 'agency', 'billing:read'];

// #158: per-workspace folder cap (mirrors folders.js) — auto-creating an agency folder must
// respect the same ceiling so a token-mint can't blow past it.
const MAX_FOLDERS_PER_WORKSPACE = 100;

// #158: resolve the folder an agency token uploads into. Either the admin PICKED an existing
// folder (must live in THIS workspace) or we AUTO-CREATE one named after the token. Returns the
// folder id, or throws { status, error } for a bad pick / folder-cap hit. Runs inside the token
// transaction so an auto-created folder and the token commit atomically.
function resolveAgencyUploadFolder(req, tokenName, pickedId) {
  if (pickedId) {
    const f = db.prepare('SELECT id, workspace_id FROM content_folders WHERE id = ?').get(pickedId);
    if (!f || f.workspace_id !== req.workspaceId) throw { status: 400, error: 'upload_folder_id is not a folder in this workspace' };
    return pickedId;
  }
  if (!isPlatformRole(req.user.role)) {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM content_folders WHERE workspace_id = ?').get(req.workspaceId);
    if (count >= MAX_FOLDERS_PER_WORKSPACE) throw { status: 429, error: `Folder limit reached (${MAX_FOLDERS_PER_WORKSPACE}). Pick an existing folder for this agency token or delete unused folders.` };
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO content_folders (id, user_id, workspace_id, parent_id, name) VALUES (?, ?, ?, NULL, ?)')
    .run(id, req.user.id, req.workspaceId, `Agency — ${tokenName}`.slice(0, 100));
  return id;
}

// List the caller's tokens in the active workspace. Never returns the secret/hash.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No active workspace' });
  const rows = db.prepare(`
    SELECT id, prefix, name, scope, auto_publish, upload_folder_id, workspace_id, created_at, last_used_at, revoked_at
    FROM api_tokens WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC
  `).all(req.user.id, req.workspaceId);
  // #73: attach designated playlists for agency tokens so the admin sees the binding persist.
  const targetsStmt = db.prepare('SELECT p.id, p.name FROM api_token_targets t JOIN playlists p ON p.id = t.playlist_id WHERE t.token_id = ? ORDER BY p.name');
  // #158: attach the bound upload folder's name (may be null = root, or dangling after delete).
  const folderStmt = db.prepare('SELECT name FROM content_folders WHERE id = ?');
  for (const r of rows) {
    if (r.scope === 'agency') {
      r.targets = targetsStmt.all(r.id);
      r.upload_folder = r.upload_folder_id ? (folderStmt.get(r.upload_folder_id)?.name || null) : null;
    }
  }
  res.json(rows);
});

// Create a token bound to the active workspace. The full secret is returned ONCE.
router.post('/', (req, res) => {
  if (!req.workspaceId || !req.workspace) return res.status(403).json({ error: 'No active workspace' });
  const name = (req.body.name || '').trim();
  const scope = req.body.scope || 'read';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'name too long' });
  if (!SCOPES.includes(scope)) return res.status(400).json({ error: "scope must be 'read', 'write', 'full', 'agency' or 'billing:read'" });
  // #146 BILLING: a billing:read token grants GLOBAL billing-read, so minting it is
  // PLATFORM-ADMIN ONLY — stricter than read/write/full/agency, which any workspace member
  // may mint. The privilege is concentrated at ISSUANCE; the token then carries only the
  // narrow read. NOTE: there is no finer "owner" tier than platform_admin here — #14
  // collapsed legacy superadmin → platform_admin, so PLATFORM_ROLES is the top level.
  if (scope === 'billing:read' && !isPlatformRole(req.user.role)) {
    return res.status(403).json({ error: 'only a platform admin can mint a billing:read token' });
  }
  // The token runs with platform powers stripped (role forced to 'user'), so it must
  // bind to a workspace the owner reaches via membership/org - not platform act-as -
  // else apiTokenAuth+resolveTenancy would land it in no workspace at use time.
  if (!accessContext(req.user.id, 'user', req.workspace)) {
    return res.status(400).json({ error: 'You must be a member of this workspace to create a token here' });
  }
  // #73: an agency token is bound to a NON-EMPTY allowlist of playlists in THIS workspace.
  // Validate up front so a bad target never leaves an orphan token behind.
  let targetIds = [];
  // auto_publish is meaningful ONLY for agency scope and is the admin's explicit opt-OUT of
  // approval. Anything but agency-scope + literal true -> 0 (draft, the fail-safe default).
  const autoPublish = (scope === 'agency' && req.body.auto_publish === true) ? 1 : 0;
  if (scope === 'agency') {
    targetIds = Array.isArray(req.body.target_playlist_ids) ? req.body.target_playlist_ids : [];
    if (!targetIds.length) return res.status(400).json({ error: 'an agency token requires target_playlist_ids' });
    const inWs = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?');
    for (const pid of targetIds) {
      if (!inWs.get(pid, req.workspaceId)) return res.status(400).json({ error: `playlist ${pid} is not in this workspace` });
      // #73: agencies get FULL-SCREEN playlists only - a zoned playlist can't take full-screen uploads.
      if (isZonedPlaylist(db, pid)) return res.status(400).json({ error: 'A selected playlist is assigned to a zone on a screen — agency uploads play full-screen, so it can\'t be shared with an agency. Use a full-screen playlist.' });
    }
  }
  const secret = generateToken();
  const id = crypto.randomUUID();
  let uploadFolderId = null;
  try {
    db.transaction(() => {
      // #158: agency uploads land in a bound folder — admin-picked (upload_folder_id) or
      // auto-created "Agency — <name>". Resolved inside the tx so folder + token commit together.
      if (scope === 'agency') uploadFolderId = resolveAgencyUploadFolder(req, name, req.body.upload_folder_id || null);
      db.prepare(`
        INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, auto_publish, upload_folder_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
      `).run(id, hashToken(secret), displayPrefix(secret), name, req.user.id, req.workspaceId, scope, autoPublish, uploadFolderId);
      if (scope === 'agency') {
        const ins = db.prepare('INSERT INTO api_token_targets (token_id, playlist_id) VALUES (?, ?)');
        for (const pid of targetIds) ins.run(id, pid);
      }
    })();
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    throw e;
  }
  // `token` is returned only here, never again.
  res.status(201).json({ id, token: secret, prefix: displayPrefix(secret), name, scope, workspace_id: req.workspaceId, target_playlist_ids: targetIds, auto_publish: !!autoPublish, upload_folder_id: uploadFolderId });
});

// Revoke one of the caller's own tokens (soft delete - takes effect on the next request).
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id, revoked_at FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Token not found' });
  if (!row.revoked_at) {
    db.prepare("UPDATE api_tokens SET revoked_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  }
  res.json({ success: true });
});

// #73: re-designate an agency token's playlist allowlist (atomic replace). JWT-only (this
// whole router is JWT-only), so an agency token can never widen its OWN targets.
router.put('/:id/targets', (req, res) => {
  const tok = db.prepare('SELECT id, scope, workspace_id FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!tok) return res.status(404).json({ error: 'Token not found' });
  if (tok.scope !== 'agency') return res.status(400).json({ error: 'only agency tokens have targets' });
  const ids = Array.isArray(req.body.target_playlist_ids) ? req.body.target_playlist_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'target_playlist_ids must be a non-empty array' });
  const inWs = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?');
  for (const pid of ids) {
    if (!inWs.get(pid, tok.workspace_id)) return res.status(400).json({ error: `playlist ${pid} is not in this token's workspace` });
    // #73: full-screen-only - a zoned playlist can't be (re-)designated to an agency.
    if (isZonedPlaylist(db, pid)) return res.status(400).json({ error: 'A selected playlist is assigned to a zone on a screen — agency uploads play full-screen, so it can\'t be shared with an agency. Use a full-screen playlist.' });
  }
  const ins = db.prepare('INSERT OR IGNORE INTO api_token_targets (token_id, playlist_id) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM api_token_targets WHERE token_id = ?').run(tok.id);
    for (const pid of ids) ins.run(tok.id, pid);
  })();
  res.json({ id: tok.id, target_playlist_ids: ids });
});

// #158: rebind an agency token's upload folder (admin can move where an agency's uploads land,
// or unbind to root). JWT-only, like the rest of this router. upload_folder_id: a folder in the
// token's workspace, or null = root. Does NOT auto-create — clearing is explicit here.
router.put('/:id/upload-folder', (req, res) => {
  const tok = db.prepare('SELECT id, scope, workspace_id FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!tok) return res.status(404).json({ error: 'Token not found' });
  if (tok.scope !== 'agency') return res.status(400).json({ error: 'only agency tokens have an upload folder' });
  const folderId = req.body.upload_folder_id || null;
  if (folderId) {
    const f = db.prepare('SELECT id, workspace_id FROM content_folders WHERE id = ?').get(folderId);
    if (!f || f.workspace_id !== tok.workspace_id) return res.status(400).json({ error: 'upload_folder_id is not a folder in this token\'s workspace' });
  }
  db.prepare('UPDATE api_tokens SET upload_folder_id = ? WHERE id = ?').run(folderId, tok.id);
  res.json({ id: tok.id, upload_folder_id: folderId });
});

module.exports = router;
