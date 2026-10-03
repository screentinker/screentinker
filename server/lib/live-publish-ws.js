'use strict';
/*
 * #go2rtc — WebSocket signaling proxy for a native (Android) device's WebRTC exchanges.
 *
 * Why a websocket and not the HTTP WHIP/WHEP routes (which the browser uses): go2rtc's HTTP answer
 * inlines its ICE candidates, and libwebrtc on Android drops candidates that arrive inline before
 * its transport exists ("JsepTransport doesn't exist") -> the peer never gets go2rtc's candidates
 * and never connects. go2rtc's WS API instead returns a candidate-less answer and TRICKLES the
 * candidates afterwards, which is what its own working web client does. This proxy lets a device
 * speak that trickle protocol without ever seeing go2rtc's URL or admin token: it connects to one of
 *   ws(s)://<screentinker>/api/devices/:id/<what>?token=<device_token>
 * and we pipe the webrtc/offer|answer|candidate JSON to go2rtc's /api/ws?<dir>=<stream>.
 *
 * Routes (all device-authenticated, gated on the same three live-video flags, fail-soft):
 *   live/publish/ws    -> dst=<video stream>        the screen publisher (#go2rtc live video)
 *   talk/publish/ws    -> dst=<talk uplink>         device mic -> operator            (#talk)
 *   talk/subscribe/ws  -> src=<talk downlink>       operator mic -> device speaker    (#talk)
 */
const WebSocket = require('ws');
const config = require('../config');
const go2rtc = require('./go2rtc');
const orgWebrtc = require('./org-webrtc');   // #talk: per-org talk flag gate
const deviceSocket = require('../ws/deviceSocket');
const { db } = require('../db/database');

// Path suffix -> how to resolve the go2rtc stream and which direction to open. dir 'dst' = the
// device sends media into the stream (publish); 'src' = the device receives from it (subscribe).
const ROUTES = {
  'live/publish': { dir: 'dst', stream: (ws, dev) => go2rtc.streamName(ws, dev) },
  'talk/publish': { dir: 'dst', talk: true, stream: (ws, dev) => go2rtc.talkStreamName(ws, dev, 'up') },
  'talk/subscribe': { dir: 'src', talk: true, stream: (ws, dev) => go2rtc.talkStreamName(ws, dev, 'dn') },
  // Broadcast listen (#talk PA): the stream is a group/workspace channel, resolved from the query
  // params AFTER validating this device belongs to that scope (see broadcastStreamFor).
  'talk/listen': { dir: 'src', talk: true, broadcast: true },
};
const PATH_RE = /^\/api\/devices\/([^/]+)\/(live\/publish|talk\/publish|talk\/subscribe|talk\/listen)\/ws$/;

// For a broadcast listen: is deviceId allowed to hear scopeKind/scopeId, and what is the stream?
// A device may listen to its own workspace's channel, or to a group it is a member of (that group
// must also be in its workspace). Returns the go2rtc stream name, or null if not permitted.
function broadcastStreamFor(deviceId, workspaceId, scopeKind, scopeId) {
  try {
    if (scopeKind === 'workspace') {
      if (scopeId !== workspaceId) return null;
      return go2rtc.broadcastTalkStreamName('workspace', workspaceId);
    }
    if (scopeKind === 'group') {
      const g = db.prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(scopeId);
      if (!g || g.workspace_id !== workspaceId) return null;
      const member = db.prepare('SELECT 1 FROM device_group_members WHERE group_id = ? AND device_id = ?').get(scopeId, deviceId);
      if (!member) return null;
      return go2rtc.broadcastTalkStreamName('group', scopeId);
    }
  } catch (_) { /* fall through */ }
  return null;
}

// Returns the workspace id if live video is on at all three levels for this device, else null.
function liveWorkspace(deviceId) {
  try {
    const d = db.prepare('SELECT workspace_id, live_video_enabled FROM devices WHERE id = ?').get(deviceId);
    if (!d || !d.workspace_id) return null;
    const w = db.prepare('SELECT live_video_enabled FROM workspaces WHERE id = ?').get(d.workspace_id);
    const on = !!(config.liveVideoEnabled && w && w.live_video_enabled && d.live_video_enabled);
    return on ? d.workspace_id : null;
  } catch (_) { return null; }
}

