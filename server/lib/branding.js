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
  brand_name: 'ScreenTinker',
  logo_url: null,
  favicon_url: null,
  primary_color: '#3B82F6',
  secondary_color: '#1E293B',
  bg_color: '#111827',
  custom_css: null,
  hide_branding: 0,
};

// The longest brand name a screen shows (playerBrand) and the most the white-label save accepts.
const BRAND_NAME_MAX = 80;

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

// #674: the name a SCREEN shows (web player: setup, status and tap-to-start screens, tab title).
// A custom brand_name is always shown. "Hide platform branding" only ever hides the upstream name,
// so an instance that hides branding but never renamed itself shows no product name at all. The
// result is plain text: the caller escapes it for wherever it lands.
function playerBrand(row) {
  const r = row || HARDCODED_BRANDING;
  const name = String(r.brand_name || '').trim().slice(0, BRAND_NAME_MAX);
  const upstream = !name || name === HARDCODED_BRANDING.brand_name;
  if (upstream && r.hide_branding) return { name: '', hidden: true };
  return { name: name || HARDCODED_BRANDING.brand_name, hidden: false };
}

// GHSA-rvxj (E): a brand name is plain text, so refuse anything that only makes sense as markup.
// ⚠️ WHY at write time as well as at render: main's t()/asText() already neutralises it, but players
// and dashboards from before v3.2.0 render brand_name unescaped, and so would any future sink that
// doesn't go through t(). The cap is playerBrand's. Returns a plain message, or null when fine.
// Callers pass the raw request value; undefined (field not sent) is theirs to skip.
function brandNameProblem(v) {
  if (typeof v !== 'string') return 'Brand name must be text.';
  if (/[<>]/.test(v)) return 'Brand name cannot contain < or >.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return 'Brand name cannot contain control characters.';
  if (v.trim().length > BRAND_NAME_MAX) return `Brand name must be ${BRAND_NAME_MAX} characters or fewer.`;
  return null;
}

// The brand of the workspace a display belongs to. Workspace row, then the platform default, as for
// the dashboard. Never throws: a screen's pairing must not depend on branding.
function playerBrandForDevice(db, deviceId) {
  try {
    const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
    return playerBrand(resolveBranding(db, { workspaceId: (d && d.workspace_id) || null }));
  } catch (e) {
    return undefined;
  }
}

module.exports = { brandNameProblem, BRAND_NAME_MAX, resolveBranding, platformDefaultRow, publicBranding, playerBrand, playerBrandForDevice, HARDCODED_BRANDING, PLATFORM_DEFAULT_ID };
