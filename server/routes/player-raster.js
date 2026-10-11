'use strict';

/*
 * Player raster — one browser-only item rendered to a still frame, for a player that cannot run
 * HTML at all (the Roku: docs/roku-player.md).
 *
 *   GET /api/player/raster?device_id=<id>&widget_id=<id>    (or &content_id=<id>)
 *       [&w=1920&h=1080] [&format=jpeg|png] [&q=85] [&bg=000000] [&rev=<opaque>]
 *   Authorization: Bearer <device_token>
 *
 * The same device-token credential and middleware as /api/embedded (middleware/deviceTokenAuth.js),
 * and the same Chromium pipeline as the e-ink renderer (lib/embedded-render.js), but a different
 * product: a full-colour frame for a television, not a dithered bitmap for e-paper. Mounted next to
 * /api/embedded in server.js and, like it, outside the PUBLIC_ROUTERS bearerAuth loop — a device
 * token is not an API token.
 *
 * Responses:
 *   200  image/jpeg | image/png, ETag, Cache-Control: no-cache, X-ST-Refresh-In: <seconds>
 *   304  If-None-Match matched (same headers, no body) — decided BEFORE any render or disk read
 *   400  bad parameters, or a content item the player plays natively (image / video / stream)
 *   401/403  auth (deviceTokenAuth), or a device that does not declare render.server_raster
 *   404  unknown id, or an id this device has no business rendering (another workspace's) — the
 *        same answer for both, so the endpoint cannot be used to probe for ids
 *   415  content that is neither native nor something the renderer can draw
 *   422  a remote page on a refused address (lib/ssrf-guard)
 *   429  rate limited (Retry-After)
 *   501  { error: 'renderer_unavailable' } — no Chromium configured (CHROME_PATH) and the item needs it
 *   504  the 15 s render deadline passed
 *
 * X-ST-Refresh-In is the number of seconds until the item's output can next change on its own: the
 * remainder of its time bucket (a clock: to the next minute; weather: ten minutes; an RSS feed or a
 * web page: five), or 0 for an item that changes only when someone edits it. A 0 does not mean
 * "never ask again": an edit arrives as a new widget_rev/content_rev in the playlist payload, and
 * the player asks again then. ⚠️ The player should re-ask a little AFTER the bucket rolls (the
 * Roku adds a couple of seconds): asking at exactly 0 races the boundary and can get the old frame.
 *
 * `rev` is opaque and IGNORED by the server. The player puts the item's rev in it to step around
 * any HTTP cache between it and us; it is deliberately not part of the cache key, or any caller
 * could force a fresh Chromium render per request by counting upwards.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { db } = require('../db/database');
const config = require('../config');
const { deviceTokenAuth } = require('../middleware/deviceTokenAuth');
const capsLib = require('../lib/player-capabilities');
const { effectiveDeviceTz, isRealTimezone } = require('../lib/device-timezone');
const { toETag, isNotModified, createCache } = require('../lib/embedded-cache');

const router = express.Router();

/*
 * The renderer, behind a seam so tests can stand in for Chromium (the e-ink tests stub
 * puppeteer-core itself; here the whole frame function is the unit, and the frame bytes are the
 * only thing the route needs from it).
 */
const renderer = {
  available: () => require('../lib/embedded-render').isBrowserAvailable(),
  frame: (source, profile, options) => require('../lib/embedded-render').renderPlayerFrame(source, profile, options),
  encode: (png, opts) => require('../lib/embedded-postprocess').encodeColour(png, opts),
};

/*
 * ⚠️ A SIBLING of the e-ink cache, not the same one (see createCache in lib/embedded-cache.js): a
 * colour 1080p frame is ~100x an e-ink frame, and one budget would let a Roku fleet evict every
 * panel's render. 300 frames / 300 MB.
 */
const cache = createCache({
  dir: () => process.env.PLAYER_RASTER_CACHE_DIR || path.join(__dirname, '..', 'data', 'player-raster-cache'),
  maxEntries: 300,
  maxBytes: 300 * 1024 * 1024,
  label: 'player-raster-cache',
});

