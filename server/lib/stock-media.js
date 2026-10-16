'use strict';

/*
 * Free stock photos and videos (docs/stock-media.md): search Pexels or Pixabay from the pickers and
 * add a result to the workspace's library as ordinary content.
 *
 * WHY THE SERVER DOES ALL OF IT
 *   - The API keys are the operator's (PEXELS_API_KEY / PIXABAY_API_KEY, or entered by a platform
 *     admin and stored with lib/secretbox). They never reach a browser: search is proxied here, and
 *     nothing this module returns, throws or logs carries a key or a URL that has one in it
 *     (Pixabay takes its key in the query string, so a URL is never logged at all).
 *   - The quota is the operator's too (Pexels: 200 requests/hour by default, for the whole key). So
 *     searches are cached and each person and workspace is rate limited, below.
 *   - Signage players download media and play it offline, so a result is DOWNLOADED into the
 *     library (it then counts toward storage, gets a thumbnail, lands on the workspace's storage
 *     backend, goes through approval) rather than hotlinked. Both providers allow this; Unsplash's
 *     API terms require hotlinking, which is why it is not here.
 *
 * ⚠️ THE CLIENT NEVER SUPPLIES A DOWNLOAD URL. An import names (provider, type, id). The server
 * looks that id up with the provider (or in its own cache of the provider's answers), picks the
 * rendition, and fetches it only if it is https on that provider's media host — through the SSRF
 * guard, which vets every redirect hop too. There is no parameter an attacker can point anywhere.
 *
 * Tests replace the transport (_setTransport) so the suite never touches the network.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { stripTags } = require('./strip-tags');

class StockError extends Error {
  constructor(message, code = 'stock', status = 502) {
    super(message);
    this.name = 'StockError';
    this.code = code;
    this.status = status;
  }
}

/* ============================== providers ============================== */

const HOUR = 60 * 60 * 1000;

/*
 * Per provider: where its key comes from, what it serves, how long a search may be cached, and the
 * hosts its media may be downloaded from. Attribution text is what the provider's API guidelines ask
 * pickers to show (docs/stock-media.md quotes them).
 */
const PROVIDERS = {
  pexels: {
    id: 'pexels',
    name: 'Pexels',
    env: 'PEXELS_API_KEY',
    setting: 'stock_key_pexels',
    types: ['photo', 'video'],
    // Pexels sets no cache period; a short one keeps a busy picker inside the hourly quota.
    searchTtlMs: 15 * 60 * 1000,
    home: 'https://www.pexels.com',
    licence: 'Pexels License',
    licenceUrl: 'https://www.pexels.com/license/',
    mediaHost: (h) => h === 'images.pexels.com' || h === 'videos.pexels.com' || h === 'player.vimeo.com',
  },
  pixabay: {
    id: 'pixabay',
    name: 'Pixabay',
    env: 'PIXABAY_API_KEY',
    setting: 'stock_key_pixabay',
    types: ['photo', 'video'],
    // Pixabay's API documentation: "Requests must be cached for 24 hours."
    searchTtlMs: 24 * HOUR,
    home: 'https://pixabay.com',
    licence: 'Pixabay Content License',
    licenceUrl: 'https://pixabay.com/service/license-summary/',
    mediaHost: (h) => h === 'pixabay.com' || h === 'cdn.pixabay.com',
  },
};
const PROVIDER_ORDER = ['pexels', 'pixabay'];

// Long edge of a downloaded photo: enough for a 1080p screen in either orientation, without pulling
// a 40-megapixel original into every library.
const PHOTO_LONG_EDGE = 1920;
// Largest video rendition picked: HD. A 4K file is several times the bytes for a screen that is
// almost always 1080p, and a player has to cache it.
const VIDEO_MAX_EDGE = 1920;
// Hard cap on one stock download, beneath the instance's own upload limit.
const STOCK_MAX_BYTES = 300 * 1024 * 1024;
const PER_PAGE = 24;
const MAX_PAGE = 50;
const MAX_QUERY = 100;
const ID_RE = /^\d{1,15}$/;

