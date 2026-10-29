'use strict';

/*
 * Wi-Fi networks a screen should know (#720): an operator keeps a short list per device in the
 * dashboard, the server hands it to the native Android player, and the player adds, updates or
 * removes the networks IT added. Networks configured on the panel by hand are never touched.
 *
 * ⚠️ THE PASSWORD NEVER LEAVES THIS SERVER EXCEPT TO THE SCREEN ITSELF. It is encrypted at rest
 * (lib/secretbox, column psk_enc), never returned by the API — present() says has_password and
 * nothing more, not even a mask at the real length — never logged and never put in activity
 * details. The one place it is decrypted is deliveryFor(), on the way to the panel, which needs the
 * plaintext to join the network at all.
 *
 * ⚠️ KEPT AWAY FROM EVERY GENERIC SURFACE. Nothing here is a devices column, a playlist-payload field
 * or a device command: those reach device lists, preview-payload, exports, mesh replicas, API tokens
 * and the MCP tools. The rows live in their own table, the routes are JWT-only
 * (config/api-surface.js) and the list travels on its own socket event, device:wifi-networks.
 *
 * ⚠️ NEVER OVER A PLAIN CONNECTION. deliveryFor() is only called for a socket isTlsSocket() accepts:
 * native TLS, or a proxy in the trusted list (config/cloudflareIps trustedProxies) that says https.
 * X-Forwarded-Proto from anyone else is ignored — on a LAN self-host any host could send it. The
 * one way around it is the operator's: WIFI_ALLOW_INSECURE=1 (config.wifiAllowInsecure), off by
 * default and logged loudly at boot, for an install that only ever runs on a LAN it trusts.
 *
 * ⚠️ NEVER THROUGH A REPLICA. The table is not replicated (lib/mesh/replication.js TABLES), so a
 * replica would deliver an EMPTY list and the player would drop every network it manages. Only a
 * screen connected to this node directly is sent anything (ws/deviceSocket.js checks viaEdge).
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const secretbox = require('./secretbox');
const config = require('../config');

const SECURITY = ['open', 'wpa2', 'wpa3'];
/*
 * What the player may report per network (device:wifi-result). 'deferred' is the stranding guard
 * at work: a change to the network the panel is connected on, or the removal of it, waits until
 * another managed network has been confirmed working or the connection drops on its own.
 */
const PLAYER_STATES = ['applied', 'suggested', 'deferred', 'failed', 'unsupported'];
const MAX_NETWORKS = 16;
const MAX_PRIORITY = 100;
// The modes a player reports in device_info.wifi_mode; anything else is stored as NULL.
const MODES = ['owner', 'direct', 'suggestions', 'unsupported'];

if (config.wifiAllowInsecure) {
  console.warn('[wifi] ⚠️ WIFI_ALLOW_INSECURE is set: Wi-Fi passwords are sent to screens on connections that are NOT HTTPS. Only for a LAN you trust end to end.');
}

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/*
 * An SSID is up to 32 octets (IEEE 802.11). Control characters are refused: they cannot be typed
 * on any panel either, and they would only make a list nobody can read.
 */
function cleanSsid(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s) throw new InputError('The network name (SSID) is required.');
  if (Buffer.byteLength(s, 'utf8') > 32) throw new InputError('The network name (SSID) can be at most 32 bytes.');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new InputError('The network name (SSID) contains a control character.');
  return s;
}

/*
 * WPA2/WPA3 personal: a passphrase of 8 to 63 printable ASCII characters. WPA2 also takes a raw
 * 64-hex-digit key. Android's own builders refuse anything else, so refusing here gives the
 * operator the error instead of a network that silently never joins.
 */
function cleanPassword(raw, security) {
  const p = String(raw);
  if (security === 'wpa2' && /^[0-9a-fA-F]{64}$/.test(p)) return p;
  if (p.length < 8 || p.length > 63 || !/^[\x20-\x7e]+$/.test(p)) {
    throw new InputError(security === 'wpa2'
      ? 'The password must be 8 to 63 printable ASCII characters, or 64 hexadecimal digits.'
      : 'The password must be 8 to 63 printable ASCII characters.');
  }
  return p;
}

/**
 * Validate a create/update body. `existing` is the stored row on an update: fields left out keep
 * their stored values, and a password left out (absent, null or '') keeps the stored one.
 * Returns { ssid, security, hidden, priority, pskEnc }. Throws InputError.
 */
