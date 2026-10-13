'use strict';
/*
 * The global abuse BACKSTOP: one generous per-minute ceiling in front of every route.
 *
 * ⚠️ THIS IS NOT THE LIMITER THAT PROTECTS ANYTHING SPECIFIC. The tight, per-endpoint limits (login,
 * register, TOTP, uploads, MCP ...) are the hand-written rateLimit() in server.js and stay exactly as
 * they were. This sits above all of them and exists for one failure: a single client in a tight loop
 * (a runaway script, a wedged player retrying with no backoff, a scraper) driving DB and disk work
 * on routes that had no ceiling at all. It must never be the reason a real screen or person sees a
 * 429, so every number here is chosen far above the heaviest legitimate client, not near it.
 *
 * ── WHO A BUCKET BELONGS TO ─────────────────────────────────────────────────────────────────────
 * Prod has sites where thousands of players leave through ONE NAT address, so an IP-only key would
 * put a whole customer in one bucket. The key is therefore the most specific identity the request
 * carries, in this order:
 *
 *   1. a credential — Authorization (dashboard JWT, st_ API token, device token), X-Device-Token,
 *      or ?token= (BrightSign / live publish). One bucket per credential, whatever IP it comes from.
 *   2. a named device on an anonymous request — ?device_id= / ?device= / X-Device-Id, which the
 *      players put on widget renders and OTA checks. Scoped to the IP as well: the id is not a
 *      secret, and without the IP anyone who knew a panel's id could exhaust that panel's bucket.
 *   3. otherwise the client IP (getClientIp: Cloudflare-aware, honours `trust proxy`), with IPv6
 *      folded to its /56 so one host cannot rotate through its own prefix.
 *
 * ⚠️ NEVER THE RAW SECRET. Credentials and device ids are HMAC'd with a per-process random key
 * before they become a map key, so the store holds nothing that authenticates and nothing that can
 * be matched against the sha256 token hashes in the database.
 *
 * The limiter runs before authentication, so a credential is NOT verified here. That is fine for a
 * backstop: a made-up token buys a fresh bucket, but every request carrying one still fails auth on
 * an indexed lookup before any route does real work. Stopping a determined attacker who rotates
 * identities is the edge's job (Cloudflare / the reverse proxy), not this one's.
 *
 * ── THE NUMBERS (per minute, fixed 60 s window, in memory per process) ──────────────────────────
 * Identity: 6000/min (100 req/s sustained for one token). The heaviest real single identity is a
 * dashboard doing a chunked upload, which uploadSessionLimiter already caps at 1200/min, plus its
 * own polling (tens/min). Embedded / Roku / BrightSign / Tizen / webOS players poll every few
 * seconds (well under 100/min each, one token each). Zapier polls per user token every few minutes; a
 * public-API script walking a large fleet sequentially sits around 1000–3000/min. 6000 clears all
 * of them with room, and still stops a loop that would otherwise run at thousands per second.
 *
 * Anonymous: 6000/min per IP (or per IP+device). What is left anonymous after the skips below is
 * landing / docs pages, widget renders and their data.json polls (one per board per 60 s), and OTA
 * checks — and the device-carrying ones get their own bucket per panel anyway. The shared-IP case
 * that remains is in-widget polling with no device id: a site would need ~6000 boards behind one
 * address before it touched this. The existing per-endpoint limits on /view (240) and room panels
 * (1200) are far tighter than this already.
 *
 * ── NEVER COUNTED ────────────────────────────────────────────────────────────────────────────────
 * Static assets and content BYTES are fetched at fleet scale in Range chunks (a 1 GB video is
 * hundreds of requests per player, times every player at a site when it lands), and cost a stat and
 * a stream, so they never count: /player/*, /uploads/*, /fonts/*, /download/* (the APK and the
 * BrightSign autorun every panel on a wave pulls), the socket.io client bundle, a
 * GET for a file with a static extension outside /api, and the content file / thumbnail / bundle
 * reads. The socket.io handshake and polling transport are answered by engine.io before Express
 * sees them; /socket.io/ is skipped anyway so a future mount order cannot start counting it.
 *
 * Env (see README): RATE_LIMIT_BACKSTOP (identity/min; 0 = backstop OFF entirely) and
 * RATE_LIMIT_BACKSTOP_ANON (anonymous/min; 0 = anonymous requests are not limited).
 */
const crypto = require('node:crypto');
const { ipKeyGenerator } = require('express-rate-limit');