/* ============================== keys ============================== */

function appSettings() { return require('./app-settings'); }

/** The key for a provider, or null. The environment wins over the stored one (an operator's choice). */
function keyFor(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  const env = String(process.env[p.env] || '').trim();
  if (env) return env;
  const enc = appSettings().get(p.setting, '');
  if (!enc) return null;
  const plain = require('./secretbox').decrypt(enc);
  return plain ? plain : null;
}

/** Where a provider's key comes from: 'env' | 'settings' | null. Never the key. */
function keySource(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  if (String(process.env[p.env] || '').trim()) return 'env';
  const enc = appSettings().get(p.setting, '');
  if (enc && require('./secretbox').decrypt(enc)) return 'settings';
  return null;
}

/** Store (or, with an empty value, remove) a platform admin's key. Encrypted at rest. */
function saveKey(providerId, key) {
  const p = PROVIDERS[providerId];
  if (!p) throw new StockError('Unknown provider.', 'bad_provider', 400);
  const v = String(key == null ? '' : key).trim();
  if (v.length > 200 || /\s/.test(v)) throw new StockError('That does not look like an API key.', 'bad_key', 400);
  appSettings().set(p.setting, v ? require('./secretbox').encrypt(v) : '');
}

function enabledProviders() { return PROVIDER_ORDER.filter((id) => !!keyFor(id)); }

/* ============================== transport ============================== */

/*
 * Two calls, both guarded:
 *   api(url, headers)            -> { status, body }      provider JSON (status 200 only has a body)
 *   download(url, dest, maxBytes)-> { size }               bytes written to dest, capped
 * Errors thrown by the default transport are reduced to StockErrors with fixed messages here, so
 * nothing from a socket or a provider body (which could echo a URL) reaches a caller.
 */
const defaultTransport = {
  async api(url, headers) {
    const { guardedRequest } = require('./ssrf-guard');
    try {
      const r = await guardedRequest(url, { headers: { Accept: 'application/json', ...headers }, responseType: 'text', maxBytes: 4 * 1024 * 1024, timeoutMs: 15000, maxRedirects: 0 });
      let body = null;
      try { body = JSON.parse(r.text); } catch { body = null; }
      return { status: r.statusCode, body };
    } catch (e) {
      if (e && e.statusCode) return { status: e.statusCode, body: null };
      return { status: 0, body: null, error: (e && (e.code || e.name)) || 'error' };
    }
  },
  async download(url, dest, maxBytes) {
    const { guardedRequest } = require('./ssrf-guard');
    const r = await guardedRequest(url, { timeoutMs: 5 * 60 * 1000, idleTimeoutMs: 30000, responseType: 'stream', maxRedirects: 3 });
    const declared = Number(r.headers && r.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { r.res.destroy(); throw new StockError('too large', 'too_large', 413); }
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      r.res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) r.res.destroy(new StockError('too large', 'too_large', 413));
      });
      r.res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', resolve);
      r.res.pipe(out);
    });
    return { size };
  },
};
let transport = defaultTransport;
/** Tests swap in a fake provider; null restores the real (guarded) one. */
function _setTransport(t) { transport = t || defaultTransport; }

/* ============================== caches ============================== */

/*
 * Two small in-process caches. Provider answers are public catalogue data, not tenant data, so
 * they are shared across workspaces — that is what makes the cache worth having against a
 * per-key quota. Bounded; the oldest entry goes first.
 */
