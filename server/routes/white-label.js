const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
// Phase 2.2f: workspace-scoped branding. POST gated by requireWorkspaceAdmin
// per the design doc (branding is a workspace_admin power, not editor).
const { requireWorkspaceAdmin } = require('../lib/permissions');
const { resolveBranding, publicBranding } = require('../lib/branding');

// Get the current workspace's effective branding. #15: when the workspace has no
// row of its own, fall through to the platform default (workspace_id IS NULL)
// instead of the hardcoded ScreenTinker default, so unbranded/new workspaces
// inherit the instance brand.
router.get('/', (req, res) => {
  res.json(resolveBranding(db, { workspaceId: req.workspaceId || null }));
});

// Get branding by custom domain. #15: domain match -> platform default ->
// hardcoded. (Mounted behind requireAuth like the rest of this router; the
// public/pre-login path is GET /api/branding, registered before auth.)
router.get('/domain/:domain', (req, res) => {
  res.json(publicBranding(resolveBranding(db, { domain: req.params.domain })));
});

// Create or update the current workspace's white-label config. Restricted to
// workspace_admin / org_owner / org_admin / platform_admin.
router.post('/', requireWorkspaceAdmin, (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before configuring branding.' });

  const { brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color,
    custom_domain, custom_css, hide_branding } = req.body;

  // Security (#3): custom_domain drives the PUBLIC, pre-auth branding resolver
  // (GET /api/branding) and custom_css is injected into the login page's <style>.
  // A workspace_admin who set custom_domain to the platform's own host would
  // hijack every visitor's login page (defacement / fake-login CSS). Both are
  // powerful, cross-tenant-affecting fields - restrict them to platform admins.
  const setsDomain = custom_domain !== undefined && custom_domain !== null && custom_domain !== '';
  const setsCss = custom_css !== undefined && custom_css !== null && custom_css !== '';
  if (!req.isPlatformAdmin && (setsDomain || setsCss)) {
    return res.status(403).json({ error: 'custom_domain and custom_css can only be set by a platform administrator.' });
  }

  let wl = db.prepare('SELECT * FROM white_labels WHERE workspace_id = ?').get(req.workspaceId);

  if (wl) {
    const fields = { brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color, custom_domain, custom_css, hide_branding };
    const updates = [];
    const values = [];
    Object.entries(fields).forEach(([k, v]) => {
      if (v !== undefined) { updates.push(`${k} = ?`); values.push(v); }
    });
    if (updates.length) {
      updates.push("updated_at = strftime('%s','now')");
      values.push(req.workspaceId);
      db.prepare(`UPDATE white_labels SET ${updates.join(', ')} WHERE workspace_id = ?`).run(...values);
    }
  } else {
    const id = uuidv4();
    db.prepare(`INSERT INTO white_labels (id, user_id, workspace_id, brand_name, logo_url, favicon_url, primary_color, secondary_color, bg_color, custom_domain, custom_css, hide_branding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, req.user.id, req.workspaceId, brand_name || 'ScreenTinker', logo_url || null, favicon_url || null,
      primary_color || '#e65c00', secondary_color || '#1E293B', bg_color || '#111827',
      custom_domain || null, custom_css || null, hide_branding ? 1 : 0);
  }

  res.json(db.prepare('SELECT * FROM white_labels WHERE workspace_id = ?').get(req.workspaceId));
});

module.exports = router;
