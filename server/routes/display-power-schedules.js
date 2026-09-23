'use strict';

/*
 * Display power schedules — the weekly BACKLIGHT clock. Nothing in this file powers a device off.
 *
 * ⚠️ DEFINITION SURFACE ONLY. Like routes/triggers.js, nothing here is on the decision path: the
 * panel evaluates its own windows, from its own copy, with the WAN down. A screen must sleep and
 * wake on time during an outage, so a server that decided "off now" and pushed it would strand a
 * dark panel the first time the network blinked — which is the failure this feature must never
 * produce, because a dark screen is indistinguishable from dead hardware.
 *
 * Scoping is by req.workspaceId on every query, the same guarantee as triggers.js and pip.js.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');
const PowerWindow = require('../lib/power-window');
const { powerScheduleForDevice, devicesAffectedBySchedule } = require('../lib/device-power-schedule');

/*
 * Changing when a screen is lit is a fleet-affecting write, so it carries the same pairing
 * triggers.js uses: requireScope('full') gates API tokens (pass-through for JWT sessions), and
 * this adds the role check that scope alone does not give a dashboard session.
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

const MAX_WINDOWS = 28;   // four per day is already more than anyone schedules; a cap bounds the payload

/** Is this a timezone this runtime can actually evaluate in? */
function validTimezone(tz) {
  if (tz === null || tz === undefined || tz === '') return true;    // inherit the device's
  if (typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

/*
 * Validate the whole document BEFORE it is stored.
 *
 * ⚠️ The evaluator is forgiving on purpose — a malformed window is inert there so one bad row can
 * never darken a screen. That forgiveness must NOT be the only check, or an operator types "2500"
 * and the dashboard cheerfully saves a schedule that silently does nothing for ever. Strict here,
 * lenient at the edge: the same split validateCommand() applies to set_server_url.
 */
function validate(b, { partial = false } = {}) {
  if (!partial || b.windows !== undefined) {
    if (!Array.isArray(b.windows)) return 'windows must be an array';
    if (b.windows.length > MAX_WINDOWS) return `windows: at most ${MAX_WINDOWS}`;
    for (const w of b.windows) {
      if (!w || typeof w !== 'object') return 'each window must be an object';
      if (!Array.isArray(w.days) || w.days.length === 0) return 'each window needs at least one day';
      for (const d of w.days) {
        if (!Number.isInteger(d) || d < 0 || d > 6) return 'days must be integers 0-6 (0=Sunday)';
      }
      const start = PowerWindow._hm(w.start);
      const end = PowerWindow._hm(w.end);
      if (start === null) return `invalid start time: ${JSON.stringify(w.start)} (expected HH:MM)`;
      if (end === null) return `invalid end time: ${JSON.stringify(w.end)} (expected HH:MM or 24:00)`;
      if (start === end) return 'a window that starts and ends at the same minute is never active';
      if (start === 1440) return 'start cannot be 24:00';
    }
  }
  if (!partial || b.timezone !== undefined) {
    if (!validTimezone(b.timezone)) return `unknown timezone: ${JSON.stringify(b.timezone)}`;
  }
  if (!partial || b.name !== undefined) {
    if (b.name !== undefined && b.name !== null && typeof b.name !== 'string') return 'name must be a string';
    if (typeof b.name === 'string' && b.name.length > 120) return 'name is too long';
  }
  return null;
}

/** The target must exist IN THIS WORKSPACE — the check that makes cross-tenant addressing fail. */
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

function shape(row) {
  if (!row) return null;
  let windows = [];
  try { windows = JSON.parse(row.windows || '[]'); } catch (_) { windows = []; }
  return {
    id: row.id,
    name: row.name || '',
    device_id: row.device_id || null,
    group_id: row.group_id || null,
    timezone: row.timezone || null,
    enabled: !!row.enabled,
    windows,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/*
 * Push a change to every screen it could affect.
 *
 * TWO deliveries, and they are not redundant:
 *   - the playlist payload carries power_schedule, so a panel is correct after any reconnect,
 *     reboot or re-pair WITHOUT a command having survived; and
 *   - set_power_schedule is the prompt edit, capability-gated per panel and last-of-type in the
 *     offline queue, so an operator sees the change take effect now rather than at the next poll.
 * A panel that lacks display.power_schedule is refused the command by deliverCommand and simply
 * ignores the payload field — no error, no dark screen.
 *
 * `before` reaches the screens LOSING a schedule (a delete, or a retarget), which otherwise keep
 * evaluating windows nobody can see in the dashboard.
 */
function pushSchedule(req, scheduleId, before) {
  try {
    const io = req.app && req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const { deliverCommand } = require('../lib/device-command');
    const ns = io.of('/device');

    const ids = new Set(before || []);
    for (const id of devicesAffectedBySchedule(db, scheduleId)) ids.add(id);

    for (const id of ids) {
      commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
      const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      if (!device) continue;
      // Resolved per device, NOT taken from the row being saved: a group member with its own
      // schedule must keep its own, and sending the group's here would overwrite it.
      const effective = powerScheduleForDevice(db, id);
      deliverCommand(ns, device, 'set_power_schedule', { schedule: effective });
    }
    if (ids.size) console.log(`[power-schedule] pushed ${scheduleId} to ${ids.size} device(s)`);
  } catch (e) {
    console.warn(`[power-schedule] push failed: ${e && e.message}`);
  }
}

/* ------------------------------------------------------------------ read */

router.get('/', requireScope('read'), (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM display_power_schedules WHERE workspace_id = ? ORDER BY created_at DESC'
  ).all(req.workspaceId);
  res.json({ schedules: rows.map(shape) });
});

/**
 * What a given SCREEN actually obeys, after the device-beats-group rule, plus the advisory next
 * edge. This is what the dashboard renders on a group editor to warn "3 screens override this",
 * and on a device to say when it next sleeps.
 */
router.get('/effective/:deviceId', requireScope('read'), (req, res) => {
  const device = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?')
    .get(req.params.deviceId, req.workspaceId);
  if (!device) return res.status(404).json({ error: 'device not found' });

  const schedule = powerScheduleForDevice(db, req.params.deviceId);
  res.json({
    schedule,
    state: schedule ? PowerWindow.stateOf(schedule, new Date()) : 'on',
    next_edge: schedule ? PowerWindow.nextEdge(schedule, new Date()) : null,
  });
});

router.get('/:id', requireScope('read'), (req, res) => {
  const row = db.prepare('SELECT * FROM display_power_schedules WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ schedule: shape(row) });
});

/* ----------------------------------------------------------------- write */

router.post('/', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  const bad = validate(b);
  if (bad) return res.status(400).json({ error: bad });
  const target = resolveTarget(req, b);
  if (target.error) return res.status(400).json({ error: target.error });

  const existing = db.prepare(
    `SELECT id FROM display_power_schedules
      WHERE workspace_id = ? AND ((device_id IS NOT NULL AND device_id = ?) OR (group_id IS NOT NULL AND group_id = ?))`
  ).get(req.workspaceId, target.deviceId, target.groupId);
  if (existing) {
    // One schedule per target, enforced by a partial unique index as well. Answering with the id
    // lets the dashboard edit the existing one rather than making the operator hunt for it.
    return res.status(409).json({ error: 'this target already has a power schedule', id: existing.id });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO display_power_schedules (id, workspace_id, name, device_id, group_id, timezone, enabled, windows)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.workspaceId, (b.name || '').trim(), target.deviceId, target.groupId,
    b.timezone || null, b.enabled === false ? 0 : 1, JSON.stringify(b.windows)
  );

  pushSchedule(req, id);
  const row = db.prepare('SELECT * FROM display_power_schedules WHERE id = ?').get(id);
  res.status(201).json({ schedule: shape(row) });
});

router.put('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM display_power_schedules WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const bad = validate(b, { partial: true });
  if (bad) return res.status(400).json({ error: bad });

  // Who was following this BEFORE the edit — a retarget has to reach the screens it leaves behind.
  const before = devicesAffectedBySchedule(db, row.id);

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

  db.prepare(
    `UPDATE display_power_schedules
        SET name = ?, device_id = ?, group_id = ?, timezone = ?, enabled = ?, windows = ?,
            updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE id = ? AND workspace_id = ?`
  ).run(
    b.name !== undefined ? String(b.name || '').trim() : row.name,
    deviceId, groupId,
    b.timezone !== undefined ? (b.timezone || null) : row.timezone,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : row.enabled,
    b.windows !== undefined ? JSON.stringify(b.windows) : row.windows,
    row.id, req.workspaceId
  );

  pushSchedule(req, row.id, before);
  const out = db.prepare('SELECT * FROM display_power_schedules WHERE id = ?').get(row.id);
  res.json({ schedule: shape(out) });
});

router.delete('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM display_power_schedules WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'not found' });

  /*
   * ⚠️ Collect the audience BEFORE the delete, then push AFTER it. The push re-resolves each
   * screen's effective schedule, which is now the group's — or null — and null is what clears a
   * panel. Deleting without pushing leaves every screen evaluating windows that no longer exist
   * anywhere, and the only symptom is a screen going dark on a schedule nobody can find.
   */
  const affected = devicesAffectedBySchedule(db, row.id);
  db.prepare('DELETE FROM display_power_schedules WHERE id = ? AND workspace_id = ?').run(row.id, req.workspaceId);
  pushSchedule(req, row.id, affected);
  res.json({ ok: true });
});

module.exports = router;