function boundedCache(max) {
  const m = new Map();
  return {
    get(k, ttl) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.at > ttl) { m.delete(k); return null; }
      return e;
    },
    set(k, value) {
      m.delete(k);
      m.set(k, { value, at: Date.now() });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    delete(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}
const searchCache = boundedCache(500);
const itemCache = boundedCache(5000);

/* ============================== rate limits ============================== */

/*
 * Per person and per workspace, on top of the per-IP limit server.js puts on /api/stock. The key's
 * quota is shared by every tenant on the instance, so one workspace must not be able to spend it.
 */
const LIMITS = {
  search: [{ scope: 'user', windowMs: 60 * 1000, max: 30 }, { scope: 'workspace', windowMs: HOUR, max: 300 }],
  import: [{ scope: 'user', windowMs: HOUR, max: 60 }, { scope: 'workspace', windowMs: HOUR, max: 150 }],
};
const hits = new Map();
function rateCheck(kind, { userId, workspaceId }) {
  const now = Date.now();
  const keys = [];
  for (const l of LIMITS[kind]) {
    const id = l.scope === 'user' ? userId : workspaceId;
    const key = `${kind}:${l.scope}:${id}`;
    const list = (hits.get(key) || []).filter((t) => t > now - l.windowMs);
    hits.set(key, list);
    if (list.length >= l.max) {
      const retry = Math.max(1, Math.ceil((list[0] + l.windowMs - now) / 1000));
      const err = new StockError('Too many stock searches. Try again in a little while.', 'rate_limited', 429);
      if (kind === 'import') err.message = 'Too many stock items added. Try again in a little while.';
      err.retryAfter = retry;
      throw err;
    }
    keys.push(key);
  }
  for (const k of keys) hits.get(k).push(now);
}
function _resetLimits() { hits.clear(); searchCache.clear(); itemCache.clear(); }

/* ============================== provider calls ============================== */

function providerOr400(providerId) {
  if (!providerId && !enabledProviders().length) throw new StockError('Free stock photos are not set up on this server.', 'not_configured', 400);
  const p = PROVIDERS[providerId];
  if (!p) throw new StockError('Unknown provider.', 'bad_provider', 400);
  const key = keyFor(providerId);
  if (!key) throw new StockError(`${p.name} is not set up on this server.`, 'not_configured', 400);
  return { p, key };
}

async function providerJson(p, url, headers) {
  const r = await transport.api(url, headers);
  if (r.status === 200 && r.body && typeof r.body === 'object') return r.body;
  // Nothing from the provider's body is passed on: an error page could quote the request URL.
  if (r.status === 429) throw new StockError(`${p.name} is busy right now. Try again in a few minutes.`, 'provider_busy', 503);
  if (r.status === 401 || r.status === 403) {
    console.warn(`[stock] ${p.id}: the API key was refused (HTTP ${r.status})`);
    throw new StockError(`${p.name} refused this server's API key. A platform admin can check it.`, 'key_rejected', 502);
  }
  if (r.status === 404 || r.status === 400) throw new StockError('That item is no longer available.', 'not_found', 404);
  console.warn(`[stock] ${p.id}: request failed (${r.status ? `HTTP ${r.status}` : (r.error || 'network')})`);
  throw new StockError(`${p.name} could not be reached.`, 'unreachable', 502);
}

// Provider text is shown in pickers and stored on the row: tags and control characters go, and any
// stray angle bracket with them. (Escaping is still the renderer's job; this is about what we keep.)
function cleanText(s, max = 120) {
  return stripTags(String(s == null ? '' : s)).replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function httpsUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : null; } catch { return null; }
}

/* ---------- Pexels ---------- */

// A Pexels photo URL is resized by its own query string (the `src` sizes in the API are exactly
// this, at fixed sizes). Long edge PHOTO_LONG_EDGE, never upscaled.
function pexelsPhotoRendition(ph) {
  const src = ph.src && ph.src.original;
  if (!src) return null;
  const u = new URL(String(src));
  u.search = '';
  const w = Number(ph.width) || 0, h = Number(ph.height) || 0;
  if (Math.max(w, h) > PHOTO_LONG_EDGE) {
    u.searchParams.set('auto', 'compress');
    u.searchParams.set('cs', 'tinysrgb');
    if (w >= h) u.searchParams.set('w', String(PHOTO_LONG_EDGE)); else u.searchParams.set('h', String(PHOTO_LONG_EDGE));
  }
  const scale = Math.max(w, h) > PHOTO_LONG_EDGE ? PHOTO_LONG_EDGE / Math.max(w, h) : 1;
  return { url: u.toString(), width: Math.round(w * scale) || null, height: Math.round(h * scale) || null };
}

