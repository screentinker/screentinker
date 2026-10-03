'use strict';

/*
 * Turn an HTML bundle into ONE self-contained document.
 *
 * ⚠️ WHY THIS EXISTS AT ALL, given players are meant to unpack bundles themselves: because a
 * document is the only form every player can already render. Web, BrightSign, Android, Tizen and
 * Vega all mount an iframe at a server URL today; none of them can unzip anything yet. Inlining is
 * what makes a bundle playable on the whole fleet on the day it ships, and it stays afterwards as
 * the fallback for any player that never learns to unpack.
 *
 * ⚠️ AND IT IS DELIBERATELY NOT THE WHOLE FEATURE. Three things a real bundle may do cannot survive
 * being flattened, and each fails SILENTLY, so they are refused up front rather than discovered on
 * a wall:
 *
 *   - fetch()/XHR against its own files. A data: URI has no base URL, so `fetch('./data.json')`
 *     resolves against nothing. Unfixable here; it needs a real per-bundle origin.
 *   - <video>/<audio> from a data: URI. No range requests, so no seeking and, on several of these
 *     players, no playback at all.
 *   - anything that builds a URL at runtime (`new Image().src = base + name`). Static rewriting
 *     cannot see it.
 *
 * ⚠️ THE SIZE CAP IS LOAD-BEARING, NOT TIDINESS. base64 is +33%, and the document is a UTF-16 JS
 * string in the player before it is a DOM. The BrightSign HDx23 has a FIXED 128MB JS heap. The
 * repo's existing inliner (routes/widgets.js MAX_INLINE_BYTES) caps a single image at 10MB for the
 * same reason; a whole bundle gets a smaller total.
 */

const path = require('path');
const htmlBundle = require('./html-bundle');

/** Total decoded bytes we will inline into one document. See the note above. */
const MAX_INLINE_TOTAL = 8 * 1024 * 1024;

/** Depth limit for @import chains — a cycle is otherwise a hang. */
const MAX_CSS_DEPTH = 4;

/*
 * Extension → mime, for the data: URIs. A CLOSED MAP, and the reason is the same one the fonts
 * mount records: under nosniff a browser refuses a resource whose type is wrong, and that failure
 * looks exactly like a missing file. Anything not here is left as a relative URL, which is honest —
 * it will 404 rather than load as the wrong type.
 */
const INLINE_TYPES = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/* Media we refuse to inline rather than inline badly — see the note above. */
const REFUSED_INLINE = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mp3', '.wav', '.ogg', '.m4a']);

class InlineTooLargeError extends Error {
  constructor(msg) { super(msg); this.name = 'InlineTooLargeError'; this.status = 413; }
}

/** Resolve a reference found inside `fromFile` to a normalised archive path, or null. */
function resolveRef(fromFile, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  // Anything already absolute — a scheme, a protocol-relative URL, a root path, a data: or blob:
  // URI, or a pure fragment — is left exactly as it is. A bundle is allowed to reference the
  // network; flattening is only about its OWN files.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('/') || raw.startsWith('#')) return null;
  const base = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(base === '.' ? '' : base, raw.split('#')[0].split('?')[0]));
  return htmlBundle.normalizeEntryPath(joined);
}

/**
 * Flatten a bundle into one document.
 *
 * @returns {Promise<{html: string, inlined: number, bytes: number, skipped: string[]}>}
 */
