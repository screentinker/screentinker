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

/*
 * ⚠️ The entry HTML's own size cap, and it is CHARGED to MAX_INLINE_TOTAL like every other byte.
 * It used to be read up to html-bundle's MAX_TOTAL_BYTES (128MB) and not counted at all, so one
 * bundle's index.html could be a 128MB string the scanners below walked and copied. Real entry
 * pages are kilobytes; 2MB is far above any of them and still a small, bounded amount of work.
 */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

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

/*
 * ── LINEAR SCANNERS ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THESE REPLACE REGEXES, AND THE REASON IS THE EVENT LOOP. The inliner runs on the main thread,
 * and the regexes it used (`<link\b[^>]*?\bhref...`, `<style\b[^>]*>([\s\S]*?)<\/style>`,
 * `url\(\s*(["']?)([^"')]+)\1\s*\)`, the @import one) each rescan to the end of the document from
 * every candidate start when a tag never closes. A 1MB entry of `<link ` repeated, with no `>`, was
 * minutes of blocked loop for every tenant; `url(` repeated in a stylesheet was worse. Each
 * `html.replace(m[0], ...)` also copied the whole document per match, quadratic again.
 *
 * So: every "next X at or after pos" lookup goes through forwardFinder(), whose answer is cached
 * and only ever moves forward (callers ask with non-decreasing positions), making a whole scan one
 * pass over the string; and replacements are spliced in by position, once.
 *
 * They match what the old regexes matched for every real shape. Two deliberate differences on
 * markup no bundle ships: a tag ends at its FIRST `>` even inside a quoted value (the old regex let
 * `href="a>b"` through), and a replacement lands at the match's own position rather than at the
 * first identical text earlier in the document (which also stops `$&` in a stylesheet being read
 * as a replacement pattern).
 */

/** "Index of the next match of `re` (global) at or after pos", linear over a forward-moving scan. */
function forwardFinder(str, re) {
  let at = -2;      // -2: not looked yet; -1: none left anywhere after the last query
  let asked = -1;
  return (pos) => {
    if (pos < asked) at = -2;           // never asked backwards today, but stay correct if it is
    asked = pos;
    if (at === -1) return -1;
    if (at >= pos) return at;
    re.lastIndex = pos;
    const m = re.exec(str);
    at = m ? m.index : -1;
    return at;
  };
}

const isWs = (ch) => ch !== undefined && /\s/.test(ch);
function skipWs(str, i) { while (i < str.length && isWs(str[i])) i++; return i; }

/*
 * Tags named by `names` (an alternation), each running from `<name` to its first `>`, that carry
 * `attr="value"` (or single-quoted). Returns [{start, end, tag, value}] in document order: the
 * tags the old `<(names)\b[^>]*?\battr\s*=\s*(["'])([^"']+)\2[^>]*>` regex found.
 */
function scanTagsWithAttr(html, names, attr) {
  const open = new RegExp(`<(?:${names})\\b`, 'gi');
  const nextGt = forwardFinder(html, />/g);
  // Run on one tag's text only. Linear: a value scan stops at the next quote of either kind.
  const attrRe = new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']+)\\1`, 'i');
  const found = [];
  let m;
  while ((m = open.exec(html))) {
    const gt = nextGt(m.index);
    if (gt === -1) break;               // no `>` anywhere after: no later tag can close either
    const tag = html.slice(m.index, gt + 1);
    const a = attrRe.exec(tag);
    if (a) found.push({ start: m.index, end: gt + 1, tag, value: a[2] });
    // Either way continue past this tag: a later `<name` inside it ends at the same `>`, and its
    // text is a suffix of this one, so it cannot match where this one did not.
    open.lastIndex = gt + 1;
  }
  return found;
}

/** <style ...>body</style> blocks: [{bodyStart, bodyEnd}], as `<style\b[^>]*>([\s\S]*?)<\/style>`. */
function scanStyleBlocks(html) {
  const open = /<style\b/gi;
  const nextGt = forwardFinder(html, />/g);
  const nextClose = forwardFinder(html, /<\/style>/gi);
  const found = [];
  let m;
  while ((m = open.exec(html))) {
    const gt = nextGt(m.index);
    if (gt === -1) break;
    const close = nextClose(gt + 1);
    if (close === -1) break;
    found.push({ bodyStart: gt + 1, bodyEnd: close });
    open.lastIndex = close + '</style>'.length;
  }
  return found;
}

/**
 * CSS url(...) references: [{start, end, value}], the matches of `url\(\s*(["']?)([^"')]+)\1\s*\)`.
 * The value runs to the next quote or `)`; a quoted value must close with its own quote, then `)`.
 */