const WINDOW_MS = 60_000;
const PROP = 'backstopRateLimit';
const DEFAULT_IDENTITY_MAX = 6000;
const DEFAULT_ANON_MAX = 6000;

// Unset or junk = the default; an explicit 0 = off. `parseInt(x) || d` would turn 0 into the default.
function parseLimit(raw, dflt) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

const KEY_SALT = crypto.randomBytes(32);
const digest = (s) => crypto.createHmac('sha256', KEY_SALT).update(String(s)).digest('hex').slice(0, 32);

const first = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => { v = first(v); return typeof v === 'string' && v.length ? v : ''; };

function credentialOf(req) {
  const h = req.headers || {};
  return str(h.authorization) || str(h['x-device-token']) || str(req.query && req.query.token);
}

function deviceHintOf(req) {
  const q = req.query || {};
  return str(q.device_id) || str(q.device) || str((req.headers || {})['x-device-id']);
}

const STATIC_EXT = /\.(?:m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|m4v|mov|mp3|m4a|ogg|wav|webmanifest|wasm)$/i;
const CONTENT_BYTES = /^\/api\/content\/[^/]+\/(?:file|thumbnail|bundle|bundle-preview\/[^/]+)$/;

// The FULL path, never req.path: inside a router req.path has the mount stripped ('/abc/file' for
// /api/content/abc/file), and the router-level mount must reach the same verdict as the app-wide one.
// Duplicate slashes are folded the way server.js folds them before routing.
function fullPath(req) {
  return String(req.originalUrl || req.url || req.path || '').split('?')[0].replace(/\/{2,}/g, '/');
}

function isUncounted(req) {
  const p = fullPath(req);
  if (p === '/socket.io' || p.startsWith('/socket.io/') || p.startsWith('/socket.io-client/')) return true;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (p === '/player' || p.startsWith('/player/') || p.startsWith('/uploads/') || p.startsWith('/fonts/') ||
      p.startsWith('/download/')) return true;
  if (CONTENT_BYTES.test(p)) return true;
  return !p.startsWith('/api/') && !p.startsWith('/mcp') && STATIC_EXT.test(p);
}

/**
 * Options for express-rate-limit. lib/backstop-limiter.js builds the one live instance from these;
 * the tests build their own with tiny limits.
 *
 * @param {{identityMax:number, anonMax:number, getClientIp:Function, onReject:Function}} o
 *   onReject(req, res, retryAfterSec, info) writes the 429.
 */
function backstopOptions({ identityMax, anonMax, getClientIp, onReject }) {
  const ipOf = (req) => ipKeyGenerator(String(getClientIp(req) || req.ip || ''));
  return {
    windowMs: WINDOW_MS,
    limit: (req) => (credentialOf(req) ? identityMax : anonMax),
    // RateLimit + RateLimit-Policy (IETF draft 7) and Retry-After on a 429; no X-RateLimit-*.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Nothing in the app reads req.rateLimit; a distinct name keeps it from ever colliding.
    requestPropertyName: PROP,
    skip: (req) => {
      if (!(identityMax > 0)) return true;           // RATE_LIMIT_BACKSTOP=0: the backstop is off
      // Already counted on this request. The one instance is mounted app-wide AND at the top of
      // each router (lib/backstop-limiter.js says why); only the first sighting may count.
      if (req[PROP]) return true;
      if (req.method === 'OPTIONS') return true;     // preflights are answered by cors() above
      if (isUncounted(req)) return true;
      if (!(anonMax > 0) && !credentialOf(req)) return true;
      return false;
    },
    keyGenerator: (req) => {
      const cred = credentialOf(req);
      if (cred) return 'cred:' + digest(cred);
      const dev = deviceHintOf(req);
      if (dev) return 'dev:' + ipOf(req) + ':' + digest(dev);
      return 'ip:' + ipOf(req);
    },
    handler: (req, res, _next, options) => {
      const info = req[options.requestPropertyName] || {};
      const retryAfter = info.resetTime ? Math.max(1, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000)) : 60;
      return onReject(req, res, retryAfter, info);
    },
    // A store failure must never turn into an outage: let the request through.
    passOnStoreError: true,
  };
}

module.exports = {
  backstopOptions, parseLimit, isUncounted, credentialOf, deviceHintOf,
  WINDOW_MS, DEFAULT_IDENTITY_MAX, DEFAULT_ANON_MAX,
};
