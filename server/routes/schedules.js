const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
// Phase 2.2m: workspace-aware schedule access. Schedules inherit workspace_id
// from their target (device or device_group). All polymorphic references
// (content / widget / layout / playlist) must live in the same workspace as
// the target. This closes a long-standing leak where POST accepted those
// payload refs with no ownership check at all (only the target was checked).
const { accessContext } = require('../lib/tenancy');

// Helper: build the expanded schedule query for a device (device-level + group-level)
function getDeviceSchedulesQuery() {
  return `
    SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name,
           dg.name as group_name, dg.color as group_color
    FROM schedules s
    LEFT JOIN content c ON s.content_id = c.id
    LEFT JOIN widgets w ON s.widget_id = w.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    LEFT JOIN device_groups dg ON s.group_id = dg.id
    WHERE s.enabled = 1
      AND (
        s.device_id = ?
        OR s.group_id IN (
          SELECT group_id FROM device_group_members WHERE device_id = ?
        )
      )
    ORDER BY
      CASE WHEN s.device_id IS NOT NULL THEN 1 ELSE 0 END DESC,
      s.priority DESC,
      s.created_at ASC
  `;
}

// Load a schedule + access context, sending 403/404 on failure.
function loadScheduleAccess(req, res, requireWrite) {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) { res.status(404).json({ error: 'Schedule not found' }); return null; }
  if (!schedule.workspace_id) { res.status(403).json({ error: 'Schedule not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(schedule.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  req.schedule = schedule;
  req.scheduleCtx = ctx;
  return schedule;
}

function requireScheduleWrite(req, res, next) {
  if (!loadScheduleAccess(req, res, true)) return;
  next();
}

// Verify caller has at least read access to the given workspace (used when
// resolving the target's workspace before stamping a new schedule).
function workspaceAccess(req, workspaceId) {
  if (!workspaceId) return null;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return null;
  return accessContext(req.user.id, req.user.role, ws);
}

// Verify a referenced row exists and lives in the given workspace. Returns
// null on success, or { status, error } on failure. Used for content / widget
// / layout / playlist refs (where workspace_id IS NULL is the platform-template
// path and is always allowed) and for devices / device_groups (where
// workspace_id is required - those tables never carry template rows).
function checkRefInWorkspace(table, id, workspaceId, opts = { allowNullWorkspace: false }) {
  const row = db.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(id);
  if (!row) return { status: 404, error: `${table.replace(/_/g, ' ').slice(0, -1)} not found` };
  if (row.workspace_id === workspaceId) return null;
  if (opts.allowNullWorkspace && row.workspace_id == null) return null;
  return { status: 403, error: `${table.replace(/_/g, ' ').slice(0, -1)} is not in this workspace` };
}

// List schedules (filterable). Phase 2.2m: workspace-scoped.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const { device_id, group_id, start, end } = req.query;
  let sql = `SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name,
             dg.name as group_name, dg.color as group_color
             FROM schedules s
             LEFT JOIN content c ON s.content_id = c.id
             LEFT JOIN widgets w ON s.widget_id = w.id
             LEFT JOIN playlists p ON s.playlist_id = p.id
             LEFT JOIN device_groups dg ON s.group_id = dg.id
             WHERE s.workspace_id = ?`;
  const params = [req.workspaceId];

  if (device_id) {
    sql += ` AND (s.device_id = ? OR s.group_id IN (SELECT group_id FROM device_group_members WHERE device_id = ?))`;
    params.push(device_id, device_id);
  }
  if (group_id) { sql += ' AND s.group_id = ?'; params.push(group_id); }
  if (start) { sql += ' AND s.end_time >= ?'; params.push(start); }
  if (end) { sql += ' AND s.start_time <= ?'; params.push(end); }

  sql += ' ORDER BY s.start_time ASC';
  res.json(db.prepare(sql).all(...params));
});

