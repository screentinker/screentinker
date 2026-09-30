'use strict';

/*
 * Turning an installed template plus an operator's values into the document a player shows.
 *
 * ⚠️ AN HTML TEMPLATE IS SOMEBODY ELSE'S CODE, and everything here is arranged around that:
 *
 *  1. It runs in an OPAQUE ORIGIN, always. The response carries `Content-Security-Policy: sandbox
 *     allow-scripts`, which isolates the document even when nobody frames it — an admin who opens
 *     the render link in a tab, or an Android panel that loads it top-level in its WebView. The
 *     player's iframe sandbox attribute is not enough on its own: that only applies when there IS
 *     an iframe, and the dashboard's session JWT sits in localStorage on this very origin.
 *  2. It talks only to the hosts its manifest declared (connect/img/font/media-src), which the
 *     reviewer saw and the install dialog showed. Everything it ships is inlined as data: URIs,
 *     so 'none' is the default for everything else. The same policy is ALSO emitted as a <meta>
 *     at the very top of the document, so a copy of the HTML that loses its headers (a cache
 *     that stores bodies only) is still fenced.
 *  3. ⚠️ WHAT IT IS GIVEN, ITS AUTHOR CAN READ. WebRTC is a second way out CSP does not close:
 *     ICE is not governed by connect-src, and the `webrtc 'block'` directive that would govern it
 *     is not implemented by Chromium (149 logs it as unrecognised). The catalog lint refuses
 *     RTCPeerConnection instead. CSP cannot stop a document navigating its own
 *     frame to `https://anywhere/?q=<values>`, so nothing secret is ever put in one: there is no
 *     secret param type, and data-source values reach it only as the already-public rendered
 *     data. Review is what keeps a template honest; this file keeps a dishonest one small.
 *
 * A slide template is data, not code: its document goes through slide-render's normalizeSlide,
 * which clamps every value, and no author script exists to run.
 */

const pkgLib = require('./package');
const params = require('./params');

const MAX_DOC_BYTES = 6 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

function dataUri(mime, buf) {
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

/* Resolve `ref` (as written in `fromFile`) to a package path, or null for anything external. */
function resolveRef(fromFile, ref) {
  if (typeof ref !== 'string') return null;
  let r = ref.trim();
  if (!r || r.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r) || r.startsWith('//')) return null;
  r = r.split('#')[0].split('?')[0];
  const parts = (r.startsWith('/') ? r.slice(1) : dirOf(fromFile) + r).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

/*
 * ⚠️ INLINING IS BUDGETED, because it amplifies. Every reference to a file re-emits that file as
 * base64, so 300 references to one 1 MB image in 5 KB of HTML used to build a 400 MB document —
 * and 20,000 of them aborted the process with an out-of-memory crash, which the panels then
 * re-triggered on every retry. Each file is encoded ONCE per render (memo), and the running total
 * of what has been emitted is checked BEFORE each emission; over budget the whole render is
 * abandoned for a black page.
 */
class RenderBudgetError extends Error {}

function inliner(files, budgetBytes) {
  const memo = new Map();
  let spent = 0;
  const spend = (n) => {
    spent += n;
    if (spent > budgetBytes) throw new RenderBudgetError('template document exceeds the render budget');
  };
  function uriFor(p, depth = 0) {
    const mime = pkgLib.mimeFor(p);
    // Binary assets are never inlined — they are fetched by URL (ST.asset), see package.js budgets.
    if (!mime || mime === 'text/html' || pkgLib.isBinaryAsset(p)) return null;
    if (!memo.has(p)) {
      let buf = files.get(p);
      if (mime === 'text/css' && depth < 2) buf = Buffer.from(rewriteCss(buf.toString('utf8'), p, depth + 1));
      memo.set(p, dataUri(mime, buf));
    }
    const uri = memo.get(p);
    spend(uri.length);
    return uri;
  }
  // ⚠️ LINEAR. The unquoted branch excludes `(`, quotes and whitespace, and every branch is
  // length-bounded: the old `url\(\s*(['"]?)([^'")]+)\1\s*\)` backtracked quadratically, and
  // a 1 MB stylesheet of `url(` held the event loop for about five minutes.
  const CSS_URL_RE = /url\(\s*(?:"([^"\n]{0,2048})"|'([^'\n]{0,2048})'|([^'"()\s]{1,2048}))\s*\)/g;
  function rewriteCss(css, fromFile, depth) {
    return css.replace(CSS_URL_RE, (m, dq, sq, bare) => {
      const ref = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
      const p = resolveRef(fromFile, ref);
      if (!p || !files.has(p)) return m;
      const uri = uriFor(p, depth);
      return uri ? `url("${uri}")` : m;
    });
  }
  return { uriFor, rewriteCss: (css, from) => rewriteCss(css, from, 0) };
}

