'use strict';

/*
 * Outbound fetch for the built-in data sources (REST, Sheets, CSV, RSS).
 *
 * Always through the SSRF guard (lib/ssrf-guard: public addresses only, DNS pinned, every
 * redirect re-checked), with a timeout and a size cap.
 *
 * ⚠️ ERRORS COME IN TWO KINDS. A `UserFacingError` carries a message written for the operator —
 * "the sheet is not shared", "the API answered 401" — and is safe to show: it says nothing about
 * the network that a public URL did not already say. Anything else (DNS, connection refused, an
 * internal address) stays generic, because the route used to reveal which of those happened and
 * that is SSRF reconnaissance. routes/data-sources.js and service.describeSyncError show
 * `userMessage` when present and the generic line otherwise.
 */

const { guardedRequest } = require('../ssrf-guard');

class UserFacingError extends Error {
  constructor(userMessage, code) {
    super(userMessage);
    this.name = 'UserFacingError';
    this.userMessage = userMessage;
    this.code = code || 'user';
  }
}

const STATUS_HINTS = {
  400: 'The server rejected the request (400). Check the URL, the method and the body.',
  401: 'The server said 401 Unauthorized — check the credentials.',
  403: 'The server said 403 Forbidden — the credentials are valid but not allowed to read this.',
  404: 'The server said 404 Not Found — check the URL.',
  405: 'The server does not accept this method (405) — try GET or POST.',
  429: 'The server is rate-limiting requests (429) — use a longer refresh interval.',
};

/**
 * Fetch a URL as text. Returns { text, contentType, status }.
 * opts: method, headers, body, maxBytes (default 1 MB), timeoutMs (default 12 s), maxRedirects,
 *       fetcher (tests)
 */
async function fetchText(url, opts = {}) {
  if (typeof opts.fetcher === 'function') return opts.fetcher(url, opts);
  let res;
  try {
    res = await guardedRequest(url, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': 'ScreenTinker-DataSource/1', ...(opts.headers || {}) },
      body: opts.body,
      timeoutMs: opts.timeoutMs || 12000,
      maxBytes: opts.maxBytes || 1024 * 1024,
      responseType: 'text',
      maxRedirects: Number.isInteger(opts.maxRedirects) ? opts.maxRedirects : 5,
      accept2xx: true,
    });
  } catch (err) {
    if (err && (err.code === 'size-limit' || /size limit/i.test(err.message || ''))) {
      throw new UserFacingError(`The response is larger than ${Math.round((opts.maxBytes || 1024 * 1024) / 1048576)} MB — narrow it down (a smaller range, a filter, or fewer fields).`, 'size-limit');
    }
    if (err && (err.code === 'timeout' || /timed out/i.test(err.message || ''))) {
      throw new UserFacingError('The server did not respond in time.', 'timeout');
    }
    if (err && err.code === 'too-many-redirects' && opts.maxRedirects === 0) {
      throw new UserFacingError('The server answered with a redirect. Enter the final address (often https:// rather than http://) — a custom API-key header is never forwarded to a redirect.', 'redirect');
    }
    const sc = err && (err.statusCode || Number((String(err.message).match(/\b([45]\d\d)\b/) || [])[1]));
    if (sc && STATUS_HINTS[sc]) throw new UserFacingError(STATUS_HINTS[sc], 'upstream-status');
    if (sc) throw new UserFacingError(`The server answered HTTP ${sc}.`, 'upstream-status');
    throw err;   // network-level: kept generic by the caller
  }
  if (res.statusCode >= 400) {
    throw new UserFacingError(STATUS_HINTS[res.statusCode] || `The server answered HTTP ${res.statusCode}.`, 'upstream-status');
  }
  const headers = res.headers || {};
  return { text: res.text || '', contentType: String(headers['content-type'] || ''), status: res.statusCode };
}

/** A URL must be http(s), without credentials in it, and parse. Returns the URL or throws a message. */
function checkHttpUrl(raw, what = 'URL') {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return `${what} is not a valid URL`; }
  if (!['http:', 'https:'].includes(u.protocol)) return `${what} must start with http:// or https://`;
  if (u.username || u.password) return `${what} must not contain a username or password — use the authentication fields`;
  if (String(raw).length > 2000) return `${what} is too long`;
  return null;
}

module.exports = { UserFacingError, fetchText, checkHttpUrl, STATUS_HINTS };
