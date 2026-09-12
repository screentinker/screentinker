'use strict';
/*
 * The media plane: ScreenTinker's thin, fail-soft client for an OPTIONAL go2rtc sidecar.
 *
 * go2rtc does the WebRTC/MSE/HLS restreaming; ScreenTinker never becomes an SFU. This module is the
 * only thing in the app that talks to go2rtc's admin API, and it exists so three properties hold:
 *
 *   1. OPTIONAL. If GO2RTC_URL is unset or go2rtc is down, every function degrades to "no live
 *      video" and the caller falls back to the existing screenshot path. The app boots and the
 *      Devices page works with no sidecar at all. Nothing here throws into a request.
 *
 *   2. WORKSPACE-SAFE STREAM NAMES. A stream is named from its workspace AND device, so one
 *      workspace can never name, and therefore never subscribe to, another's stream. The name is
 *      derived deterministically and sanitised to the charset go2rtc accepts.
 *
 *   3. THE ADMIN PORT STAYS PRIVATE. The browser never gets GO2RTC_URL or a token; it signals
 *      through a ScreenTinker route that proxies to go2rtc (routes/devices live endpoints). This
 *      module is server-side only.
 */
const crypto = require('crypto');
const config = require('../config');

// go2rtc stream names allow [A-Za-z0-9._-]. Workspace and device ids are UUIDs (safe), but a hash
// keeps the name bounded and stable even if an id ever carries something uglier, and it means the
// raw ids are not sitting in a name a misconfigured go2rtc might log. Prefix keeps them greppable.
function streamName(workspaceId, deviceId) {
  if (!workspaceId || !deviceId) return null;
  const h = crypto.createHash('sha256').update(`${workspaceId}:${deviceId}`).digest('hex').slice(0, 24);
  return `st_${h}`;
}

// The reverse question the proxy must answer before honouring a signaling request: does this
// stream name belong to this workspace+device? Recomputing and comparing is the whole check — a
// name is only ever valid for the pair that produced it.
function streamBelongsTo(name, workspaceId, deviceId) {
  return !!name && name === streamName(workspaceId, deviceId);
}

// #talk — two-way intercom rides two one-directional Opus streams per device (go2rtc streams are
// one-producer, so a bidirectional call needs one each way):
//   dir 'dn' (downlink): operator mic -> device speaker  (dashboard publishes, device subscribes)
//   dir 'up' (uplink):   device mic   -> operator speaker (device publishes, dashboard subscribes)
// Same hashing as streamName so raw ids never sit in a go2rtc name; a distinct prefix keeps talk
// streams greppable and separate from the video stream.
function talkStreamName(workspaceId, deviceId, dir) {
  if (!workspaceId || !deviceId || (dir !== 'dn' && dir !== 'up')) return null;
  const h = crypto.createHash('sha256').update(`talk:${dir}:${workspaceId}:${deviceId}`).digest('hex').slice(0, 24);
  return `tk_${dir}_${h}`;
}

function talkStreamBelongsTo(name, workspaceId, deviceId) {
  return !!name && (name === talkStreamName(workspaceId, deviceId, 'dn') ||
                    name === talkStreamName(workspaceId, deviceId, 'up'));
}

// #talk broadcast (one-way PA): one shared downlink stream per group or per workspace. The operator
// publishes their mic to it once; every device in scope subscribes and plays it (listen-only). kind
// is 'group' or 'workspace', id the group/workspace id.
function broadcastTalkStreamName(kind, id) {
  if ((kind !== 'group' && kind !== 'workspace') || !id) return null;
  const h = crypto.createHash('sha256').update(`talkcast:${kind}:${id}`).digest('hex').slice(0, 24);
  return `tk_cast_${kind === 'group' ? 'g' : 'w'}_${h}`;
}

function baseUrl() {
  const u = config.go2rtcUrl;
  return u ? String(u).replace(/\/+$/, '') : null;
}
function enabled() { return !!baseUrl(); }

// Auth to go2rtc's own API, if the operator protected it. Never leaves the server.
function adminHeaders() {
  const h = {};
  if (config.go2rtcApiToken) h.Authorization = `Bearer ${config.go2rtcApiToken}`;
  else if (config.go2rtcBasicAuth) h.Authorization = `Basic ${Buffer.from(config.go2rtcBasicAuth).toString('base64')}`;
  return h;
}

// Every network call funnels through here so "go2rtc is optional and may be down" is expressed
// once: a short timeout, and null (never a throw) on any failure. A caller that gets null falls
// back to snapshots.
async function call(method, path, { body, headers, raw } = {}) {
  const base = baseUrl();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.go2rtcTimeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...adminHeaders(), ...(headers || {}) },
      body: body != null ? body : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) return raw ? { ok: false, status: res.status } : null;
    if (raw) return { ok: true, status: res.status, text: await res.text(), contentType: res.headers.get('content-type') || '' };
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  } catch (_) {
    return null;   // unreachable / timed out / aborted — treated as "no go2rtc"
  } finally {
    clearTimeout(timer);
  }
}

