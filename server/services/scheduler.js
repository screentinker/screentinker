const { db } = require('../db/database');
const { _localParts } = require('../lib/schedule-eval');

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
    `).all(device.id, device.id);

    const active = schedules.find(s => isScheduleActiveNow(s, now, deviceTz(device)));
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

// #74/#75 Part B: device-level schedules are evaluated in the DEVICE's effective
// timezone, not the server's. We reuse the canonical UTC->local conversion
// (_localParts from schedule-eval.js) - no second conversion path. start_time/end_time
// are stored as device-local wall-clock datetimes, so we compare them to a device-local
// "now". tz === null (no override AND no reported zone) falls back to the server clock,
// preserving the pre-existing behaviour for un-migrated / non-reporting devices.
function deviceTz(device) {
  const override = (device.timezone && device.timezone !== 'UTC') ? device.timezone : null;
  return override || device.reported_timezone || null;
}

function localStamp(parts) {
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const hh = Math.floor(parts.min / 60), mm = parts.min % 60;
  return `${parts.y}-${p2(parts.mo)}-${p2(parts.day)}T${p2(hh)}:${p2(mm)}`;
}

function isScheduleActiveNow(schedule, now, tz) {
  const L = _localParts(now, tz);
  const nowStamp = localStamp(L);                   // device-local "YYYY-MM-DDTHH:MM"
  const startStamp = String(schedule.start_time).slice(0, 16);
  const endStamp = String(schedule.end_time).slice(0, 16);

  if (!schedule.recurrence) {
    return nowStamp >= startStamp && nowStamp <= endStamp;
  }

  const rule = parseSimpleRRule(schedule.recurrence);
  if (!rule) return nowStamp >= startStamp && nowStamp <= endStamp;

  // Day-of-week in the device's local zone.
  if (rule.byDay && !rule.byDay.includes(L.dow)) return false;

  // Time-of-day window in the device's local zone (HH:MM string compare).
  const nowHM = nowStamp.slice(11), startHM = startStamp.slice(11), endHM = endStamp.slice(11);
  return nowHM >= startHM && nowHM <= endHM;
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
  const commandQueue = require('../lib/command-queue');
  commandQueue.queueOrEmitPlaylistUpdate(deviceNs, deviceId, buildPlaylistPayload);
}

module.exports = { startScheduler, pushPlaylistToDevice };
