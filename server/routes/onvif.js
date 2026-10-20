'use strict';

/*
 * ONVIF cameras (lib/onvif): find them, add one as a live stream, refresh its snapshot thumbnail and
 * its stream address, and steer a PTZ camera.
 *
 * Every call names HOW the camera is reached, `via`:
 *   'server'     this server, directly. Only where the operator opened private networks
 *                (OUTBOUND_ALLOW_PRIVATE / OUTBOUND_ALLOW_HOSTS): a self-hosted server on the LAN.
 *   <device id>  a screen on the camera's network that relays for the server (lib/onvif/relay.js).
 *                Any online screen of THIS workspace whose player declares onvif.bridge.
 *
 * A camera added here is an ordinary video/rtsp item (players need nothing new to play it), plus
 * content.onvif (how to reach it again) and content.onvif_secret (its password, encrypted, never
 * sent back: middleware/mask-stream-credentials.js drops it from every response).
 *
 * JWT-only (config/api-surface.js): this reaches into a customer's network through their screens, so
 * it is for signed-in people, not API tokens. Writes need a workspace role above viewer.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db/database');
const config = require('../config');
const { denyReadOnly, resourceAccess } = require('../lib/tenancy');
const { PLATFORM_ROLES } = require('../middleware/auth');
const secretbox = require('../lib/secretbox');
const caps = require('../lib/player-capabilities');
const { privateNetworkAccess } = require('../lib/ssrf-guard');
const { OnvifCamera, discover, xaddrFrom } = require('../lib/onvif/camera');
const { serverTransport, deviceTransport } = require('../lib/onvif/transport');
const { OnvifError } = require('../lib/onvif/soap');

const router = express.Router();

/*
 * Rate limits, per client address. Every route here reaches a camera, through this server or a
 * screen: `connectLimit` for the ones that search a network or sign in (discover, inspect, add,
 * refresh); `cameraLimit` for the rest, generous enough for a held PTZ arrow (a move every 700 ms).
 */
const { rateLimit } = require('express-rate-limit');
const limiter = (windowMs, limit) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many camera requests, slow down and retry in a moment.', code: 'rate-limited' },
});
const connectLimit = limiter(60 * 1000, 20);
const cameraLimit = limiter(60 * 1000, 240);
const RTSP_MIME = 'video/rtsp';

/**
 * An OnvifError as a response a person can act on. ⚠️ The CAMERA refusing the password is 422,
 * never 401: the dashboard treats any 401 as the person's own session ending and signs them out.
 */
function sendError(res, e) {
  if (e instanceof OnvifError) {
    const status = e.code === 'not-authorized' ? 422
      : e.code === 'server-blocked' ? 403
        : /^screen-(offline|timeout|elsewhere)$/.test(e.code) ? 503
          : e.code === 'screen-unsupported' || e.code === 'no-ptz' ? 409
            : 502;
    return res.status(status).json({ error: e.message, code: e.code });
  }
  console.error('[onvif]', e);
  return res.status(500).json({ error: 'Something went wrong talking to the camera' });
}

function deviceNs(req) {
  const io = req.app.get('io');
  return io ? io.of('/device') : null;
}

/** The transport for `via`, or sends the error and returns null. */
function transportFor(req, res, via, workspaceId) {
  if (via === 'server' || !via) {
    if (!privateNetworkAccess()) {
      res.status(403).json({ error: 'This server can\'t reach cameras on a private network. Pick a screen on the cameras\' network instead.', code: 'server-blocked' });
      return null;
    }
    return serverTransport();
  }
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(String(via));
  if (!device || device.workspace_id !== workspaceId) {
    res.status(404).json({ error: 'That screen is not in this workspace', code: 'screen-unknown' });
    return null;
  }
  if (!caps.supports(device, 'onvif.bridge')) {
    res.status(409).json({ error: `The screen "${device.name || device.id}" can't search for cameras (it needs a newer player)`, code: 'screen-unsupported' });
    return null;
  }
  const ns = deviceNs(req);
  if (!ns) { res.status(503).json({ error: 'The realtime layer is not available.' }); return null; }
  return deviceTransport(ns, device);
}