function scanCssUrls(css) {
  const open = /url\(/gi;
  const nextStop = forwardFinder(css, /["')]/g);
  const found = [];
  let m;
  while ((m = open.exec(css))) {
    const j = skipWs(css, m.index + 4);
    const q = css[j] === '"' || css[j] === "'" ? css[j] : '';
    const vStart = q ? j + 1 : j;
    const stop = nextStop(vStart);
    if (stop === -1) break;
    if (stop === vStart) continue;      // empty value
    let end;
    if (q) {
      if (css[stop] !== q) continue;
      const k = skipWs(css, stop + 1);
      if (css[k] !== ')') continue;
      end = k + 1;
    } else {
      if (css[stop] !== ')') continue;
      end = stop + 1;
    }
    found.push({ start: m.index, end, value: css.slice(vStart, stop) });
    open.lastIndex = end;
  }
  return found;
}

/**
 * CSS @import rules: [{start, end, value}], the matches of
 * `@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*;`.
 */
function scanCssImports(css) {
  const open = /@import/gi;
  const isTok = (ch) => ch !== undefined && ch !== '"' && ch !== "'" && ch !== ')' && ch !== ';' && !isWs(ch);
  const tryFrom = (i, withUrl) => {
    if (withUrl) {
      if (css.slice(i, i + 4).toLowerCase() !== 'url(') return null;
      i = skipWs(css, i + 4);
    }
    if (css[i] === '"' || css[i] === "'") i++;
    const tStart = i;
    while (isTok(css[i])) i++;
    if (i === tStart) return null;
    const value = css.slice(tStart, i);
    if (css[i] === '"' || css[i] === "'") i++;
    i = skipWs(css, i);
    if (css[i] === ')') i = skipWs(css, i + 1);
    if (css[i] !== ';') return null;
    return { end: i + 1, value };
  };
  const found = [];
  let m;
  while ((m = open.exec(css))) {
    const afterKw = m.index + 7;
    const i = skipWs(css, afterKw);
    if (i === afterKw) continue;        // \s+ needs at least one
    const r = tryFrom(i, true) || tryFrom(i, false);
    if (!r) continue;
    found.push({ start: m.index, end: r.end, value: r.value });
    open.lastIndex = r.end;
  }
  return found;
}

/** Rebuild `str` with each [start, end) span swapped for its replacement (no replacement keeps it). */
function splice(str, spans) {
  const parts = [];
  let at = 0;
  for (const s of spans) {
    if (s.replacement == null) continue;
    parts.push(str.slice(at, s.start), s.replacement);
    at = s.end;
  }
  parts.push(str.slice(at));
  return parts.join('');
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
  const tooLargeMsg = () =>
    `This bundle inlines to more than ${Math.round(maxBytes / 1048576)}MB, which is more than a player can hold in one document.`;

  async function read(name) {
    if (cache.has(name)) return cache.get(name);
    let buf = null;
    // Each read is capped at the inline budget (real bytes, see html-bundle readBundleEntry); an
    // entry that CLAIMS more than the budget is "too large", not "missing".
    try { buf = await htmlBundle.readBundleEntry(archivePath, name, { maxBytes }); } catch (e) {
      if (e && e.code === 'ENTRY_TOO_LARGE') throw new InlineTooLargeError(tooLargeMsg());
      buf = null;
    }
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
      const imports = scanCssImports(out);
      for (const m of imports) {
        const target = resolveRef(fromFile, m.value);
        if (!target) continue;
        const buf = await read(target);
        if (!buf) continue;
        budget += buf.length;
        if (budget > maxBytes) throw new InlineTooLargeError('This bundle inlines to more than the per-document limit.');
        m.replacement = await inlineCss(buf.toString('utf8'), target, depth + 1);
      }
      out = splice(out, imports);
    }

    const urls = scanCssUrls(out);
    for (const m of urls) {
      const target = resolveRef(fromFile, m.value);
      if (!target) continue;
      const uri = await dataUri(target);
      if (uri) m.replacement = `url("${uri}")`;
    }
    return splice(out, urls);
  }

  // The entry point is capped at MAX_ENTRY_BYTES (real bytes) and charged to the budget like any
  // other file. See MAX_ENTRY_BYTES for why it no longer rides free.
  const entryCap = Math.min(MAX_ENTRY_BYTES, maxBytes);
  const entryTooLarge = () => new InlineTooLargeError(
    `This bundle's entry page is larger than ${Math.round((entryCap / 1048576) * 10) / 10}MB, which is more than it can be served as.`);
  let entryBuf;
  try { entryBuf = await htmlBundle.readBundleEntry(archivePath, entryPoint, { maxBytes: entryCap }); } catch (e) {
    // ENTRY_TOO_LARGE is the declared size; "inflates past" is a lying header that went beyond it.
    if (e && (e.code === 'ENTRY_TOO_LARGE' || /inflates past/.test(e.message || ''))) throw entryTooLarge();
    throw e;
  }
  if (!entryBuf) throw new Error(`Bundle entry point is missing: ${entryPoint}`);
  if (entryBuf.length > entryCap) throw entryTooLarge();
  budget += entryBuf.length;
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
  const links = scanTagsWithAttr(html, 'link', 'href');
  for (const m of links) {
    const target = resolveRef(entryPoint, m.value);
    if (!target) continue;
    if (/\bstylesheet\b/i.test(m.tag) && path.posix.extname(target).toLowerCase() === '.css') {
      const buf = await read(target);
      if (!buf) continue;
      budget += buf.length;
      if (budget > maxBytes) throw new InlineTooLargeError('This bundle inlines to more than the per-document limit.');
      const css = await inlineCss(buf.toString('utf8'), target, 0);
      inlined++;
      m.replacement = `<style>\n${css}\n</style>`;
    } else {
      const uri = await dataUri(target);
      if (uri) m.replacement = m.tag.replace(m.value, () => uri);
    }
  }
  html = splice(html, links);

  const srcs = scanTagsWithAttr(html, 'script|img|source|iframe|audio|video', 'src');
  for (const m of srcs) {
    const target = resolveRef(entryPoint, m.value);
    if (!target) continue;
    const uri = await dataUri(target);
    if (uri) m.replacement = m.tag.replace(m.value, () => uri);
  }
  html = splice(html, srcs);

  // Inline <style> blocks, which carry their own url() references.
  const styles = scanStyleBlocks(html);
  for (const m of styles) {
    const body = html.slice(m.bodyStart, m.bodyEnd);
    const css = await inlineCss(body, entryPoint, 0);
    if (css !== body) Object.assign(m, { start: m.bodyStart, end: m.bodyEnd, replacement: css });
  }
  html = splice(html, styles);

  return { html, inlined, bytes: budget, skipped };
}

/*
 * ── RESULT CACHE ────────────────────────────────────────────────────────────────────────────────
 * GET /api/content/:id/bundle is public (a player's iframe carries no credentials), skips the
 * content limiter like every GET, and used to re-read the archive and re-inline on EVERY request:
 * each player poll, each reload, anyone who knows a referenced content id. The output only depends
 * on the archive's bytes and the entry name, so it is cached per (archive file, its mtime and size,
 * entry), a key the server derives from the file itself and never from the caller's ?rev=. A
 * replaced bundle is a new file or a new mtime, so it can never be served stale, even by an
 * in-place overwrite that forgot to bump the content row.
 *
 * Bounded both ways (count and total characters, least recently used out first) because one
 * result can be ~11M characters (8MB of base64 is +33%). Concurrent misses for one key share a
 * single inline. A too-large refusal is cached too, so a hostile bundle costs one inline, not one
 * per request.
 *
 * ⚠️ Callers get the SAME object back on every hit. Read it, never mutate it.
 */
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_CHARS = 64 * 1024 * 1024;
const resultCache = new Map();   // key -> { out } | { err }, Map order = least recently used first
const inflight = new Map();      // key -> Promise
let cacheChars = 0;

function cacheStore(key, value, chars) {
  if (chars > CACHE_MAX_CHARS) return;
  const prev = resultCache.get(key);
  if (prev) { cacheChars -= prev.chars; resultCache.delete(key); }
  resultCache.set(key, { ...value, chars });
  cacheChars += chars;
  for (const [k, v] of resultCache) {
    if (resultCache.size <= CACHE_MAX_ENTRIES && cacheChars <= CACHE_MAX_CHARS) break;
    resultCache.delete(k);
    cacheChars -= v.chars;
  }
}

/** inlineBundle(), memoised on the archive file's identity. Same result shape. */
async function inlineBundleCached(archivePath, entryPoint) {
  const st = await require('fs').promises.stat(archivePath);
  const key = `${archivePath}\0${st.mtimeMs}\0${st.size}\0${entryPoint}`;
  const hit = resultCache.get(key);
  if (hit) {
    resultCache.delete(key); resultCache.set(key, hit);   // now most recently used
    if (hit.err) throw hit.err;
    return hit.out;
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = inlineBundle(archivePath, entryPoint).then(
    (out) => { cacheStore(key, { out }, out.html.length); return out; },
    (err) => { if (err instanceof InlineTooLargeError) cacheStore(key, { err }, 0); throw err; },
  ).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Tests only. */
function _clearCache() { resultCache.clear(); cacheChars = 0; }
const _cacheStats = () => ({ entries: resultCache.size, chars: cacheChars });

module.exports = {
  inlineBundle, inlineBundleCached, resolveRef, MAX_INLINE_TOTAL, MAX_ENTRY_BYTES, INLINE_TYPES, InlineTooLargeError,
  scanTagsWithAttr, scanStyleBlocks, scanCssUrls, scanCssImports,
  CACHE_MAX_ENTRIES, CACHE_MAX_CHARS, _clearCache, _cacheStats,
};
