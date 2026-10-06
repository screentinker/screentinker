'use strict';

/*
 * /api/templates — the templates library.
 *
 * Browsing and USING installed templates is for any workspace member who can write (a template
 * widget is created in the active workspace like any other widget). Everything that changes what
 * code this server will serve — installing, importing, uninstalling, catalogs, the two switches —
 * is platform-admin only (PLATFORM_ROLES: never platform_operator, so a support session cannot
 * install anything either).
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES } = require('../middleware/auth');
const { denyReadOnly } = require('../lib/tenancy');
const appSettings = require('../lib/app-settings');
const catalog = require('../lib/templates/catalog');
const store = require('../lib/templates/store');
const tplWidget = require('../lib/templates/widget');
const render = require('../lib/templates/render');
const pkgLib = require('../lib/templates/package');
const gallery = require('../lib/templates/gallery');

const router = express.Router();

const KEY_RE = /^([a-z][a-z0-9-]{1,31})\/([a-z][a-z0-9-]{1,63})$/;

function isPlatformAdmin(req) { return !!(req.user && PLATFORM_ROLES.includes(req.user.role)); }
function requirePlatformAdmin(req, res, next) {
  if (!isPlatformAdmin(req)) return res.status(403).json({ error: 'Platform admin access required' });
  next();
}
function sendError(res, e) {
  const status = e && Number.isInteger(e.status) ? e.status : 500;
  if (status >= 500) console.warn('[templates]', e && e.stack ? e.stack : e);
  res.status(status).json({ error: status >= 500 ? 'Template operation failed' : e.message, ...(e && e.param ? { param: e.param } : {}), ...(e && e.widgets ? { widgets: e.widgets } : {}) });
}
function audit(req, action, details) {
  try {
    // Instance-wide actions: logged with NO workspace, never under whichever tenant workspace the
    // admin happened to have selected.
    require('../services/activity').logActivity(req.user && req.user.id, action, JSON.stringify(details), null, req.ip, null);
  } catch { /* the audit log is best effort, never a reason to fail the request */ }
}
function keyOf(req) {
  const key = `${req.params.catalog}/${req.params.id}`;
  return KEY_RE.test(key) ? key : null;
}

/* ------------------------------------------------------------------ browsing */

router.get('/library', (req, res) => {
  try { res.json(catalog.library(req.user.id)); } catch (e) { sendError(res, e); }
});

router.post('/library/seen', (req, res) => {
  const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys.filter((k) => typeof k === 'string' && KEY_RE.test(k)).slice(0, 2000) : null;
  try { res.json({ marked: catalog.markSeen(req.user.id, keys) }); } catch (e) { sendError(res, e); }
});

function publicInstalled(row) {
  const m = row.manifest || {};
  return {
    key: row.id, catalog: row.catalog, id: row.template_id, version: row.version, kind: row.kind, name: row.name,
    description: m.description || '', author: m.author || '', license: m.license || '', tags: m.tags || [],
    orientation: m.orientation || [], network: m.network || [], params: m.params || [],
    trust: row.trust, signer: row.signer, status: row.status, status_reason: row.status_reason,
    usable: !tplWidget.usable(row), unusable_reason: tplWidget.usable(row),
    thumbnail: m.thumbnail ? `/api/templates/thumb/${row.sha256}` : null,
    sha256: row.sha256, installed_at: row.installed_at, updated_at: row.updated_at,
  };
}

router.get('/installed', (req, res) => {
  try { res.json({ templates: store.listInstalled().map(publicInstalled) }); } catch (e) { sendError(res, e); }
});

router.get('/installed/:catalog/:id', (req, res) => {
  const key = keyOf(req);
  const row = key && store.getInstalled(key);
  if (!row) return res.status(404).json({ error: 'Template not installed' });
  const out = publicInstalled(row);
  if (isPlatformAdmin(req)) out.used_by = store.widgetsUsing(key).map((w) => ({ id: w.id, name: w.name, workspace_id: w.workspace_id }));
  res.json(out);
});

