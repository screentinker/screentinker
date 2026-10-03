'use strict';

/*
 * Per-plugin network egress allowlist.
 *
 * A plugin MAY declare the hosts its fetches are allowed to reach, in plugin.json:
 *
 *     "network": { "allow": ["api.weather.com", "*.example.com"] }
 *
 * When declared, every fetch this plugin makes (api.fetch, and the fetch handed to a data-source
 * resolve) is checked against the list BEFORE the SSRF guard runs; a host not on the list is
 * refused. When NOT declared, egress is unrestricted (still SSRF-guarded: loopback / link-local /
 * cloud-metadata are always refused) -- because plugins like json-api and webhook exist to fetch an
 * operator-supplied URL at any host, and a static list cannot express that. The declaration is
 * therefore an opt-in guardrail an honest plugin uses to constrain itself, and it is visible in the
 * manifest a platform admin reviews at approval. It is NOT a boundary against a hostile plugin,
 * which runs in-process and could bypass it with raw require('http') -- see docs/plugins.md.
 *
 * Matching is on hostname only (not port/path): an exact host, or a leading "*." wildcard that
 * matches one-or-more leading labels ("*.example.com" matches "a.example.com" and "a.b.example.com",
 * but not the bare "example.com"). Matching is case-insensitive.
 */

const { guardedRequest, GuardedRequestError } = require('../ssrf-guard');

/** Normalise a declared entry / a URL host to a lowercased hostname, or null. */
function hostOf(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.toLowerCase();
}

/** Does [host] match a single allowlist [pattern] (exact, or "*." wildcard on leading labels)? */
function matchesPattern(host, pattern) {
  const p = hostOf(pattern);
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === p;
}

/**
 * true if [urlString]'s host is allowed by [allow]. An empty / missing allow list means
 * "unrestricted" (returns true). A declared-but-unmatched host returns false. An unparseable URL
 * returns false so a bad target cannot slip past a declared list.
 */
function isAllowed(urlString, allow) {
  if (!Array.isArray(allow) || allow.length === 0) return true;
  let host;
  try { host = new URL(urlString).hostname.toLowerCase(); } catch (_) { return false; }
  return allow.some((pat) => matchesPattern(host, pat));
}

/**
 * Build the guarded fetch handed to plugin code. [allow] is the plugin's declared allowlist (or
 * null/[]). [defaults] are guardedRequest option defaults (timeout / maxBytes / responseType).
 * The returned fetch enforces the allowlist, then delegates to guardedRequest.
 */
function makePluginFetch(allow, defaults = {}) {
  return (url, opts = {}) => {
    if (!isAllowed(url, allow)) {
      let host = '(unparseable)';
      try { host = new URL(url).hostname; } catch (_) { /* keep placeholder */ }
      return Promise.reject(new GuardedRequestError(
        `host "${host}" is not in this plugin's network.allow list`, 'egress-not-allowed',
      ));
    }
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
    }
    return guardedRequest(url, {
      method: opts.method || 'GET',
      headers,
      body,
      timeoutMs: opts.timeoutMs || defaults.timeoutMs || 8000,
      maxBytes: opts.maxBytes || defaults.maxBytes || 64 * 1024,
      responseType: opts.responseType || defaults.responseType || 'text',
      accept2xx: opts.accept2xx !== false,
    });
  };
}

module.exports = { isAllowed, matchesPattern, makePluginFetch };