async function inlineBundle(archivePath, entryPoint, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_INLINE_TOTAL;
  const cache = new Map();          // archive path -> Buffer | null
  const skipped = [];
  let budget = 0;
  let inlined = 0;

  async function read(name) {
    if (cache.has(name)) return cache.get(name);
    let buf = null;
    try { buf = await htmlBundle.readBundleEntry(archivePath, name); } catch (e) { buf = null; }
    cache.set(name, buf);
    return buf;
  }

  /** A data: URI for one archive file, or null when it must stay a plain reference. */
  async function dataUri(name) {
    const ext = path.posix.extname(name).toLowerCase();
    if (REFUSED_INLINE.has(ext)) { skipped.push(name); return null; }
    const mime = INLINE_TYPES[ext];
    if (!mime) { skipped.push(name); return null; }
    const buf = await read(name);
    if (!buf) { skipped.push(name); return null; }
    budget += buf.length;
    if (budget > maxBytes) {
      throw new InlineTooLargeError(
        `This bundle inlines to more than ${Math.round(maxBytes / 1048576)}MB, which is more than a player can hold in one document.`);
    }
    inlined++;
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /* CSS: url(...) and @import, resolved relative to the stylesheet they appear in. */
  async function inlineCss(css, fromFile, depth) {
    let out = css;

    if (depth < MAX_CSS_DEPTH) {
      const imports = [...out.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*;/gi)];
      for (const m of imports) {
        const target = resolveRef(fromFile, m[1]);
        if (!target) continue;
        const buf = await read(target);
        if (!buf) continue;
        budget += buf.length;
        if (budget > maxBytes) throw new InlineTooLargeError('This bundle inlines to more than the per-document limit.');
        out = out.replace(m[0], await inlineCss(buf.toString('utf8'), target, depth + 1));
      }
    }

    const urls = [...out.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
    for (const m of urls) {
      const target = resolveRef(fromFile, m[2]);
      if (!target) continue;
      const uri = await dataUri(target);
      if (uri) out = out.replace(m[0], `url("${uri}")`);
    }
    return out;
  }

  const entryBuf = await htmlBundle.readBundleEntry(archivePath, entryPoint);
  if (!entryBuf) throw new Error(`Bundle entry point is missing: ${entryPoint}`);
  let html = entryBuf.toString('utf8');

  /*
   * ⚠️ ATTRIBUTE REWRITING BY REGEX, AND THE LIMIT IS ACKNOWLEDGED RATHER THAN HIDDEN. A real
   * parser would be more correct on pathological markup; this covers the shapes a bundle actually
   * ships (href/src attributes and CSS url()). Anything it misses stays a relative URL and 404s
   * visibly, which is the right failure — it does not silently become the wrong resource.
   */

  // <link href> and <script/img/source/iframe src>. Ordered so <link rel=stylesheet> is handled by
  // the stylesheet pass below rather than base64'd as an opaque blob (a stylesheet's own url()s
  // would otherwise never be resolved).
  const links = [...html.matchAll(/<link\b[^>]*?\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/gi)];
  for (const m of links) {
    const target = resolveRef(entryPoint, m[2]);
    if (!target) continue;
    if (/\bstylesheet\b/i.test(m[0]) && path.posix.extname(target).toLowerCase() === '.css') {
      const buf = await read(target);
      if (!buf) continue;
      budget += buf.length;
      if (budget > maxBytes) throw new InlineTooLargeError('This bundle inlines to more than the per-document limit.');
      const css = await inlineCss(buf.toString('utf8'), target, 0);
      inlined++;
      html = html.replace(m[0], `<style>\n${css}\n</style>`);
    } else {
      const uri = await dataUri(target);
      if (uri) html = html.replace(m[0], m[0].replace(m[2], uri));
    }
  }

  const srcs = [...html.matchAll(/<(script|img|source|iframe|audio|video)\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\2[^>]*>/gi)];
  for (const m of srcs) {
    const target = resolveRef(entryPoint, m[3]);
    if (!target) continue;
    const uri = await dataUri(target);
    if (uri) html = html.replace(m[0], m[0].replace(m[3], uri));
  }

  // Inline <style> blocks, which carry their own url() references.
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const m of styles) {
    const css = await inlineCss(m[1], entryPoint, 0);
    if (css !== m[1]) html = html.replace(m[1], css);
  }

  return { html, inlined, bytes: budget, skipped };
}

module.exports = { inlineBundle, resolveRef, MAX_INLINE_TOTAL, INLINE_TYPES, InlineTooLargeError };
