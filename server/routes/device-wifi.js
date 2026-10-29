'use strict';

/*
 * Wi-Fi networks of a screen (#720, lib/device-wifi.js). The device page lists them, adds, changes
 * and removes them; every change is pushed to the screen at once when it is connected here, and
 * again on its next connect.
 *
 * JWT-only (config/api-surface.js): these are credentials into a customer's network, so signed-in
 * people only — an API token gets a 401 at the door, which also keeps the MCP tools (loopback calls
 * with the caller's token) away from them. Not in docs/openapi.yaml for the same reason.
 *
 * Access is the settings PIN's (routes/devices.js checkDeviceOwnership, POST /:id/settings-pin):
 * reading needs access to the device's workspace, changing needs a role above workspace_viewer.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const wifi = require('../lib/device-wifi');

/** The device if this person may see it, else null after answering. Same rule as GET /devices/:id. */
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

/** The device if this person may change it. Same rule as checkDeviceOwnership (the settings PIN). */
function deviceForWrite(req, res) {
  const device = deviceForRead(req, res);
  if (!device) return null;
  // ctx.actingAs covers platform_admin and org_owner/admin paths (always writable).
  if (!device._ctx.actingAs && device._ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return device;
}

function networkOf(device, id) {
  return db.prepare('SELECT * FROM device_wifi_networks WHERE id = ? AND device_id = ?').get(String(id || ''), device.id);
}

function state(req, device) {
  const io = req.app.get('io');
  return {
    // net.wifi: the player can manage networks at all. mode: how (owner / direct / suggestions / unsupported).
    supported: require('../lib/player-capabilities').supports(device, 'net.wifi'),
    mode: device.wifi_mode || null,
    connection: wifi.connectionState(io, device.id),
    networks: wifi.listForDevice(device.id).map(wifi.present),
  };
}

/** Push after a change and say what happened ('delivered' | 'offline' | 'insecure' | …). */
function deliver(req, device) {
  try { return wifi.push(req.app.get('io'), device.id); } catch (e) {
    console.warn(`[wifi] push to ${device.id} failed: ${e.message}`);
    return 'error';
  }
}

function sendError(res, e) {
  if (e instanceof wifi.InputError) return res.status(e.status).json({ error: e.message });
  console.error('[wifi]', e.message);
  return res.status(500).json({ error: 'Could not save the network.' });
}

router.get('/:deviceId', (req, res) => {
  const device = deviceForRead(req, res);
  if (!device) return;
  res.json(state(req, device));
});

router.post('/:deviceId/networks', (req, res) => {
  const device = deviceForWrite(req, res);
  if (!device) return;
  let row;
  try { row = wifi.create(device, req.body); } catch (e) { return sendError(res, e); }
  wifi.audit(req, 'wifi_network_added', device, row.ssid);
  const delivery = deliver(req, device);
  res.status(201).json({ network: wifi.present(wifi.listForDevice(device.id).find((r) => r.id === row.id) || row), delivery });
});

router.put('/:deviceId/networks/:id', (req, res) => {
  const device = deviceForWrite(req, res);
  if (!device) return;
  const existing = networkOf(device, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Network not found' });
  let row;
  try { row = wifi.update(existing, req.body); } catch (e) { return sendError(res, e); }
  wifi.audit(req, 'wifi_network_changed', device, row.ssid);
  const delivery = deliver(req, device);
  res.json({ network: wifi.present(networkOf(device, row.id) || row), delivery });
});

router.delete('/:deviceId/networks/:id', (req, res) => {
  const device = deviceForWrite(req, res);
  if (!device) return;
  const existing = networkOf(device, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Network not found' });
  wifi.remove(existing);
  wifi.audit(req, 'wifi_network_removed', device, existing.ssid);
  const delivery = deliver(req, device);
  res.json({ success: true, delivery });
});

module.exports = router;