/* ------------------------------------------------------------------ using */

/*
 * Previews: an unguessable token, served without auth (an iframe cannot send the dashboard's
 * bearer token) and ALWAYS with the sandbox CSP.
 *
 * ⚠️ THE TOKEN HOLDS THE INPUTS, NOT THE DOCUMENT. It used to hold the rendered HTML — up to 6 MB
 * each, 200 of them, shared by every tenant — so one editor with a large template could park ~1 GB
 * in server memory in a few seconds and evict everyone else's previews. Now it holds the template
 * key and the validated values (a few KB), rendered on each GET; each user keeps at most a handful.
 */
const previews = new Map();
const PREVIEW_TTL = 5 * 60 * 1000;
const PREVIEW_MAX = 500;
const PREVIEW_PER_USER = 5;
const PREVIEW_MAX_VALUES_BYTES = 64 * 1024;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.at > PREVIEW_TTL) previews.delete(k);
}, 60 * 1000).unref();

function renderPreview(p, origin) {
  const fake = { id: 'preview', workspace_id: p.workspaceId, widget_type: 'template', config: JSON.stringify({ template: p.key, values: p.values }) };
  const widgets = require('./widgets');
  return tplWidget.renderTemplateWidget(fake, {
    origin,
    resolveImage: widgets.imageResolverFor(fake),
    resolveFont: require('./fonts').fontResolverFor(fake),
    resolveData: widgets.dataResolverFor(fake),
  });
}

router.post('/installed/:catalog/:id/preview', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const key = keyOf(req);
  try {
    // Partial: a preview is shown while the form is still being filled in.
    const installed = key && store.getInstalled(key);
    const why = tplWidget.usable(installed);
    if (why) return res.status(installed ? 409 : 404).json({ error: why });
    const env = store.loadPackage(installed.sha256);
    if (!env) return res.status(409).json({ error: 'the installed package failed its integrity check' });
    const values = require('../lib/templates/params').resolveValues(env.manifest.params, req.body && req.body.values, {
      files: env.files, partial: true,
      dataSourceExists: (s) => !!db.prepare('SELECT 1 FROM data_sources WHERE workspace_id = ? AND slug = ?').get(req.workspaceId, s),
      contentExists: (id) => !!db.prepare("SELECT 1 FROM content WHERE id = ? AND workspace_id = ? AND mime_type LIKE 'image/%'").get(id, req.workspaceId),
    });
    if (Buffer.byteLength(JSON.stringify(values)) > PREVIEW_MAX_VALUES_BYTES) return res.status(413).json({ error: 'values too large' });
    // One user's previews never evict another user's: drop this user's oldest first.
    const mine = [...previews].filter(([, v]) => v.userId === req.user.id);
    while (mine.length >= PREVIEW_PER_USER) previews.delete(mine.shift()[0]);
    if (previews.size >= PREVIEW_MAX) return res.status(503).json({ error: 'too many previews in progress, try again shortly' });
    const token = crypto.randomBytes(24).toString('base64url');
    previews.set(token, { key, values, workspaceId: req.workspaceId, userId: req.user.id, at: Date.now() });
    res.json({ url: `/api/templates/preview/${token}` });
  } catch (e) { sendError(res, e); }
});

router.get('/preview/:token', (req, res) => {
  const p = previews.get(String(req.params.token));
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!p || Date.now() - p.at > PREVIEW_TTL) {
    res.setHeader('Content-Security-Policy', 'sandbox');
    return res.status(410).type('text/html').send(render.blankPage('Preview expired'));
  }
  // Rendered now, so an uninstall or revoke since the token was issued already applies.
  const out = renderPreview(p, `${req.protocol}://${req.get('host')}`);
  res.setHeader('Content-Security-Policy', out.csp);
  res.type('text/html').send(out.html);
});

