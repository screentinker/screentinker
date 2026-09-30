'use strict';

/*
 * Installed templates: the database rows and the package files behind them.
 *
 * ⚠️ CONTENT-ADDRESSED, AND RE-VERIFIED ON EVERY LOAD. A package lives at
 * `$DATA_DIR/templates/packages/<sha256>.sttemplate`, and loading it recomputes that sha256 from
 * the bytes and compares it with the row. A file edited on disk after install — by an operator,
 * a backup restore gone wrong, or anyone with write access to the data dir — is refused rather
 * than rendered. The same rule the plugin allowlist applies to a plugin's tree (P10).
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../../db/database');
const config = require('../../config');
const pkgLib = require('./package');

function root() {
  return process.env.TEMPLATES_DIR || path.join(config.dataDir, 'templates');
}
function packagesDir() { return path.join(root(), 'packages'); }

function packagePath(sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('bad sha256');
  return path.join(packagesDir(), `${sha256}.sttemplate`);
}

/** Write a package file (the envelope bytes) under its sha. Idempotent. */
function putPackageFile(sha256, envelopeBytes) {
  fs.mkdirSync(packagesDir(), { recursive: true });
  const dst = packagePath(sha256);
  const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, envelopeBytes, { mode: 0o640 });
  fs.renameSync(tmp, dst);
  return dst;
}

function hasPackageFile(sha256) {
  try { return fs.statSync(packagePath(sha256)).isFile(); } catch { return false; }
}

// Parsed packages, by sha. Small: a package is ≤2 MB and a server shows a handful of templates.
const cache = new Map();
const CACHE_MAX = 24;

/** Load + re-verify a package by sha. Returns { manifest, files, sha256, signature, packageBytes } or null. */
function fileStamp(sha256) {
  try { const st = fs.statSync(packagePath(sha256)); return `${st.size}:${st.mtimeMs}:${st.ino}`; } catch { return null; }
}

function loadPackage(sha256) {
  // ⚠️ A cache hit is re-checked against the file's stat, so a package swapped on disk after it
  // was first loaded is re-read — and re-hashed — rather than served from memory until restart.
  const stamp = fileStamp(sha256);
  if (!stamp) { cache.delete(sha256); return null; }
  if (cache.has(sha256)) {
    const hit = cache.get(sha256);
    if (hit._stamp === stamp) {
      cache.delete(sha256); cache.set(sha256, hit);
      return hit;
    }
    cache.delete(sha256);
  }
  let bytes;
  try { bytes = fs.readFileSync(packagePath(sha256)); } catch { return null; }
  let env;
  try { env = pkgLib.parseEnvelope(bytes); } catch { return null; }
  if (env.sha256 !== sha256) {
    console.warn(`[templates] package ${sha256.slice(0, 12)}… on disk does not match its hash — refusing it`);
    return null;
  }
  Object.defineProperty(env, '_stamp', { value: stamp, enumerable: false });
  cache.set(sha256, env);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return env;
}

function rowToInstalled(r) {
  if (!r) return null;
  let manifest = null;
  try { manifest = JSON.parse(r.manifest_json); } catch { /* corrupt row */ }
  return { ...r, manifest };
}

function listInstalled() {
  return db.prepare('SELECT * FROM templates_installed ORDER BY name COLLATE NOCASE').all().map(rowToInstalled);
}

function getInstalled(id) {
  return rowToInstalled(db.prepare('SELECT * FROM templates_installed WHERE id = ?').get(String(id)));
}

/**
 * Record an install (or an explicit update to a new version). `env` is a parsed envelope whose
 * signature the caller has ALREADY evaluated into `trust`/`signer`/`catalog`.
 */
function recordInstall({ env, envelopeBytes, catalog, trust, signer, signerKeyId, userId }) {
  putPackageFile(env.sha256, envelopeBytes);
  const id = `${catalog}/${env.manifest.id}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO templates_installed (id, catalog, template_id, version, sha256, kind, name, manifest_json, trust, signer, signer_key_id, status, status_reason, installed_by, installed_at, updated_at)
    VALUES (@id, @catalog, @template_id, @version, @sha256, @kind, @name, @manifest_json, @trust, @signer, @signer_key_id, 'active', NULL, @user, @now, @now)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, sha256 = excluded.sha256, kind = excluded.kind,
      name = excluded.name, manifest_json = excluded.manifest_json, trust = excluded.trust, signer = excluded.signer, signer_key_id = excluded.signer_key_id,
      status = 'active', status_reason = NULL, updated_at = excluded.updated_at
  `).run({
    id, catalog, template_id: env.manifest.id, version: env.manifest.version, sha256: env.sha256,
    kind: env.manifest.kind, name: env.manifest.name, manifest_json: JSON.stringify(env.manifest),
    trust, signer: signer || null, signer_key_id: signerKeyId || null, user: userId || null, now,
  });
  bumpWidgets(id);
  return getInstalled(id);
}

function setStatus(id, status, reason) {
  const r = db.prepare("UPDATE templates_installed SET status = ?, status_reason = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(status, reason || null, id);
  if (r.changes) bumpWidgets(id);
  return r.changes;
}

/** Widgets using a template, across every workspace. */
function widgetsUsing(id) {
  return db.prepare("SELECT id, workspace_id, name, config FROM widgets WHERE widget_type = 'template'").all()
    .filter((w) => { try { return JSON.parse(w.config || '{}').template === id; } catch { return false; } });
}

function uninstall(id) {
  const users = widgetsUsing(id);
  if (users.length) {
    const e = new Error(`still used by ${users.length} widget${users.length === 1 ? '' : 's'}`);
    e.status = 409; e.widgets = users.map((w) => ({ id: w.id, name: w.name, workspace_id: w.workspace_id }));
    throw e;
  }
  const row = getInstalled(id);
  if (!row) return 0;
  db.prepare('DELETE FROM templates_installed WHERE id = ?').run(id);
  // The file is shared by sha; keep it if another install (another catalog id) still points at it.
  // Keep the file if another install uses it, or if a catalog index pins it (an offline bundle's
  // copy is the only copy an air-gapped server has — deleting it would make reinstalling impossible).
  const still = db.prepare('SELECT 1 FROM templates_installed WHERE sha256 = ?').get(row.sha256)
    || db.prepare('SELECT 1 FROM template_catalogs WHERE index_json LIKE ?').get(`%"${row.sha256}"%`);
  if (!still) { try { fs.unlinkSync(packagePath(row.sha256)); } catch { /* already gone */ } cache.delete(row.sha256); }
  return 1;
}

/*
 * A template's widgets must re-render when the template itself changes (update, revoke,
 * reinstate): widgets.updated_at is the player's rev, exactly as data-sources/service.js
 * bumpDependentWidgets uses it. Pushing to the panels is the route's job (it has `io`).
 */
let onWidgetsChanged = null;
function setWidgetsChangedHook(fn) { onWidgetsChanged = fn; }
function bumpWidgets(id) {
  const ws = widgetsUsing(id);
  if (!ws.length) return [];
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare('UPDATE widgets SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?');
  for (const w of ws) stmt.run(now, w.id);
  const ids = ws.map((w) => w.id);
  if (onWidgetsChanged) { try { onWidgetsChanged(ids); } catch { /* best effort */ } }
  return ids;
}

module.exports = {
  root, packagesDir, packagePath, putPackageFile, hasPackageFile, loadPackage,
  listInstalled, getInstalled, recordInstall, setStatus, uninstall, widgetsUsing, bumpWidgets,
  setWidgetsChangedHook,
  _clearCache: () => cache.clear(),
};
