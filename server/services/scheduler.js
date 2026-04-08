const { db } = require('../db/database');

let io = null;

function startScheduler(socketIo) {
  io = socketIo;
  // Check schedules every 60 seconds
  setInterval(evaluateSchedules, 60000);
  console.log('Scheduler service started');
}

function evaluateSchedules() {
  const deviceNs = io?.of('/device');
  if (!deviceNs) return;

  const now = new Date();
  const onlineDevices = db.prepare("SELECT * FROM devices WHERE status = 'online'").all();

  for (const device of onlineDevices) {
    const schedules = db.prepare(`
      SELECT s.*, c.filename, c.mime_type, c.filepath, c.file_size, c.remote_url,
             c.duration_sec as content_duration
      FROM schedules s
      LEFT JOIN content c ON s.content_id = c.id
      WHERE s.device_id = ? AND s.enabled = 1
      ORDER BY s.priority DESC
    `).all(device.id);

    // Find currently active schedule
    const active = schedules.find(s => isScheduleActiveNow(s, now));

    if (active && active.content_id) {
      // Check if this is different from current playback
      const currentLayout = device.layout_id;
      if (active.layout_id && active.layout_id !== currentLayout) {
        // Switch layout
        db.prepare("UPDATE devices SET layout_id = ? WHERE id = ?").run(active.layout_id, device.id);
        // Push updated playlist
        pushPlaylistToDevice(device.id, deviceNs);
      }
    }
  }
}

function isScheduleActiveNow(schedule, now) {
  const start = new Date(schedule.start_time);
  const end = new Date(schedule.end_time);

  if (!schedule.recurrence) {
    return now >= start && now <= end;
  }

  // For recurring schedules, check if current time-of-day falls within range
  // and current day matches recurrence pattern
  const rule = parseSimpleRRule(schedule.recurrence);
  if (!rule) return now >= start && now <= end;

  // Check day of week
  if (rule.byDay && !rule.byDay.includes(now.getDay())) return false;

  // Check time of day
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();

  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

function parseSimpleRRule(rrule) {
  if (!rrule) return null;
  const parts = rrule.split(';');
  const rule = {};
  const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key === 'FREQ') rule.freq = val;
    if (key === 'BYDAY') rule.byDay = val.split(',').map(d => dayMap[d]).filter(d => d !== undefined);
    if (key === 'INTERVAL') rule.interval = parseInt(val);
  }
  return rule;
}

function pushPlaylistToDevice(deviceId, deviceNs) {
  const assignments = db.prepare(`
    SELECT a.*, COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size, c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM assignments a LEFT JOIN content c ON a.content_id = c.id LEFT JOIN widgets w ON a.widget_id = w.id
    WHERE a.device_id = ? AND a.enabled = 1
    ORDER BY a.sort_order ASC
  `).all(deviceId);

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  let layout = null;
  if (device.layout_id) {
    layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
    if (layout) {
      layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
    }
  }

  deviceNs.to(deviceId).emit('device:playlist-update', { assignments, layout, orientation: device?.orientation || 'landscape' });
}

module.exports = { startScheduler, pushPlaylistToDevice };