/** The best MP4 for a screen: the largest whose long edge is <= VIDEO_MAX_EDGE, else the smallest. */
function pickVideoFile(files) {
  const mp4 = (files || []).filter((f) => f && f.link && (!f.file_type || f.file_type === 'video/mp4') && Number(f.width) > 0 && Number(f.height) > 0);
  if (!mp4.length) return null;
  const edge = (f) => Math.max(Number(f.width), Number(f.height));
  const fits = mp4.filter((f) => edge(f) <= VIDEO_MAX_EDGE).sort((a, b) => edge(b) - edge(a));
  const f = fits[0] || mp4.sort((a, b) => edge(a) - edge(b))[0];
  return { url: f.link, width: Number(f.width), height: Number(f.height), size: Number(f.size) || null };
}

function titleFromSlug(pageUrl, fallback) {
  try {
    const seg = new URL(pageUrl).pathname.split('/').filter(Boolean).pop() || '';
    const words = seg.replace(/-\d+$/, '').replace(/-/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback;
  } catch { return fallback; }
}

function normPexelsPhoto(ph) {
  const page = httpsUrl(ph.url);
  return {
    provider: 'pexels', type: 'photo', id: String(ph.id),
    width: Number(ph.width) || null, height: Number(ph.height) || null,
    thumb: httpsUrl(ph.src && (ph.src.medium || ph.src.small)),
    preview: httpsUrl(ph.src && (ph.src.large || ph.src.medium)),
    title: cleanText(ph.alt) || titleFromSlug(page, 'Pexels photo'),
    author: cleanText(ph.photographer, 80) || null,
    author_url: httpsUrl(ph.photographer_url),
    page_url: page,
    color: /^#[0-9a-f]{6}$/i.test(ph.avg_color || '') ? ph.avg_color : null,
    _rendition: pexelsPhotoRendition(ph),
  };
}

function normPexelsVideo(v) {
  const page = httpsUrl(v.url);
  const user = v.user || {};
  return {
    provider: 'pexels', type: 'video', id: String(v.id),
    width: Number(v.width) || null, height: Number(v.height) || null,
    duration: Number(v.duration) || null,
    thumb: httpsUrl(v.image),
    preview: httpsUrl(v.image),
    title: titleFromSlug(page, 'Pexels video'),
    author: cleanText(user.name, 80) || null,
    author_url: httpsUrl(user.url),
    page_url: page,
    _rendition: pickVideoFile(v.video_files),
  };
}

/* ---------- Pixabay ---------- */

function normPixabayPhoto(h) {
  const page = httpsUrl(h.pageURL);
  // fullHDURL (1920) needs Pixabay's "full API access"; largeImageURL (1280) is what every key gets.
  const big = h.fullHDURL ? { url: h.fullHDURL, edge: 1920 } : { url: h.largeImageURL, edge: 1280 };
  const w = Number(h.imageWidth) || 0, ht = Number(h.imageHeight) || 0;
  const scale = Math.max(w, ht) > big.edge ? big.edge / Math.max(w, ht) : 1;
  return {
    provider: 'pixabay', type: 'photo', id: String(h.id),
    width: w || null, height: ht || null,
    thumb: httpsUrl(h.webformatURL || h.previewURL),
    preview: httpsUrl(h.webformatURL),
    title: cleanText(h.tags) || 'Pixabay image',
    author: cleanText(h.user, 80) || null,
    author_url: h.user && h.user_id ? `https://pixabay.com/users/${encodeURIComponent(String(h.user))}-${encodeURIComponent(String(h.user_id))}/` : null,
    page_url: page,
    _rendition: big.url ? { url: big.url, width: Math.round(w * scale) || null, height: Math.round(ht * scale) || null } : null,
  };
}

function normPixabayVideo(h) {
  const page = httpsUrl(h.pageURL);
  const vids = h.videos || {};
  const files = ['large', 'medium', 'small', 'tiny'].map((k) => vids[k]).filter(Boolean)
    .map((f) => ({ link: f.url, width: f.width, height: f.height, size: f.size, file_type: 'video/mp4' }));
  const thumbOf = (vids.medium && vids.medium.thumbnail) || (vids.small && vids.small.thumbnail) || (vids.tiny && vids.tiny.thumbnail);
  const best = pickVideoFile(files);
  return {
    provider: 'pixabay', type: 'video', id: String(h.id),
    width: best ? best.width : null, height: best ? best.height : null,
    duration: Number(h.duration) || null,
    thumb: httpsUrl(thumbOf),
    preview: httpsUrl(thumbOf),
    title: cleanText(h.tags) || 'Pixabay video',
    author: cleanText(h.user, 80) || null,
    author_url: h.user && h.user_id ? `https://pixabay.com/users/${encodeURIComponent(String(h.user))}-${encodeURIComponent(String(h.user_id))}/` : null,
    page_url: page,
    _rendition: best,
  };
}

/* ---------- requests ---------- */

function requestFor(p, key, type, { q, page, orientation, id }) {
  if (p.id === 'pexels') {
    const base = type === 'video' ? 'https://api.pexels.com/videos' : 'https://api.pexels.com/v1';
    const headers = { Authorization: key };
    if (id) return { url: type === 'video' ? `${base}/videos/${id}` : `${base}/photos/${id}`, headers };
    const u = new URL(`${base}/search`);
    u.searchParams.set('query', q);
    u.searchParams.set('per_page', String(PER_PAGE));
    u.searchParams.set('page', String(page));
    if (orientation) u.searchParams.set('orientation', orientation);
    return { url: u.toString(), headers };
  }
  const u = new URL(type === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/');
  u.searchParams.set('key', key);
  if (id) { u.searchParams.set('id', id); return { url: u.toString(), headers: {} }; }
  u.searchParams.set('q', q);
  u.searchParams.set('safesearch', 'true');
  u.searchParams.set('per_page', String(PER_PAGE));
  u.searchParams.set('page', String(page));
  if (type === 'photo') u.searchParams.set('image_type', 'photo');
  if (orientation) u.searchParams.set('orientation', orientation === 'portrait' ? 'vertical' : 'horizontal');
  return { url: u.toString(), headers: {} };
}

function normalizeList(p, type, body) {
  if (p.id === 'pexels') {
    const list = type === 'video' ? body.videos : body.photos;
    const items = (Array.isArray(list) ? list : []).map(type === 'video' ? normPexelsVideo : normPexelsPhoto);
    return { items, hasMore: !!body.next_page, total: Number(body.total_results) || items.length };
  }
  const items = (Array.isArray(body.hits) ? body.hits : []).map(type === 'video' ? normPixabayVideo : normPixabayPhoto);
  return { items, hasMore: null, total: Number(body.totalHits) || items.length };
}

const publicItem = (it) => {
  const { _rendition, ...rest } = it;
  return rest;
};

function attributionFor(p, type) {
  return {
    text: p.id === 'pexels' ? (type === 'video' ? 'Videos provided by Pexels' : 'Photos provided by Pexels') : `${type === 'video' ? 'Videos' : 'Images'} from Pixabay`,
    url: p.home,
  };
}

/**
 * Search one provider. Returns { provider, type, page, items, has_more, attribution }.
 * Each item is also remembered (with its download rendition) so an import can resolve it.
 */
async function search({ provider, type, q, page = 1, orientation = null, userId, workspaceId }) {
  const { p, key } = providerOr400(provider);
  if (!p.types.includes(type)) throw new StockError('Unsupported type.', 'bad_type', 400);
  const query = cleanText(q, MAX_QUERY);
  if (!query) throw new StockError('Type something to search for.', 'bad_query', 400);
  const pg = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(page, 10) || 1));
  const orient = orientation === 'landscape' || orientation === 'portrait' ? orientation : null;

  const cacheKey = `${p.id}|${type}|${query.toLowerCase()}|${pg}|${orient || ''}`;
  let result;
  const hit = searchCache.get(cacheKey, p.searchTtlMs);
  if (hit) {
    result = hit.value;
  } else {
    // Only a request that actually reaches the provider spends the person's allowance.
    rateCheck('search', { userId, workspaceId });
    const req = requestFor(p, key, type, { q: query, page: pg, orientation: orient });
    const body = await providerJson(p, req.url, req.headers);
    result = normalizeList(p, type, body);
    if (result.hasMore === null) result.hasMore = pg * PER_PAGE < Math.min(result.total, 500);
    searchCache.set(cacheKey, result);
  }
  for (const it of result.items) {
    const k = `${p.id}|${type}|${it.id}`;
    if (!itemCache.get(k, p.searchTtlMs)) itemCache.set(k, it);
  }
  return {
    provider: p.id, type, page: pg,
    items: result.items.filter((it) => it._rendition).map(publicItem),
    has_more: !!result.hasMore,
    attribution: attributionFor(p, type),
  };
}