// ─── Parameters ────────────────────────────────────────────────────────────────

const DIM_MIN = 64;
const DIM_MAX = 3840;
const Q_MIN = 40;
const Q_MAX = 95;

function dim(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(DIM_MIN, Math.min(DIM_MAX, Math.round(n)));
}

function parseParams(q) {
  const widgetId = typeof q.widget_id === 'string' && q.widget_id ? q.widget_id : null;
  const contentId = typeof q.content_id === 'string' && q.content_id ? q.content_id : null;
  if (!widgetId === !contentId) return { error: 'exactly one of widget_id or content_id is required' };
  if ((widgetId || contentId).length > 128) return { error: 'id too long' };
  const w = dim(q.w, 1920);
  const h = dim(q.h, 1080);
  if (w === null || h === null) return { error: 'w and h must be numbers' };
  const fmt = String(q.format || 'jpeg').toLowerCase();
  const format = fmt === 'jpg' ? 'jpeg' : fmt;
  if (format !== 'jpeg' && format !== 'png') return { error: "format must be 'jpeg' or 'png'" };
  let quality = 85;
  if (q.q !== undefined && q.q !== '') {
    const n = Number(q.q);
    if (!Number.isFinite(n)) return { error: 'q must be a number' };
    quality = Math.max(Q_MIN, Math.min(Q_MAX, Math.round(n)));
  }
  // The colour under the page. Widgets are drawn transparent over the player's own zone background
  // (a clock is white text on nothing); a screenshot of nothing is white, so white on white. The
  // player sends its zone colour; black is what every player paints when none is set.
  const bgRaw = q.bg === undefined || q.bg === '' ? '000000' : String(q.bg).replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(bgRaw)) return { error: 'bg must be a 6-digit hex colour' };
  const background = bgRaw.toLowerCase();
  return { widgetId, contentId, w, h, format, quality, background };
}

// ─── What this device may render ───────────────────────────────────────────────

/*
 * The ids in what this screen was actually TOLD to play: its own playlist payload, built by the one
 * function every delivery path uses (ws/deviceSocket.js buildPlaylistPayload) — so a corporate
 * mandate's head-office widget, a wall's or a group's playlist, an emergency card and the default
 * content are all covered without a second resolver that could drift from it.
 *
 * Consulted only when the item is NOT in the device's own workspace (the cheap check), and cached
 * per device for a few seconds: a Roku asks for every zone of a layout at once, and building the
 * payload is dozens of queries.
 */
const REF_TTL_MS = 15 * 1000;
const refCache = new Map();   // deviceId -> { at, widgets: Set, contents: Set }

function referencedIds(deviceId) {
  const now = Date.now();
  const hit = refCache.get(deviceId);
  if (hit && now - hit.at < REF_TTL_MS) return hit;
  const widgets = new Set();
  const contents = new Set();
  try {
    const build = require('../ws/deviceSocket').buildPlaylistPayload;
    const payload = typeof build === 'function' ? build(deviceId) : null;
    for (const a of (payload && Array.isArray(payload.assignments) ? payload.assignments : [])) {
      if (!a) continue;
      if (a.widget_id) widgets.add(String(a.widget_id));
      if (a.content_id) contents.add(String(a.content_id));
    }
    if (payload && payload.default_content && payload.default_content.content_id) {
      contents.add(String(payload.default_content.content_id));
    }
  } catch (e) {
    // Never fatal: with no payload the workspace rule alone applies, which only ever refuses more.
    console.warn(`[player-raster] payload resolve failed for ${deviceId}: ${e.message}`);
  }
  const entry = { at: now, widgets, contents };
  if (refCache.size > 5000) refCache.clear();
  refCache.set(deviceId, entry);
  return entry;
}

