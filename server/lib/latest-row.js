'use strict';

/*
 * #788: ONE latest telemetry / screenshot row per screen, chosen deterministically.
 *
 * The old shape joined each device to `MAX(reported_at)` and then back to every row carrying that
 * timestamp. reported_at is whole SECONDS, so two heartbeats in the same second (a reconnect right
 * after a beat, the embedded writer, a replica, HEARTBEAT_MIN_INTERVAL_MS=0) both "are" the latest
 * row, and the device came back once per tied row. GET /devices is capped at LIMIT 100, so the
 * duplicates pushed real screens off the Displays page (one workspace lost 3 screens to a device
 * with 110 tied rows; prod had 5 tied devices the day this was written).
 *
 * The fix is a tie-break, newest reported_at then highest id, as a correlated lookup per device.
 * It rides idx_telemetry_device / idx_screenshots_device (device_id, time DESC), so it is one index
 * seek per listed device instead of grouping the whole telemetry table on every page load.
 *
 * ⚠️ Use these instead of hand-writing a MAX() join: test/latest-row.test.js greps the server for
 * the old shape so a fifth copy cannot creep back in.
 *
 * ROWID, not id: in the real schema `id` IS the rowid (INTEGER PRIMARY KEY), but some tests and
 * older stub tables build these tables without an id column, and rowid exists on every rowid table.
 * Callers join with `t.rowid = <this>`.
 *
 * deviceCol is a trusted SQL column reference written by the caller (e.g. 'd.id'), never input.
 */
const SAFE_COL = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function check(col) {
  if (!SAFE_COL.test(col)) throw new Error(`latest-row: not a column reference: ${col}`);
  return col;
}

function latestTelemetryIdSql(deviceCol) {
  return `(SELECT lt.rowid FROM device_telemetry lt WHERE lt.device_id = ${check(deviceCol)}
            ORDER BY lt.reported_at DESC, lt.rowid DESC LIMIT 1)`;
}

function latestScreenshotIdSql(deviceCol) {
  return `(SELECT ls.rowid FROM screenshots ls WHERE ls.device_id = ${check(deviceCol)}
            ORDER BY ls.captured_at DESC, ls.rowid DESC LIMIT 1)`;
}

module.exports = { latestTelemetryIdSql, latestScreenshotIdSql };
