'use strict';

/*
 * View-only access to one display: watch what it is showing from any browser, without pairing.
 *
 * Additive, and separate from every credential that already exists:
 *   - a display is still paired with a code, or opened with its #313 enrol-key URL, exactly as before;
 *     both of those ARE the screen (a device token), and nothing here reads, rotates or accepts them;
 *   - a view token is its own secret, scoped to one display, good for one thing: GET the view page and
 *     its read-only payload. It is never a device token (device:register compares device_token, a
 *     different column), never an API token (st_… hashes in api_tokens), never a session.
 *
 * Off by default per display (devices.view_enabled = 0) and switchable off for a whole instance
 * (config.viewOnlyEnabled). Two ways in once a display allows it:
 *   1. the share link   /view/<token>          anyone holding it, from anywhere
 *   2. the network      /view/screen/<id>      no token, but only from the admin's CIDR ranges
 *
 * The viewer gets the same payload a screen gets, minus everything that is not needed to draw it
 * (sanitizeForViewer), and polls for it; turning access off or regenerating the link makes the next
 * poll answer 410, so an open viewer goes dark within one poll interval.
 */

const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const config = require('../config');
const secretbox = require('./secretbox');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const MAX_CIDRS = 32;
const POLL_MS = 4000;

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const looksLikeToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/** A new share token: 32 random bytes, base64url. Stored hashed (lookup) + sealed (admin copy). */
function mintToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token), enc: secretbox.encrypt(token) };
}

/* ------------------------------------------------------------------ CIDR */

// IPv4 a.b.c.d/n and IPv6 …/n. proxy-addr (already a dependency, used by getClientIp) does the
// matching for both families; this only decides what an admin may type.
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function parseCidr(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const ip = m[1];
  const isV4 = V4.test(ip);
  const isV6 = !isV4 && ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip) && require('net').isIPv6(ip);
  if (!isV4 && !isV6) return null;
  const max = isV4 ? 32 : 128;
  const bits = m[2] === undefined ? max : Number(m[2]);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  if (bits === 0) return null;   // 0.0.0.0/0 and ::/0 are "everyone": that is the share link, not a network
  return `${ip.toLowerCase()}/${bits}`;
}

/** Validate an admin's list. Returns { cidrs } or { error, invalid }. Accepts an array or text. */
function normaliseCidrs(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [];
  const invalid = [];
  for (const raw of list) {
    if (!String(raw || '').trim()) continue;
    const c = parseCidr(raw);
    if (!c) invalid.push(String(raw).trim().slice(0, 64));
    else if (!out.includes(c)) out.push(c);
  }
  if (invalid.length) return { error: `Not a valid network range: ${invalid.join(', ')}. Use a range like 10.0.0.0/8 or 192.168.1.0/24.`, invalid };
  if (out.length > MAX_CIDRS) return { error: `At most ${MAX_CIDRS} network ranges.` };
  return { cidrs: out };
}

function parseStoredCidrs(text) {
  try { const a = JSON.parse(text || '[]'); return Array.isArray(a) ? a.filter((c) => parseCidr(c)) : []; } catch { return []; }
}

function ipInCidrs(ip, cidrs) {
  if (!ip || !cidrs || !cidrs.length) return false;
  try {
    const trust = proxyaddr.compile(cidrs);
    return trust(ip, 0);
  } catch { return false; }
}

/* ------------------------------------------------------------------ client IP */

/*
 * ⚠️ NOT req.ip. The app trusts loopback, private ranges and Cloudflare as proxies (server.js
 * 'trust proxy'), which is right for logs and rate limits, and wrong for an ACCESS decision: any host
 * on a private network could send X-Forwarded-For: 10.0.0.5 and be believed. Here X-Forwarded-For is
 * honoured only through proxies the operator listed in VIEW_TRUSTED_PROXIES; otherwise the answer is
 * the TCP peer, full stop.
 */
