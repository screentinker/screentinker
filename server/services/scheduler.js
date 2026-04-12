const { db } = require('../db/database');

let io = null;

function startScheduler(socketIo) {
  io = socketIo;
  // Check schedules every 60 seconds
  setInterval(evaluateSchedules, 60000);
  console.log('Scheduler service started');
}

// Track which devices have a schedule override active so we can revert
const activeOverrides = new Map(); // deviceId -> { playlist_id, layout_id }

function evaluateSchedules() {
  const deviceNs = io?.of('/device');
  if (!deviceNs) return;

  const now = new Date();
  const onlineDevices = db.prepare("SELECT * FROM devices WHERE status = 'online'").all();

  for (const device of onlineDevices) {
    const schedules = db.prepare(`
      SELECT s.*
      FROM schedules s
      WHERE s.device_id = ? AND s.enabled = 1
      ORDER BY s.priority DESC
    `).all(device.id);

    const active = schedules.find(s => isScheduleActiveNow(s, now));
    const override = activeOverrides.get(device.id);
    let changed = false;

    if (active) {
      // Apply layout override if schedule has one
      if (active.layout_id && active.layout_id !== device.layout_id) {
        if (!override) activeOverrides.set(device.id, { layout_id: device.layout_id, playlist_id: device.playlist_id });
        db.prepare("UPDATE devices SET layout_id = ? WHERE id = ?").run(active.layout_id, device.id);
        changed = true;
      }
      // Apply playlist override if schedule has one
      if (active.playlist_id && active.playlist_id !== device.playlist_id) {
        if (!override) activeOverrides.set(device.id, { layout_id: device.layout_id, playlist_id: device.playlist_id });
        db.prepare("UPDATE devices SET playlist_id = ? WHERE id = ?").run(active.playlist_id, device.id);
        changed = true;
      }
    } else if (override) {
      // No active schedule — revert to original playlist/layout
      db.prepare("UPDATE devices SET playlist_id = ?, layout_id = ? WHERE id = ?")
        .run(override.playlist_id, override.layout_id, device.id);
      activeOverrides.delete(device.id);
      changed = true;
    }

    if (changed) pushPlaylistToDevice(device.id, deviceNs);
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
  // Use the single-source buildPlaylistPayload from deviceSocket
  const { buildPlaylistPayload } = require('../ws/deviceSocket');
  const payload = buildPlaylistPayload(deviceId);
  deviceNs.to(deviceId).emit('device:playlist-update', payload);
}

module.exports = { startScheduler, pushPlaylistToDevice };