// Health, cached briefly so a Devices page full of tiles does not hammer the sidecar. A null answer
// means "assume no live video"; callers must not block on it.
let healthCache = { at: 0, ok: false };
async function healthy() {
  const now = Date.now();
  if (now - healthCache.at < config.go2rtcHealthTtlMs) return healthCache.ok;
  const r = await call('GET', '/api/streams', { raw: true });
  healthCache = { at: now, ok: !!(r && r.ok) };
  return healthCache.ok;
}
function _resetHealth() { healthCache = { at: 0, ok: false }; }   // tests

// Register or update a stream's source. go2rtc's API is PUT /api/streams?name=&src=. Called only
// by the server, only when a device is (re)publishing. Returns true on success, false/absent
// otherwise — never throws.
async function putStream(name, src) {
  if (!name || !src) return false;
  const q = `?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`;
  const r = await call('PUT', '/api/streams' + q, { raw: true });
  return !!(r && r.ok);
}
async function deleteStream(name) {
  if (!name) return false;
  const r = await call('DELETE', '/api/streams?src=' + encodeURIComponent(name), { raw: true });
  return !!(r && r.ok);
}
async function hasStream(name) {
  if (!name) return false;
  const streams = await call('GET', '/api/streams');
  return !!(streams && typeof streams === 'object' && Object.prototype.hasOwnProperty.call(streams, name));
}

// go2rtc's WHIP publish (POST /api/webrtc?dst=NAME) returns 404 for a stream that does not exist,
// and the streams API cannot create a truly empty one (PUT requires a src). 'webrtc:' is the
// documented inert placeholder for a stream that expects an inbound WebRTC producer, so we create
// the stream with that source before a player publishes into it. Idempotent: only creates when the
// stream is absent, so it never stacks duplicate placeholders. Verified against go2rtc 1.9.14 — a
// dst= publish to a webrtc:-sourced stream succeeds and a WHEP viewer receives the pushed frames.
async function ensureStream(name) {
  if (!name) return false;
  if (await hasStream(name)) return true;
  const r = await call('PUT', '/api/streams?name=' + encodeURIComponent(name) + '&src=webrtc:', { raw: true });
  return !!(r && r.ok);
}

// Is a publisher ACTUALLY connected to this stream right now? A stream created by ensureStream
// always lists its inert placeholder producer ({url:"webrtc:"}), so mere existence is not enough to
// answer "is someone publishing?". A live WHIP producer shows up as an ADDITIONAL producer with a
// real connection: a remote_addr, medias and received bytes. So the honest signal is "any producer
// with a remote_addr". Used by GET /:id/live to choose webrtc vs the not_publishing snapshot.
async function hasActiveProducer(name) {
  if (!name) return false;
  const streams = await call('GET', '/api/streams');
  const st = streams && typeof streams === 'object' ? streams[name] : null;
  const producers = st && Array.isArray(st.producers) ? st.producers : [];
  return producers.some((pr) => pr && pr.remote_addr);
}

// Proxy a WebRTC SDP exchange for one stream. A ScreenTinker route POSTs the client's offer here
// after checking access; go2rtc answers with the SDP answer.
//
//   dir 'sub' (watch)    -> ?src=NAME : go2rtc SENDS this stream's media to the client (a dashboard
//                           watching a screen). The client offered recvonly.
//   dir 'pub' (publish)  -> ?dst=NAME : go2rtc RECEIVES the client's media INTO this stream (a web
//                           player publishing its screen), creating the stream if it does not exist.
//                           The client offered sendonly.
//
// The two are different query params to go2rtc, so this is not merely advisory: a publisher must
// hit dst or go2rtc has nothing to add the producer to.
async function webrtcExchange(name, sdpOffer, dir = 'sub') {
  if (!name || !sdpOffer) return null;
  const param = dir === 'pub' ? 'dst' : 'src';
  const r = await call('POST', `/api/webrtc?${param}=` + encodeURIComponent(name), {
    body: sdpOffer,
    headers: { 'Content-Type': 'application/sdp' },
    raw: true,
  });
  return (r && r.ok) ? { sdp: r.text, dir } : null;
}

// ICE servers handed to the browser: a STUN server always helps, TURN only if the operator
// configured one (needed when neither side can reach the other's host candidates, e.g. across
// NAT with UDP 8555 closed). Never includes go2rtc's admin credentials.
function iceServers() {
  const out = [];
  for (const u of config.go2rtcStunUrls) out.push({ urls: u });
  if (config.go2rtcTurnUrl) {
    const s = { urls: config.go2rtcTurnUrl };
    if (config.go2rtcTurnUser) { s.username = config.go2rtcTurnUser; s.credential = config.go2rtcTurnPass; }
    out.push(s);
  }
  return out;
}

module.exports = {
  streamName, streamBelongsTo, talkStreamName, talkStreamBelongsTo, broadcastTalkStreamName, enabled, healthy, iceServers,
  putStream, deleteStream, hasStream, ensureStream, hasActiveProducer, webrtcExchange,
  _call: call, _resetHealth, _adminHeaders: adminHeaders,
};
