'use strict';

/*
 * Every request the social connectors make, through lib/bi/http.js request(): each resolved address
 * is vetted and the socket pinned to it (no DNS rebinding), metadata/link-local/private addresses
 * are refused, nothing redirects silently, and bodies are capped.
 *
 * API hosts are fixed per network (BASES). Media (post images, avatars) come from whatever CDN the
 * network names, so they go through the same guard with redirects followed hop by hop — each hop
 * vetted again — and only an actual image is kept (lib/social/media.js sniffs the bytes).
 *
 * ⚠️ TESTS ONLY: with NODE_ENV=test, SOCIAL_API_BASES (JSON {network: base}) points a network at a
 * local mock, and SOCIAL_TEST_TRUSTED_ORIGINS (comma separated origins) lets exactly those origins
 * through the private-address check. Neither is read in any other environment.
 */

const { request, describe } = require('../bi/http');

const BASES = {
  instagram: 'https://graph.instagram.com',
  facebook: 'https://graph.facebook.com/v21.0',
  youtube: 'https://www.googleapis.com/youtube/v3',
  x: 'https://api.x.com/2',
  bluesky: 'https://public.api.bsky.app/xrpc',
};

const isTest = () => process.env.NODE_ENV === 'test';

function baseFor(network) {
  if (isTest() && process.env.SOCIAL_API_BASES) {
    try {
      const o = JSON.parse(process.env.SOCIAL_API_BASES);
      if (o && typeof o[network] === 'string') return o[network].replace(/\/+$/, '');
    } catch (_) { /* fall through */ }
  }
  return BASES[network];
}

function trustedForTest(url) {
  if (!isTest() || !process.env.SOCIAL_TEST_TRUSTED_ORIGINS) return false;
  try {
    const origin = new URL(url).origin;
    return process.env.SOCIAL_TEST_TRUSTED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
  } catch { return false; }
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** GET JSON from a social API. Throws ApiError with a message an admin can act on. */
async function getJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
  let r;
  try {
    r = await request(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ScreenTinker-SocialWall/1.0', ...headers },
      allowPrivate: trustedForTest(url), timeoutMs, maxBytes: 4 * 1024 * 1024,
    });
  } catch (e) {
    throw new ApiError(describe(e), 0);
  }
  let body = null;
  try { body = JSON.parse(r.body.toString('utf8')); } catch { body = null; }
  if (r.status < 200 || r.status >= 300) {
    const msg = body && ((body.error && (body.error.message || body.error.error_user_msg || (typeof body.error === 'string' ? body.error : '')))
      || body.detail || body.message || body.title);
    throw new ApiError(`${r.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`, r.status);
  }
  if (body === null) throw new ApiError('the answer was not JSON', r.status);
  return body;
}

/** Fetch a media file, following at most 3 redirects, each hop vetted. Returns { status, headers, body }. */
async function getMedia(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && trustedForTest(current))) throw new ApiError('media must be https', 0);
    const r = await request(current, {
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9', 'User-Agent': 'ScreenTinker-SocialWall/1.0' },
      allowPrivate: trustedForTest(current), timeoutMs: 20000, maxBytes,
    });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      current = new URL(r.headers.location, current).toString();
      continue;
    }
    return r;
  }
  throw new ApiError('too many redirects', 0);
}

module.exports = { BASES, baseFor, getJson, getMedia, ApiError, describe };
