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
const { effectiveDeviceTz } = require('../lib/device-timezone');
const { resolveItemDuration } = require('../lib/item-duration');

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

// Every schedule in a workspace, each row carrying the NAME of what it targets.
//
// The per-device query answers "what plays on THIS screen". This answers "what is
// scheduled anywhere", which is what an operator actually needs to see: with a
// single-device calendar you cannot tell whether a gap is deliberate or whether you
// pointed the schedule at the wrong screen — the failure mode a real user hit.
function getWorkspaceSchedulesQuery() {
  return `
    SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name,
           dg.name as group_name, dg.color as group_color,
           d.name as device_name
    FROM schedules s
    LEFT JOIN content c ON s.content_id = c.id
    LEFT JOIN widgets w ON s.widget_id = w.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    LEFT JOIN device_groups dg ON s.group_id = dg.id
    LEFT JOIN devices d ON s.device_id = d.id
    WHERE s.enabled = 1 AND s.workspace_id = ?
    ORDER BY
      CASE WHEN s.device_id IS NOT NULL THEN 1 ELSE 0 END DESC,
      s.priority DESC,
      s.created_at ASC
  `;
}

/*
 * A recurring instance must go out in the SAME shape a one-off does: a naive wall-clock string.
 *
 * ⚠️ THIS IS THE "MY SCHEDULE IS ON THE WRONG DAY" BUG.
 *
 * expandSchedule had two emit paths that disagreed. A one-off returns schedule.start_time
 * untouched - a naive local string like 2026-08-19T20:00:00 - which the browser parses in ITS OWN
 * zone, giving back the day the operator picked. A recurring instance returned cursor.toISOString(),
 * an absolute instant derived by reading that same naive string in the SERVER's zone. The browser
 * then converted it back into its own zone, and the two conversions do not cancel:
 *
 *   operator in Tokyo saves Wed 20:00   ->  stored "2026-08-19T20:00:00"
 *   server in US Central reads 20:00 CDT ->  emits "2026-08-20T01:00:00.000Z"
 *   browser renders that in JST          ->  THURSDAY 10:00
 *
 * Day and time both wrong, and only for recurring schedules - which is why it looked intermittent.
 * The calendar was also the odd one out: the playback engine compares start_time as a STRING
 * (services/scheduler.js), never as an instant, so expandSchedule was the only place in the
 * codebase reinterpreting a wall-clock time as a point in time.
 *
 * schedules.timezone is already stored per row; rendering true instants from it would be the fuller
 * answer. Matching the format the rest of the system already speaks fixes the bug in front of us
 * and cannot change what the engine actually plays.
 */
function localDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// The week calendar sends a local YYYY-MM-DD, which represents the date shown in the browser —
// not a UTC instant. Construct from numeric local parts instead of new Date('YYYY-MM-DD') because
// that ISO form is specified as UTC and becomes the preceding day on servers west of Greenwich.
// Full timestamps remain accepted for older browser clients.
function parseCalendarDate(value) {
  if (!value) return new Date();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(value);

  const [, year, month, day] = match.map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
    ? parsed
    : new Date(NaN);
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
// layout_zones has no workspace_id of its own — a zone belongs to a layout, and the layout carries
// the workspace. zone_id was the one polymorphic reference missing from the ownership checks, so a
// schedule could be pointed at a zone in someone else's workspace.
function checkZoneInWorkspace(zoneId, workspaceId) {
  const row = db.prepare(
    'SELECT l.workspace_id FROM layout_zones z JOIN layouts l ON l.id = z.layout_id WHERE z.id = ?'
  ).get(zoneId);
  if (!row) return { status: 404, error: 'zone not found' };
  if (row.workspace_id === workspaceId) return null;
  if (row.workspace_id == null) return null;          // platform-template layout
  return { status: 403, error: 'zone is not in this workspace' };
}

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
  const { date, device_id, all } = req.query;
  if (!device_id && !all) return res.status(400).json({ error: 'device_id or all=1 required' });

  // all=1 -> every schedule on every screen, for the "all screens" calendar. The workspace
  // comes from the caller's resolved tenancy, never from the query string: a client-supplied
  // workspace_id here would be a cross-tenant read waiting to happen.
  let scopeWorkspaceId = all ? req.workspaceId : null;
  if (all && !scopeWorkspaceId) return res.json([]);
  if (device_id) {
    const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(device_id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
    scopeWorkspaceId = device.workspace_id;
  }
  const ctx = workspaceAccess(req, scopeWorkspaceId);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });

  const weekStart = parseCalendarDate(date);
  if (Number.isNaN(weekStart.getTime())) return res.status(400).json({ error: 'Invalid calendar date' });
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const schedules = device_id
    ? db.prepare(getDeviceSchedulesQuery()).all(device_id, device_id)
    : db.prepare(getWorkspaceSchedulesQuery()).all(scopeWorkspaceId);
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
  let targetTz = null;
  if (device_id) {
    const device = db.prepare('SELECT workspace_id, timezone, reported_timezone FROM devices WHERE id = ?').get(device_id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
    targetWorkspaceId = device.workspace_id;
    targetTz = effectiveDeviceTz(device);
  }
  if (group_id) {
    const group = db.prepare('SELECT workspace_id, leader_device_id FROM device_groups WHERE id = ?').get(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.workspace_id) return res.status(403).json({ error: 'Group not assigned to a workspace' });
    targetWorkspaceId = group.workspace_id;
    // A group can span zones, so there is no single right answer. The leader defines the
    // group's wall clock; failing that, the oldest member that reports one. The resolved
    // value is stored explicitly so the caller can see which zone it landed on.
    const leader = group.leader_device_id
      ? db.prepare('SELECT timezone, reported_timezone FROM devices WHERE id = ?').get(group.leader_device_id)
      : null;
    targetTz = effectiveDeviceTz(leader);
    if (!targetTz) {
      const member = db.prepare(`SELECT d.timezone, d.reported_timezone FROM devices d
         JOIN device_group_members m ON m.device_id = d.id
         WHERE m.group_id = ? AND COALESCE(d.timezone, d.reported_timezone) IS NOT NULL
         ORDER BY d.created_at LIMIT 1`).get(group_id);
      targetTz = effectiveDeviceTz(member);
    }
  }
  const ctx = workspaceAccess(req, targetWorkspaceId);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  // Payload refs must live in the same workspace. Platform templates
  // (workspace_id IS NULL) on content / widget / layout / playlist are allowed.
  const refChecks = [
    ['content',   content_id,  true],
    ['widgets',   widget_id,   true],
    ['layouts',   layout_id,   true],
    ['playlists', playlist_id, true],
  ];
  for (const [table, id, allowNull] of refChecks) {
    if (!id) continue;
    const err = checkRefInWorkspace(table, id, targetWorkspaceId, { allowNullWorkspace: allowNull });
    if (err) return res.status(err.status).json({ error: err.error });
  }
  if (zone_id) {
    const zErr = checkZoneInWorkspace(zone_id, targetWorkspaceId);
    if (zErr) return res.status(zErr.status).json({ error: zErr.error });
  }

  // A content-only schedule is turned into a playlist holding that one item.
  //
  // The dialog offers "Content (single item, optional)" and the value was stored faithfully — but
  // the engine only ever acts on layout_id and playlist_id, so content_id was read by nothing at
  // all. The schedule fired, changed nothing, and the calendar drew a block labelled with the
  // filename as confirmation that it would. Rather than add a third override path through the
  // engine and every player, give the item the same shape everything already understands: its own
  // playlist. That reuses the whole published/assign/push pipeline as-is.
  let effectivePlaylistId = playlist_id || null;
  if (!effectivePlaylistId && content_id) {
    const c = db.prepare('SELECT filename, duration_sec FROM content WHERE id = ?').get(content_id);
    const genId = uuidv4();
    db.prepare('INSERT INTO playlists (id, name, workspace_id, user_id, status, is_auto_generated) VALUES (?, ?, ?, ?, ?, 1)')
      .run(genId, `Scheduled: ${(c && c.filename) || 'item'}`, targetWorkspaceId, req.user.id, 'published');
    // #237: a scheduled video is a one-item playlist with nowhere to edit the duration, so a
    // flat 10 here would cut the clip off with no visible knob to fix it.
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 0, ?)')
      .run(genId, content_id, resolveItemDuration(null, c));
    // Publish through the shared path rather than hand-rolling the snapshot: players read
    // denormalized fields (filename, mime_type, filepath, remote_url, schedules...) out of
    // published_snapshot, and duplicating that shape here would rot the moment it changes.
    require('./playlists').publishPlaylist(genId);
    effectivePlaylistId = genId;
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO schedules (id, user_id, workspace_id, device_id, group_id, zone_id, content_id, widget_id, layout_id, playlist_id, title,
      start_time, end_time, timezone, recurrence, recurrence_end, priority, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, targetWorkspaceId, device_id || null, group_id || null, zone_id || null, content_id || null, widget_id || null,
    layout_id || null, effectivePlaylistId, title || '', start_time, end_time, timezone || targetTz || 'UTC',
    recurrence || null, recurrence_end || null, priority || 0, color || '#3B82F6');

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
    ['devices',       req.body.device_id,   schedule.device_id,   false],
    ['device_groups', req.body.group_id,    schedule.group_id,    false],
    ['content',       req.body.content_id,  schedule.content_id,  true],
    ['widgets',       req.body.widget_id,   schedule.widget_id,   true],
    ['layouts',       req.body.layout_id,   schedule.layout_id,   true],
    ['playlists',     req.body.playlist_id, schedule.playlist_id, true],
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

  // Walk DAY BY DAY across the visible range and draw every day the rule actually fires.
  //
  // The old loop stepped by the recurrence unit from the schedule's original start, which got both
  // of the common presets wrong:
  //   - WEEKLY advanced a whole week at a time, so dayOfWeek never changed and a
  //     FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR rule matched only its start day — one event a week, or
  //     none at all if it had been created on a weekend.
  //   - Starting from the original start with a 366-iteration cap meant a schedule begun more than
  //     a year ago never reached the current week, so it drew nothing whatsoever.
  // The engine meanwhile evaluates day-of-week directly, so it ran Mon-Fri regardless. The calendar
  // is the operator's only view of what is scheduled, and it disagreed with reality in both
  // directions. Iterating the range instead means the drawing follows the same rule the engine
  // applies, and the cost is bounded by the window being displayed rather than by history.
  const dayMs = 24 * 60 * 60 * 1000;
  const startTimeOfDay = { h: start.getHours(), m: start.getMinutes(), s: start.getSeconds() };

  // First candidate day: the later of the schedule's start and the window's start.
  let cursor = new Date(Math.max(start.getTime(), rangeStart.getTime()));
  cursor.setHours(startTimeOfDay.h, startTimeOfDay.m, startTimeOfDay.s, 0);
  if (cursor.getTime() + durationMs < rangeStart.getTime()) cursor = new Date(cursor.getTime() + dayMs);

  const lastDay = new Date(Math.min(rangeEnd.getTime(), recEnd.getTime()));
  const interval = Math.max(1, rule.interval || 1);

  while (cursor <= lastDay) {
    const instanceEnd = new Date(cursor.getTime() + durationMs);
    let fires = false;
    switch (rule.freq) {
      case 'DAILY':
        // Honour the interval by counting whole days from the original start.
        fires = Math.floor((cursor - start) / dayMs) % interval === 0;
        break;
      case 'WEEKLY':
        // byDay is what makes Mon-Fri work. Without it, weekly means "the start's weekday".
        fires = rule.byDay ? rule.byDay.includes(cursor.getDay()) : cursor.getDay() === start.getDay();
        break;
      case 'MONTHLY':
        fires = cursor.getDate() === start.getDate();
        break;
      default:
        fires = true;
    }
    if (fires && (cursor >= rangeStart || instanceEnd >= rangeStart)) {
      events.push({
        ...schedule,
        instance_start: localDateTime(cursor),
        instance_end: localDateTime(instanceEnd),
      });
    }
    cursor = new Date(cursor.getTime() + dayMs);
    cursor.setHours(startTimeOfDay.h, startTimeOfDay.m, startTimeOfDay.s, 0);   // DST-safe re-anchor
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
// Exported for testing, the same way playlists.js exports publishPlaylist. The calendar's
// correctness is arithmetic and deserves to be checked without standing up a server.
module.exports.expandSchedule = expandSchedule;
module.exports.localDateTime = localDateTime;
module.exports.parseCalendarDate = parseCalendarDate;
