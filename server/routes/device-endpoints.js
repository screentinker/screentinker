'use strict';

/*
 * Saved device endpoints — REST calls a PANEL makes on its own network, on its own clock.
 *
 * ⚠️ DEFINITION SURFACE ONLY. Nothing here performs a request, and that is the feature rather than
 * a limitation: the panel stands on the private side of the customer's firewall, next to the PLC
 * and the sensor, and this server has no route to any of it. The rows are synced to the device and
 * the device runs them — including with the WAN down. Same principle as routes/triggers.js.
 *
 * Scoping is by req.workspaceId on every query, the same guarantee as triggers.js and pip.js.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { accessContext, denyReadOnly } = require('../lib/tenancy');
const endpoints = require('../lib/device-endpoints');

/*
 * A saved endpoint makes a screen issue requests inside the customer's LAN, on a timer, for ever.
 * That is a fleet-affecting capability rather than content editing, so it carries the same pairing
 * triggers.js and display-power-schedules.js use.
 */
function requireFleetWrite(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  next();
}

/** The target must exist IN THIS WORKSPACE — what makes cross-tenant addressing fail. */
function resolveTarget(req, b) {
  const deviceId = b.device_id || null;
  const groupId = b.group_id || null;
  if (!!deviceId === !!groupId) return { error: 'exactly one of device_id or group_id is required' };
  if (deviceId) {
    const d = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(deviceId, req.workspaceId);
    if (!d) return { error: 'device not found' };
  } else {
    const g = db.prepare('SELECT id FROM device_groups WHERE id = ? AND workspace_id = ?').get(groupId, req.workspaceId);
    if (!g) return { error: 'group not found' };
  }
  return { deviceId, groupId };
}

/** ⚠️ Header VALUES are never returned. Names are, so an operator can see what is configured. */
function shape(row) {
  return {
    id: row.id,
    name: row.name,
    device_id: row.device_id || null,
    group_id: row.group_id || null,
    method: (row.method || 'GET').toUpperCase(),
    url: row.url,
    headers: endpoints.redactHeaders(endpoints.parseHeaders(row.headers)),
    body: row.body || null,
    timeout_ms: row.timeout_ms || null,
    interval_sec: row.interval_sec || null,
    run_on: row.run_on || null,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Re-sync every screen whose list may have changed. */
function pushEndpoints(req, endpointId, before) {
  try {
    const io = req.app && req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const ns = io.of('/device');
    const ids = new Set(before || []);
    for (const id of endpoints.devicesForEndpoint(endpointId)) ids.add(id);
    // The endpoint list rides the device payload, so one push carries it — no separate command.
    for (const id of ids) commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
    if (ids.size) console.log(`[endpoints] pushed ${endpointId} to ${ids.size} device(s)`);
  } catch (e) {
    console.warn(`[endpoints] push failed: ${e && e.message}`);
  }
}

/* ------------------------------------------------------------------ read */

router.get('/', requireScope('read'), (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM device_endpoints WHERE workspace_id = ? ORDER BY name COLLATE NOCASE'
  ).all(req.workspaceId);
  res.json({ endpoints: rows.map(shape) });
});

/** What a given SCREEN will actually run, after the group + own union. */
router.get('/effective/:deviceId', requireScope('read'), (req, res) => {
  const device = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?')
    .get(req.params.deviceId, req.workspaceId);
  if (!device) return res.status(404).json({ error: 'device not found' });
  // ⚠️ Redacted here too. This is a read surface, and the plaintext headers exist for the PANEL.
  const list = endpoints.endpointsForDevice(req.params.deviceId).map((e) => ({
    ...e, headers: endpoints.redactHeaders(e.headers),
  }));
  res.json({ endpoints: list });
});

router.get('/:id', requireScope('read'), (req, res) => {
  const row = db.prepare('SELECT * FROM device_endpoints WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ endpoint: shape(row) });
});

/* ----------------------------------------------------------------- write */

router.post('/', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  const bad = endpoints.validate(b);
  if (bad) return res.status(400).json({ error: bad });
  const target = resolveTarget(req, b);
  if (target.error) return res.status(400).json({ error: target.error });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO device_endpoints
       (id, workspace_id, name, device_id, group_id, method, url, headers, body, timeout_ms, interval_sec, run_on, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.workspaceId, String(b.name).trim(), target.deviceId, target.groupId,
    String(b.method || 'GET').toUpperCase(), String(b.url).trim(),
    JSON.stringify(endpoints.encryptHeaders(b.headers || {})),
    b.body == null ? null : String(b.body),
    b.timeout_ms || null, b.interval_sec || null, b.run_on || null,
    b.enabled === false ? 0 : 1
  );

  pushEndpoints(req, id);
  res.status(201).json({ endpoint: shape(db.prepare('SELECT * FROM device_endpoints WHERE id = ?').get(id)) });
});

router.put('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM device_endpoints WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const bad = endpoints.validate({ ...b, interval_sec: b.interval_sec ?? row.interval_sec, run_on: b.run_on ?? row.run_on }, { partial: true });
  if (bad) return res.status(400).json({ error: bad });

  const before = endpoints.devicesForEndpoint(row.id);

  let deviceId = row.device_id;
  let groupId = row.group_id;
  if (b.device_id !== undefined || b.group_id !== undefined) {
    const target = resolveTarget(req, {
      device_id: b.device_id !== undefined ? b.device_id : row.device_id,
      group_id: b.group_id !== undefined ? b.group_id : row.group_id,
    });
    if (target.error) return res.status(400).json({ error: target.error });
    deviceId = target.deviceId;
    groupId = target.groupId;
  }

  /*
   * ⚠️ A blank header value KEEPS the stored one. GET never returns a header value, so a form that
   * round-trips this object sends back empty strings — saving those verbatim would erase the API
   * key every time anyone edited the URL. That is the classic "the form saved what it could see".
   */
  const storedPlain = endpoints.decryptHeaders(endpoints.parseHeaders(row.headers));
  const nextHeaders = b.headers !== undefined
    ? endpoints.encryptHeaders(endpoints.mergeHeaders(b.headers, storedPlain))
    : endpoints.parseHeaders(row.headers);

  db.prepare(
    `UPDATE device_endpoints
        SET name = ?, device_id = ?, group_id = ?, method = ?, url = ?, headers = ?, body = ?,
            timeout_ms = ?, interval_sec = ?, run_on = ?, enabled = ?,
            updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE id = ? AND workspace_id = ?`
  ).run(
    b.name !== undefined ? String(b.name).trim() : row.name,
    deviceId, groupId,
    b.method !== undefined ? String(b.method).toUpperCase() : row.method,
    b.url !== undefined ? String(b.url).trim() : row.url,
    JSON.stringify(nextHeaders),
    b.body !== undefined ? (b.body == null ? null : String(b.body)) : row.body,
    b.timeout_ms !== undefined ? (b.timeout_ms || null) : row.timeout_ms,
    b.interval_sec !== undefined ? (b.interval_sec || null) : row.interval_sec,
    b.run_on !== undefined ? (b.run_on || null) : row.run_on,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : row.enabled,
    row.id, req.workspaceId
  );

  pushEndpoints(req, row.id, before);
  res.json({ endpoint: shape(db.prepare('SELECT * FROM device_endpoints WHERE id = ?').get(row.id)) });
});

