'use strict';

/*
 * Outbound HTTP for "switch to ScreenTinker" (lib/migrate). Every request a vendor adapter makes goes
 * through here, and here only through lib/ssrf-guard's guardedRequest: public addresses only (unless
 * the operator opened a private range with OUTBOUND_ALLOW_HOSTS / OUTBOUND_ALLOW_PRIVATE), the socket
 * pinned to the vetted address, every redirect re-vetted, and Authorization stripped on a redirect to
 * another origin. Cloud metadata addresses are refused whatever the operator allowed.
 *
 * ⚠️ THE CREDENTIAL ONLY EVER GOES TO THE API ORIGIN. Adapters build their requests with `api()`,
 * which takes the vendor's fixed origin (or, for a self-hosted Xibo / Anthias, the origin the person
 * typed and the guard accepted) and refuses a path that would leave it. Media downloads use
 * `download()`, which sends the credential only when the file URL is on that same origin; a CDN or
 * signed-storage URL a vendor hands back is fetched bare. A vendor answer can therefore never steer
 * a key to a host of its choosing.
 *
 * ⚠️ NOTHING HERE LOGS A URL, A HEADER OR A BODY. Errors carry a status and a short code; the
 * adapters turn those into sentences. A vendor that echoes the request (key included) into an error
 * body never reaches a log line or the job report.
 *
 * Backoff: 429 and 503 (and a dropped connection) are retried up to MAX_RETRIES times, honouring
 * Retry-After (seconds or an HTTP date, capped at MAX_WAIT_MS), otherwise exponential with jitter.
 * Tests replace both the wire (`_setTransport`) and the clock (`_setSleep`).
 */

const fs = require('fs');

const MAX_RETRIES = 5;
const MAX_WAIT_MS = 60 * 1000;
const API_MAX_BYTES = 16 * 1024 * 1024;   // one page of a listing; a whole library is paginated

class MigrateHttpError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = 'MigrateHttpError';
    this.code = code;
    if (status) this.status = status;
  }
}

/* ------------------------------------------------------------------ the wire */

/*
 * The default wire. request() resolves { status, headers, text } for ANY status (the caller decides
 * what a 401 means); download() streams to a file with a byte cap and resolves { size }.
 */
const defaultWire = {
  async request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
    const { guardedRequest } = require('../ssrf-guard');
    try {
      const r = await guardedRequest(url, {
        method, headers, body, timeoutMs, maxBytes: API_MAX_BYTES, responseType: 'text', maxRedirects: 3, accept2xx: true,
      });
      return { status: r.statusCode, headers: r.headers || {}, text: r.text || '' };
    } catch (e) {
      if (e && e.statusCode) return { status: e.statusCode, headers: {}, text: '' };
      throw wireError(e, url);
    }
  },
  async download(url, dest, { headers = {}, maxBytes }) {
    const { guardedRequest } = require('../ssrf-guard');
    let r;
    try {
      r = await guardedRequest(url, { headers, timeoutMs: 30 * 60 * 1000, idleTimeoutMs: 60000, responseType: 'stream', maxRedirects: 3 });
    } catch (e) {
      if (e && e.statusCode) throw new MigrateHttpError(`The file could not be downloaded (HTTP ${e.statusCode}).`, 'upstream-status', e.statusCode);
      throw wireError(e, url);
    }
    const declared = Number(r.headers && r.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { r.res.destroy(); throw new MigrateHttpError('too large', 'too_large'); }
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { flags: 'wx' });
      r.res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) r.res.destroy(new MigrateHttpError('too large', 'too_large'));
      });
      r.res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', resolve);
      r.res.pipe(out);
    }).catch((e) => { try { fs.rmSync(dest, { force: true }); } catch { /* not written */ } throw e.code === 'too_large' ? e : wireError(e, url); });
    return { size };
  },
};

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; }
}

/*
 * What a person reads when the SSRF guard refuses. It used to say "not allowed (private, internal or
 * metadata addresses are blocked)" for EVERY refusal, including a name this server cannot resolve at
 * all (#900: a Docker install whose container did not see the internal DNS or the host's hosts file
 * was told its address was blocked, and spent a day on NAT). A name that does not resolve now says
 * so; a refused address names itself and, on a self-hosted server, the setting that opens it.
 */
function ssrfError(e, url) {
  const host = hostOf(url);
  const reason = String((e && e.reason) || '');
  const selfHosted = require('../../config').selfHosted;
  if (reason === 'dns-fail' || reason === 'no-address') {
    // The Docker advice only makes sense to the person who runs this server.
    return new MigrateHttpError(`This server could not look up ${host || 'that address'}. Check the name.${selfHosted
      ? ' If ScreenTinker runs in Docker, the container uses its own DNS and does not read the host\'s hosts file: add a dns: or extra_hosts: entry for it.'
      : ' It must be reachable from the internet.'}`, 'unresolved');
  }
  const ip = reason.startsWith('blocked-ip:') ? reason.slice('blocked-ip:'.length) : '';
  const where = ip && ip !== host ? `${host} (${ip})` : (ip || host);
  const hint = selfHosted ? ` ${require('../ssrf-guard').privateAddressHint()}` : '';
  return new MigrateHttpError(`That address${where ? ` (${where})` : ''} is not allowed from this server (private, internal or metadata addresses are blocked).${hint}`, 'blocked');
}

