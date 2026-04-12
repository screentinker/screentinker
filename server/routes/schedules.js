const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// List schedules (filterable)
router.get('/', (req, res) => {
  const { device_id, start, end } = req.query;
  let sql = 'SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name FROM schedules s LEFT JOIN content c ON s.content_id = c.id LEFT JOIN widgets w ON s.widget_id = w.id LEFT JOIN playlists p ON s.playlist_id = p.id WHERE s.user_id = ?';
  const params = [req.user.id];

  if (device_id) { sql += ' AND s.device_id = ?'; params.push(device_id); }
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

  const schedules = db.prepare(`
    SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name
    FROM schedules s
    LEFT JOIN content c ON s.content_id = c.id
    LEFT JOIN widgets w ON s.widget_id = w.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    WHERE s.device_id = ? AND s.enabled = 1
    ORDER BY s.priority DESC, s.start_time ASC
  `).all(req.params.deviceId);
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

  const schedules = db.prepare(`
    SELECT s.*, c.filename as content_name, w.name as widget_name, p.name as playlist_name
    FROM schedules s
    LEFT JOIN content c ON s.content_id = c.id
    LEFT JOIN widgets w ON s.widget_id = w.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    WHERE s.device_id = ? AND s.enabled = 1
    ORDER BY s.priority DESC, s.start_time ASC
  `).all(device_id);

  const events = [];
  for (const s of schedules) {
    const expanded = expandSchedule(s, weekStart, weekEnd);
    events.push(...expanded);
  }

  res.json(events);
});

// Create schedule
router.post('/', (req, res) => {
  const { device_id, zone_id, content_id, widget_id, layout_id, playlist_id, title, start_time, end_time,
          timezone, recurrence, recurrence_end, priority, color } = req.body;

  if (!device_id || !start_time || !end_time) {
    return res.status(400).json({ error: 'device_id, start_time, and end_time required' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO schedules (id, user_id, device_id, zone_id, content_id, widget_id, layout_id, playlist_id, title,
      start_time, end_time, timezone, recurrence, recurrence_end, priority, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, device_id, zone_id || null, content_id || null, widget_id || null,
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

  const fields = ['device_id', 'zone_id', 'content_id', 'widget_id', 'layout_id', 'playlist_id', 'title',
    'start_time', 'end_time', 'timezone', 'recurrence', 'recurrence_end', 'priority', 'enabled', 'color'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });

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
