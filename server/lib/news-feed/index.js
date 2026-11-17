'use strict';

/*
 * 3.0 news feeds: this server reads RSS / Atom / JSON feeds — and builds headlines from sites that
 * have none — so a SCREEN never contacts a feed's publisher or any feed-conversion service.
 * docs/news-feeds.md is the user and admin description.
 *
 * WHY HERE AND NOT ON THE SCREEN. The ticker used to ask a third-party converter (rss2json) for
 * every feed, from every screen. That service refused perfectly good feeds ("Internal error" for a
 * valid 25-item RSS 2.0 feed), rate-limited busy fleets into "Feed unavailable", and told a third
 * party which feeds every screen reads. Now one server-side read serves every screen and workspace
 * showing that feed, the outbound connections ledger names it (lib/trust/features.js: news_feeds),
 * and a screen talks only to this server.
 *
 * FETCHING. Always through the SSRF guard (lib/ssrf-guard guardedRequest): public addresses only
 * unless the operator opened private ones (OUTBOUND_ALLOW_HOSTS / OUTBOUND_ALLOW_PRIVATE), DNS
 * pinned, every redirect re-vetted, a deadline and a size cap. Reads to one host are capped per
 * minute (HOST_LIMIT) whatever the cache says, so no number of screens or editors turns this server
 * into a crawler.
 *
 * CACHING. One entry per (mode, URL), shared by everyone: fresh for FRESH_MS; after that the next
 * request refetches, and if the source is down the last good items are served (marked stale) for up
 * to STALE_MAX_MS — a screen keeps its headlines through a publisher's outage. A failed read is not
 * retried for ERROR_BACKOFF_MS. Concurrent requests for the same feed share one fetch.
 *
 * ⚠️ BUILT-FROM-PAGE FEEDS ARE HEADLINES, LINKS AND PICTURES ONLY (lib/news-feed/discover.js), and
 * they honour robots.txt for the reader's user agent. An ordinary feed is something a publisher
 * offers for exactly this; scraping a page is not, so that mode asks first.
 *
 * WHO MAY ASK. The screen-facing reads (GET /api/news-feeds/items and /image) are public — a widget
 * page is a null-origin frame with no session — so each carries an HMAC over (mode, URL) that only
 * this server can mint (itemsPath / imagePath). A leaked address lets someone read that one cached
 * feed, as the screen does; it does not make this server fetch anything else.
 */

const crypto = require('crypto');
const { guardedRequest } = require('../ssrf-guard');
const parse = require('./parse');
const discover = require('./discover');

const USER_AGENT = 'ScreenTinker-FeedReader/1.0 (ScreenTinker feed reader; +https://screentinker.com)';
const ROBOTS_TOKENS = ['screentinker-feedreader', 'screentinker'];

const FRESH_MS = 5 * 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 60 * 1000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ARTICLE_META_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;
const HOST_LIMIT = 30;            // reads per host per minute, all callers together
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const ITEMS_MAX = 50;
const ENRICH_MAX = 3;             // built-from-page items given a picture from their own page, at most
const MODES = ['feed', 'page'];

const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
const IMAGE_TTL_MS = 6 * 60 * 60 * 1000;

/* ───────────── errors ───────────── */

/**
 * A failure with a code the editor turns into words (frontend i18n news.err.<code>). `message` is
 * plain English for logs and API callers; it never carries anything about the network that the
 * address itself did not already say.
 */
class FeedError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'FeedError';
    this.code = code;
    if (status) this.upstreamStatus = status;
  }
}

/* ───────────── per-host budget ───────────── */

const hostWindows = new Map();
function takeHostBudget(host, now = Date.now()) {
  const key = String(host || '').toLowerCase();
  let w = hostWindows.get(key);
  if (!w || now - w.start >= 60000) { w = { start: now, n: 0 }; hostWindows.set(key, w); }
  if (hostWindows.size > 5000) for (const [k, v] of hostWindows) { if (now - v.start >= 60000) hostWindows.delete(k); }
  if (w.n >= HOST_LIMIT) return false;
  w.n += 1;
  return true;
}

/* ───────────── fetching ───────────── */

