'use strict';

/*
 * Plugin loader. Off by default and invisible (P1). When PLUGINS_ENABLED is unset this
 * module still exists, but boot() returns without scanning, requiring, or mounting.
 *
 * Plugins are trusted local code, same as server/lib — there is no sandbox. They load
 * from two directories only (P2). A broken plugin is recorded and skipped (P3). Nothing
 * here fetches a registry or phones home (P4). An uploaded zip is never require()'d
 * until a platform admin has approved that exact tree hash (P9).
 */

const fs = require('fs');
const path = require('path');
const { validateManifest } = require('./validate-manifest');
const { isInside, realpathOrNull, pluginRoots } = require('./paths');
const { RESERVED_WIDGET_TYPES, RESERVED_DATA_SOURCE_TYPES } = require('./reserved');
const registry = require('./registry');
const sanitize = require('../widget-sanitize');
const secrets = require('./secrets');
const hooks = require('./hooks');
const { satisfies } = require('./semver');
const VERSION = require('../../version');
const { makePluginFetch } = require('./egress');
const allowlist = require('./allowlist');

function readStateMap(db) {
  const map = new Map();
  try {
    for (const row of db.prepare('SELECT id, enabled, error, allowlist_required FROM plugin_state').all()) {
      map.set(row.id, row);
    }
  } catch (e) {
    if (!/no such table/i.test(e.message)) {
      console.warn('[plugins] could not read plugin_state:', e.message);
    }
  }
  return map;
}

function persistError(db, id, error) {
  try {
    db.prepare(`
      INSERT INTO plugin_state (id, enabled, error, updated_at)
      VALUES (?, 0, ?, strftime('%s','now'))
      ON CONFLICT(id) DO UPDATE SET error = excluded.error, updated_at = excluded.updated_at
    `).run(id, error);
  } catch (e) {
    console.warn(`[plugins] could not persist error for ${id}:`, e.message);
  }
}

