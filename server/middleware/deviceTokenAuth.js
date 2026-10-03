'use strict';

/*
 * HTTP middleware that authenticates an embedded device by its device_token credential.
 *
 * Devices (ESP32, Raspberry Pi, etc.) authenticate with the same device_id + device_token
 * pair they use for the WebSocket connection. The MCU stores these in flash at pairing time
 * and sends them on every HTTP request to the embedded renderer endpoint.
 *
 * Wire format:
 *   Authorization: Bearer <device_token>   (the plaintext token the device got at pairing)
 *   ?device_id=<id>                         (the device's UUID, also stored in flash)
 *
 * Security model:
 *   - device_token is stored PLAINTEXT in devices.device_token (same as the WebSocket path).
 *   - Comparison uses crypto.timingSafeEqual to prevent timing attacks.
 *   - No new credential type is introduced — the device already has these two values.
 *   - See ws/deviceSocket.js validateDeviceToken for the identical pattern on WebSocket.
 *
 * After successful auth, sets:
 *   req.device      — full device row (do NOT return without calling stripDeviceSecrets first)
 *   req.workspaceId — device's workspace_id (consumed by downstream handlers)
 */

const crypto = require('crypto');
const { db } = require('../db/database');

function deviceTokenAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) {
    return res.status(401).json({ error: 'Authorization: Bearer <device_token> required' });
  }

  const deviceId = req.query.device_id;
  if (!deviceId) {
    return res.status(400).json({ error: 'device_id query parameter required' });
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    return res.status(401).json({ error: 'Device not found' });
  }
  if (!device.device_token) {
    return res.status(401).json({ error: 'Device not paired (no token)' });
  }
  if (device.blocked) {
    return res.status(403).json({ error: 'Device is blocked' });
  }

  // Timing-safe comparison — device_token is plaintext, same as ws/deviceSocket.js.
  let valid = false;
  try {
    valid = raw.length === device.device_token.length &&
      crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(device.device_token));
  } catch {
    valid = false;
  }

  if (!valid) {
    return res.status(401).json({ error: 'Invalid device token' });
  }

  req.device = device;
  req.workspaceId = device.workspace_id;
  next();
}

module.exports = { deviceTokenAuth };