/*
 * GHSA-rvxj 13.1: does this feed address carry a user name or password (https://user:pass@host/)?
 * ⚠️ WHY refuse rather than strip: such a feed needs those credentials to be read, so a stripped
 * address would just fail; and the address ends up on screens and in the widget config every
 * workspace member can read. parse.absUrl already refused these silently (the widget showed
 * nothing); this says why, and the widget save refuses them up front (routes/widgets.js).
 */
const CREDENTIALS_MESSAGE = 'A feed address cannot include a user name or password. Use the feed\'s public address.';
function hasCredentials(raw) {
  let v = String(raw == null ? '' : raw).trim();
  if (!v) return false;
  if (/^feed:/i.test(v)) v = v.replace(/^feed:(\/\/)?/i, '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  try { const u = new URL(v); return !!(u.username || u.password); } catch (_) { return false; }
}

/** Accept "fox6now.com" and "www.example.com/news" as well as full addresses. */
function normaliseInput(raw) {
  let v = String(raw == null ? '' : raw).trim();
  if (!v) throw new FeedError('bad-url', 'Enter a web address');
  if (v.length > 2000) throw new FeedError('bad-url', 'That address is too long');
  if (hasCredentials(v)) throw new FeedError('bad-url', CREDENTIALS_MESSAGE);
  if (/^feed:/i.test(v)) v = v.replace(/^feed:(\/\/)?/i, '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  const u = parse.absUrl(v);
  if (!u) throw new FeedError('bad-url', 'That is not a web address (http:// or https://)');
  return u;
}

function classify(err, url) {
  if (err instanceof FeedError) return err;
  if (err && err.code === 'ssrf') {
    const priv = /blocked-ip:/.test(err.message || '');
    return new FeedError(priv ? 'private' : 'blocked', priv ? `That address is not allowed. ${require('../ssrf-guard').privateAddressHint()}` : 'That address is not allowed');
  }
  if (err && (err.code === 'timeout' || /timed out/i.test(err.message || ''))) return new FeedError('timeout', 'The site did not answer in time');
  if (err && err.code === 'size-limit') return new FeedError('too-large', 'The response was too large');
  if (err && err.code === 'too-many-redirects') return new FeedError('redirects', 'The site redirected too many times');
  if (err && err.statusCode) return new FeedError('status', `The site answered HTTP ${err.statusCode}`, err.statusCode);
  return new FeedError('network', `Could not reach ${(() => { try { return new URL(url).host; } catch (_) { return 'the site'; } })()}`);
}

/**
 * One guarded GET. Returns { text, contentType, finalUrl }. Throws FeedError. `accept` is the
 * Accept header; a server that varies on it gets the feed rather than its HTML page.
 */
async function fetchText(url, { accept, maxBytes = FEED_MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let host;
  try { host = new URL(url).hostname; } catch (_) { throw new FeedError('bad-url', 'That is not a web address'); }
  if (!takeHostBudget(host)) throw new FeedError('rate', 'Too many reads from that site this minute; try again shortly');
  let res;
  try {
    res = await guardedRequest(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept || '*/*', 'Accept-Language': 'en;q=0.8, *;q=0.5' },
      timeoutMs, maxBytes, responseType: 'buffer', maxRedirects: 5, accept2xx: true,
    });
  } catch (err) { throw classify(err, url); }
  const contentType = String((res.headers || {})['content-type'] || '');
  return { text: parse.decodeBody(res.buffer, contentType), contentType, finalUrl: res.finalUrl || url };
}

const ACCEPT_FEED = 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5';
const ACCEPT_HTML = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';

/* ───────────── robots.txt ───────────── */

const robotsCache = new Map();
async function robotsFor(url) {
  const origin = new URL(url).origin;
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.robots;
  let robots;
  try {
    const r = await fetchText(origin + '/robots.txt', { accept: 'text/plain, */*;q=0.5', maxBytes: 512 * 1024, timeoutMs: 8000 });
    robots = discover.parseRobots(/^\s*</.test(r.text) ? '' : r.text, ROBOTS_TOKENS);
  } catch (err) {
    // RFC 9309: an unavailable (4xx) robots.txt means no rules. An unreachable one (5xx, network)
    // means "assume everything is disallowed" — we would rather build nothing than guess.
    if (err.code === 'status' && err.upstreamStatus >= 400 && err.upstreamStatus < 500) robots = discover.parseRobots('', ROBOTS_TOKENS);
    else if (err.code === 'rate') throw err;
    else robots = discover.parseRobots('User-agent: *\nDisallow: /', ROBOTS_TOKENS);
  }
  if (robotsCache.size > 2000) robotsCache.clear();
  robotsCache.set(origin, { at: Date.now(), robots });
  return robots;
}
async function robotsAllow(url) {
  const u = new URL(url);
  return (await robotsFor(url)).allows(u.pathname + u.search);
}

/* ───────────── reading a feed ───────────── */

function looksLikeHtml(text) {
  const head = String(text).slice(0, 4096).replace(/^\uFEFF/, '');
  if (parse.detectFormat(head)) return false;
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(head);
}

async function loadFeed(url) {
  const r = await fetchText(url, { accept: ACCEPT_FEED });
  const feed = parse.parseFeed(r.text, r.finalUrl);
  if (!feed) {
    throw new FeedError('not-feed', looksLikeHtml(r.text)
      ? 'That address is a web page, not a feed. Use "Find feeds" to look for one on the site.'
      : 'That address did not return an RSS, Atom or JSON feed.');
  }
  return { title: feed.title, link: feed.link || '', format: feed.format, source: 'feed', items: feed.items.slice(0, ITEMS_MAX) };
}

/* ───────────── building a feed from a page ───────────── */

const articleMeta = new Map();   // url -> { at, image }
async function enrich(items) {
  const todo = items.slice(0, ENRICH_MAX + 2).filter((it) => !it.image).slice(0, ENRICH_MAX);
  await Promise.all(todo.map(async (it) => {
    const hit = articleMeta.get(it.link);
    if (hit && Date.now() - hit.at < ARTICLE_META_TTL_MS) { if (hit.image) it.image = hit.image; return; }
    try {
      if (!(await robotsAllow(it.link))) return;
      const r = await fetchText(it.link, { accept: ACCEPT_HTML, maxBytes: PAGE_MAX_BYTES, timeoutMs: 8000 });
      const meta = discover.pageMeta(r.text, r.finalUrl);
      if (articleMeta.size > 5000) articleMeta.clear();
      articleMeta.set(it.link, { at: Date.now(), image: meta.image || '' });
      if (meta.image) it.image = meta.image;
    } catch (_) { /* a picture is a nicety; the headline stands without it */ }
  }));
  return items;
}

async function sitemapItems(pageUrl, robots) {
  const base = new URL(pageUrl);
  const candidates = [];
  const add = (u) => { if (u && discover.sameSite(u, pageUrl) && !candidates.includes(u)) candidates.push(u); };
  // A news sitemap first if robots.txt names one, then the rest robots.txt names, then the default.
  robots.sitemaps.filter((u) => /news/i.test(u)).forEach(add);
  robots.sitemaps.forEach(add);
  add(base.origin + '/sitemap.xml');
  let fetched = 0;
  const queue = candidates.slice(0, 6);
  while (queue.length && fetched < 4) {
    const sm = queue.shift();
    try {
      const u = new URL(sm);
      if (!robots.allows(u.pathname + u.search)) continue;
      fetched += 1;
      const r = await fetchText(sm, { accept: 'application/xml, text/xml;q=0.9, */*;q=0.5', maxBytes: 8 * 1024 * 1024 });
      const parsed = discover.parseSitemap(r.text, r.finalUrl);
      if (parsed.news.length) return parsed.news;
      // An index: its news child first; never more than a few fetches in all.
      parsed.index.filter((x) => /news/i.test(x)).concat(parsed.index.filter((x) => /(article|post|latest|fastchanging)/i.test(x)))
        .filter((x) => discover.sameSite(x, pageUrl)).slice(0, 2).forEach((x) => { if (!queue.includes(x)) queue.unshift(x); });
    } catch (err) { if (err.code === 'rate') throw err; }
  }
  return [];
}

async function loadPage(url) {
  const robots = await robotsFor(url);
  const u = new URL(url);
  if (!robots.allows(u.pathname + u.search)) {
    throw new FeedError('robots', 'This site’s robots.txt asks automated readers not to read that page, so no feed can be built from it.');
  }
  const r = await fetchText(url, { accept: ACCEPT_HTML, maxBytes: PAGE_MAX_BYTES });
  if (!looksLikeHtml(r.text) && parse.detectFormat(r.text)) {
    // It is a feed after all: read it as one.
    const feed = parse.parseFeed(r.text, r.finalUrl);
    return { title: feed.title, link: feed.link || url, format: feed.format, source: 'feed', items: feed.items.slice(0, ITEMS_MAX) };
  }
  const meta = discover.pageMeta(r.text, r.finalUrl);
  let source = 'jsonld';
  let items = discover.extractJsonLd(r.text, r.finalUrl).filter((it) => discover.sameSite(it.link, r.finalUrl));
  if (items.length < 3) {
    const fromSitemap = await sitemapItems(r.finalUrl, robots);
    if (fromSitemap.length >= 3) { items = fromSitemap; source = 'sitemap'; }
  }
  if (items.length < 3) {
    const links = discover.extractHeadlineLinks(r.text, r.finalUrl);
    if (links.length > items.length) { items = links; source = 'links'; }
  }
  if (!items.length) throw new FeedError('no-items', 'No headlines could be found on that page.');
  items = items.slice(0, ITEMS_MAX).map((it) => ({ title: it.title, link: it.link, summary: it.summary || '', published: it.published || null, image: it.image || '' }));
  await enrich(items);
  return { title: meta.siteName || meta.title || u.hostname, link: url, format: 'page', source, items };
}

/* ───────────── the shared cache ───────────── */

const cache = new Map();      // `${mode} ${url}` -> { data, at, err, errAt }
const inflight = new Map();

function keyOf(url, mode) { return `${mode} ${url}`; }
function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function result(entry, stale) {
  return { ...entry.data, fetched_at: new Date(entry.at).toISOString(), stale: !!stale };
}

/**
 * The items of a feed (mode 'feed') or of a page read as one (mode 'page'). Resolves with
 * { title, link, format, source, items, fetched_at, stale }; rejects with FeedError when there is
 * nothing to show at all (no fresh read and no last good one within STALE_MAX_MS).
 */
async function getFeed(rawUrl, mode = 'feed', { now = Date.now() } = {}) {
  if (!MODES.includes(mode)) throw new FeedError('bad-mode', 'Unknown feed mode');
  const url = normaliseInput(rawUrl);
  const key = keyOf(url, mode);
  const e = cache.get(key);
  const usable = e && e.data && now - e.at < STALE_MAX_MS;
  if (e && e.data && now - e.at < FRESH_MS) return result(e, false);
  if (e && e.errAt && now - e.errAt < ERROR_BACKOFF_MS) {
    if (usable) return result(e, true);
    throw e.err;
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await (mode === 'page' ? loadPage(url) : loadFeed(url));
      const entry = { data, at: Date.now() };
      remember(key, entry);
      return result(entry, false);
    } catch (raw) {
      const err = classify(raw, url);
      const prev = cache.get(key);
      remember(key, { ...(prev || {}), err, errAt: Date.now() });
      if (prev && prev.data && Date.now() - prev.at < STALE_MAX_MS) return result(prev, true);
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * What the cache holds for this feed right now, without waiting: the last good read (fresh or
 * stale) or null. Starts a refresh in the background when a held entry is no longer fresh. For a
 * synchronous page render that wants to seed itself.
 */
function peek(rawUrl, mode = 'feed') {
  let url;
  try { url = normaliseInput(rawUrl); } catch (_) { return null; }
  if (!MODES.includes(mode)) return null;
  const e = cache.get(keyOf(url, mode));
  const now = Date.now();
  // Refresh what the cache already holds; an unknown feed is first read when a screen asks for it,
  // so rendering a page (or a preview, or a test) never makes this server reach out on its own.
  if (e && e.data && now - e.at >= FRESH_MS) getFeed(url, mode).catch(() => {});
  if (!e || !e.data || now - e.at >= STALE_MAX_MS) return null;
  return result(e, now - e.at >= FRESH_MS);
}

/* ───────────── discovery (the editor's "Find feeds") ───────────── */

/**
 * What a pasted address offers:
 *   { url, title, feeds: [{ url, title, format }], page: null | { available, source, title, items, reason } }
 * A feed address answers with itself. A page answers with the feeds it advertises (or that sit at
 * the usual paths), and — only when it has none — with headlines built from the page.
 */
async function discoverFeeds(rawUrl) {
  const url = normaliseInput(rawUrl);
  const r = await fetchText(url, { accept: `${ACCEPT_HTML}, ${ACCEPT_FEED}`, maxBytes: PAGE_MAX_BYTES });
  const direct = !looksLikeHtml(r.text) && parse.parseFeed(r.text, r.finalUrl);
  if (direct) {
    const data = { title: direct.title, link: direct.link || '', format: direct.format, source: 'feed', items: direct.items.slice(0, ITEMS_MAX) };
    remember(keyOf(url, 'feed'), { data, at: Date.now() });
    return { url, title: direct.title, feeds: [{ url, title: direct.title || url, format: direct.format, item_count: direct.items.length }], page: null };
  }
  if (!looksLikeHtml(r.text)) throw new FeedError('not-feed', 'That address is neither a web page nor a feed.');
  const meta = discover.pageMeta(r.text, r.finalUrl);
  let feeds = discover.findFeedLinks(r.text, r.finalUrl).slice(0, 40);
  if (!feeds.length) {
    const origin = new URL(r.finalUrl).origin;
    for (const p of discover.COMMON_PATHS) {
      try {
        const probe = await fetchText(origin + p, { accept: ACCEPT_FEED, maxBytes: FEED_MAX_BYTES, timeoutMs: 8000 });
        const f = !looksLikeHtml(probe.text) && parse.parseFeed(probe.text, probe.finalUrl);
        if (f && f.items.length) {
          feeds.push({ url: origin + p, title: f.title || meta.siteName || origin, format: f.format, item_count: f.items.length });
          break;   // /feed, /rss and /rss.xml are usually the same feed: one is the answer
        }
      } catch (err) { if (err.code === 'rate') break; }
    }
  }
  let page = null;
  if (!feeds.length) {
    try {
      const built = await getFeed(url, 'page');
      page = { available: true, source: built.source, title: built.title, items: built.items.slice(0, 10) };
    } catch (err) {
      page = { available: false, reason: err.code || 'error', message: err.message };
    }
  }
  return { url, title: meta.siteName || meta.title || '', feeds, page };
}

/* ───────────── pictures ───────────── */

const images = new Map();     // url -> { at, buf, type }
let imageBytes = 0;
const imageInflight = new Map();

function dropImage(url) {
  const e = images.get(url);
  if (e) { imageBytes -= e.buf.length; images.delete(url); }
}

/**
 * An item's picture, fetched by this server and cached in memory, so a screen showing headlines
 * with pictures still contacts only this server. Only bytes that ARE an image (sniffed, whatever
 * the Content-Type claimed) are kept or served. Resolves { buf, type } or rejects FeedError.
 */
async function getImage(rawUrl) {
  const url = parse.absUrl(rawUrl);
  if (!url) throw new FeedError('bad-url', 'Not an image address');
  const hit = images.get(url);
  if (hit && Date.now() - hit.at < IMAGE_TTL_MS) return hit;
  if (imageInflight.has(url)) return imageInflight.get(url);
  const p = (async () => {
    let host;
    try { host = new URL(url).hostname; } catch (_) { throw new FeedError('bad-url', 'Not an image address'); }
    try {
      if (!takeHostBudget(host)) throw new FeedError('rate', 'Too many reads from that site this minute');
      let res;
      try {
        res = await guardedRequest(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' },
          timeoutMs: TIMEOUT_MS, maxBytes: IMAGE_MAX_BYTES, responseType: 'buffer', maxRedirects: 5,
        });
      } catch (err) { throw classify(err, url); }
      const type = require('../social/media').sniff(res.buffer);
      if (!type) throw new FeedError('not-image', 'That address is not an image');
      dropImage(url);
      const entry = { at: Date.now(), buf: res.buffer, type };
      images.set(url, entry);
      imageBytes += entry.buf.length;
      for (const [k] of images) { if (imageBytes <= IMAGE_CACHE_BYTES) break; dropImage(k); }
      return entry;
    } catch (err) {
      if (hit) return hit;   // an old copy beats a broken picture
      throw err;
    } finally {
      imageInflight.delete(url);
    }
  })();
  imageInflight.set(url, p);
  return p;
}

/* ───────────── signed screen-facing addresses ───────────── */

function secret() { return require('../../config').jwtSecret; }
function mac(purpose, value) {
  return crypto.createHmac('sha256', secret()).update(purpose + value).digest('base64url').slice(0, 32);
}
function sameMac(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const signFeed = (url, mode) => mac('news-feed:v1:', `${mode}\n${url}`);
const signImage = (url) => mac('news-image:v1:', url);
function verifyFeed(url, mode, sig) { return MODES.includes(mode) && sameMac(signFeed(url, mode), sig); }
function verifyImage(url, sig) { return sameMac(signImage(url), sig); }

/** The address a screen reads this feed's items from (relative, or absolute with origin). */
function itemsPath(rawUrl, mode = 'feed', origin = '') {
  let url;
  try { url = normaliseInput(rawUrl); } catch (_) { return ''; }
  const m = MODES.includes(mode) ? mode : 'feed';
  return `${origin || ''}/api/news-feeds/items?m=${m}&u=${encodeURIComponent(url)}&s=${signFeed(url, m)}`;
}
/*
 * GHSA-rvxj 13.1: the address a SAVED news widget's page reads its items from. ⚠️ It names the
 * widget, not the feed: the render page is public to anyone holding the widget id (every player
 * that shows it), and a feed address can carry a key in its query string
 * (https://example.com/rss?apikey=...). The items handler looks the feed up from the widget's live
 * config server-side, so the page never contains it. Signed like the feed form, so the endpoint
 * still answers only for widgets this server rendered. Pages built without a saved widget (the
 * editor's preview, offline bundles) keep the feed form above.
 */
const signWidgetFeed = (widgetId) => mac('news-feed-widget:v1:', String(widgetId));
function verifyWidgetFeed(widgetId, sig) { return !!widgetId && sameMac(signWidgetFeed(widgetId), sig); }
function widgetItemsPath(widgetId, origin = '') {
  return widgetId ? `${origin || ''}/api/news-feeds/items?w=${encodeURIComponent(widgetId)}&s=${signWidgetFeed(widgetId)}` : '';
}

function imagePath(url, origin = '') {
  return url ? `${origin || ''}/api/news-feeds/image?u=${encodeURIComponent(url)}&s=${signImage(url)}` : '';
}

/**
 * The JSON a screen gets: headlines, links and this server's address for each picture. Never the
 * publisher's image URL — the screen would fetch it from there. `max` caps the item count.
 */
function screenPayload(data, { origin = '', max = ITEMS_MAX, images: withImages = true } = {}) {
  const items = (data.items || []).slice(0, Math.max(1, Math.min(ITEMS_MAX, max || ITEMS_MAX))).map((it) => ({
    title: it.title, link: it.link, summary: it.summary || '', published: it.published || null,
    image: withImages && it.image ? imagePath(it.image, origin) : '',
  }));
  return { title: data.title || '', items, fetched_at: data.fetched_at || null, stale: !!data.stale };
}

/* ───────────── tests ───────────── */

function _reset() {
  cache.clear(); inflight.clear(); hostWindows.clear(); robotsCache.clear(); articleMeta.clear();
  images.clear(); imageInflight.clear(); imageBytes = 0;
}
/** Age a cached entry (tests): pretend it was read `ms` ago. */
function _age(rawUrl, mode, ms) {
  const e = cache.get(keyOf(normaliseInput(rawUrl), mode));
  if (e && e.data) e.at -= ms;
  if (e && e.errAt) e.errAt -= ms;
}

module.exports = {
  getFeed, peek, discoverFeeds, getImage, fetchText, normaliseInput, hasCredentials, CREDENTIALS_MESSAGE, robotsAllow,
  itemsPath, widgetItemsPath, verifyWidgetFeed, imagePath, signFeed, signImage, verifyFeed, verifyImage, screenPayload,
  FeedError, USER_AGENT, MODES, FRESH_MS, STALE_MAX_MS, ERROR_BACKOFF_MS, HOST_LIMIT, ITEMS_MAX,
  _reset, _age,
};