/*
 * ⚠️ The rule is "this device's workspace, or this device's own payload" — and NOT "any widget",
 * although /api/widgets/:id/render itself is public. That route is public because a sandboxed
 * player iframe cannot carry credentials, and an id is hard to guess; this one spends a Chromium
 * render on the answer and is reached with a credential, so it holds the credential to its tenant.
 * A widget with no workspace (a platform template) passes only through the payload.
 */
function mayRender(device, row, kind) {
  if (row.workspace_id && row.workspace_id === device.workspace_id) return true;
  const refs = referencedIds(device.id);
  return kind === 'widget' ? refs.widgets.has(String(row.id)) : refs.contents.has(String(row.id));
}

// ─── What the item is, and how often it changes ────────────────────────────────

/*
 * A raster of these depends on WHICH SCREEN asks, so the device id joins the cache key:
 *   room-display    — a room sign's state is fetched with ?device= (lib/rooms/render.js)
 *   diag-smoothness — reports telemetry keyed by the device
 * Everything else renders identically for every screen in the fleet given the same zone, so one
 * render serves them all. ⚠️ The ZONE is always in the key (the page is rendered with the screen's
 * timezone emulated, so a clock or a date reads local time), which is what keeps a clock shared
 * across a fleet in one zone and correct across a fleet in several.
 */
const DEVICE_SCOPED_WIDGETS = new Set(['room-display', 'diag-smoothness']);

/*
 * Time buckets for widget types the e-ink table (routes/embedded.js dynamicPeriodFor) does not
 * know, because e-ink never had to show them well. Consulted only when that table returns null, so
 * the two never disagree about a type both know.
 */
const RASTER_EXTRA_PERIODS = {
  cap_alert: 60,          // live alerts change under the card
  'room-display': 60,     // meetings start and end
  'menu-board': 300,      // prices and 86'd items come from a data source
  template: 300,          // a template may bind data or draw the time
  'bi-dashboard': 300,
  'directory-search': 300,
  'cloud-doc': 300,
};

function periodFor(item) {
  const { dynamicPeriodFor } = require('./embedded');
  const p = dynamicPeriodFor(item);
  if (p) return p;
  const s = item.widget_type && RASTER_EXTRA_PERIODS[item.widget_type];
  return s ? { label: item.widget_type, seconds: s } : null;
}

/*
 * Content the Roku plays itself. Refused with 400 rather than rendered: a still of a video is a
 * black frame or a thumbnail, and an image is cheaper sent as itself.
 */
function playsNatively(mime) {
  const m = String(mime || '').toLowerCase();
  return m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/')
    || m === 'application/x-st-hold';
}

function bundleMime() { return require('../lib/html-bundle').BUNDLE_MIME; }

/*
 * How to draw a content row, or an error. Only two kinds of content need a browser: an HTML bundle
 * (flattened by lib/bundle-inline, exactly what /api/content/:id/bundle serves players) and a
 * remote web page (navigated, every request SSRF-vetted). A PDF or an uploaded document has no
 * renderer here — Chromium's PDF viewer does not paint in a headless screenshot — and is a 415.
 */
function contentSource(row) {
  if (playsNatively(row.mime_type)) return { status: 400, error: 'plays_natively' };
  if (row.mime_type === bundleMime() && row.filepath) return { kind: 'bundle' };
  const { looksLikeImage } = require('../lib/embedded-render');
  if (row.remote_url && /^https?:\/\//i.test(row.remote_url) && !looksLikeImage(row.remote_url, row.mime_type)) {
    return { kind: 'page' };
  }
  return { status: 415, error: 'unsupported_type' };
}

async function bundleHtml(row) {
  let safePath = path.resolve(config.contentDir, path.basename(row.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir) + path.sep)) {
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  }
  if (!fs.existsSync(safePath) && require('../lib/storage/serve').storedElsewhere(row)) {
    safePath = await require('../lib/storage/locations').ensureLocalFile(row, 'asset');
    if (!safePath) throw Object.assign(new Error('Bundle not found'), { code: 'NOT_FOUND' });
  }
  const { inlineBundle } = require('../lib/bundle-inline');
  const out = await inlineBundle(safePath, row.bundle_entry || 'index.html');
  return out.html;
}