/**
 * The CSP for an html template. `network` is the manifest's host list (already validated as bare
 * hostnames by package.js, so nothing here can close the header or add a directive).
 */
/*
 * The base URL a template's binary assets are fetched from: THIS server's asset route for THIS
 * package only (a path-restricted CSP source, so it opens nothing else on the origin). Built from
 * the request's own origin and refused unless it has exactly the expected shape — the Host header
 * is caller-supplied, and this string goes into a CSP header.
 */
const ASSET_BASE_RE = /^https?:\/\/(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?\/api\/templates\/asset\/[0-9a-f]{64}\/$/;
function assetBaseFor(origin, sha256) {
  const base = `${origin}/api/templates/asset/${sha256}/`;
  return ASSET_BASE_RE.test(base) ? base : null;
}

function htmlCsp(network, { sandbox = true, assetBase = null, wasm = false } = {}) {
  const hosts = (network || []).filter((h) => pkgLib.HOST_RE.test(h)).map((h) => `https://${h}`);
  const wss = (network || []).filter((h) => pkgLib.HOST_RE.test(h)).map((h) => `wss://${h}`);
  const list = (base) => [...base, ...hosts].join(' ');
  const connect = [...hosts, ...wss, ...(assetBase && ASSET_BASE_RE.test(assetBase) ? [assetBase] : [])];
  const directives = [
    "default-src 'none'",
    // 'wasm-unsafe-eval' compiles WebAssembly and nothing else (eval/new Function stay blocked),
    // and only for a package that actually ships a .wasm file.
    `script-src 'unsafe-inline' data:${wasm ? " 'wasm-unsafe-eval'" : ''}`,
    "style-src 'unsafe-inline' data:",
    `img-src ${list(['data:', 'blob:'])}`,
    `font-src ${list(['data:'])}`,
    `media-src ${list(['data:', 'blob:'])}`,
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ];
  if (sandbox) directives.unshift('sandbox allow-scripts');
  return directives.join('; ');
}

/** JSON that is safe inside <script type="application/json">: no `<`, `>`, `&`, U+2028/9. */
function scriptSafeJson(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const RUNTIME = `<script>(function(){var d={};try{d=JSON.parse(document.getElementById('st-values').textContent)}catch(e){}
function fz(o){if(o&&typeof o==='object'){Object.freeze(o);for(var k in o){fz(o[k])}}return o}
var assets=d.assets||{};
window.ST=fz({values:d.values||{},data:d.data||{},template:d.template||{},
asset:function(p){return Object.prototype.hasOwnProperty.call(assets,p)?assets[p]:null},
ready:function(fn){if(document.readyState!=='loading'){fn()}else{document.addEventListener('DOMContentLoaded',fn)}}});})();</script>`;

/**
 * Build the html-kind document. `pkg` = { manifest, files: Map }.
 * `values` — already validated. `extra.images` — { paramName: dataUri|null } for image params.
 * `extra.data` — { paramName: flat object } for data_source params.
 */
function buildHtmlDocument(pkg, values, extra = {}) {
  const { manifest, files } = pkg;
  const entry = manifest.entry;
  let html = files.get(entry).toString('utf8');
  const inl = inliner(files, MAX_DOC_BYTES);
  const sha = pkg.sha256;
  const assetBase = extra.origin && sha ? assetBaseFor(extra.origin, sha) : null;
  const assets = {};
  if (assetBase) {
    for (const p of files.keys()) if (pkgLib.isBinaryAsset(p)) assets[p] = assetBase + p.split('/').map(encodeURIComponent).join('/');
  }
  const wasm = [...files.keys()].some((p) => pkgLib.extOf(p) === '.wasm');
  try {
    // Local references become data: URIs. Anything else is left alone and the CSP decides.
    // Bounded like the CSS pattern: no nested quantifiers, the value capped at 2 KB.
    html = html.replace(/(\s(?:src|href|poster)\s*=\s*)(?:"([^"]{0,2048})"|'([^']{0,2048})')/gi, (m, pre, dq, sq) => {
      const ref = dq !== undefined ? dq : sq;
      const q = dq !== undefined ? '"' : "'";
      const p = resolveRef(entry, ref);
      if (!p || !files.has(p)) return m;
      if (assets[p]) return `${pre}${q}${assets[p]}${q}`;
      const uri = inl.uriFor(p);
      return uri ? `${pre}${q}${uri}${q}` : m;
    });
    html = inl.rewriteCss(html, entry);
  } catch (e) {
    if (e instanceof RenderBudgetError) return { html: blankPage('Template is too large to render'), csp: htmlCsp([]) };
    throw e;
  }
  // A leading doctype is re-emitted by us, first, so the prelude below sits ahead of every byte the
  // author wrote without dropping the page into quirks mode.
  html = html.replace(/^\uFEFF?\s*<!doctype[^>]*>/i, '');

  const shown = {};
  for (const p of manifest.params) {
    if (p.type === 'image') shown[p.name] = (extra.images && extra.images[p.name]) || null;
    else if (p.type === 'data_source') shown[p.name] = values[p.name] || '';
    else shown[p.name] = values[p.name];
  }
  const payload = {
    values: shown,
    data: extra.data || {},
    template: { id: manifest.id, version: manifest.version, name: manifest.name },
    assets,
  };
  const policy = { assetBase, wasm };
  const prelude = '<!DOCTYPE html><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${htmlCsp(manifest.network, { ...policy, sandbox: false })}">`
    + '<meta name="referrer" content="no-referrer">'
    + `<script id="st-values" type="application/json">${scriptSafeJson(payload)}</script>${RUNTIME}`;
  const doc = prelude + html;
  if (Buffer.byteLength(doc) > MAX_DOC_BYTES) return { html: blankPage('Template is too large to render'), csp: htmlCsp([]) };
  return { html: doc, csp: htmlCsp(manifest.network, policy) };
}

