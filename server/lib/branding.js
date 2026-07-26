'use strict';

// Issue #15: instance-level default white-label branding.
//
// Branding is stored per-workspace in white_labels (keyed by workspace_id). This
// adds a single "platform default" row that every workspace inherits unless it
// has set its own. Resolution order:
//   1. the current workspace's row        (per-workspace override; unchanged)
//   2. a custom-domain match              (public/pre-login white-label hosts)
//   3. the platform-default row           (instance default, #15)
//   4. hardcoded ScreenTinker fallback
//
// The platform-default row is identified by a FIXED id (not "workspace_id IS
// NULL"): legacy pre-multitenancy white_labels rows can also have a null
// workspace_id, so a null-scope sentinel would be ambiguous. A fixed id is not.
//
// Override is ROW-LEVEL: a workspace that has any row uses it wholesale; only
// workspaces with NO row fall through to the platform default. No row-copying at
// creation, so editing the platform default propagates everywhere instantly.

const PLATFORM_DEFAULT_ID = 'platform-default';

const HARDCODED_BRANDING = {
  brand_name: 'SwiftDisplay',
  logo_url: '/assets/logowhiteswift.png',
  favicon_url: '/assets/pwa-icon.png',
  primary_color: '#ff6b00',
  secondary_color: '#1E293B',
  bg_color: '#1c1c1e',
  custom_css: null,
  hide_branding: 0,
};

// The single platform-default row (fixed id), or null if none has been set.
function platformDefaultRow(db) {
  return db.prepare('SELECT * FROM white_labels WHERE id = ?').get(PLATFORM_DEFAULT_ID) || null;
}

// Resolve effective branding for a context. Pass whichever you have:
//   { workspaceId } for the authed app, { domain } for the public/login path.
function resolveBranding(db, { workspaceId = null, domain = null } = {}) {
  if (workspaceId) {
    const wl = db.prepare('SELECT * FROM white_labels WHERE workspace_id = ?').get(workspaceId);
    if (wl) return wl;
  }
  if (domain) {
    const wl = db.prepare('SELECT * FROM white_labels WHERE custom_domain = ?').get(domain);
    if (wl) return wl;
  }
  return platformDefaultRow(db) || { ...HARDCODED_BRANDING };
}

// Presentational fields only. The PUBLIC resolver (GET /api/branding) and the
// by-domain lookup must not leak internal columns (id, user_id, workspace_id,
// custom_domain, timestamps) to unauthenticated / cross-tenant callers.
const PUBLIC_BRANDING_FIELDS = ['brand_name', 'logo_url', 'favicon_url', 'primary_color', 'secondary_color', 'bg_color', 'custom_css', 'hide_branding'];
function publicBranding(row) {
  const out = {};
  for (const f of PUBLIC_BRANDING_FIELDS) out[f] = row ? (row[f] ?? null) : null;
  return out;
}

module.exports = { resolveBranding, platformDefaultRow, publicBranding, HARDCODED_BRANDING, PLATFORM_DEFAULT_ID };