// ─── Rate limits ───────────────────────────────────────────────────────────────

/*
 * Two budgets per DEVICE, never per IP — a venue's screens share one NAT address, and a per-IP
 * limit would make one busy Roku blank its neighbours (the lib/ota-download-guard reasoning).
 *   requests: 240/min — answering a 304 or a cache hit is cheap; this only stops a loop.
 *   renders:   30/min — a Chromium page is the expensive part, and the pool is 3 pages shared by
 *              the whole server (e-ink included). A layout of six refreshing zones on a 60 s clock
 *              needs six a minute; thirty leaves room for edits without letting one screen starve
 *              the pool. Counted only on a cache MISS, so a fleet sharing a frame costs one render.
 */
const REQUESTS_PER_MIN = 240;
const RENDERS_PER_MIN = 30;
const WINDOW_MS = 60 * 1000;
const hits = { req: new Map(), render: new Map() };

function overBudget(bucket, deviceId, max, now = Date.now()) {
  const map = hits[bucket];
  const recent = (map.get(deviceId) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    map.set(deviceId, recent);
    return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  map.set(deviceId, recent);
  if (map.size > 10000) {
    for (const [k, v] of map) if (v.every((t) => now - t >= WINDOW_MS)) map.delete(k);
  }
  return 0;
}

// ─── The route ─────────────────────────────────────────────────────────────────

// One render per key at a time: thirty Rokus asking for the same clock as the minute rolls must
// cost one Chromium page, not thirty.
const inflight = new Map();   // key -> Promise<{ buffer, contentType }>

// res.end, not res.json: Express would stamp its own weak ETag on the error body, and an ETag on
// anything but a frame is exactly what frameHeaders() below is careful never to send.
function send(res, status, body) {
  return res.status(status).type('application/json').end(JSON.stringify(body));
}

router.get('/raster', deviceTokenAuth, async (req, res) => {
  const device = req.device;
  if (!capsLib.supports(device, 'render.server_raster')) {
    return send(res, 403, { error: 'capability_required', capability: 'render.server_raster' });
  }
  const p = parseParams(req.query || {});
  if (p.error) return send(res, 400, { error: 'bad_request', detail: p.error });

  const reqWait = overBudget('req', device.id, REQUESTS_PER_MIN);
  if (reqWait) { res.set('Retry-After', String(reqWait)); return send(res, 429, { error: 'rate_limited' }); }

  // The item, held to this device's tenant.
  let item;
  let source;
  let editRev;
  let id;
  let kind;
  if (p.widgetId) {
    kind = 'widget';
    const row = db.prepare('SELECT id, workspace_id, widget_type, config, updated_at FROM widgets WHERE id = ?').get(p.widgetId);
    if (!row || !mayRender(device, row, 'widget')) return send(res, 404, { error: 'not_found' });
    id = row.id;
    editRev = row.updated_at || 0;
    item = { widget_id: row.id, widget_type: row.widget_type, widget_config: row.config };
    const scoped = DEVICE_SCOPED_WIDGETS.has(row.widget_type);
    /*
     * The widget's own public render page — exactly what a browser player frames — so every type
     * (templates with their CSP, alert cards, room signs, social walls, menu boards, plugins) draws
     * here the way it draws there, with no second renderer to drift. ⚠️ NO ?rev=: a rev-pinned
     * render is sent `immutable`, and Chromium's cache would then hand a time-bucketed re-render the
     * same stale alert card or post list for a year. renderPlayerFrame also turns its cache off.
     */
    source = {
      path: `/api/widgets/${encodeURIComponent(row.id)}/render`
        + (scoped ? `?device=${encodeURIComponent(device.id)}` : ''),
    };
    item.scoped = scoped;
  } else {
    kind = 'content';
    const row = db.prepare(`SELECT id, workspace_id, mime_type, filepath, remote_url, bundle_entry,
        COALESCE(NULLIF(updated_at, 0), created_at) AS rev FROM content WHERE id = ?`).get(p.contentId);
    if (!row || !mayRender(device, row, 'content')) return send(res, 404, { error: 'not_found' });
    const how = contentSource(row);
    if (how.error) return send(res, how.status, { error: how.error });
    id = row.id;
    editRev = row.rev || 0;
    item = { content_id: row.id, mime_type: row.mime_type, remote_url: row.remote_url, scoped: false };
    source = how.kind === 'page' ? { url: row.remote_url } : { bundleRow: row };
  }

  const tzRaw = effectiveDeviceTz(device);
  const timezone = tzRaw && isRealTimezone(tzRaw) ? tzRaw : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const period = periodFor(item);
  const bucket = period ? Math.floor(nowSec / period.seconds) : null;
  const refreshIn = period ? period.seconds - (nowSec % period.seconds) : 0;

  const key = crypto.createHash('sha256').update(JSON.stringify([
    'player-raster-v2', kind, id, editRev, bucket,
    p.w, p.h, p.format, p.format === 'jpeg' ? p.quality : null,
    timezone, item.scoped ? device.id : null, p.background,
  ])).digest('hex');
  const etag = toETag(key);
  /*
   * ⚠️ Only on a 200 or a 304. An ETag on a 501 or a 429 would name a frame the player never
   * received; a client that kept it would send it back and be told 304 — "you already have it" —
   * for a picture it does not have.
   */
  const frameHeaders = () => {
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');
    res.set('X-ST-Refresh-In', String(refreshIn));
  };

  if (isNotModified(key, req.headers['if-none-match'])) { frameHeaders(); return res.status(304).end(); }

  const cached = cache.get(key);
  if (cached.hit) {
    frameHeaders();
    res.type(p.format === 'png' ? 'image/png' : 'image/jpeg');
    return res.send(cached.buffer);
  }

  if (!renderer.available()) return send(res, 501, { error: 'renderer_unavailable' });

  let job = inflight.get(key);
  if (!job) {
    const renderWait = overBudget('render', device.id, RENDERS_PER_MIN);
    if (renderWait) { res.set('Retry-After', String(renderWait)); return send(res, 429, { error: 'rate_limited' }); }
    job = (async () => {
      const frameSource = source.bundleRow ? { html: await bundleHtml(source.bundleRow) } : source;
      const png = await renderer.frame(frameSource, { width: p.w, height: p.h }, { timezone, background: p.background });
      const out = await renderer.encode(png, { width: p.w, height: p.h, format: p.format, quality: p.quality });
      cache.set(key, out.buffer);
      return out;
    })();
    inflight.set(key, job);
    job.then(() => inflight.delete(key), () => inflight.delete(key));
  }

  try {
    const out = await job;
    frameHeaders();
    res.type(out.contentType);
    return res.send(out.buffer);
  } catch (e) {
    const code = e && e.code;
    if (code === 'BROWSER_UNAVAILABLE' || code === 'BROWSER_NOT_FOUND') return send(res, 501, { error: 'renderer_unavailable' });
    if (code === 'BLOCKED_URL') return send(res, 422, { error: 'blocked_url' });
    if (code === 'RENDER_TIMEOUT') return send(res, 504, { error: 'render_timeout' });
    if (code === 'NOT_FOUND' || code === 'INVALID_PATH') return send(res, 404, { error: 'not_found' });
    if (e && e.status === 413) return send(res, 413, { error: 'too_large' });
    console.warn(`[player-raster] ${kind} ${id} for ${device.id}: ${e && e.message}`);
    return send(res, 500, { error: 'render_failed' });
  }
});

module.exports = router;
// Test seams. Not part of the route's contract.
module.exports.__renderer = renderer;
module.exports.__reset = () => { refCache.clear(); inflight.clear(); hits.req.clear(); hits.render.clear(); };
module.exports.__periodFor = periodFor;
