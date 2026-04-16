const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

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

// List schedules (filterable)
router.get('/', (req, res) => {
  const { device_id, group_id, start, end } = req.query;
  let sql = `SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name,
             dg.name as group_name, dg.color as group_color
             FROM schedules s
             LEFT JOIN content c ON s.content_id = c.id
             LEFT JOIN widgets w ON s.widget_id = w.id
             LEFT JOIN playlists p ON s.playlist_id = p.id
             LEFT JOIN device_groups dg ON s.group_id = dg.id
             WHERE s.user_id = ?`;
  const params = [req.user.id];

  if (device_id) {
    // Return both device-level and group-level schedules affecting this device
    sql += ` AND (s.device_id = ? OR s.group_id IN (SELECT group_id FROM device_group_members WHERE device_id = ?))`;
    params.push(device_id, device_id);
  }
  if (group_id) { sql += ' AND s.group_id = ?'; params.push(group_id); }
  if (start) { sql += ' AND s.end_time >= ?'; params.push(start); }
  if (end) { sql += ' AND s.start_time <= ?'; params.push(end); }

  sql += ' ORDER BY s.start_time ASC';
  res.json(db.prepare(sql).all(...params));
});

// Get schedules for a device (verify device belongs to user)
router.get('/device/:deviceId', (req, res) => {
  const device = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!['admin','superadmin'].includes(req.user.role) && device.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const schedules = db.prepare(getDeviceSchedulesQuery()).all(req.params.deviceId, req.params.deviceId);
  res.json(schedules);
});

// Get expanded week view (resolves recurrences into individual events)
router.get('/week', (req, res) => {
  const { date, device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  // Verify device ownership
  const device = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!['admin','superadmin'].includes(req.user.role) && device.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

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

// Create schedule
router.post('/', (req, res) => {
  const { device_id, group_id, zone_id, content_id, widget_id, layout_id, playlist_id, title, start_time, end_time,
          timezone, recurrence, recurrence_end, priority, color } = req.body;

  if (!start_time || !end_time) {
    return res.status(400).json({ error: 'start_time and end_time required' });
  }

  // Mutual exclusion: exactly one of device_id or group_id
  if (device_id && group_id) {
    return res.status(400).json({ error: 'Cannot set both device_id and group_id. A schedule applies to one device OR one group.' });
  }
  if (!device_id && !group_id) {
    return res.status(400).json({ error: 'Either device_id or group_id is required' });
  }

  // Ownership checks
  if (device_id) {
    const device = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(device_id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!['admin','superadmin'].includes(req.user.role) && device.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }
  if (group_id) {
    const group = db.prepare('SELECT user_id FROM device_groups WHERE id = ?').get(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!['admin','superadmin'].includes(req.user.role) && group.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO schedules (id, user_id, device_id, group_id, zone_id, content_id, widget_id, layout_id, playlist_id, title,
      start_time, end_time, timezone, recurrence, recurrence_end, priority, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, device_id || null, group_id || null, zone_id || null, content_id || null, widget_id || null,
    layout_id || null, playlist_id || null, title || '', start_time, end_time, timezone || 'UTC',
    recurrence || null, recurrence_end || null, priority || 0, color || '#3B82F6');

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  res.status(201).json(schedule);
});

// Update schedule
router.put('/:id', (req, res) => {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!['admin','superadmin'].includes(req.user.role) && schedule.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  // If changing target, enforce mutual exclusion
  const newDeviceId = req.body.device_id !== undefined ? req.body.device_id : schedule.device_id;
  const newGroupId = req.body.group_id !== undefined ? req.body.group_id : schedule.group_id;
  if (newDeviceId && newGroupId) {
    return res.status(400).json({ error: 'Cannot set both device_id and group_id' });
  }
  if (!newDeviceId && !newGroupId) {
    return res.status(400).json({ error: 'Either device_id or group_id is required' });
  }

  // Ownership check if changing to a new group
  if (req.body.group_id && req.body.group_id !== schedule.group_id) {
    const group = db.prepare('SELECT user_id FROM device_groups WHERE id = ?').get(req.body.group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!['admin','superadmin'].includes(req.user.role) && group.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const fields = ['device_id', 'group_id', 'zone_id', 'content_id', 'widget_id', 'layout_id', 'playlist_id', 'title',
    'start_time', 'end_time', 'timezone', 'recurrence', 'recurrence_end', 'priority', 'enabled', 'color'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });

  // When switching from device to group (or vice versa), null out the other field
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
router.delete('/:id', (req, res) => {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!['admin','superadmin'].includes(req.user.role) && schedule.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
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

  // Parse simple RRULE
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

    // Advance
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