function needWorkspace(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context. Switch to a workspace first.' }); return false; }
  return true;
}

/** An ONVIF camera item this person may change, with its decoded settings; or sends the error. */
function cameraItem(req, res, { write = true } = {}) {
  const c = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!c || !c.onvif) { res.status(404).json({ error: 'Camera not found' }); return null; }
  if (!c.workspace_id) {
    if (write && !PLATFORM_ROLES.includes(req.user.role)) { res.status(403).json({ error: 'Access denied' }); return null; }
  } else {
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(c.workspace_id);
    const ctx = ws && resourceAccess(req, ws);
    if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
    if (write && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  }
  let o;
  try { o = JSON.parse(c.onvif); } catch { o = null; }
  if (!o || !o.xaddr) { res.status(409).json({ error: 'This camera\'s ONVIF settings are damaged; add it again' }); return null; }
  return { row: c, o };
}

function sessionFor(transport, o, password) {
  return new OnvifCamera(transport, {
    xaddr: o.xaddr, username: o.username || '', password: password || '',
    services: o.services || null, timeOffsetMs: o.time_offset_ms || 0,
  });
}

/** Store a snapshot as the item's thumbnail; returns the new thumbnail_path or null. */
function saveThumbnail(row, snap) {
  if (!snap) return null;
  const ext = snap.type === 'image/png' ? 'png' : snap.type === 'image/webp' ? 'webp' : 'jpg';
  const name = `onvif-${row.id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.contentDir, name), snap.buffer);
  const old = row.thumbnail_path;
  db.prepare("UPDATE content SET thumbnail_path = ?, updated_at = strftime('%s','now') WHERE id = ?").run(name, row.id);
  // Only ever our own previous snapshot: never a thumbnail something else owns.
  if (old && /^onvif-[\w-]+\.(jpg|png|webp)$/.test(path.basename(old))) {
    try { fs.unlinkSync(path.join(config.contentDir, path.basename(old))); } catch { /* gone */ }
  }
  return name;
}

function safeName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f/\\]/g, ' ').trim().slice(0, 120) || 'Camera';
}

/** What a browser may know about a camera's ONVIF settings: never the password. */
function publicOnvif(o, row) {
  return {
    xaddr: o.xaddr, username: o.username || '', has_password: !!row.onvif_secret,
    profile_token: o.profile_token, profile_name: o.profile_name || '', ptz: !!o.ptz,
    via: o.via || 'server', manufacturer: o.manufacturer || '', model: o.model || '',
  };
}

// ─── Finding and adding cameras ───────────────────────────────────────────────

/** How cameras can be reached from this workspace: the server, and which screens. */
router.get('/bridges', cameraLimit, (req, res) => {
  if (!needWorkspace(req, res)) return;
  const devices = db.prepare('SELECT * FROM devices WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  res.json({
    server: privateNetworkAccess() === true ? 'all' : privateNetworkAccess() === 'some' ? 'some' : 'none',
    screens: devices.filter((d) => caps.supports(d, 'onvif.bridge'))
      .map((d) => ({ id: d.id, name: d.name || d.id, online: d.status === 'online' })),
  });
});

/** WS-Discovery: { via, host? } -> the cameras that answered. */
router.post('/discover', connectLimit, async (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (denyReadOnly(req, res)) return;
  const { via, host } = req.body || {};
  if (host != null && (typeof host !== 'string' || !/^[a-z0-9.\-:[\]]{1,253}$/i.test(host))) return res.status(400).json({ error: 'That is not a host name or address' });
  const t = transportFor(req, res, via, req.workspaceId);
  if (!t) return;
  try {
    res.json({ cameras: await discover(t, { host: host || null, timeoutMs: 3000 }) });
  } catch (e) { sendError(res, e); }
});

/** Sign in to a camera and list what it offers: { via, xaddr | host, username, password }. */
router.post('/inspect', connectLimit, async (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (denyReadOnly(req, res)) return;
  const { via, username, password } = req.body || {};
  const xaddr = xaddrFrom(req.body && (req.body.xaddr || req.body.host));
  if (!xaddr) return res.status(400).json({ error: 'Enter the camera\'s address, for example 192.168.1.20' });
  const t = transportFor(req, res, via, req.workspaceId);
  if (!t) return;
  try {
    const cam = new OnvifCamera(t, { xaddr, username: username || '', password: password || '' });
    const info = await cam.connect();
    const profiles = await cam.profiles();
    res.json({
      xaddr, manufacturer: info.manufacturer, model: info.model, firmware: info.firmware,
      ptz: !!info.services.ptz, profiles,
    });
  } catch (e) { sendError(res, e); }
});

/**
 * Add a camera as a live stream item:
 * { via, xaddr, username, password, profile_token, name?, folder_id?, tls_self_signed? }.
 * The stream address is resolved now and stored with the credentials (masked in every response, as
 * any camera URL); a snapshot becomes the thumbnail when the camera has one.
 */
router.post('/cameras', connectLimit, async (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (denyReadOnly(req, res)) return;
  const b = req.body || {};
  const xaddr = xaddrFrom(b.xaddr || b.host);
  if (!xaddr) return res.status(400).json({ error: 'Enter the camera\'s address, for example 192.168.1.20' });
  if (!b.profile_token || typeof b.profile_token !== 'string') return res.status(400).json({ error: 'Choose one of the camera\'s streams' });
  let folderId = null;
  if (b.folder_id) {
    const f = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(String(b.folder_id));
    if (!f || f.workspace_id !== req.workspaceId) return res.status(400).json({ error: 'Invalid folder_id for this workspace' });
    folderId = String(b.folder_id);
  }
  const via = b.via || 'server';
  const t = transportFor(req, res, via, req.workspaceId);
  if (!t) return;
  try {
    const cam = new OnvifCamera(t, { xaddr, username: b.username || '', password: b.password || '' });
    const info = await cam.connect();
    const profile = (await cam.profiles()).find((p) => p.token === b.profile_token);
    if (!profile) return res.status(400).json({ error: 'That stream is no longer offered by the camera' });
    const url = await cam.streamUri(profile.token);
    const o = {
      xaddr, username: b.username || '', profile_token: profile.token, profile_name: profile.name,
      ptz: profile.ptz, via, services: cam.services, time_offset_ms: cam.timeOffsetMs,
      manufacturer: info.manufacturer || '', model: info.model || '',
    };
    const id = crypto.randomUUID();
    const name = safeName(b.name || [info.manufacturer, info.model].filter(Boolean).join(' ') || profile.name);
    const selfSigned = /^rtsps:/i.test(url) && b.tls_self_signed ? 1 : 0;
    db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, folder_id, tls_self_signed, onvif, onvif_secret)
                VALUES (?, ?, ?, ?, '', ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, req.workspaceId, name, RTSP_MIME, url, folderId, selfSigned, JSON.stringify(o), secretbox.encrypt(b.password || ''));
    let row = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    try { saveThumbnail(row, await cam.snapshot(profile.token)); } catch { /* a camera without snapshots still works */ }
    row = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    try { require('../lib/revisions').recordCurrent(db, 'content', id, { actor: require('../lib/releases').actorOf(req), summary: 'Added' }); } catch { /* history is best effort */ }
    require('../lib/audit').auditFromReq(req, 'content.onvif_added', { content_id: id, via: via === 'server' ? 'server' : 'screen', ptz: profile.ptz });
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

// ─── An added camera ──────────────────────────────────────────────────────────

router.get('/cameras/:id', cameraLimit, (req, res) => {
  const c = cameraItem(req, res, { write: false });
  if (!c) return;
  res.json(publicOnvif(c.o, c.row));
});

/** Ask the camera again for the stream address (it changed IP, firmware, password): { username?, password?, via? }. */
router.post('/cameras/:id/refresh', connectLimit, async (req, res) => {
  const c = cameraItem(req, res);
  if (!c) return;
  const b = req.body || {};
  const o = { ...c.o };
  if (typeof b.username === 'string') o.username = b.username;
  if (b.via) o.via = String(b.via);
  const password = typeof b.password === 'string' ? b.password : secretbox.decrypt(c.row.onvif_secret) || '';
  const t = transportFor(req, res, o.via, c.row.workspace_id);
  if (!t) return;
  try {
    const cam = sessionFor(t, { ...o, services: null }, password);
    const info = await cam.connect();
    const profiles = await cam.profiles();
    const profile = profiles.find((p) => p.token === o.profile_token) || profiles[0];
    const url = await cam.streamUri(profile.token);
    Object.assign(o, { profile_token: profile.token, profile_name: profile.name, ptz: profile.ptz, services: cam.services, time_offset_ms: cam.timeOffsetMs, manufacturer: info.manufacturer || o.manufacturer, model: info.model || o.model });
    db.prepare("UPDATE content SET remote_url = ?, onvif = ?, onvif_secret = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(url, JSON.stringify(o), secretbox.encrypt(password), c.row.id);
    try { saveThumbnail(c.row, await cam.snapshot(profile.token)); } catch { /* optional */ }
    require('../lib/audit').auditFromReq(req, 'content.onvif_refreshed', { content_id: c.row.id });
    res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(c.row.id));
  } catch (e) { sendError(res, e); }
});

/** A new snapshot as the thumbnail. */
router.post('/cameras/:id/snapshot', cameraLimit, async (req, res) => {
  const c = cameraItem(req, res);
  if (!c) return;
  const t = transportFor(req, res, c.o.via, c.row.workspace_id);
  if (!t) return;
  try {
    const snap = await sessionFor(t, c.o, secretbox.decrypt(c.row.onvif_secret)).snapshot(c.o.profile_token);
    if (!snap) return res.status(404).json({ error: 'This camera does not offer snapshots', code: 'no-snapshot' });
    res.json({ thumbnail_path: saveThumbnail(c.row, snap) });
  } catch (e) { sendError(res, e); }
});

router.get('/cameras/:id/presets', cameraLimit, async (req, res) => {
  const c = cameraItem(req, res);
  if (!c) return;
  if (!c.o.ptz) return res.json({ presets: [] });
  const t = transportFor(req, res, c.o.via, c.row.workspace_id);
  if (!t) return;
  try {
    res.json({ presets: await sessionFor(t, c.o, secretbox.decrypt(c.row.onvif_secret)).presets(c.o.profile_token) });
  } catch (e) { sendError(res, e); }
});

/**
 * Steer: { action: 'move', pan, tilt, zoom } (speeds -1..1; the camera stops by itself after
 * `timeout` seconds, default 1, so a lost Stop can't leave it spinning), { action: 'stop' },
 * { action: 'preset', preset }, { action: 'home' }.
 */
router.post('/cameras/:id/ptz', cameraLimit, async (req, res) => {
  const c = cameraItem(req, res);
  if (!c) return;
  if (!c.o.ptz) return res.status(409).json({ error: 'This camera cannot pan, tilt or zoom', code: 'no-ptz' });
  const b = req.body || {};
  if (!['move', 'stop', 'preset', 'home'].includes(b.action)) return res.status(400).json({ error: 'action must be move, stop, preset or home' });
  if (b.action === 'preset' && (typeof b.preset !== 'string' || !b.preset)) return res.status(400).json({ error: 'preset is required' });
  const t = transportFor(req, res, c.o.via, c.row.workspace_id);
  if (!t) return;
  try {
    const cam = sessionFor(t, c.o, secretbox.decrypt(c.row.onvif_secret));
    const token = c.o.profile_token;
    if (b.action === 'move') await cam.move(token, { pan: b.pan, tilt: b.tilt, zoom: b.zoom }, b.timeout || 1);
    else if (b.action === 'stop') await cam.stop(token);
    else if (b.action === 'preset') await cam.gotoPreset(token, b.preset);
    else await cam.home(token);
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
