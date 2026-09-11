const { db } = require('../db/database');
const { _localParts } = require('../lib/schedule-eval');
const playerCapabilities = require('../lib/player-capabilities');

let io = null;

function startScheduler(socketIo) {
  io = socketIo;
  // Check schedules every 60 seconds
  setInterval(evaluateSchedules, 60000);
  console.log('Scheduler service started');
}

// No in-memory override state: a schedule's effect lives in devices.scheduled_playlist_id /
// scheduled_layout_id, so it survives a restart and reverts by being cleared. The Map that used to
// live here was the reason a restart mid-schedule stranded a device permanently.

// ioOverride lets a test drive one evaluation without startScheduler's 60s setInterval, which keeps
// the process alive and turns the test run into a hang rather than a failure.
function evaluateSchedules(ioOverride) {
  const deviceNs = (ioOverride || io)?.of('/device');
  if (!deviceNs) return;

  const now = new Date();
  const onlineDevices = db.prepare("SELECT * FROM devices WHERE status = 'online'").all();

  for (const device of onlineDevices) {
    // #12 scheduled reboot — evaluated independently of playlist/layout overrides.
    maybeRebootDevice(device, now, deviceNs);

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

    /*
     * ⚠️ A schedule writes its OWN columns and never touches devices.playlist_id or layout_id.
     *
     * This used to overwrite them and remember the previous values in an in-memory Map, which had
     * two consequences. A server restart during an active schedule lost the Map, so the device was
     * stranded on the scheduled playlist FOREVER — nothing on the row recorded that it had been
     * temporary. And a schedule was indistinguishable from an operator's own choice, because both
     * ended up as the same column.
     *
     * With dedicated columns, "revert" is not "restore what I memorised" — it is "clear the
     * column", and the values a schedule used to clobber were never written over in the first
     * place. That makes every tick idempotent and the whole thing self-healing across a restart:
     * the next evaluation simply re-derives whether a schedule is active.
     *
     * Resolution order lives in the view (lib/playlist-resolver-sql.js), where scheduled_playlist_id
     * sits ABOVE the device's own — a schedule is meant to win while it runs, and only while it runs.
     */
    const wantPlaylist = active?.playlist_id || null;
    const wantLayout = active?.layout_id || null;
    const changed = wantPlaylist !== (device.scheduled_playlist_id || null)
      || wantLayout !== (device.scheduled_layout_id || null);

    if (changed) {
      db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = ? WHERE id = ?')
        .run(wantPlaylist, wantLayout, device.id);
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

// #12 scheduled reboot: resolve the device's effective nightly-reboot time. A device's
// own reboot_schedule wins; otherwise the first group it belongs to that sets one. null = off.
function effectiveRebootSchedule(device) {
  if (device.reboot_schedule) return device.reboot_schedule;
  const row = db.prepare(`
    SELECT g.reboot_schedule
    FROM device_groups g
    JOIN device_group_members m ON m.group_id = g.id
    WHERE m.device_id = ? AND g.reboot_schedule IS NOT NULL AND g.reboot_schedule != ''
    ORDER BY g.created_at ASC
    LIMIT 1
  `).get(device.id);
  return row?.reboot_schedule || null;
}

// Fires at most once per device-local day. The 5-minute catch window makes the fire
// robust to 60s-tick drift (a tick that lands at :59 then :59 next minute never skips the
// target minute). reboot_last_date (device-local YYYY-MM-DD) is the once-per-day guard.
const REBOOT_WINDOW_MIN = 5;

// Pure decision: given a "HH:MM" schedule, the device-local `now`, the device's tz, and the
// last fired date, return { due, today }. `today` is the device-local YYYY-MM-DD to stamp on
// fire. Extracted so it's unit-testable with no DB / socket. Invalid/off schedule -> not due.
function rebootDue(schedule, tz, now, lastDate) {
  if (!schedule) return { due: false, today: null };
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(schedule).trim());
  if (!m) return { due: false, today: null };
  const schedMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (schedMin > 1439) return { due: false, today: null };

  const L = _localParts(now, tz);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const today = `${L.y}-${p2(L.mo)}-${p2(L.day)}`;
  const inWindow = L.min >= schedMin && L.min < schedMin + REBOOT_WINDOW_MIN;
  return { due: inWindow && lastDate !== today, today };
}

function maybeRebootDevice(device, now, deviceNs) {
  const { due, today } = rebootDue(effectiveRebootSchedule(device), deviceTz(device), now, device.reboot_last_date);
  if (!due) return;
  // A nightly reboot can be scheduled on a group, and a group holds browser tabs. Sending it
  // anyway was harmless in itself, but the log line below then claimed a reboot had fired every
  // night for a display that cannot reboot — which is what someone reads when they are trying to
  // work out why a panel never came back.
  if (!playerCapabilities.supports(device, 'system.reboot')) return;
  db.prepare('UPDATE devices SET reboot_last_date = ? WHERE id = ?').run(today, device.id);
  deviceNs.to(device.id).emit('device:command', { type: 'reboot', payload: { scheduled: true } });
  console.log(`[reboot] scheduled reboot fired for device ${device.id} (${device.name || 'unnamed'}) at local ${today}`);
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

  // The DATE window. A recurring schedule was previously compared on weekday and HH:MM alone, with
  // the date component dropped entirely — so it was live before its start date and, more visibly,
  // carried on forever after its end date. A campaign set to finish on the 1st was still switching
  // screens weeks later, while the calendar (which does read recurrence_end) showed it as stopped.
  // The end date is offered on the form; it has to mean something.
  const nowDate = nowStamp.slice(0, 10);
  if (nowDate < startStamp.slice(0, 10)) return false;                  // has not begun yet
  if (schedule.recurrence_end) {
    // Inclusive: an end date of the 5th means the 5th still runs, to its normal end time.
    if (nowDate > String(schedule.recurrence_end).slice(0, 10)) return false;
  }

  // Day-of-week in the device's local zone.
  if (rule.byDay && !rule.byDay.includes(L.dow)) return false;

  // Day-of-month, for FREQ=MONTHLY. This function never branched on FREQ, so a monthly rule had
  // no filter at all and played EVERY day, while the calendar (routes/schedules.js expandSchedule,
  // which does check the day-of-month) drew it once a month. The dashboard now offers Monthly, so
  // the two have to agree; this is the same comparison the calendar makes. BYDAY-less on purpose:
  // an nth-weekday form ("1MO") is dropped by both parsers and is not offered anywhere.
  if (rule.freq === 'MONTHLY' && L.day !== Number(startStamp.slice(8, 10))) return false;

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

// evaluateSchedules is exported for tests: it is the whole of the scheduler's effect on what a
// screen plays, and the columns it writes are the difference between a revertible override and the
// permanent stranding the in-memory Map used to cause. Untested, that distinction is a comment.
module.exports = { startScheduler, pushPlaylistToDevice, rebootDue, evaluateSchedules };
// Exported for testing: whether a schedule is live right now is the single decision this service
// exists to make, and it should be checkable without a ticking timer.
module.exports.isScheduleActiveNow = isScheduleActiveNow;
