'use strict';

const { effectiveDeviceTz } = require('./device-timezone');

/*
 * WHICH POWER SCHEDULE DOES THIS SCREEN OBEY — the single definition.
 *
 * There is exactly one answer and it is computed here. The device payload builder asks, the REST
 * route asks so the dashboard can show what a screen will actually do, and the group editor asks
 * so it can warn that a device-level schedule is overriding it. Three callers, one rule.
 *
 * ⚠️ This is the third inheritance ladder in the product (content playlists, content schedules,
 * now power), and they deliberately agree: DEVICE BEATS GROUP, full stop. An operator who has
 * learned that a per-screen playlist overrides its group's expects a per-screen power schedule to
 * do the same, and a product where the precedence depends on which feature you are in is a product
 * where operators stop trusting precedence at all. See lib/playlist-resolver-sql.js, whose header
 * makes the same argument from the other side.
 *
 * ⚠️ NO "most specific wins" beyond that. A device is only ever in one power schedule of its own
 * (a partial unique index enforces it), and if it is in several groups the lowest group id wins —
 * arbitrary, but STABLE and documented, which beats a tiebreak that changes when rows are touched.
 * Two groups with contradictory power schedules is a misconfiguration the dashboard surfaces
 * rather than one the resolver silently picks a winner for.
 */

/**
 * Parse the stored windows document into something the evaluator will accept.
 *
 * ⚠️ Returns [] for anything unparseable rather than throwing. A corrupt row must mean "no
 * schedule", i.e. the screen stays lit — the same fail-to-ON direction lib/power-window.js takes,
 * enforced here as well because this is the other place a bad document could reach a panel.
 */
function parseWindows(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

/**
 * The compiled schedule for one device, or null when it has none.
 *
 * The shape returned is EXACTLY what the player stores and what power-window.js consumes, so the
 * payload builder does no reshaping of its own — a second shape is a second thing to keep in step.
 *
 * @returns {{id:string, source:'device'|'group', enabled:boolean, timezone:string|null,
 *            windows:Array}|null}
 */
function powerScheduleForDevice(db, deviceId) {
  const device = db.prepare(
    'SELECT id, workspace_id, timezone, reported_timezone FROM devices WHERE id = ?'
  ).get(deviceId);
  if (!device) return null;

  /*
   * Device first. Its own row wins outright, INCLUDING a disabled one: switching a screen's
   * schedule off is an instruction about that screen, not an invitation to fall back to whatever
   * its group says. Falling through on `enabled = 0` would mean the only way to exempt one panel
   * from a group schedule is to remove it from the group — and the operator who unticked the box
   * would watch it sleep anyway.
   */
  let row = db.prepare(
    `SELECT id, enabled, timezone, windows, 'device' AS source
       FROM display_power_schedules
      WHERE device_id = ? AND workspace_id = ?`
  ).get(deviceId, device.workspace_id);

  if (!row) {
    row = db.prepare(
      `SELECT s.id, s.enabled, s.timezone, s.windows, 'group' AS source
         FROM display_power_schedules s
         JOIN device_group_members m ON m.group_id = s.group_id
        WHERE m.device_id = ? AND s.workspace_id = ?
        ORDER BY s.group_id ASC
        LIMIT 1`
    ).get(deviceId, device.workspace_id);
  }

  if (!row) return null;

  return {
    id: row.id,
    source: row.source,
    enabled: !!row.enabled,
    /*
     * The zone the windows are EVALUATED in. An explicit zone on the schedule wins; otherwise the
     * device's effective zone — the same lib/device-timezone call the per-item scheduler and
     * routes/schedules.js make. ⚠️ Resolving this anywhere else, or defaulting to the SERVER's
     * zone, is how "off at 22:00" becomes "off at 22:00 somewhere else": the server is frequently
     * in a different country from the screen.
     */
    timezone: row.timezone || effectiveDeviceTz(device),
    windows: parseWindows(row.windows),
  };
}

/**
 * Every device a schedule currently applies to — the fan-out for "push this change now".
 *
 * ⚠️ Goes back through powerScheduleForDevice for each candidate rather than trusting the join,
 * because a group schedule does NOT apply to a member that has its own. Pushing to the raw
 * membership list would hand a device the group's windows and overwrite the ones it is supposed to
 * be keeping. The set is small (members of one group) so the per-device re-resolve is cheap, and
 * it means there is still only one rule in the codebase.
 */
function devicesForSchedule(db, scheduleId) {
  const s = db.prepare(
    'SELECT id, workspace_id, device_id, group_id FROM display_power_schedules WHERE id = ?'
  ).get(scheduleId);
  if (!s) return [];

  const candidates = s.device_id
    ? [s.device_id]
    : db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?')
        .all(s.group_id).map((r) => r.device_id);

  return candidates.filter((deviceId) => {
    const eff = powerScheduleForDevice(db, deviceId);
    return !!eff && eff.id === scheduleId;
  });
}

/**
 * Devices whose effective schedule may have CHANGED because this one was deleted or retargeted.
 *
 * Superset of devicesForSchedule and deliberately so: after a device-level schedule is deleted the
 * screen may fall back to its group's, and it needs telling. Callers push the newly-resolved
 * schedule (which may be null) to everything this returns.
 */
function devicesAffectedBySchedule(db, scheduleId) {
  const s = db.prepare(
    'SELECT id, device_id, group_id FROM display_power_schedules WHERE id = ?'
  ).get(scheduleId);
  if (!s) return [];
  return s.device_id
    ? [s.device_id]
    : db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?')
        .all(s.group_id).map((r) => r.device_id);
}

module.exports = { powerScheduleForDevice, devicesForSchedule, devicesAffectedBySchedule, parseWindows };