function wireError(e, url = '') {
  if (e && e.name === 'MigrateHttpError') return e;
  if (e && e.statusCode) return new MigrateHttpError(`The vendor answered HTTP ${e.statusCode}.`, 'upstream-status', e.statusCode);
  if (e && (e.name === 'SsrfError' || e.code === 'ssrf')) return ssrfError(e, url);
  if (e && e.code === 'timeout') return new MigrateHttpError('The server did not respond in time.', 'timeout');
  if (e && e.code === 'size-limit') return new MigrateHttpError('The answer was larger than expected.', 'too_large');
  return new MigrateHttpError('The server could not be reached.', 'network');
}

let wire = defaultWire;
/** Tests swap in a fake vendor; null restores the guarded one. */
function _setTransport(t) { wire = t || defaultWire; }

let sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
/** Tests make backoff instant (and observable). */
function _setSleep(fn) { sleep = fn || ((ms) => new Promise((r) => setTimeout(r, ms).unref?.())); }

/* ------------------------------------------------------------------ helpers */

function retryAfterMs(headers, attempt) {
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(MAX_WAIT_MS, n * 1000);
    const at = Date.parse(String(raw));
    if (Number.isFinite(at)) return Math.min(MAX_WAIT_MS, Math.max(0, at - Date.now()));
  }
  const base = Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * An origin the person typed for a self-hosted CMS: http(s), no credentials, no query, and checked by
 * the SSRF guard's parser (a literal private / metadata address fails here, a name that resolves to
 * one fails at connect). Returns the origin + path prefix with no trailing slash, or throws.
 */
function normalizeBaseUrl(raw) {
  const { parseSafeUrl } = require('../ssrf-guard');
  const s = String(raw || '').trim();
  if (!s || s.length > 500) throw new MigrateHttpError('Enter the address of your server.', 'bad_url');
  let parsed;
  try { parsed = parseSafeUrl(s); }
  catch (e) {
    if (e && e.reason && /^blocked-ip/.test(e.reason)) throw ssrfError(e, s);
    throw new MigrateHttpError('Enter a full http:// or https:// address, without a username or password in it.', 'bad_url');
  }
  const u = parsed.url;
  if (u.search || u.hash) throw new MigrateHttpError('Enter the server address only, without ?query or #fragment.', 'bad_url');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * A client bound to one API origin and one set of auth headers.
 *   api(path, opts)   -> parsed JSON body (and `headers`), retried on 429/503
 *   download(url, dest, maxBytes) -> { size }; credential only on the same origin
 */
function client(baseUrl, authHeaders = {}) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  let headers = { ...authHeaders };

  async function raw(pathOrUrl, { method = 'GET', body = null, extraHeaders = {}, query = null } = {}) {
    const url = new URL(/^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : baseUrl.replace(/\/+$/, '') + pathOrUrl);
    if (url.origin !== origin) throw new MigrateHttpError('The vendor pointed outside its own API.', 'off_origin');
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await wire.request(url.toString(), { method, headers: { Accept: 'application/json', 'User-Agent': 'ScreenTinker-Migrate/1', ...headers, ...extraHeaders }, body });
      } catch (e) {
        const err = wireError(e);
        if (err.code === 'network' && attempt < MAX_RETRIES) { await sleep(retryAfterMs(null, attempt++)); continue; }
        throw err;
      }
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(res.headers, attempt++));
        continue;
      }
      return res;
    }
  }

  async function api(path, opts = {}) {
    const res = await raw(path, opts);
    if (res.status === 401) throw new MigrateHttpError('The key or token was refused (401). Check it and that it can read this account.', 'unauthorized', 401);
    if (res.status === 403) throw new MigrateHttpError('The key is valid but not allowed to read this (403). Give it read access.', 'forbidden', 403);
    if (res.status === 404) throw new MigrateHttpError('Not found (404). Check the server address.', 'not_found', 404);
    if (res.status === 429) throw new MigrateHttpError('The vendor kept rate-limiting the import (429). Try again later; the import resumes where it stopped.', 'rate_limited', 429);
    if (res.status < 200 || res.status >= 300) throw new MigrateHttpError(`The vendor answered HTTP ${res.status}.`, 'upstream-status', res.status);
    let body = null;
    if (res.text) {
      try { body = JSON.parse(res.text); } catch { throw new MigrateHttpError('The vendor sent an answer that is not JSON. Check the server address.', 'bad_json'); }
    }
    return { body, headers: res.headers || {} };
  }

  async function download(url, dest, maxBytes) {
    let u;
    try { u = new URL(url, baseUrl); } catch { throw new MigrateHttpError('The vendor gave a file address that is not valid.', 'bad_url'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.origin === origin)) {
      throw new MigrateHttpError('The vendor gave a file address that is not https.', 'bad_url');
    }
    const sameOrigin = u.origin === origin;
    let attempt = 0;
    for (;;) {
      try {
        return await wire.download(u.toString(), dest, { headers: sameOrigin ? { 'User-Agent': 'ScreenTinker-Migrate/1', ...headers } : { 'User-Agent': 'ScreenTinker-Migrate/1' }, maxBytes });
      } catch (e) {
        try { fs.rmSync(dest, { force: true }); } catch { /* not written */ }
        const err = wireError(e);
        const retriable = err.code === 'network' || (err.status === 429 || err.status === 503);
        if (retriable && attempt < MAX_RETRIES) { await sleep(retryAfterMs(null, attempt++)); continue; }
        throw err;
      }
    }
  }

  return {
    origin,
    raw,
    api,
    download,
    /** OAuth: swap in a bearer token once one is obtained. */
    setAuth(h) { headers = { ...h }; },
  };
}

module.exports = {
  client, normalizeBaseUrl, retryAfterMs, MigrateHttpError, MAX_RETRIES,
  _setTransport, _setSleep,
  _ssrfErrorForTest: ssrfError,
};
