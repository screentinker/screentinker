'use strict';

/*
 * The `template` widget type: an installed template, used in a workspace with its own values.
 *
 * config = { template: "<catalog>/<id>", values: { param: value }, ds_refs: [{ slug }] }
 *
 * ⚠️ THE STORED CONFIG IS NEVER TRUSTED AT RENDER. It is validated strictly when written through
 * /api/templates, but widget configs also arrive by other roads — revision restore, approvals,
 * workspace import, mesh replication — so render re-checks every value (lenientValues) and falls
 * back to the template's default for anything that does not pass. `ds_refs` exists only so
 * data-sources/service.js bumpDependentWidgets (which matches `"slug":"<slug>"`) re-renders the
 * widget when a bound source changes.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../../db/database');
const config = require('../../config');
const store = require('./store');
const params = require('./params');
const render = require('./render');
const catalog = require('./catalog');

class TemplateWidgetError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'TemplateWidgetError'; this.status = status; }
}

function dataSourceExistsIn(workspaceId) {
  return (slug) => !!db.prepare('SELECT 1 FROM data_sources WHERE workspace_id = ? AND slug = ?').get(workspaceId, slug);
}
function imageContentExistsIn(workspaceId) {
  return (id) => !!db.prepare("SELECT 1 FROM content WHERE id = ? AND workspace_id = ? AND mime_type LIKE 'image/%'").get(id, workspaceId);
}

/** Whether a template may be USED right now (install exists, active, allowed by policy). */
function usable(installed) {
  if (!installed) return 'not installed';
  if (installed.status !== 'active') return installed.status_reason || 'withdrawn';
  /*
   * ⚠️ "VERIFIED" IS A STANDING CLAIM, RE-CHECKED EVERY TIME. It means "signed by a catalog this
   * server trusts NOW": disabling a catalog, or rotating its key, withdraws that trust from what
   * was installed under it — not only from future installs.
   */
  if (installed.trust === 'verified') {
    const cat = catalog.getCatalog(installed.catalog);
    if (!cat || !cat.enabled) return `the ${installed.catalog} catalog is disabled on this server`;
    if (installed.signer_key_id) {
      let kid = null;
      try { kid = require('./signing').keyId(cat.public_key); } catch { kid = null; }
      if (kid !== installed.signer_key_id) return `the ${installed.catalog} catalog key has changed — reinstall this template`;
    }
  }
  if (installed.kind === 'html' && installed.trust !== 'verified' && !catalog.unsignedCodeAllowed()) {
    return 'unsigned code templates are switched off on this server';
  }
  return null;
}

/** Strictly validate a config for a workspace. Returns the clean config. Throws TemplateWidgetError/ParamError. */
function buildConfig(templateKey, valuesIn, workspaceId) {
  const installed = store.getInstalled(templateKey);
  const why = usable(installed);
  if (why) throw new TemplateWidgetError(`template ${String(templateKey).slice(0, 100)}: ${why}`, installed ? 409 : 404);
  const env = store.loadPackage(installed.sha256);
  if (!env) throw new TemplateWidgetError('the installed package failed its integrity check — reinstall it', 409);
  const values = params.resolveValues(env.manifest.params, valuesIn, {
    files: env.files,
    dataSourceExists: dataSourceExistsIn(workspaceId),
    contentExists: imageContentExistsIn(workspaceId),
  });
  return {
    template: installed.id,
    values,
    ds_refs: params.boundSlugs(env.manifest.params, values).map((slug) => ({ slug })),
  };
}

function readContentImage(contentId, workspaceId) {
  if (!params.CONTENT_ID_RE.test(String(contentId || ''))) return null;
  const row = workspaceId
    ? db.prepare("SELECT filepath, mime_type FROM content WHERE id = ? AND workspace_id = ? AND mime_type LIKE 'image/%'").get(contentId, workspaceId)
    : null;
  if (!row || !row.filepath || !/^image\/[a-zA-Z0-9.+-]+$/.test(row.mime_type)) return null;
  const base = path.resolve(config.contentDir || path.join(config.uploadsDir || path.join(config.dataDir, 'uploads'), 'content'));
  const file = path.resolve(base, row.filepath);
  if (!file.startsWith(base + path.sep)) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > render.MAX_INLINE_IMAGE_BYTES) return null;
    return render.dataUri(row.mime_type, fs.readFileSync(file));
  } catch { return null; }
}

/** Flat, bounded copy of a data source's cached values for an html template. */
function boundedData(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n++ >= 300) break;
    if (typeof k !== 'string' || k.length > 64) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  return out;
}

/**
 * Render a template widget row. Returns { html, csp }.
 * opts: resolveImage, resolveData, resolveFont — the same resolvers routes/widgets.js builds for
 * every other widget, already scoped to the widget's workspace.
 */
function renderTemplateWidget(widget, opts = {}) {
  // Whatever goes wrong inside a template render, the answer is a black page — never an
  // exception out of the render route, and never the process.
  try {
    return renderUnsafe(widget, opts);
  } catch (e) {
    console.warn(`[templates] render failed for widget ${String(widget && widget.id).slice(0, 40)}: ${e && e.message}`);
    return { html: render.blankPage(), csp: render.htmlCsp([]) };
  }
}

function renderUnsafe(widget, opts) {
  let cfg = {};
  try { cfg = JSON.parse(widget.config || '{}'); } catch { cfg = {}; }
  const installed = store.getInstalled(cfg.template);
  if (usable(installed)) return { html: render.blankPage(), csp: render.htmlCsp([]) };
  const env = store.loadPackage(installed.sha256);
  if (!env) return { html: render.blankPage(), csp: render.htmlCsp([]) };
  const values = render.lenientValues(env.manifest, cfg.values, { files: env.files });

  if (env.manifest.kind === 'slide') {
    const slideRender = require('../slide-render');
    const slideCfg = render.buildSlideConfig(env, values);
    const html = slideRender.renderSlideHtml(slideCfg, {
      resolveImage: render.slideImageResolver(env, opts.resolveImage),
      resolveFont: opts.resolveFont,
      resolveData: opts.resolveData,
    });
    // No author code runs in a slide, but it is still an opaque origin: nothing about a slide needs
    // this server's origin, so nothing gets it.
    return { html, csp: 'sandbox allow-scripts' };
  }

  const images = {};
  const data = {};
  let dataMap = null;
  for (const p of env.manifest.params) {
    const v = values[p.name];
    if (p.type === 'image' && v) {
      images[p.name] = String(v).startsWith('tpl:')
        ? render.slideImageResolver(env, null)(v)
        : readContentImage(v, widget.workspace_id);
    }
    // opts.dataFor: the public gallery's demo render supplies its own values and has no workspace.
    if (p.type === 'data_source' && v && typeof opts.dataFor === 'function') {
      data[p.name] = boundedData(opts.dataFor(v));
    } else if (p.type === 'data_source' && v && widget.workspace_id) {
      if (!dataMap) {
        try { dataMap = require('../data-sources/service').getWorkspaceDataMapSync(widget.workspace_id); } catch { dataMap = {}; }
      }
      data[p.name] = boundedData(dataMap[v]);
    }
  }
  return render.buildHtmlDocument(env, values, { images, data, origin: opts.origin });
}

module.exports = { TemplateWidgetError, usable, buildConfig, renderTemplateWidget, readContentImage };
