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
  res.json(view({ ...device, led_config: JSON.stringify(toStore) }));
});

module.exports = router;
