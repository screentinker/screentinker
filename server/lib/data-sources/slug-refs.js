'use strict';

/*
 * Where a data source's slug is written down, and renaming it there.
 *
 * ⚠️ A SLUG IS A NAME OTHER THINGS HOLD. Slides and widgets bind to a source by text, not by id:
 * `{{ds:menu.latte_price}}` in any string of a widget config (slides, tickers, text…), a menu
 * board's `source: { slug }`, and a template widget's data_source values + `ds_refs`. Renaming the
 * source used to leave all of them on the old name, and every one of those tags then rendered as
 * empty text with no warning anywhere. PUT /api/data-sources/:id now asks first (GET
 * /:id/references) and rewrites them when told to (`rewrite_tags: true`).
 *
 * Same workspace only: that is the only scope a slug resolves in (getWorkspaceDataMapSync).
 */

// Lazy, so rewriteConfig() can be unit-tested without opening a database.
const db = () => require('../../db/database').db;

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `{{ds:old.` and not `{{ds:old`: 'room' must not match the tags of 'room-b'.
const tagRe = (slug) => new RegExp(`\\{\\{ds:${escRe(slug)}\\.`, 'gi');
const sameSlug = (a, b) => typeof a === 'string' && a.toLowerCase() === String(b).toLowerCase();

/**
 * Rewrite one parsed widget config in place. Returns true when anything changed.
 * `dsParams`: for a template widget, the names of its data_source params (null = unknown, then a
 * value is only treated as a slug when ds_refs already lists it).
 */
function rewriteConfig(cfg, oldSlug, newSlug, dsParams = null) {
  if (!cfg || typeof cfg !== 'object') return false;
  let changed = false;
  const re = tagRe(oldSlug);
  const walk = (v) => {
    if (typeof v === 'string') {
      re.lastIndex = 0;
      if (!re.test(v)) return v;
      changed = true;
      return v.replace(tagRe(oldSlug), `{{ds:${newSlug}.`);
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
    return v;
  };
  walk(cfg);
  // Menu board (lib/menu-board.js): source: { slug }.
  if (cfg.source && typeof cfg.source === 'object' && sameSlug(cfg.source.slug, oldSlug)) { cfg.source.slug = newSlug; changed = true; }
  // Template widget (lib/templates/widget.js): values[param] = slug, ds_refs: [{ slug }].
  if (Array.isArray(cfg.ds_refs)) {
    const listed = cfg.ds_refs.some((r) => r && sameSlug(r.slug, oldSlug));
    if (listed && cfg.values && typeof cfg.values === 'object') {
      for (const k of Object.keys(cfg.values)) {
        if ((dsParams ? dsParams.includes(k) : true) && sameSlug(cfg.values[k], oldSlug)) { cfg.values[k] = newSlug; changed = true; }
      }
    }
    for (const r of cfg.ds_refs) if (r && sameSlug(r.slug, oldSlug)) { r.slug = newSlug; changed = true; }
  }
  return changed;
}

function referencesSlug(configText, slug) {
  if (!configText || !slug) return false;
  const s = String(configText).toLowerCase();
  const l = String(slug).toLowerCase();
  return s.includes(`{{ds:${l}.`) || s.includes(`"slug":"${l}"`);
}

function templateDsParams(cfg) {
  if (!cfg || !cfg.template) return null;
  try {
    const store = require('../templates/store');
    const installed = store.getInstalled(cfg.template);
    const env = installed && store.loadPackage(installed.sha256);
    if (!env) return null;
    return env.manifest.params.filter((p) => p.type === 'data_source').map((p) => p.name);
  } catch { return null; }
}

/** The widgets (live config or pending draft) in a workspace that use this slug. */
function findReferences(workspaceId, slug) {
  if (!workspaceId || !slug) return [];
  return db().prepare('SELECT id, name, widget_type, config, draft_config FROM widgets WHERE workspace_id = ?').all(workspaceId)
    .filter((w) => referencesSlug(w.config, slug) || referencesSlug(w.draft_config, slug))
    .map((w) => ({ id: w.id, name: w.name, widget_type: w.widget_type }));
}

/**
 * Point every reference to oldSlug at newSlug, in the live config and any pending draft. Returns
 * the ids of the widgets changed. Their revision is advanced so the screens pick the change up.
 */
function rewriteReferences(workspaceId, oldSlug, newSlug) {
  if (!workspaceId || !oldSlug || !newSlug || oldSlug === newSlug) return [];
  const rows = db().prepare('SELECT id, config, draft_config FROM widgets WHERE workspace_id = ?').all(workspaceId)
    .filter((w) => referencesSlug(w.config, oldSlug) || referencesSlug(w.draft_config, oldSlug));
  const changedIds = [];
  const upd = db().prepare("UPDATE widgets SET config = ?, draft_config = ?, updated_at = MAX(updated_at + 1, strftime('%s','now')) WHERE id = ?");
  db().transaction(() => {
    for (const w of rows) {
      let config = w.config;
      let draft = w.draft_config;
      let changed = false;
      try {
        const cfg = JSON.parse(w.config || '{}');
        if (rewriteConfig(cfg, oldSlug, newSlug, templateDsParams(cfg))) { config = JSON.stringify(cfg); changed = true; }
      } catch (_) { /* a config we cannot read is left as it is */ }
      if (w.draft_config) {
        try {
          const d = JSON.parse(w.draft_config);
          const dc = d && d.config && typeof d.config === 'object' ? d.config : null;
          if (dc && rewriteConfig(dc, oldSlug, newSlug, templateDsParams(dc))) { draft = JSON.stringify(d); changed = true; }
        } catch (_) { /* likewise */ }
      }
      if (changed) { upd.run(config, draft, w.id); changedIds.push(w.id); }
    }
  })();
  return changedIds;
}

module.exports = { rewriteConfig, referencesSlug, findReferences, rewriteReferences };