router.delete('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM device_endpoints WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });
  // Audience collected BEFORE the delete; the push re-resolves each device's list afterwards.
  const affected = endpoints.devicesForEndpoint(row.id);
  db.prepare('DELETE FROM device_endpoints WHERE id = ? AND workspace_id = ?').run(row.id, req.workspaceId);
  pushEndpoints(req, row.id, affected);
  res.json({ ok: true });
});

/**
 * Run one endpoint now, on one screen.
 *
 * ⚠️ Goes through deliverCommand like any other http_request — same capability gate, same target
 * guard, same minted id — rather than a private path. An operator testing an endpoint must be
 * exercising the code that will run it on a timer, or the test proves nothing.
 */
router.post('/:id/run', requireScope('full'), requireFleetWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM device_endpoints WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });

  const deviceId = req.body && req.body.device_id ? req.body.device_id : row.device_id;
  if (!deviceId) return res.status(400).json({ error: 'device_id is required to run a group endpoint' });
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id = ?').get(deviceId, req.workspaceId);
  if (!device) return res.status(404).json({ error: 'device not found' });

  const io = req.app.get('io');
  if (!io) return res.status(503).json({ error: 'The realtime layer is not available.' });

  const { deliverCommand } = require('../lib/device-command');
  const e = endpoints.toPlayerShape(row);
  const r = deliverCommand(io.of('/device'), device, 'http_request', {
    url: e.url, method: e.method, headers: e.headers, body: e.body, timeout_ms: e.timeout_ms,
    endpoint_id: e.id,
  });
  if (r.status === 'unsupported') {
    return res.status(400).json({ error: 'That screen cannot make requests', capability: r.capability });
  }
  res.json({ success: true, status: r.status, device_id: device.id, id: r.id });
});

module.exports = router;