/** One item by id, from the cache of the provider's answers or from the provider. */
async function resolveItem(p, key, type, id, { fresh = false } = {}) {
  const k = `${p.id}|${type}|${id}`;
  if (!fresh) {
    const hit = itemCache.get(k, p.searchTtlMs);
    if (hit) return { item: hit.value, at: hit.at };
  }
  const req = requestFor(p, key, type, { id });
  const body = await providerJson(p, req.url, req.headers);
  let item = null;
  if (p.id === 'pexels') item = type === 'video' ? normPexelsVideo(body) : normPexelsPhoto(body);
  else { const h = Array.isArray(body.hits) ? body.hits[0] : null; if (h) item = type === 'video' ? normPixabayVideo(h) : normPixabayPhoto(h); }
  // The provider answered about a DIFFERENT id: refuse rather than import something nobody chose.
  if (!item || item.id !== id) throw new StockError('That item is no longer available.', 'not_found', 404);
  itemCache.set(k, item);
  return { item, at: Date.now() };
}

/** Whether the server may fetch this rendition: https, no credentials, on the provider's media host. */
function checkMediaUrl(p, raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new StockError(`${p.name} returned an invalid download address.`, 'bad_url'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !p.mediaHost(u.hostname.toLowerCase())) {
    throw new StockError(`${p.name} returned a download address outside its own servers; it was not fetched.`, 'bad_url');
  }
  return u.toString();
}

