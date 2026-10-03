'use strict';

/*
 * Sanitizers for widget HTML. Used by the built-in renderers in routes/widgets.js and by the
 * plugin render ctx. One copy, because a plugin that concatenated raw config into HTML would
 * be the same XSS the built-ins already had to close (render output is public and CSP-exempt).
 *
 * THE REPLACEMENTS ARE THE FEATURE. A previous extraction HTML-decoded this file so
 * named entities became their characters and escapeHtml became a no-op.
 * plugins-invariants.test.js asserts both the behaviour and that those entities
 * are still in the source.
 */

function escapeHtml(str) {
  // ⚠️ COERCE FIRST. Returning a non-string unchanged (the old behaviour) was an escaping bypass:
  // widget `config` is stored verbatim and only `slide` widgets are normalized, so a field that is a
  // JSON array/object (e.g. weather `location`, social `platform`/`query`, rss `feed_url`) reached a
  // template sink unescaped and was string-coerced there — Array.prototype.toString does not escape
  // quotes, so an array value in a JS-string context (rss `feed_url`) meant arbitrary JS. String()
  // it before replacing, exactly as slide-render's escapeHtml does. null/undefined -> '' so the
  // `escapeHtml(x) || 'default'` sinks keep their defaults.
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Validate URL is http/https
function safeUrl(url) {
  if (!url) return 'about:blank';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : 'about:blank';
  } catch { return 'about:blank'; }
}

// Security: widget render output is public and CSP-exempt, so config values that
// get inlined into <style>/CSS must not be able to break out (a config field set
// via the API could otherwise carry `}</style><script>...`). safeCss allows
// colors/gradients but rejects breakout/exfil constructs; safeNumber coerces to
// a finite number (so e.g. font_size can't smuggle markup).
function safeCss(v, fallback) {
  if (typeof v !== 'string') return fallback;
  if (/[<>{}\\;]/.test(v) || /url\s*\(/i.test(v) || /@import/i.test(v) || /expression/i.test(v) || /javascript:/i.test(v)) return fallback;
  // Other CSS functions that fetch an external URL without the `url(` token, which the check above
  // would otherwise miss: image-set()/image()/cross-fade() load a resource (a value like
  // `image-set("//attacker/beacon.png" 1x)` passes as a background and beacons on render); paint()/
  // element() reference a worklet/element. -webkit- prefixed image-set/cross-fade contain the same
  // token, so they are caught too. Blocked to keep safeCss's "no exfil" contract.
  if (/image-set\s*\(/i.test(v) || /cross-fade\s*\(/i.test(v) || /\bimage\s*\(/i.test(v)
      || /\bpaint\s*\(/i.test(v) || /\belement\s*\(/i.test(v)) return fallback;
  return v.trim().slice(0, 200);
}
function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { escapeHtml, safeUrl, safeCss, safeNumber };