let trustedFn = null;
let trustedFor = null;
function trustFn() {
  const list = config.viewTrustedProxies || [];
  const key = list.join(',');
  if (trustedFor !== key) {
    trustedFor = key;
    try { trustedFn = list.length ? proxyaddr.compile(list) : () => false; } catch { trustedFn = () => false; }
  }
  return trustedFn;
}
function viewerIp(req) {
  const fn = trustFn();
  try { return normaliseIp(proxyaddr(req, fn)); } catch { return normaliseIp(req.socket && req.socket.remoteAddress); }
}
function normaliseIp(ip) {
  const s = String(ip || '');
  return s.startsWith('::ffff:') && V4.test(s.slice(7)) ? s.slice(7) : s;
}

/* ------------------------------------------------------------------ lookup */

/**
 * The display a request may view, or a reason it may not.
 * by: { token } for the share link, { deviceId } for the network path.
 * Returns { device } or { status, reason } — 404 for anything that does not exist or is off, so a
 * probe cannot tell "wrong token" from "turned off"; 403 only for a known display opened from outside
 * its networks (the network path names its own id, so there is nothing to hide there).
 */
function resolve(db, req, by) {
  if (!config.viewOnlyEnabled) return { status: 404, reason: 'disabled' };
  let device = null;
  if (by.token !== undefined) {
    if (!looksLikeToken(by.token)) return { status: 404, reason: 'unknown' };
    device = db.prepare('SELECT id, workspace_id, name, view_enabled, view_cidrs, view_token_hash, status FROM devices WHERE view_token_hash = ?').get(hashToken(by.token));
    if (!device) return { status: 404, reason: 'unknown' };
    // Belt and braces: the lookup was by hash; compare the hash again in constant time.
    const a = Buffer.from(device.view_token_hash, 'hex');
    const b = Buffer.from(hashToken(by.token), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 404, reason: 'unknown' };
    if (!device.view_enabled) return { status: 404, reason: 'off' };
    return { device };
  }
  if (by.deviceId !== undefined) {
    if (!/^[0-9a-f-]{36}$/i.test(String(by.deviceId))) return { status: 404, reason: 'unknown' };
    device = db.prepare('SELECT id, workspace_id, name, view_enabled, view_cidrs, status FROM devices WHERE id = ?').get(String(by.deviceId));
    if (!device || !device.view_enabled) return { status: 404, reason: 'unknown' };
    const cidrs = parseStoredCidrs(device.view_cidrs);
    if (!cidrs.length) return { status: 404, reason: 'unknown' };   // no networks set: this door does not exist
    if (!ipInCidrs(viewerIp(req), cidrs)) return { status: 403, reason: 'network' };
    return { device };
  }
  return { status: 404, reason: 'unknown' };
}

/* ------------------------------------------------------------------ payload */

/*
 * What a viewer receives: enough to draw the screen, nothing more. Built from the same payload the
 * screen gets (buildPlaylistPayload, so a suspended screen shows its suspended card) and then
 * reduced to an allowlist — a new top-level field added to the screen payload later is NOT passed
 * to viewers until someone decides it should be.
 */
const VIEWER_FIELDS = ['assignments', 'layout', 'orientation', 'background_color', 'default_content', 'playback_order', 'timezone', 'custom_shaders', 'suspended', 'reason', 'message', 'detail'];
/*
 * ⚠️ widget_panel is a meeting-room display's PANEL capability — it lets the page book and end
 * meetings as that screen (lib/rooms/service.js). A viewer must never get it: without it the room
 * page renders read-only, which is exactly what a viewer is.
 */
const ITEM_DROP = ['widget_panel', '__origin_ws', 'trigger', 'match_token', 'clear_token', 'secret'];

function sanitizeForViewer(payload) {
  const p = payload || {};
  const out = {};
  for (const k of VIEWER_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  if (Array.isArray(out.assignments)) {
    out.assignments = out.assignments.map((a) => {
      const c = { ...a };
      for (const k of ITEM_DROP) delete c[k];
      return c;
    });
  }
  return out;
}

/** A short fingerprint of what is on screen, so a poll can answer "unchanged" without the body. */
function revOf(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('base64url').slice(0, 16);
}

module.exports = {
  POLL_MS, MAX_CIDRS, mintToken, hashToken, looksLikeToken, parseCidr, normaliseCidrs, parseStoredCidrs,
  ipInCidrs, viewerIp, resolve, sanitizeForViewer, revOf, VIEWER_FIELDS,
};
