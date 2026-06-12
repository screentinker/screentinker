// Public API token management (Phase 1). DASHBOARD-ONLY: this router is mounted
// JWT-only in server.js, so an API token can never manage tokens (no privilege
// self-escalation). A user manages their own tokens, bound to their active workspace.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { generateToken, hashToken, displayPrefix } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');

const SCOPES = ['read', 'write', 'full'];

// List the caller's tokens in the active workspace. Never returns the secret/hash.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No active workspace' });
  const rows = db.prepare(`
    SELECT id, prefix, name, scope, workspace_id, created_at, last_used_at, revoked_at
    FROM api_tokens WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC
  `).all(req.user.id, req.workspaceId);
  res.json(rows);
});

// Create a token bound to the active workspace. The full secret is returned ONCE.
router.post('/', (req, res) => {
  if (!req.workspaceId || !req.workspace) return res.status(403).json({ error: 'No active workspace' });
  const name = (req.body.name || '').trim();
  const scope = req.body.scope || 'read';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'name too long' });
  if (!SCOPES.includes(scope)) return res.status(400).json({ error: "scope must be 'read', 'write' or 'full'" });
  // The token runs with platform powers stripped (role forced to 'user'), so it must
  // bind to a workspace the owner reaches via membership/org - not platform act-as -
  // else apiTokenAuth+resolveTenancy would land it in no workspace at use time.
  if (!accessContext(req.user.id, 'user', req.workspace)) {
    return res.status(400).json({ error: 'You must be a member of this workspace to create a token here' });
  }
  const secret = generateToken();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(id, hashToken(secret), displayPrefix(secret), name, req.user.id, req.workspaceId, scope);
  // `token` is returned only here, never again.
  res.status(201).json({ id, token: secret, prefix: displayPrefix(secret), name, scope, workspace_id: req.workspaceId });
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

module.exports = router;