function normaliseInput(body, existing = null) {
  const b = body || {};
  const ssid = cleanSsid(b.ssid !== undefined ? b.ssid : (existing ? existing.ssid : undefined));

  const security = String(b.security !== undefined ? b.security : (existing ? existing.security : ''));
  if (!SECURITY.includes(security)) throw new InputError('security must be open, wpa2 or wpa3.');

  const hidden = b.hidden !== undefined ? (b.hidden === true || b.hidden === 1 || b.hidden === '1') : (existing ? !!existing.hidden : false);

  let priority = existing ? existing.priority : null;
  if (b.priority !== undefined) {
    if (b.priority === null || b.priority === '') priority = null;
    else {
      const n = Number(b.priority);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) throw new InputError(`priority must be a whole number from 0 to ${MAX_PRIORITY}, or empty.`);
      priority = n;
    }
  }

  const given = b.password !== undefined && b.password !== null && b.password !== '';
  let pskEnc;
  if (security === 'open') {
    if (given) throw new InputError('An open network has no password.');
    pskEnc = null; // switching a network to open drops its stored password
  } else if (given) {
    pskEnc = secretbox.encrypt(cleanPassword(b.password, security));
  } else {
    // Kept only while the network stays secured; open → secured needs a password typed now.
    pskEnc = existing && existing.security !== 'open' ? existing.psk_enc : null;
    if (!pskEnc) throw new InputError('A password is required for a secured network.');
    // WPA2 → WPA3 keeps it only if it is valid for WPA3 too (a raw 64-hex WPA2 key is not).
    if (existing && existing.security !== security) {
      const kept = secretbox.decrypt(pskEnc);
      if (!kept) throw new InputError('The stored password can no longer be read. Enter it again.');
      try { cleanPassword(kept, security); } catch {
        throw new InputError(`Enter the password again: the stored one is not valid for ${security === 'wpa3' ? 'WPA3' : 'WPA2'}.`);
      }
    }
  }
  return { ssid, security, hidden, priority, pskEnc };
}

