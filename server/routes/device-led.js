'use strict';

/*
 * LED settings of an addressable-LED screen (lib/embedded-led-config.js): brightness, colour order,
 * matrix wiring, power limit and brownout protection. The device page reads and changes them here;
 * the firmware picks them up from X-ST-Led-Config on its next poll (routes/embedded.js /render).
 *
 *   GET /api/device-led/:deviceId   { supported, config, defaults, options, state, state_at }
 *   PUT /api/device-led/:deviceId   a partial config; { reset_learned: true } makes the firmware
 *                                   forget the power limit it lowered itself after brownouts.
 *
 * Reading needs access to the device's workspace, changing needs a role above workspace_viewer
 * (same rule as routes/device-wifi.js).
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const led = require('../lib/embedded-led-config');
const { SIZE_LIMITS, parseProfile } = require('../lib/embedded-profiles');

/* The stored screen profile as an object ({ preset } for a bare preset name). */
function profileObj(device) {
  const raw = device.screen_profile;
  if (raw && typeof raw === 'object') return { ...raw };
  if (typeof raw === 'string' && raw.trim().startsWith('{')) { try { return JSON.parse(raw); } catch (_) { return {}; } }
  return raw ? { preset: String(raw) } : {};
}

/* The matrix size: the profile's, else what pairing recorded. */
function matrixSize(device) {
  const p = profileObj(device);
  const w = parseInt(p.width, 10) || parseInt(device.screen_width, 10) || 0;
  const h = parseInt(p.height, 10) || parseInt(device.screen_height, 10) || 0;
  return { width: w, height: h };
}

function deviceForRead(req, res) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  device._ctx = ctx;
  return device;
}

function deviceForWrite(req, res) {
  const device = deviceForRead(req, res);
  if (!device) return null;
  if (!device._ctx.actingAs && device._ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return device;
}

function view(device) {
  const config = led.read(device);
  const state = led.readState(device);
  // Layout fields nobody set here show what the wall reports it is using (they are not sent to it).
  const explicit = led.explicitLayout(device);
  for (const k of led.LAYOUT_FIELDS) if (!explicit.includes(k) && state && state[k]) config[k] = state[k];
  return {
    supported: led.isLedDevice(device, null),
    config,
    layout_set: explicit,
    // The matrix size is the screen profile's (what every frame is rendered at), edited here too.
    size: matrixSize(device),
    size_limits: { max_side: SIZE_LIMITS.LED_MAX_SIDE, max_pixels: SIZE_LIMITS.LED_MAX_PIXELS },
    defaults: led.DEFAULTS,
    options: {
      color_order: led.COLOR_ORDERS, wiring: led.WIRINGS, axis: led.AXES, origin: led.ORIGINS,
      power_limit_max_ma: led.POWER_LIMIT_MAX_MA,
    },
    state,
    state_at: device.led_state_at || null,
  };
}

router.get('/:deviceId', (req, res) => {
  const device = deviceForRead(req, res);
  if (!device) return;
  res.json(view(device));
});

router.put('/:deviceId', (req, res) => {
  const device = deviceForWrite(req, res);
  if (!device) return;
  if (!led.isLedDevice(device, null)) return res.status(400).json({ error: 'LED settings apply to addressable-LED screens only' });
  const body = { ...(req.body || {}) };
  // Matrix size (width x height LEDs): stored in the screen profile, which every frame is rendered
  // at; the firmware takes the new size from X-ST-Led-Config on its next poll.
  let profileUpdate = null;
  if (body.width !== undefined || body.height !== undefined) {
    const cur = matrixSize(device);
    const w = body.width !== undefined ? Number(body.width) : cur.width;
    const h = body.height !== undefined ? Number(body.height) : cur.height;
    const okSide = (n) => Number.isInteger(n) && n >= 1 && n <= SIZE_LIMITS.LED_MAX_SIDE;
    if (!okSide(w)) return res.status(400).json({ error: 'invalid width', field: 'width' });
    if (!okSide(h)) return res.status(400).json({ error: 'invalid height', field: 'height' });
    if (w * h > SIZE_LIMITS.LED_MAX_PIXELS) return res.status(400).json({ error: `at most ${SIZE_LIMITS.LED_MAX_PIXELS} LEDs`, field: 'width' });
    const next = { ...profileObj(device), width: w, height: h };
    if (!next.preset) next.preset = 'seeed-xiao-led';
    if (!parseProfile(next)) return res.status(400).json({ error: 'invalid size for this screen', field: 'width' });
    profileUpdate = { json: JSON.stringify(next), w, h };
  }
  delete body.width;
  delete body.height;
  const current = led.read(device);
  // Only layout fields that were already set here, or that this request sets, are stored, so
  // saving brightness from the device page does not start overriding the wall's own wiring.
  const keepLayout = new Set([...led.explicitLayout(device), ...led.LAYOUT_FIELDS.filter((k) => body[k] !== undefined)]);
  if (body.reset_learned === true) body.learned_reset = (current.learned_reset + 1) & 0xffff;
  delete body.reset_learned;
  const r = led.normalise(body, current);
  if (r.error) return res.status(400).json({ error: r.error, field: r.field });
  const toStore = { ...r.value };
  for (const k of led.LAYOUT_FIELDS) if (!keepLayout.has(k)) delete toStore[k];
  db.prepare('UPDATE devices SET led_config = ? WHERE id = ?').run(JSON.stringify(toStore), device.id);
  let updated = { ...device, led_config: JSON.stringify(toStore) };
  if (profileUpdate) {
    db.prepare('UPDATE devices SET screen_profile = ?, screen_width = ?, screen_height = ? WHERE id = ?')
      .run(profileUpdate.json, profileUpdate.w, profileUpdate.h, device.id);
    updated = { ...updated, screen_profile: profileUpdate.json, screen_width: profileUpdate.w, screen_height: profileUpdate.h };
  }
  res.json(view(updated));
});

module.exports = router;