/*
 * Binary assets (WebAssembly, game data, 3D models) by package hash. Public for the same reason as
 * a widget render — the sandboxed template fetches them with no credentials — and limited to:
 *   - a package that is INSTALLED and active (not merely cached from a bundle, not revoked);
 *   - the binary asset types only. Never html/js/css/svg: this is the dashboard's own origin, and
 *     serving third-party script from it would let any markup injection there load that script
 *     under the dashboard's `script-src 'self'`.
 * CORS-open (the template is an opaque origin, so its fetch carries `Origin: null`), immutable,
 * content-addressed, nosniff, and a sandbox CSP in case anyone opens one directly.
 */
router.get(/^\/asset\/([0-9a-f]{64})\/(.+)$/, (req, res) => {
  const sha = req.params[0];
  let rel;
  try { rel = decodeURIComponent(req.params[1]); } catch { return res.status(404).end(); }
  if (!pkgLib.isBinaryAsset(rel)) return res.status(404).end();
  const installed = db.prepare("SELECT id FROM templates_installed WHERE sha256 = ? AND status = 'active'").get(sha);
  if (!installed) return res.status(404).end();
  if (tplWidget.usable(store.getInstalled(installed.id))) return res.status(404).end();
  const env = store.loadPackage(sha);
  if (!env || !env.files.has(rel)) return res.status(404).end();
  const buf = env.files.get(rel);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Type', pkgLib.mimeFor(rel));
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

// Thumbnails by package hash: public (an <img> cannot send the bearer token), content-addressed,
// and only for a package this server holds and that still passes its integrity check.
router.get('/thumb/:sha', (req, res) => {
  const sha = String(req.params.sha);
  if (!/^[0-9a-f]{64}$/.test(sha)) return res.status(404).end();
  const env = store.loadPackage(sha);
  const t = env && env.manifest.thumbnail;
  if (!t || !env.files.has(t)) return res.status(404).end();
  const mime = pkgLib.mimeFor(t);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return res.status(404).end();
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(env.files.get(t));
});

/*
 * The public gallery's "Interactive web preview" (/templates): an installed OFFICIAL template,
 * rendered with its own defaults and demo weather, by package hash.
 *
 * Public because the marketing page is, and safe to be because:
 *   - only a package from the official catalog that is installed, active and usable here;
 *   - the values are the template's defaults plus lib/templates/gallery.js demo data, never a
 *     workspace's data, images or fonts (there is no workspace);
 *   - the document gets the same CSP as a real render (`sandbox allow-scripts`, opaque origin,
 *     connect-src limited to the manifest's declared hosts) — the page that frames it gets nothing;
 *   - rendered once per hash and cached in process, so a burst of visitors costs one render each,
 *     on top of the 120/min/IP limit on this public mount.
 * Off with the marketing page (DISABLE_HOMEPAGE).
 */
const demos = new Map();
const DEMO_TTL = 60 * 60 * 1000;
router.get('/demo/:sha', (req, res) => {
  const sha = String(req.params.sha);
  res.removeHeader('X-Frame-Options');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const gone = () => {
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).type('text/html').send(render.blankPage('Preview unavailable'));
  };
  if (require('../config').disableHomepage || !/^[0-9a-f]{64}$/.test(sha)) return gone();
  const row = db.prepare("SELECT id FROM templates_installed WHERE sha256 = ? AND status = 'active' AND catalog = ?").get(sha, gallery.OFFICIAL);
  const installed = row && store.getInstalled(row.id);
  if (!installed || tplWidget.usable(installed)) { demos.delete(sha); return gone(); }
  let out = demos.get(sha);
  if (!out || Date.now() - out.at > DEMO_TTL) {
    const env = store.loadPackage(sha);
    if (!env) return gone();
    const fake = { id: 'gallery-demo', workspace_id: null, widget_type: 'template', config: JSON.stringify({ template: installed.id, values: gallery.demoValues(env.manifest) }) };
    const r = tplWidget.renderTemplateWidget(fake, {
      origin: `${req.protocol}://${req.get('host')}`,
      resolveImage: () => null,
      resolveFont: () => null,
      resolveData: (slug, key) => { const d = gallery.demoData(slug); return d && d[key] !== undefined ? d[key] : null; },
      dataFor: (slug) => gallery.demoData(slug),
    });
    out = { ...r, at: Date.now() };
    if (demos.size > 200) demos.clear();
    demos.set(sha, out);
  }
  res.setHeader('Content-Security-Policy', out.csp);
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.type('text/html').send(out.html);
});

router.post('/installed/:catalog/:id/use', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace first.' });
  if (denyReadOnly(req, res)) return;
  const key = keyOf(req);
  if (!key) return res.status(404).json({ error: 'Template not installed' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  try {
    const config = tplWidget.buildConfig(key, req.body && req.body.values, req.workspaceId);
    const id = uuidv4();
    db.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, req.workspaceId, 'template', name || store.getInstalled(key).name, JSON.stringify(config));
    try { require('../lib/revisions').recordCurrent(db, 'widget', id, { actor: require('../lib/releases').actorOf(req), summary: `Created from template ${key}` }); } catch { /* optional */ }
    res.status(201).json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));
  } catch (e) { sendError(res, e); }
});

