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
function buildConfig(templateKey, valuesIn, workspaceId, extra = {}) {
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
  const out = {
    template: installed.id,
    values,
    ds_refs: params.boundSlugs(env.manifest.params, values).map((slug) => ({ slug })),
  };
  // "Fill the zone": a slide template stretches to its zone instead of letterboxing (slide-render
  // FIT_SCRIPT). A display setting of the widget, not a template value, so it is kept beside them.
  if (extra && extra.fill_zone === true && env.manifest.kind === 'slide') out.fill_zone = true;
  return out;
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

/*
 * What a code (html) template receives as ST.data[param]: a flat, bounded copy of the source's
 * cached values. ⚠️ THE CAPS EXIST FOR THE RENDERED DOCUMENT, NOT THE SOURCE. All of it is
 * serialised into the one self-contained HTML document every screen downloads, parses and keeps in
 * memory — and render.buildHtmlDocument blanks the WHOLE template ("too large to render") past
 * render.MAX_DOC_BYTES (6 MB). Keys alone are not a byte bound: 3000 keys x 2000 chars is 6M
 * characters — up to ~18 MB of UTF-8 and more again after script-safe escaping — so there is a
 * byte budget too, per source and per document.
 *
 * SUMMARY KEYS GO FIRST. Sources emit per-row keys (row3_price, item2_title, day1_high,
 * event_4_title) alongside the keys a screen needs most (row_count, columns, sum_/avg_*, lookup keys,
 * status, current_/next_*, agenda_text) — and not always in that order. Everything that is not a
 * per-row key is taken first, so a wide table runs out of ROWS, never out of its totals.
 */
const MAX_TEMPLATE_DATA_KEYS = 3000;                     // per data source
const MAX_TEMPLATE_DATA_STRING = 2000;                   // characters per string value
const MAX_TEMPLATE_DATA_BYTES = 1024 * 1024;             // per data source, as serialised into the page
const MAX_TEMPLATE_DATA_DOC_BYTES = 2 * 1024 * 1024;     // all data sources of one render together
// Kept back from per-row keys in the shared budget, so a source listed after a huge one still gets
// its summary keys (row_count, status, …) rather than nothing.
const DOC_SUMMARY_RESERVE_BYTES = 64 * 1024;
const PER_ROW_KEY = /^(?:row|item|day)\d+_|^event_\d+_/;

/** Bytes a key/value pair adds to the page's script-safe JSON: both quoted and escaped, plus ":" and ",". */
function servedBytes(k, v) {
  return Buffer.byteLength(render.scriptSafeJson(k)) + Buffer.byteLength(render.scriptSafeJson(v)) + 2;
}

/**
 * `budget` — optional { bytes } shared by every data source of one render; spent as keys are taken.
 */
function boundedData(obj, budget) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  let keys = 0;
  let bytes = 0;
  const take = (k, v, isRow) => {
    if (keys >= MAX_TEMPLATE_DATA_KEYS) return false;
    const val = typeof v === 'string' ? v.slice(0, MAX_TEMPLATE_DATA_STRING) : v;
    const size = servedBytes(k, val);
    if (bytes + size > MAX_TEMPLATE_DATA_BYTES) return false;
    if (budget && size > budget.bytes - (isRow ? DOC_SUMMARY_RESERVE_BYTES : 0)) return false;
    out[k] = val;
    keys++;
    bytes += size;
    if (budget) budget.bytes -= size;
    return true;
  };
  const rows = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k.length > 64) continue;
    if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) continue;
    if (PER_ROW_KEY.test(k)) { rows.push([k, v]); continue; }
    take(k, v, false); // a summary value too big to fit is skipped; smaller ones after it still go in
  }
  // Rows in source order, stopping at the first that does not fit — no holes for a loop over rowN.
  for (const [k, v] of rows) if (!take(k, v, true)) break;
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
      fill: cfg.fill_zone === true,
    });
    // No author code runs in a slide, but it is still an opaque origin: nothing about a slide needs
    // this server's origin, so nothing gets it.
    return { html, csp: 'sandbox allow-scripts' };
  }

  const images = {};
  const data = {};
  const dataBudget = { bytes: MAX_TEMPLATE_DATA_DOC_BYTES };
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
      data[p.name] = boundedData(opts.dataFor(v), dataBudget);
    } else if (p.type === 'data_source' && v && widget.workspace_id) {
      if (!dataMap) {
        try { dataMap = require('../data-sources/service').getWorkspaceDataMapSync(widget.workspace_id); } catch { dataMap = {}; }
      }
      data[p.name] = boundedData(dataMap[v], dataBudget);
    }
  }
  return render.buildHtmlDocument(env, values, { images, data, origin: opts.origin });
}

module.exports = {
  TemplateWidgetError, usable, buildConfig, renderTemplateWidget, readContentImage, boundedData,
  MAX_TEMPLATE_DATA_KEYS, MAX_TEMPLATE_DATA_STRING, MAX_TEMPLATE_DATA_BYTES, MAX_TEMPLATE_DATA_DOC_BYTES,
};
