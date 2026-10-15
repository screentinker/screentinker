'use strict';

/*
 * 3.0 news feeds (lib/news-feed, docs/news-feeds.md).
 *
 * The dashboard's API — JWT only, workspace editors (config/api-surface.js):
 *   POST /discover  { url }        what a pasted address offers: its feeds, or headlines built from
 *                                  the page when it has none (the editor's "Find feeds")
 *   POST /preview   { url, mode }  the items a widget would show, for the editor and the designer
 *
 * The screen-facing reads — PUBLIC, mounted in server.js before the JWT-only routers, because a
 * widget page is a null-origin frame with no session. Each needs this server's signature over its
 * address (lib/news-feed itemsPath / imagePath), so they serve feeds and pictures some widget was
 * rendered with, never an arbitrary URL:
 *   GET /items?m=&u=&s=   the items, from the shared cache
 *   GET /image?u=&s=      an item's picture, fetched and cached by this server
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const news = require('../lib/news-feed');
const { denyReadOnly } = require('../lib/tenancy');

function editor(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return false; }
  // Every call here makes this server read a third-party site: a view-only member has no widget to build.
  if (denyReadOnly(req, res)) return false;
  return true;
}

function fail(res, err) {
  const code = (err && err.code) || 'error';
  // 400: the address itself; 422: a fine address with nothing usable there; 429: the per-site budget;
  // 502: the site failed (down, slow, refused).
  const status = ['bad-url', 'bad-mode', 'blocked', 'private'].includes(code) ? 400
    : ['not-feed', 'robots', 'no-items'].includes(code) ? 422
      : code === 'rate' ? 429 : 502;
  res.status(status).json({ error: (err && err.message) || 'The feed could not be read', code });
}

const modeOf = (v) => (news.MODES.includes(v) ? v : 'feed');

/*
 * 3.0.1: the editor's preview shows each picture through this server's signed image proxy (GET
 * /image, the one screens use: SSRF guard, size cap, sniffed type), never the publisher's URL. The
 * dashboard's CSP allows only https: images from elsewhere, so an http feed's pictures came out as
 * broken images — and the CSP stays as it is. Copies: the cached feed is shared and not ours to edit.
 */
const viaThisServer = (items) => (Array.isArray(items) ? items.map((it) => ({ ...it, image: it.image ? news.imagePath(it.image) : '' })) : items);

router.post('/discover', async (req, res) => {
  if (!editor(req, res)) return;
  try {
    const out = await news.discoverFeeds((req.body || {}).url);
    // Built-from-page previews go to the dashboard, which draws them with esc(); their pictures go
    // through the image proxy like a screen's (viaThisServer above).
    if (out && out.page && Array.isArray(out.page.items)) out.page = { ...out.page, items: viaThisServer(out.page.items) };
    res.json(out);
  } catch (err) { fail(res, err); }
});

router.post('/preview', async (req, res) => {
  if (!editor(req, res)) return;
  const b = req.body || {};
  try {
    const data = await news.getFeed(b.url, modeOf(b.mode));
    res.json({ title: data.title, source: data.source, stale: data.stale, fetched_at: data.fetched_at, items: viaThisServer(data.items.slice(0, 20)) });
  } catch (err) { fail(res, err); }
});

/* ───────────── public, screen-facing ───────────── */

function publicHeaders(res) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function itemsHandler(req, res) {
  publicHeaders(res);
  const u = String(req.query.u || '');
  const m = String(req.query.m || 'feed');
  if (!news.verifyFeed(u, m, String(req.query.s || ''))) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(403).json({ error: 'This feed address is not signed by this server', items: [] });
  }
  const n = parseInt(req.query.n, 10);
  try {
    const data = await news.getFeed(u, m);
    // Short: the server cache is what keeps a fleet off the publisher; this only absorbs a burst.
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(news.screenPayload(data, { max: Number.isFinite(n) ? n : news.ITEMS_MAX }));
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    // The page keeps what it already shows on any error; `items` is there for older pages that read it blindly.
    res.status(502).json({ error: err.message || 'The feed could not be read', code: err.code || 'error', items: [] });
  }
}

async function imageHandler(req, res) {
  publicHeaders(res);
  const u = String(req.query.u || '');
  if (!news.verifyImage(u, String(req.query.s || ''))) return res.status(403).end();
  try {
    const img = await news.getImage(u);
    res.setHeader('Content-Type', img.type);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Loaded by an opaque-origin widget page: same-origin CORP would block it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(img.buf);
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).end();
  }
}

module.exports = router;
module.exports.itemsHandler = itemsHandler;
module.exports.imageHandler = imageHandler;
