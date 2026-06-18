const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
// #109 PiP: a real-time floating overlay PUSHED to a device/group. Fleet-affecting,
// full-trust (a `web` overlay renders an arbitrary page in the player), so — like the
// group command route — it requires the 'full' token scope. No-op for JWT sessions.
const { requireScope } = require('../middleware/apiToken');

// Reuse the existing 6-hex color contract (#RRGGBB). Overlay transparency is expressed
// via the separate `opacity` field, so no alpha channel is accepted here.
const VALID_COLOR = /^#[0-9A-Fa-f]{6}$/;
const PIP_TYPES = ['image', 'web'];
const PIP_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];

// Numeric bounds (px / seconds). MVP keeps these conservative; sizes are clamped by
// validation, not silently coerced.
const DIM_MIN = 40, DIM_MAX = 3840;          // overlay box px
const DUR_MIN = 0, DUR_MAX = 86400;          // seconds; 0 = until explicitly cleared
const RADIUS_MAX = 512;                       // border-radius px

function intInRange(v, def, lo, hi) {
  if (v === undefined || v === null || v === '') return { ok: true, val: def };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  const r = Math.round(n);
  if (r < lo || r > hi) return { ok: false };
  return { ok: true, val: r };
}

function floatInRange(v, def, lo, hi) {
  if (v === undefined || v === null || v === '') return { ok: true, val: def };
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return { ok: false };
  return { ok: true, val: n };
}

// Resolve a target id to its online/offline device list within the CALLER'S workspace.
// A device first, then a group; null if neither exists in this workspace (the handler
// 404s). Scoping every query by req.workspaceId is the workspace-isolation guarantee:
// a token bound to workspace A can never address a device/group in workspace B.
function resolveTargets(req, id) {
  const wsId = req.workspaceId;
  if (!wsId || !id) return null;
  const device = db.prepare('SELECT id, name, status FROM devices WHERE id = ? AND workspace_id = ?').get(id, wsId);
  if (device) return { kind: 'device', devices: [device] };
  const group = db.prepare('SELECT id, name FROM device_groups WHERE id = ? AND workspace_id = ?').get(id, wsId);
  if (group) {
    const devices = db.prepare(`
      SELECT d.id, d.name, d.status FROM devices d
      JOIN device_group_members dgm ON d.id = dgm.device_id
      WHERE dgm.group_id = ? AND d.workspace_id = ?
    `).all(id, wsId);
    return { kind: 'group', devices };
  }
  return null;
}

// Emit `event` to each online target, mirroring the group command route's room-size
// online check and {device_id, name, status: sent|offline} result shape. Offline
// devices are reported, never queued — PiP is ephemeral (a stale flash on reconnect
// is worse than a miss; see the proposal §6).
function emitToTargets(req, devices, event, payload) {
  const deviceNs = req.app.get('io').of('/device');
  const results = [];
  for (const device of devices) {
    const room = deviceNs.adapter.rooms.get(device.id);
    if (room && room.size > 0) {
      deviceNs.to(device.id).emit(event, payload);
      results.push({ device_id: device.id, name: device.name, status: 'sent' });
    } else {
      results.push({ device_id: device.id, name: device.name, status: 'offline' });
    }
  }
  return results;
}

function summarize(results) {
  const sent = results.filter(r => r.status === 'sent').length;
  const offline = results.filter(r => r.status === 'offline').length;
  return { sent, offline, total: results.length, results };
}

// POST /api/pip — show an overlay on a device or group.
router.post('/', requireScope('full'), (req, res) => {
  const b = req.body || {};

  if (!b.device_id) return res.status(400).json({ error: 'device_id required (device or group id)' });
  if (!PIP_TYPES.includes(b.type)) return res.status(400).json({ error: `invalid type, use one of: ${PIP_TYPES.join(', ')}` });

  // uri must be an absolute http(s) URL — the PLAYER fetches it directly (no server
  // proxy), same trust model as remote_url content.
  let parsed;
  try { parsed = new URL(b.uri); } catch { return res.status(400).json({ error: 'uri must be a valid absolute URL' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'uri scheme must be http or https' });
  }

  const position = b.position == null || b.position === '' ? 'top-right' : b.position;
  if (!PIP_POSITIONS.includes(position)) return res.status(400).json({ error: `invalid position, use one of: ${PIP_POSITIONS.join(', ')}` });

  const width = intInRange(b.width, 480, DIM_MIN, DIM_MAX);
  if (!width.ok) return res.status(400).json({ error: `width must be ${DIM_MIN}-${DIM_MAX}` });
  const height = intInRange(b.height, 360, DIM_MIN, DIM_MAX);
  if (!height.ok) return res.status(400).json({ error: `height must be ${DIM_MIN}-${DIM_MAX}` });
  const duration = intInRange(b.duration, 0, DUR_MIN, DUR_MAX);
  if (!duration.ok) return res.status(400).json({ error: `duration must be ${DUR_MIN}-${DUR_MAX} seconds (0 = until cleared)` });
  const opacity = floatInRange(b.opacity, 1, 0, 1);
  if (!opacity.ok) return res.status(400).json({ error: 'opacity must be between 0 and 1' });
  const borderRadius = intInRange(b.border_radius, 0, 0, RADIUS_MAX);
  if (!borderRadius.ok) return res.status(400).json({ error: `border_radius must be 0-${RADIUS_MAX}` });

  if (b.title_color != null && b.title_color !== '' && !VALID_COLOR.test(b.title_color)) {
    return res.status(400).json({ error: 'invalid title_color, use #RRGGBB' });
  }
  if (b.background_color != null && b.background_color !== '' && !VALID_COLOR.test(b.background_color)) {
    return res.status(400).json({ error: 'invalid background_color, use #RRGGBB' });
  }

  const targets = resolveTargets(req, b.device_id);
  if (!targets) return res.status(404).json({ error: 'device or group not found in this workspace' });

  const pip_id = uuidv4();
  const payload = {
    pip_id,
    type: b.type,
    uri: b.uri,
    position,
    width: width.val,
    height: height.val,
    duration: duration.val,
    opacity: opacity.val,
    border_radius: borderRadius.val,
    close_button: b.close_button === true,
  };
  if (b.title != null && b.title !== '') payload.title = String(b.title).slice(0, 200);
  if (b.title_color) payload.title_color = b.title_color;
  if (b.background_color) payload.background_color = b.background_color;

  const results = emitToTargets(req, targets.devices, 'device:pip-show', payload);
  res.json({ success: true, pip_id, target: targets.kind, ...summarize(results) });
});

// Clear an overlay. DELETE /api/pip and POST /api/pip/clear are equivalent; an omitted
// pip_id clears whatever is showing.
function handleClear(req, res) {
  const b = req.body || {};
  if (!b.device_id) return res.status(400).json({ error: 'device_id required (device or group id)' });
  const targets = resolveTargets(req, b.device_id);
  if (!targets) return res.status(404).json({ error: 'device or group not found in this workspace' });
  const payload = b.pip_id ? { pip_id: String(b.pip_id) } : {};
  const results = emitToTargets(req, targets.devices, 'device:pip-clear', payload);
  res.json({ success: true, target: targets.kind, ...summarize(results) });
}

router.post('/clear', requireScope('full'), handleClear);
router.delete('/', requireScope('full'), handleClear);

module.exports = router;