// Get schedules for a device. Phase 2.2m: device access via workspace_id.
router.get('/device/:deviceId', (req, res) => {
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
  const ctx = workspaceAccess(req, device.workspace_id);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });

  const schedules = db.prepare(getDeviceSchedulesQuery()).all(req.params.deviceId, req.params.deviceId);
  res.json(schedules);
});

// Expanded week view (resolves recurrences). Phase 2.2m: device access via workspace.
router.get('/week', (req, res) => {
  const { date, device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
  const ctx = workspaceAccess(req, device.workspace_id);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });

  const weekStart = date ? new Date(date) : new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const schedules = db.prepare(getDeviceSchedulesQuery()).all(device_id, device_id);
  const events = [];
  for (const s of schedules) {
    const expanded = expandSchedule(s, weekStart, weekEnd);
    events.push(...expanded);
  }
  res.json(events);
});

// Create schedule. Phase 2.2m: schedule.workspace_id is inherited from the
// target (device or group). Single workspace lookup also enforces caller's
// write access. Closes 4 pre-existing leaks: content / widget / layout /
// playlist were accepted with NO ownership check at all.
router.post('/', (req, res) => {
  const { device_id, group_id, zone_id, content_id, widget_id, layout_id, playlist_id, title, start_time, end_time,
    timezone, recurrence, recurrence_end, priority, color } = req.body;

  if (!start_time || !end_time) {
    return res.status(400).json({ error: 'start_time and end_time required' });
  }
  if (device_id && group_id) {
    return res.status(400).json({ error: 'Cannot set both device_id and group_id. A schedule applies to one device OR one group.' });
  }
  if (!device_id && !group_id) {
    return res.status(400).json({ error: 'Either device_id or group_id is required' });
  }

  // Resolve target's workspace_id and verify caller has write access there.
  let targetWorkspaceId = null;
  if (device_id) {
    const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(device_id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
    targetWorkspaceId = device.workspace_id;
  }
  if (group_id) {
    const group = db.prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.workspace_id) return res.status(403).json({ error: 'Group not assigned to a workspace' });
    targetWorkspaceId = group.workspace_id;
  }
  const ctx = workspaceAccess(req, targetWorkspaceId);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  // Payload refs must live in the same workspace. Platform templates
  // (workspace_id IS NULL) on content / widget / layout / playlist are allowed.
  const refChecks = [
    ['content', content_id, true],
    ['widgets', widget_id, true],
    ['layouts', layout_id, true],
    ['playlists', playlist_id, true],
  ];
  for (const [table, id, allowNull] of refChecks) {
    if (!id) continue;
    const err = checkRefInWorkspace(table, id, targetWorkspaceId, { allowNullWorkspace: allowNull });
    if (err) return res.status(err.status).json({ error: err.error });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO schedules (id, user_id, workspace_id, device_id, group_id, zone_id, content_id, widget_id, layout_id, playlist_id, title,
      start_time, end_time, timezone, recurrence, recurrence_end, priority, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, targetWorkspaceId, device_id || null, group_id || null, zone_id || null, content_id || null, widget_id || null,
    layout_id || null, playlist_id || null, title || '', start_time, end_time, timezone || 'UTC',
    recurrence || null, recurrence_end || null, priority || 0, color || '#e65c00');

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  res.status(201).json(schedule);
});

// Update schedule. Phase 2.2m: every polymorphic target that is changing must
// live in the schedule's workspace. Closes the pre-existing leak where
// verifyOwnership keyed only on user_id (workspace-blind).
router.put('/:id', requireScheduleWrite, (req, res) => {
  const schedule = req.schedule;

  const newDeviceId = req.body.device_id !== undefined ? req.body.device_id : schedule.device_id;
  const newGroupId = req.body.group_id !== undefined ? req.body.group_id : schedule.group_id;
  if (newDeviceId && newGroupId) {
    return res.status(400).json({ error: 'Cannot set both device_id and group_id' });
  }
  if (!newDeviceId && !newGroupId) {
    return res.status(400).json({ error: 'Either device_id or group_id is required' });
  }

  // For each field changing to a non-null value, verify the referenced row
  // lives in the schedule's workspace. Devices and groups must match exactly
  // (no NULL workspace path); content / widget / layout / playlist may be
  // platform templates (NULL workspace_id).
  const ownershipChecks = [
    ['devices', req.body.device_id, schedule.device_id, false],
    ['device_groups', req.body.group_id, schedule.group_id, false],
    ['content', req.body.content_id, schedule.content_id, true],
    ['widgets', req.body.widget_id, schedule.widget_id, true],
    ['layouts', req.body.layout_id, schedule.layout_id, true],
    ['playlists', req.body.playlist_id, schedule.playlist_id, true],
  ];
  for (const [table, newVal, oldVal, allowNull] of ownershipChecks) {
    if (newVal === undefined || newVal === oldVal || !newVal) continue;
    const err = checkRefInWorkspace(table, newVal, schedule.workspace_id, { allowNullWorkspace: allowNull });
    if (err) return res.status(err.status).json({ error: err.error });
  }

  const fields = ['device_id', 'group_id', 'zone_id', 'content_id', 'widget_id', 'layout_id', 'playlist_id', 'title',
    'start_time', 'end_time', 'timezone', 'recurrence', 'recurrence_end', 'priority', 'enabled', 'color'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });

  if (req.body.group_id && !updates.some(u => u.startsWith('device_id'))) {
    updates.push('device_id = ?'); values.push(null);
  }
  if (req.body.device_id && !updates.some(u => u.startsWith('group_id'))) {
    updates.push('group_id = ?'); values.push(null);
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  res.json(db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id));
});