/**
 * The slide config (template + fields) for a slide-kind template, with values substituted.
 * normalizeSlide (in renderSlideHtml) does the rest of the checking.
 */
function buildSlideConfig(pkg, values) {
  let doc;
  try { doc = JSON.parse(pkg.files.get(pkg.manifest.entry).toString('utf8')); } catch { doc = {}; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  const substituted = params.substitute({ template: doc.template || {}, fields: doc.fields || {} }, pkg.manifest.params, values);
  // A data_source param left empty turns `{{ds:{{param:x}}.key}}` into `{{ds:.key}}`, which the
  // data-source interpolation (rightly) does not match — so the raw token would be painted on the
  // wall. Unbound tokens become empty text instead.
  for (const [k, v] of Object.entries(substituted.fields || {})) {
    if (typeof v === 'string') substituted.fields[k] = v.replace(/\{\{ds:\.[a-zA-Z0-9_]*\}\}/g, '');
  }
  return substituted;
}

/** resolveImage for a slide template: `tpl:` refs from the package, everything else delegated. */
function slideImageResolver(pkg, fallback) {
  return (id) => {
    if (typeof id === 'string' && id.startsWith('tpl:')) {
      const p = params.packageImage(id, pkg.files);
      if (!p) return null;
      const buf = pkg.files.get(p);
      if (buf.length > MAX_INLINE_IMAGE_BYTES) return null;
      return dataUri(pkgLib.mimeFor(p), buf);
    }
    return typeof fallback === 'function' ? fallback(id) : null;
  };
}

/** Values checked one by one; an invalid stored value falls back to the default, never throws. */
function lenientValues(manifest, stored, ctx) {
  const out = {};
  const src = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
  for (const p of manifest.params) {
    let v;
    try {
      v = Object.prototype.hasOwnProperty.call(src, p.name) && src[p.name] !== null
        ? params.checkValue(p, src[p.name], ctx) : undefined;
    } catch { v = undefined; }
    if (v === undefined) {
      try { v = p.default !== undefined ? params.checkValue(p, p.default, { files: ctx.files }) : (p.type === 'checkbox' ? false : ''); }
      catch { v = p.type === 'checkbox' ? false : ''; }
    }
    out[p.name] = v;
  }
  return out;
}

/** A page for a template that cannot be shown. Black, like every other failed widget on a wall. */
function blankPage(reason) {
  const safe = String(reason || '').replace(/[<>&"']/g, '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safe}</title></head>`
    + '<body style="margin:0;background:#000"></body></html>';
}

module.exports = {
  MAX_INLINE_IMAGE_BYTES, MAX_DOC_BYTES, RenderBudgetError,
  htmlCsp, assetBaseFor, scriptSafeJson, resolveRef, buildHtmlDocument, buildSlideConfig, slideImageResolver,
  lenientValues, blankPage, dataUri,
};