/* ------------------------------------------------------------------ administering */

router.get('/settings', requirePlatformAdmin, (req, res) => {
  res.json({ network_enabled: catalog.networkEnabled(), unsigned_code_allowed: catalog.unsignedCodeAllowed() });
});

router.put('/settings', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  if (b.network_enabled !== undefined) {
    appSettings.setBool(catalog.SETTING_ENABLED, b.network_enabled === true);
    if (b.network_enabled === true) catalog.startPoller();
  }
  if (b.unsigned_code_allowed !== undefined) {
    // Turning this on is a security decision about code running on screens: it must be said,
    // not clicked past, the same way the widget-sandbox toggle asks for a typed phrase.
    if (b.unsigned_code_allowed === true && b.confirm !== 'I understand unsigned templates run unreviewed code on my screens') {
      return res.status(400).json({ error: 'confirmation phrase required', phrase: 'I understand unsigned templates run unreviewed code on my screens' });
    }
    appSettings.setBool(catalog.SETTING_UNSIGNED_CODE, b.unsigned_code_allowed === true);
    // Widgets of unsigned html templates start or stop rendering: re-render them.
    for (const r of store.listInstalled()) if (r.kind === 'html' && r.trust !== 'verified') store.bumpWidgets(r.id);
  }
  audit(req, 'templates.settings', { network_enabled: catalog.networkEnabled(), unsigned_code_allowed: catalog.unsignedCodeAllowed() });
  res.json({ network_enabled: catalog.networkEnabled(), unsigned_code_allowed: catalog.unsignedCodeAllowed() });
});

router.get('/catalogs', requirePlatformAdmin, (req, res) => {
  res.json({ catalogs: catalog.listCatalogs().map((c) => ({
    id: c.id, label: c.label, url: c.url, builtin: !!c.builtin, enabled: !!c.enabled, public_key: c.public_key,
    key_id: (() => { try { return require('../lib/templates/signing').keyId(c.public_key); } catch { return null; } })(),
    serial: c.last_serial, expires: c.index_expires, last_checked: c.last_checked, last_ok: c.last_ok, last_error: c.last_error,
  })) });
});

router.post('/catalogs', requirePlatformAdmin, (req, res) => {
  try {
    const c = catalog.addCatalog({ id: req.body?.id, label: req.body?.label, url: req.body?.url, publicKey: req.body?.public_key });
    audit(req, 'templates.catalog_added', { id: c.id, url: c.url });
    res.status(201).json({ id: c.id });
  } catch (e) { sendError(res, e); }
});