// The device's workspace id with no feature gate (used by talk routes, which gate on the per-org
// talk flag instead of the live-video flags).
function workspaceOf(deviceId) {
  try { const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId); return (d && d.workspace_id) || null; }
  catch (_) { return null; }
}

function reject(socket, code, text) {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch (_) {}
  try { socket.destroy(); } catch (_) {}
}

// Attach to the shared HTTP server's 'upgrade' event. Only claims OUR path; every other upgrade
// (socket.io's own) is left untouched, so this coexists with the dashboard/device namespaces.
function attach(server) {
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (_) { return; }
    const m = PATH_RE.exec(u.pathname);
    if (!m) return;                                   // not ours — leave it for socket.io/engine.io
    const deviceId = m[1];
    const route = ROUTES[m[2]];
    const token = u.searchParams.get('token') || req.headers['x-device-token'];
    if (!deviceSocket.validateDeviceToken(deviceId, token)) return reject(socket, 401, 'Unauthorized');
    if (!route || !go2rtc.enabled()) return reject(socket, 409, 'Conflict');
    // Live video gates on the three live-video flags; talk gates on the per-org talk flag.
    const workspaceId = route.talk
      ? (orgWebrtc.talkEnabledForDevice(deviceId) ? workspaceOf(deviceId) : null)
      : liveWorkspace(deviceId);
    if (!workspaceId) return reject(socket, 409, 'Conflict');
    // A broadcast listen resolves its stream from the (validated) scope; every other route has a
    // fixed per-device stream.
    let name;
    if (route.broadcast) {
      name = broadcastStreamFor(deviceId, workspaceId, u.searchParams.get('scopeKind'), u.searchParams.get('scopeId'));
      if (!name) return reject(socket, 403, 'Forbidden');
    } else {
      name = route.stream(workspaceId, deviceId);
    }
    if (!name) return reject(socket, 409, 'Conflict');
    wss.handleUpgrade(req, socket, head, (client) => proxy(client, name, route));
  });
  return wss;
}

async function proxy(client, name, route) {
  if (!name) { try { client.close(); } catch (_) {} return; }
  // Only a PUBLISH (dst) needs the stream to exist first; ensureStream leaves an inert `webrtc:`
  // placeholder. A SUBSCRIBE (src) to a placeholder-only stream fails ("unsupported url"), so we do
  // NOT create one — the far side's publish creates the real producer, and the device's subscribe
  // leg retries until it does.
  if (route.dir === 'dst') { try { await go2rtc.ensureStream(name); } catch (_) { /* go2rtc may auto-create on dst */ } }
  const wsBase = String(config.go2rtcUrl).replace(/^http/i, 'ws').replace(/\/+$/, '');
  let upstream;
  try {
    upstream = new WebSocket(wsBase + '/api/ws?' + route.dir + '=' + encodeURIComponent(name), { headers: go2rtc._adminHeaders() });
  } catch (_) { try { client.close(); } catch (_e) {} return; }

  const pending = [];
  upstream.on('open', () => { for (const msg of pending) { try { upstream.send(msg); } catch (_) {} } pending.length = 0; });
  upstream.on('message', (data) => { if (client.readyState === WebSocket.OPEN) { try { client.send(data.toString()); } catch (_) {} } });
  upstream.on('close', () => { try { client.close(); } catch (_) {} });
  upstream.on('error', () => { try { client.close(); } catch (_) {} });

  client.on('message', (data) => {
    const s = data.toString();
    if (upstream.readyState === WebSocket.OPEN) { try { upstream.send(s); } catch (_) {} }
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push(s);
  });
  client.on('close', () => { try { upstream.close(); } catch (_) {} });
  client.on('error', () => { try { upstream.close(); } catch (_) {} });
}

module.exports = { attach, _liveWorkspace: liveWorkspace, _PATH_RE: PATH_RE };