function safeName(title, provider) {
  const t = String(title || '').replace(/[\u0000-\u001f\u007f/\\<>:"|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return t || `${provider} stock`;
}

/**
 * Add one stock item to a workspace's library.
 * opts: { provider, type, id, userId, workspaceId, folderId, maxBytes }
 * Resolves the content row (with `attribution` set). maxBytes is the caller's remaining allowance
 * (storage room and the instance's upload limit), already worked out; STOCK_MAX_BYTES caps it.
 */
async function importItem(opts) {
  const { provider, type, userId, workspaceId, folderId = null } = opts;
  const id = String(opts.id || '');
  const { p, key } = providerOr400(provider);
  if (!p.types.includes(type)) throw new StockError('Unsupported type.', 'bad_type', 400);
  if (!ID_RE.test(id)) throw new StockError('Invalid item id.', 'bad_id', 400);
  rateCheck('import', { userId, workspaceId });

  let { item, at } = await resolveItem(p, key, type, id);
  const limit = Math.max(0, Math.min(STOCK_MAX_BYTES, opts.maxBytes == null ? STOCK_MAX_BYTES : opts.maxBytes));
  if (!item._rendition) throw new StockError('That item has no file this server can use.', 'no_rendition', 404);
  if (item._rendition.size && item._rendition.size > limit) throw tooLarge(opts, limit);

  const tmp = path.join(config.contentDir, `${uuidv4()}.part`);
  const fetchOnce = async (it) => {
    const url = checkMediaUrl(p, it._rendition.url);
    return transport.download(url, tmp, limit);
  };
  let got;
  try {
    try {
      got = await fetchOnce(item);
    } catch (e) {
      // Pixabay's download links are temporary. A cached answer whose link has gone stale gets ONE
      // fresh lookup; anything else fails as it is.
      const status = e && e.statusCode;
      if (!(status >= 400 && status < 500) || Date.now() - at < 60 * 1000) throw e;
      ({ item } = await resolveItem(p, key, type, id, { fresh: true }));
      if (!item._rendition) throw new StockError('That item has no file this server can use.', 'no_rendition', 404);
      got = await fetchOnce(item);
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not written */ }
    if (e instanceof StockError && e.code === 'too_large') throw tooLarge(opts, limit);
    if (e instanceof StockError) throw e;
    console.warn(`[stock] ${p.id}: download failed (${(e && (e.code || e.statusCode || e.name)) || 'error'})`);
    throw new StockError(`The file could not be downloaded from ${p.name}.`, 'download', 502);
  }

  // The bytes decide what this is (lib/upload-sniff), and it must be what was asked for: a "photo"
  // that turns out to be a zip, or a "video" that is an image, is refused before anything is stored.
  const { sniffMime, readHead } = require('./upload-sniff');
  let mime = null;
  try { mime = sniffMime(readHead(tmp)); } catch { mime = null; }
  const want = type === 'video' ? /^video\// : /^image\/(jpeg|png|webp)$/;
  if (!mime || !want.test(mime)) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw new StockError(`${p.name} sent a file that is not a ${type}; it was not added.`, 'bad_file', 502);
  }

  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime] || '.mp4';
  const { ingestUploadedFile } = require('./content-ingest');
  const file = { path: tmp, size: got.size, originalname: `${safeName(item.title, p.name)}${ext}` };
  const row = await ingestUploadedFile({ file, userId, workspaceId, folderId });

  const attribution = {
    provider: p.id,
    provider_name: p.name,
    type,
    id: item.id,
    title: item.title || null,
    author: item.author || null,
    author_url: item.author_url || null,
    page_url: item.page_url || null,
    licence: p.licence,
    licence_url: p.licenceUrl,
    added_at: Math.floor(Date.now() / 1000),
  };
  const { db } = require('../db/database');
  db.prepare('UPDATE content SET attribution = ? WHERE id = ? AND workspace_id = ?').run(JSON.stringify(attribution), row.id, workspaceId);
  return db.prepare('SELECT * FROM content WHERE id = ?').get(row.id);
}

function tooLarge(opts, limit) {
  if (opts.roomLimited && limit < STOCK_MAX_BYTES) {
    const e = new StockError('This item would exceed your storage allowance.', 'STORAGE_LIMIT', 403);
    return e;
  }
  return new StockError(`That file is larger than the ${Math.round(limit / (1024 * 1024))} MB limit for a stock item.`, 'too_large', 413);
}

/** A cheap check that a key works: one tiny search, never cached, never counted against a tenant. */
async function testKey(providerId) {
  const { p, key } = providerOr400(providerId);
  const req = requestFor(p, key, 'photo', { q: 'coffee', page: 1 });
  await providerJson(p, req.url, req.headers);
  return true;
}

module.exports = {
  PROVIDERS, PROVIDER_ORDER, StockError, STOCK_MAX_BYTES,
  keyFor, keySource, saveKey, enabledProviders, attributionFor,
  search, importItem, testKey, checkMediaUrl, pickVideoFile,
  _setTransport, _resetLimits,
};