router.patch('/catalogs/:cid', requirePlatformAdmin, (req, res) => {
  try {
    catalog.setCatalogEnabled(req.params.cid, req.body?.enabled === true);
    audit(req, 'templates.catalog_toggled', { id: req.params.cid, enabled: req.body?.enabled === true });
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

router.delete('/catalogs/:cid', requirePlatformAdmin, (req, res) => {
  try { catalog.removeCatalog(req.params.cid); audit(req, 'templates.catalog_removed', { id: req.params.cid }); res.json({ ok: true }); }
  catch (e) { sendError(res, e); }
});

router.post('/catalogs/:cid/refresh', requirePlatformAdmin, async (req, res) => {
  if (!catalog.networkEnabled()) return res.status(409).json({ error: 'The community library is switched off. Turn it on first, or import an offline bundle.' });
  try {
    const { index } = await catalog.refreshCatalog(req.params.cid);
    audit(req, 'templates.catalog_refreshed', { id: req.params.cid, serial: index.serial });
    res.json({ ok: true, serial: index.serial, templates: index.templates.length });
  } catch (e) {
    // An admin-triggered outbound fetch is audited whether or not it succeeded.
    audit(req, 'templates.catalog_refreshed', { id: String(req.params.cid).slice(0, 40), error: e && e.message ? String(e.message).slice(0, 200) : 'failed' });
    sendError(res, e);
  }
});

router.post('/install', requirePlatformAdmin, async (req, res) => {
  const { catalog: cid, id, version } = req.body || {};
  if (typeof cid !== 'string' || typeof id !== 'string' || (version !== undefined && typeof version !== 'string')) {
    return res.status(400).json({ error: 'catalog and id are required' });
  }
  try {
    const row = await catalog.installFromCatalog(cid, id, version, req.user.id);
    audit(req, 'templates.installed', { key: row.id, version: row.version, sha256: row.sha256, trust: row.trust });
    res.status(201).json(publicInstalled(row));
  } catch (e) { sendError(res, e); }
});

/*
 * Import: a .sttemplate (signed or not), an author's template .zip, or an offline catalog bundle.
 * Raw body so nothing is buffered to a temp dir first; the size cap is the parser's.
 */
const TEMPLATE_UPLOAD_LIMIT = pkgLib.MAX_ENVELOPE_BYTES + 64 * 1024;
const BUNDLE_UPLOAD_LIMIT = 300 * 1024 * 1024;
/*
 * ⚠️ THE SIZE IS DECIDED BEFORE ANYTHING IS BUFFERED. One 300 MB raw parser for every upload let
 * a 120 MB "template" cost ~220 MB of heap before the 8 MB check refused it. A template gets the
 * template limit; only an explicit ?kind=bundle gets the bundle one.
 */
function importBody(req, res, next) {
  const limit = req.query.kind === 'bundle' ? BUNDLE_UPLOAD_LIMIT : TEMPLATE_UPLOAD_LIMIT;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return res.status(413).json({ error: req.query.kind === 'bundle' ? 'offline bundle is too large' : `a template file is at most ${Math.round(pkgLib.MAX_ENVELOPE_BYTES / 1048576)} MB — is this an offline bundle? (kind=bundle)` });
  }
  if (Buffer.isBuffer(req.body)) return next();   // parsed earlier (server.js mounts this before express.json)
  return express.raw({ type: () => true, limit })(req, res, next);
}

router.post('/import', requirePlatformAdmin, importBody, async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'empty upload' });
  try {
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    if (isZip && req.query.kind === 'bundle') {
      const r = await catalog.importOfflineBundle(buf);
      audit(req, 'templates.bundle_imported', r);
      return res.json({ bundle: r });
    }
    const row = isZip ? await catalog.importTemplateZip(buf, req.user.id) : catalog.importPackage(buf, req.user.id);
    audit(req, 'templates.imported', { key: row.id, version: row.version, sha256: row.sha256, trust: row.trust });
    res.status(201).json(publicInstalled(row));
  } catch (e) { sendError(res, e); }
});

router.delete('/installed/:catalog/:id', requirePlatformAdmin, (req, res) => {
  const key = keyOf(req);
  if (!key) return res.status(404).json({ error: 'Template not installed' });
  try {
    if (!store.uninstall(key)) return res.status(404).json({ error: 'Template not installed' });
    audit(req, 'templates.uninstalled', { key });
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
module.exports.importBody = importBody;