// Delete schedule
router.delete('/:id', requireScheduleWrite, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Helper: expand a schedule with recurrence into individual events for a date range
function expandSchedule(schedule, rangeStart, rangeEnd) {
  const events = [];
  const start = new Date(schedule.start_time);
  const end = new Date(schedule.end_time);
  const durationMs = end - start;

  if (!schedule.recurrence) {
    if (end >= rangeStart && start <= rangeEnd) {
      events.push({ ...schedule, instance_start: schedule.start_time, instance_end: schedule.end_time });
    }
    return events;
  }

  const rule = parseRRule(schedule.recurrence);
  if (!rule) {
    events.push({ ...schedule, instance_start: schedule.start_time, instance_end: schedule.end_time });
    return events;
  }

  const recEnd = schedule.recurrence_end ? new Date(schedule.recurrence_end) : rangeEnd;
  let current = new Date(start);
  let count = 0;
  const maxIterations = 366;

  while (current <= rangeEnd && current <= recEnd && count < maxIterations) {
    const instanceEnd = new Date(current.getTime() + durationMs);

    if (current >= rangeStart || instanceEnd >= rangeStart) {
      const dayOfWeek = current.getDay();
      const matchesDay = !rule.byDay || rule.byDay.includes(dayOfWeek);

      if (matchesDay) {
        events.push({
          ...schedule,
          instance_start: current.toISOString(),
          instance_end: instanceEnd.toISOString()
        });
      }
    }

    switch (rule.freq) {
      case 'DAILY': current.setDate(current.getDate() + (rule.interval || 1)); break;
      case 'WEEKLY': current.setDate(current.getDate() + 7 * (rule.interval || 1)); break;
      case 'MONTHLY': current.setMonth(current.getMonth() + (rule.interval || 1)); break;
      default: current.setDate(current.getDate() + 1);
    }
    count++;
  }

  return events;
}

function parseRRule(rrule) {
  if (!rrule) return null;
  const parts = rrule.split(';');
  const rule = {};
  const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  for (const part of parts) {
    const [key, val] = part.split('=');
    switch (key) {
      case 'FREQ': rule.freq = val; break;
      case 'INTERVAL': rule.interval = parseInt(val); break;
      case 'BYDAY': rule.byDay = val.split(',').map(d => dayMap[d]).filter(d => d !== undefined); break;
      case 'COUNT': rule.count = parseInt(val); break;
      case 'UNTIL': rule.until = val; break;
    }
  }
  return rule;
}

module.exports = router;
