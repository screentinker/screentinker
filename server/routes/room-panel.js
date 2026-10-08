'use strict';

/*
 * What a room display PAGE talks to (lib/rooms/render.js). Mounted in server.js without a session,
 * like /api/widgets/:id/render, because the page runs in a sandboxed, opaque-origin frame that can
 * carry no credentials; CORS is open for the same reason, and the bodies are text/plain so no
 * preflight is needed.
 *
 *   GET  /:widgetId/state    the room as that widget shows it, privacy already applied. Readable by
 *                            whoever has the widget id, exactly like the widget's own render.
 *   POST /:widgetId/action   book now, end early, check in. Needs the PANEL capability: proof that
 *                            this server issued it to that paired screen for that widget
 *                            (lib/rooms/service.js panelToken). No session, no API token, and no
 *                            calendar credential is ever on the device.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const svc = require('../lib/rooms/service');
const { logActivity, getClientIp } = require('../services/activity');
const { RoomSourceError } = require('../lib/rooms/http');
const replicaProxy = require('../lib/replica-proxy');
const appConfig = require('../config');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function roomForWidget(widgetId) {
  const w = db.prepare('SELECT id, workspace_id, widget_type, config FROM widgets WHERE id = ?').get(String(widgetId));
  if (!w || w.widget_type !== 'room-display') return { widget: null, room: null };
  let cfg = {};
  try { cfg = JSON.parse(w.config || '{}'); } catch { cfg = {}; }
  const room = cfg.room_id ? db.prepare('SELECT * FROM rooms WHERE id = ? AND workspace_id = ?').get(String(cfg.room_id), w.workspace_id) : null;
  return { widget: w, room: room || null };
}

router.get('/:widgetId/state', async (req, res) => {
  cors(res);
  const { widget, room } = roomForWidget(req.params.widgetId);
  if (!widget) return res.status(404).json({ error: 'Not a room display' });
  if (!room) return res.json({ room: null, events: [], server_now: Date.now(), options: {} });
  try {
    res.json(await svc.panelState(room));
  } catch (e) {
    console.warn(`[rooms] state ${room.id}: ${e && e.message}`);
    res.status(503).json({ error: 'The room is unavailable right now' });
  }
});

/*
 * Per-DEVICE limit, not per IP: a building's panels share one NAT address, and one busy room must
 * not lock out the others. Bounded so a stream of made-up device ids cannot grow it without end.
 */
const hits = new Map();
const LIMIT = 12;
const WINDOW_MS = 60 * 1000;
function limited(deviceId) {
  const now = Date.now();
  const list = (hits.get(deviceId) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) { hits.set(deviceId, list); return true; }
  list.push(now);
  hits.delete(deviceId);
  hits.set(deviceId, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return false;
}

router.options('/:widgetId/action', (req, res) => { cors(res); res.status(204).end(); });

/*
 * Scale-out: an action for a COPIED workspace is forwarded to the primary, which owns its bookings —
 * the same guard routes/workspaces.js carries, for the same reason (this router is not behind
 * resolveTenancy, whose interceptor would otherwise do it). Before the body parser on purpose: an
 * unparsed body is streamed to the primary as it came.
 */
function forwardIfCopy(req, res, next) {
  const w = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(String(req.params.widgetId));
  const ws = w ? db.prepare('SELECT * FROM workspaces WHERE id = ?').get(w.workspace_id) : null;
  if (ws && replicaProxy.shouldIntercept(req, ws)) return replicaProxy.proxyToPrimary(req, res, appConfig);
  next();
}

router.post('/:widgetId/action', forwardIfCopy, express.text({ type: '*/*', limit: '4kb' }), async (req, res) => {
  cors(res);
  let b = {};
  try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { b = {}; }
  const { widget, room } = roomForWidget(req.params.widgetId);
  if (!widget) return res.status(404).json({ error: 'Not a room display' });
  const device = b.device ? db.prepare('SELECT id, workspace_id, device_token, blocked FROM devices WHERE id = ?').get(String(b.device)) : null;
  // One answer for every way this can fail, so the endpoint does not confirm which ids exist.
  if (!device || device.blocked || device.workspace_id !== widget.workspace_id || !svc.verifyPanelToken(widget.id, device, b.panel)) {
    return res.status(403).json({ error: 'This screen is not allowed to change the booking.' });
  }
  if (limited(device.id)) return res.status(429).json({ error: 'Too many requests — wait a moment.' });
  if (!room) return res.status(409).json({ error: 'This room display has no room selected.' });

  const ip = getClientIp(req);
  try {
    let detail;
    if (b.action === 'book') {
      const r = await svc.book(room, device.id, b.minutes);
      detail = `${room.name}: booked ${Math.round((r.end - r.start) / 60000)} min`;
      logActivity(null, 'room:booked', detail, device.id, ip, room.workspace_id);
    } else if (b.action === 'end') {
      await svc.endMeeting(room, device.id, String(b.event_id || ''));
      logActivity(null, 'room:ended', `${room.name}: meeting ended early`, device.id, ip, room.workspace_id);
    } else if (b.action === 'checkin') {
      await svc.checkIn(room, device.id, String(b.event_id || ''));
      logActivity(null, 'room:checked_in', `${room.name}: checked in`, device.id, ip, room.workspace_id);
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
    res.json({ ok: true, state: await svc.panelState(room) });
  } catch (e) {
    const status = e instanceof svc.ActionError ? e.status : e instanceof RoomSourceError ? 502 : 500;
    if (status === 500) console.error(`[rooms] action ${room.id}: ${e && e.message}`);
    let state = null;
    try { state = await svc.panelState(room); } catch { state = null; }
    res.status(status).json({
      error: status === 500 ? 'That did not work.' : (e instanceof RoomSourceError ? 'The calendar refused that. Try again, or book from your calendar.' : e.message),
      code: e.code || null,
      state,
    });
  }
});

function _resetLimits() { hits.clear(); }

module.exports = router;
module.exports._resetLimits = _resetLimits;