function discover(cfg) {
  const found = new Map(); // id -> { dir, origin, manifest }
  for (const root of pluginRoots(cfg)) {
    const rootReal = realpathOrNull(root.dir);
    if (!rootReal) continue;
    let entries;
    try { entries = fs.readdirSync(rootReal, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const dir = path.join(rootReal, ent.name);
      const dirReal = realpathOrNull(dir);
      if (!dirReal || !isInside(rootReal, dirReal)) {
        console.warn(`[plugins] refused plugin path that escaped ${root.dir}: ${ent.name}`);
        continue;
      }
      const manifestPath = path.join(dirReal, 'plugin.json');
      let raw;
      try { raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
      catch (e) {
        registry.recordPlugin({
          id: ent.name, name: ent.name, origin: root.origin, dir: dirReal,
          enabled: false, loaded: false, error: `plugin.json: ${e.message}`,
          capabilities: [],
        });
        continue;
      }
      const { manifest, error } = validateManifest(raw, ent.name);
      if (error) {
        registry.recordPlugin({
          id: (raw && raw.id) || ent.name, name: ent.name, origin: root.origin, dir: dirReal,
          enabled: false, loaded: false, error, capabilities: [],
        });
        continue;
      }
      // Data-dir wins over bundled for the same id (operator override).
      found.set(manifest.id, { dir: dirReal, origin: root.origin, manifest });
    }
  }
  return found;
}

function makeApi(pluginId, manifest, db) {
  // A plugin may only use the capabilities it declared in plugin.json. validate-manifest
  // auto-adds "widget"/"data-source" when those blocks are present; "routes" and "hooks" must be
  // declared explicitly. Calling an undeclared capability throws, so activatePlugin catches it and
  // rolls the plugin back — the manifest's capabilities list is now a real grant, not a label.
  const caps = new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities : []);
  const settingsFields = (manifest.settings && manifest.settings.fields) || [];
  const requireCap = (cap, method) => {
    if (!caps.has(cap)) {
      throw new Error(`${method}() requires the "${cap}" capability, which ${pluginId} did not declare`);
    }
  };
  return Object.freeze({
    registerWidget(spec) {
      requireCap('widget', 'registerWidget');
      const merged = {
        ...spec,
        type: spec.type || (manifest.widget && manifest.widget.type),
        fields: spec.fields || (manifest.widget && manifest.widget.fields) || [],
        label: spec.label || (manifest.widget && manifest.widget.label),
        icon: spec.icon || (manifest.widget && manifest.widget.icon),
        network: manifest.network,
      };
      registry.registerWidget(pluginId, merged);
    },
    registerDataSource(spec) {
      requireCap('data-source', 'registerDataSource');
      const merged = {
        ...spec,
        type: spec.type || (manifest.dataSource && manifest.dataSource.type),
        fields: spec.fields || (manifest.dataSource && manifest.dataSource.fields) || [],
        label: spec.label || (manifest.dataSource && manifest.dataSource.label),
        icon: spec.icon || (manifest.dataSource && manifest.dataSource.icon),
        network: manifest.network,
      };
      registry.registerDataSource(pluginId, merged);
    },
    registerRouter(router) { requireCap('routes', 'registerRouter'); registry.registerRouter(pluginId, router); },
    on(name, fn) { requireCap('hooks', 'on'); hooks.register(pluginId, name, fn); },
    log(...args) { console.warn(`[plugin:${pluginId}]`, ...args); },
    // Egress goes through the plugin's declared network.allow list (if any) and then the SSRF guard.
    fetch: makePluginFetch(manifest.network && manifest.network.allow, { timeoutMs: 8000, maxBytes: 64 * 1024, responseType: 'text' }),
    getSettings() {
      try {
        const row = db.prepare('SELECT settings FROM plugin_state WHERE id = ?').get(pluginId);
        if (!row || !row.settings) return {};
        const parsed = JSON.parse(row.settings);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // Secret settings fields are encrypted at rest; decrypt for the plugin's use.
        return secrets.decryptSecrets(parsed, settingsFields);
      } catch { return {}; }
    },
    saveSettings(obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('settings must be an object');
      // Encrypt secret settings fields at rest.
      const json = JSON.stringify(secrets.encryptSecrets(obj, settingsFields));
      if (json.length > 32 * 1024) throw new Error('settings too large');
      db.prepare(`
        INSERT INTO plugin_state (id, enabled, settings, updated_at)
        VALUES (?, 1, ?, strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at
      `).run(pluginId, json);
    },
    escapeHtml: sanitize.escapeHtml,
    safeUrl: sanitize.safeUrl,
    safeCss: sanitize.safeCss,
    safeNumber: sanitize.safeNumber,
  });
}

function activatePlugin(entry, db) {
  const { dir, origin, manifest } = entry;
  const info = registry.recordPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    origin,
    dir,
    capabilities: manifest.capabilities,
    widget: manifest.widget,
    dataSource: manifest.dataSource,
    settingsFields: (manifest.settings && manifest.settings.fields) || [],
    enabled: true,
    loaded: false,
    error: null,
  });

  if (manifest.screentinker && !satisfies(manifest.screentinker, VERSION)) {
    const error = `requires ScreenTinker ${manifest.screentinker} (running ${VERSION})`;
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  if (manifest.widget && RESERVED_WIDGET_TYPES.has(manifest.widget.type)) {
    const error = `widget type "${manifest.widget.type}" is reserved`;
    info.enabled = true;
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  if (manifest.dataSource && RESERVED_DATA_SOURCE_TYPES.has(manifest.dataSource.type)) {
    const error = `data-source type "${manifest.dataSource.type}" is reserved`;
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  const allowErr = allowlist.assertLoadable(db, manifest.id, dir);
  if (allowErr) {
    const error = allowErr;
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  const mainAbs = path.resolve(dir, manifest.main);
  const mainReal = realpathOrNull(mainAbs);
  if (!mainReal || !isInside(dir, mainReal)) {
    const error = 'main escaped the plugin directory';
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  let mod;
  try {
    mod = require(mainReal);
  } catch (e) {
    const error = `require failed: ${e.message}`;
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  const activate = typeof mod === 'function' ? mod : (mod && mod.activate);
  if (typeof activate !== 'function') {
    const error = 'index.js must export activate(api) or module.exports = { activate }';
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
    return;
  }

  try {
    const result = activate(makeApi(manifest.id, manifest, db));
    if (result && typeof result.then === 'function') {
      const error = 'activate() must be synchronous — register capabilities before returning';
      registry.dropPlugin(manifest.id);
      info.error = error;
      persistError(db, manifest.id, error);
      console.warn(`[plugins] ${manifest.id}: ${error}`);
      return;
    }
    info.loaded = true;
    info.error = null;
    try {
      db.prepare(`
        INSERT INTO plugin_state (id, enabled, error, loaded_at, updated_at)
        VALUES (?, 1, NULL, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET error = NULL, loaded_at = excluded.loaded_at, updated_at = excluded.updated_at
      `).run(manifest.id);
    } catch (_) { /* table may be missing in unit tests */ }
  } catch (e) {
    registry.dropPlugin(manifest.id);
    const error = `activate failed: ${e.message}`;
    info.error = error;
    persistError(db, manifest.id, error);
    console.warn(`[plugins] ${manifest.id}: ${error}`);
  }
}

function loadPlugins(opts = {}) {
  const cfg = opts.config || require('../../config');
  const db = opts.db || require('../../db/database').db;
  registry.reset();

  if (!cfg.pluginsEnabled) {
    return { enabled: false, plugins: [] };
  }

  const found = discover(cfg);
  const state = opts.stateMap || readStateMap(db);

  for (const [id, entry] of found) {
    const row = state.get(id);
    const enabled = !!(row && Number(row.enabled) === 1);
    if (!enabled) {
      registry.recordPlugin({
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        origin: entry.origin,
        dir: entry.dir,
        capabilities: entry.manifest.capabilities,
        widget: entry.manifest.widget,
        dataSource: entry.manifest.dataSource,
        settingsFields: (entry.manifest.settings && entry.manifest.settings.fields) || [],
        enabled: false,
        loaded: false,
        error: row && row.error ? row.error : null,
      });
      continue;
    }
    activatePlugin(entry, db);
  }

  return { enabled: true, plugins: registry.listPlugins() };
}

/*
 * Re-read the two plugin roots into the registry WITHOUT require(). Approve, a
 * drop-folder copy, and unpin all change the disk while the process is up; Admin
 * GET uses this so Enable is available on the newly appeared id. It must never
 * activate — loading new Node into a running process is a restart (P9).
 *
 * Already-loaded plugins are left alone (their code is in memory until restart).
 * A directory that vanished and was not loaded is forgotten.
 */
function rescan(opts = {}) {
  const cfg = opts.config || require('../../config');
  const db = opts.db || require('../../db/database').db;
  if (!cfg.pluginsEnabled) return { enabled: false, plugins: registry.listPlugins() };

  const found = discover(cfg);
  const state = opts.stateMap || readStateMap(db);
  const seen = new Set();

  for (const [id, entry] of found) {
    seen.add(id);
    const existing = registry.getPlugin(id);
    if (existing && existing.loaded) continue;
    const row = state.get(id);
    const enabled = !!(row && Number(row.enabled) === 1);
    registry.recordPlugin({
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description,
      origin: entry.origin,
      dir: entry.dir,
      capabilities: entry.manifest.capabilities,
      widget: entry.manifest.widget,
      dataSource: entry.manifest.dataSource,
      settingsFields: (entry.manifest.settings && entry.manifest.settings.fields) || [],
      enabled,
      loaded: false,
      error: row && row.error ? row.error : null,
    });
  }

  for (const p of registry.listPlugins()) {
    if (seen.has(p.id) || p.loaded) continue;
    registry.forgetPlugin(p.id);
  }

  return { enabled: true, plugins: registry.listPlugins() };
}

function boot(app, { requireAuth, resolveTenancy } = {}, opts = {}) {
  const cfg = opts.config || require('../../config');
  if (!cfg.pluginsEnabled) return { enabled: false, plugins: [] };

  let result;
  try {
    result = loadPlugins(opts);
  } catch (e) {
    console.warn('[plugins] loader failed:', e.message);
    return { enabled: true, plugins: [], error: e.message };
  }

  try {
    const staticHandler = require('./static');
    app.use('/plugins/:id', staticHandler);
  } catch (e) {
    console.warn('[plugins] static mount failed:', e.message);
  }

  if (requireAuth && resolveTenancy) {
    for (const { pluginId, router } of registry.listRouters()) {
      try {
        app.use(`/api/plugins/${pluginId}`, requireAuth, resolveTenancy, router);
      } catch (e) {
        console.warn(`[plugins] router mount failed for ${pluginId}:`, e.message);
      }
    }
  }

  const loaded = result.plugins.filter((p) => p.loaded).length;
  const errors = result.plugins.filter((p) => p.error).length;
  if (result.plugins.length) {
    console.log(`[plugins] ${result.plugins.length} discovered, ${loaded} loaded, ${errors} error(s)`);
  }
  return result;
}

module.exports = { loadPlugins, boot, discover, rescan };