/** What the API may say about a network. Never the password. */
function present(row) {
  return {
    id: row.id,
    ssid: row.ssid,
    security: row.security,
    hidden: !!row.hidden,
    priority: row.priority == null ? null : row.priority,
    has_password: !!row.psk_enc,
    status: row.status || 'pending',
    status_reason: row.status_reason || null,
    status_at: row.status_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listForDevice(deviceId) {
  return db.prepare('SELECT * FROM device_wifi_networks WHERE device_id = ? ORDER BY created_at, ssid').all(deviceId);
}

function create(device, body) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM device_wifi_networks WHERE device_id = ?').get(device.id).n;
  if (count >= MAX_NETWORKS) throw new InputError(`A screen can hold at most ${MAX_NETWORKS} managed networks.`);
  const v = normaliseInput(body);
  if (db.prepare('SELECT 1 FROM device_wifi_networks WHERE device_id = ? AND ssid = ?').get(device.id, v.ssid)) {
    throw new InputError('This screen already has a network with that name.', 409);
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO device_wifi_networks (id, workspace_id, device_id, ssid, security, hidden, priority, psk_enc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(id, device.workspace_id, device.id, v.ssid, v.security, v.hidden ? 1 : 0, v.priority, v.pskEnc);
  return db.prepare('SELECT * FROM device_wifi_networks WHERE id = ?').get(id);
}

function update(row, body) {
  const v = normaliseInput(body, row);
  if (v.ssid !== row.ssid && db.prepare('SELECT 1 FROM device_wifi_networks WHERE device_id = ? AND ssid = ? AND id != ?').get(row.device_id, v.ssid, row.id)) {
    throw new InputError('This screen already has a network with that name.', 409);
  }
  db.prepare(`UPDATE device_wifi_networks SET ssid = ?, security = ?, hidden = ?, priority = ?, psk_enc = ?,
    status = 'pending', status_reason = NULL, status_at = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(v.ssid, v.security, v.hidden ? 1 : 0, v.priority, v.pskEnc, row.id);
  return db.prepare('SELECT * FROM device_wifi_networks WHERE id = ?').get(row.id);
}

function remove(row) {
  db.prepare('DELETE FROM device_wifi_networks WHERE id = ?').run(row.id);
}

/*
 * ─── Transport security ──────────────────────────────────────────────────────────────────────
 * Same trust rule as Express's req.protocol and deviceSocket's getClientIp: a forwarded header
 * counts only when the peer that sent it is a proxy we trust; its first value is the client's
 * scheme. Anything else is the socket's own transport.
 */
let _trust = null;
function isTlsSocket(socket) {
  const hs = socket && socket.handshake;
  if (!hs) return false;
  if (hs.secure) return true;
  const fwd = hs.headers && hs.headers['x-forwarded-proto'];
  if (!fwd) return false;
  try {
    if (!_trust) _trust = require('proxy-addr').compile(require('../config/cloudflareIps').trustedProxies);
    if (!_trust(hs.address, 0)) return false;
  } catch { return false; }
  return String(fwd).split(',')[0].trim().toLowerCase() === 'https';
}

/** The connected sockets of this device on THIS node (a screen on another node is not ours to reach). */
function socketsOf(io, deviceId) {
  if (!io) return [];
  const ns = io.of('/device');
  const room = ns.adapter.rooms.get(deviceId);
  if (!room) return [];
  return [...room].map((sid) => ns.sockets.get(sid)).filter(Boolean);
}

/** { online, tls } for the dashboard: tls is null while the screen is not connected here. */
function connectionState(io, deviceId) {
  const sockets = socketsOf(io, deviceId);
  if (!sockets.length) return { online: false, tls: null, allow_insecure: !!config.wifiAllowInsecure };
  return { online: true, tls: sockets.every(isTlsSocket), allow_insecure: !!config.wifiAllowInsecure };
}

function setStatus(deviceId, status, reason) {
  db.prepare(`UPDATE device_wifi_networks SET status = ?, status_reason = ?, status_at = strftime('%s','now') WHERE device_id = ?`)
    .run(status, reason || null, deviceId);
}

/*
 * The list as the player gets it, passwords decrypted. Fails CLOSED: if any stored password cannot
 * be decrypted (JWT_SECRET rotated), nothing is sent. Sending the list without that network would
 * make the player remove a network that may still be working; the operator re-enters it instead.
 */
function deliveryFor(deviceId) {
  const rows = listForDevice(deviceId);
  const networks = [];
  for (const r of rows) {
    let password = null;
    if (r.security !== 'open') {
      password = secretbox.decrypt(r.psk_enc);
      if (!password) return { error: 'password_unreadable' };
    }
    networks.push({ id: r.id, ssid: r.ssid, security: r.security, hidden: !!r.hidden, priority: r.priority == null ? null : r.priority, password });
  }
  return { networks };
}

/**
 * Send the current list to this device's connected sockets. Returns what happened, for the
 * dashboard: 'delivered' | 'offline' | 'unsupported' | 'insecure' | 'password_unreadable' | 'not_owner'. A device without the
 * capability is not sent anything — an older player would not understand the event.
 */
function push(io, deviceId) {
  // A copied workspace (scale-out replica) has no rows here: only the node that owns it delivers.
  const owner = db.prepare('SELECT w.origin_node_id FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?').get(deviceId);
  if (!owner || owner.origin_node_id) return 'not_owner';
  const sockets = socketsOf(io, deviceId);
  if (!sockets.length) return 'offline';
  if (!supportsWifi(deviceId)) return 'unsupported';
  if (!config.wifiAllowInsecure && !sockets.every(isTlsSocket)) {
    setStatus(deviceId, 'not_delivered', 'insecure_connection');
    return 'insecure';
  }
  const d = deliveryFor(deviceId);
  if (d.error) {
    setStatus(deviceId, 'not_delivered', d.error);
    return d.error;
  }
  for (const s of sockets) s.emit('device:wifi-networks', { networks: d.networks });
  setStatus(deviceId, 'sent', null);
  return 'delivered';
}

function supportsWifi(deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  return !!device && require('./player-capabilities').supports(device, 'net.wifi');
}

/*
 * The player's report (device:wifi-result): one state per network id it was sent. Only ids of
 * THIS device are updated, states outside the vocabulary are dropped and a reason is a short code,
 * never free text from the panel.
 */
function applyResult(deviceId, data) {
  const results = data && Array.isArray(data.results) ? data.results.slice(0, MAX_NETWORKS) : [];
  const stmt = db.prepare(`UPDATE device_wifi_networks SET status = ?, status_reason = ?, status_at = strftime('%s','now')
    WHERE id = ? AND device_id = ?`);
  for (const r of results) {
    if (!r || typeof r.id !== 'string' || !PLAYER_STATES.includes(r.state)) continue;
    const reason = typeof r.reason === 'string' && /^[a-z0-9_]{1,48}$/.test(r.reason) ? r.reason : null;
    stmt.run(r.state, reason, r.id, deviceId);
  }
}

/*
 * The activity_log entry for a change: who (the request), which screen, which SSID and what
 * happened. ⚠️ Never the password, and not "has_password" either — the trail records the change,
 * not the credential's shape.
 */
function audit(req, action, device, ssid) {
  require('./audit').audit(action, {
    userId: req && req.user ? req.user.id : null,
    workspaceId: device.workspace_id,
    deviceId: device.id,
    ip: req && (req.ip || null),
    details: { ssid },
  });
}

/** device_info.wifi_mode as stored: one of MODES, or NULL for an older or non-Android player. */
function cleanMode(raw) {
  return MODES.includes(raw) ? raw : null;
}

module.exports = {
  InputError, SECURITY, MODES, MAX_NETWORKS,
  normaliseInput, present, listForDevice, create, update, remove,
  isTlsSocket, connectionState, deliveryFor, push, applyResult, audit, cleanMode,
};
