'use strict';

/*
 * Reading proof-of-play across the raw/rollup seam.
 *
 * Raw play_logs are pruned on config.playLogRetentionDays; services/play-rollup aggregates every
 * hour into play_log_hourly before the prune is allowed past it. So a report whose range predates
 * the raw floor has to read the aggregate, a recent one reads raw, and one spanning the boundary
 * reads both — without counting the overlap twice.
 *
 * ⚠️ THE SEAM IS THE OLDEST SURVIVING RAW ROW, NOT THE ROLLUP WATERMARK.
 *
 * Both sources describe the same hours: the rollup is written BEFORE raw is pruned, so for a
 * window either side of the watermark the plays exist in both tables at once. Splitting on the
 * watermark would count that overlap twice — every play in it reported at double. Splitting on
 * MIN(started_at) is exact by construction: an hour either still has its raw rows, or it does not
 * and the rollup is the only copy. It also self-corrects if retention is changed, or if a prune is
 * interrupted partway.
 *
 * ⚠️ BOTH SOURCES ARE NORMALISED TO THE SAME HOURLY GRAIN, which is what makes them addable at
 * all. Raw is grouped to (workspace, device, content, hour) in SQL — the rollup's own key — so a
 * caller cannot tell which side of the seam a row came from, and a range that crosses it produces
 * one uniform series instead of two that have to be reconciled.
 *
 * ⚠️ DAY AND HOUR-OF-DAY BUCKETING HAPPENS IN JAVASCRIPT, NOT SQL. The bucket must be the DEVICE'S
 * local day, and SQLite has no IANA timezone support — its 'localtime' modifier is the SERVER's
 * zone, which is a third answer that belongs to neither the device nor the viewer. reports.js used
 * 'localtime' and was correct only because production happens to run Etc/UTC; the same report on a
 * self-hoster's box in another zone bucketed differently, and would now disagree with the
 * UTC-keyed rollup. Intl.DateTimeFormat does real zone conversion, including DST.
 */

const { db } = require('../db/database');

const HOUR = 3600;

/**
 * The oldest raw play still on disk. null when play_logs is empty, in which case every hour in
 * range must come from the rollup.
 */
function rawFloor() {
  const row = db.prepare('SELECT MIN(started_at) AS t FROM play_logs').get();
  return row && row.t != null ? row.t : null;
}

/**
 * Hourly-grained rows for [startEpoch, endEpoch], combining rollup and raw with no overlap.
 *
 * ⚠️ TENANCY IS FILTERED ON THE SNAPSHOTTED workspace_id, NOT ON CURRENT DEVICE MEMBERSHIP.
 *
 * The obvious filter — `device_id IN (SELECT id FROM devices WHERE workspace_id = ?)` — asks where
 * each device is NOW, and so re-creates on the read side exactly the leak the stored column exists
 * to prevent: a display moved from one client's workspace to another drags its entire play history
 * into the new tenant's reports and out of the previous tenant's. Both tables carry the workspace
 * the play actually happened in; that is what is matched here.
 *
 * Rows whose workspace could not be determined (an unattributed pre-migration row, a device
 * deleted before the backfill ran) match no tenant and are therefore invisible to tenant-scoped
 * reports. Showing them to an arbitrary workspace would be worse than omitting them.
 */
function hourlyRows({ startEpoch, endEpoch, workspaceId = null, deviceId = null }) {
  const scope = [];
  const scopeParams = [];
  // A request with no workspace context matches nothing, mirroring getWorkspaceDeviceSubquery's
  // `WHERE 1=0` — an unscoped read of this table is a cross-tenant export.
  if (!workspaceId) return [];
  scope.push('workspace_id = ?');
  scopeParams.push(workspaceId);
  if (deviceId) { scope.push('device_id = ?'); scopeParams.push(deviceId); }
  const scopeSql = scope.length ? ` AND ${scope.join(' AND ')}` : '';
  const floor = rawFloor();

  // Where the two sources meet. Everything below `split` comes from the rollup, everything at or
  // above it from raw. floor === null => no raw at all => rollup covers the whole range.
  const split = floor == null ? endEpoch + 1 : Math.max(startEpoch, floor);

  const out = [];

  if (split > startEpoch) {
    // Rollup side. hour_utc is the START of the hour, so an hour is in range when its start is
    // below `split`; it cannot straddle the seam because `split` is itself derived from raw rows.
    out.push(...db.prepare(`
      SELECT workspace_id, device_id,
             NULLIF(content_id, '') AS content_id,
             content_name, hour_utc,
             play_count AS plays,
             duration_sec AS seconds
        FROM play_log_hourly
       WHERE hour_utc >= ? AND hour_utc < ?${scopeSql}
    `).all(startEpoch, split, ...scopeParams));
  }

  if (floor != null && endEpoch >= split) {
    out.push(...db.prepare(`
      SELECT workspace_id, device_id, content_id, MAX(content_name) AS content_name,
             (started_at / ${HOUR}) * ${HOUR} AS hour_utc,
             COUNT(*) AS plays,
             COALESCE(SUM(duration_sec), 0) AS seconds
        FROM play_logs
       WHERE started_at >= ? AND started_at <= ?${scopeSql}
       GROUP BY workspace_id, device_id, content_id, hour_utc
    `).all(split, endEpoch, ...scopeParams));
  }

  return out;
}

/**
 * Each device's IANA zone, for local-day bucketing.
 *
 * reported_timezone is what the panel itself says and is the truth when present; `timezone` is the
 * operator-set column, which on the production fleet is 'UTC' for every one of 804 rows and so
 * carries no information. Neither is guaranteed — 46% of devices report nothing — so UTC is the
 * documented fallback rather than an error.
 */
function deviceZones() {
  const map = new Map();
  for (const r of db.prepare('SELECT id, reported_timezone, timezone FROM devices').all()) {
    map.set(r.id, r.reported_timezone || r.timezone || 'UTC');
  }
  return map;
}

/*
 * Formatter construction is the expensive part of Intl, not formatting, so one per zone is built
 * and reused across every row. A 90-day report is ~214k rows and a handful of distinct zones.
 *
 * An invalid or unknown zone throws inside the Intl constructor. A display reporting a zone this
 * Node build does not know must not fail the whole report, so it degrades to UTC.
 */
function zoneFormatter(cache, zone) {
  if (cache.has(zone)) return cache.get(zone);
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    });
  } catch (_) {
    fmt = zoneFormatter(cache, 'UTC');
  }
  cache.set(zone, fmt);
  return fmt;
}

/** { day: 'YYYY-MM-DD', hour: 0-23 } for an epoch second, in `zone`. */
function localParts(fmt, epochSec) {
  const parts = fmt.formatToParts(new Date(epochSec * 1000));
  let y = '', m = '', d = '', h = '0';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
    else if (p.type === 'hour') h = p.value;
  }
  // 'en-CA' with hour12:false renders midnight as 24 in some ICU versions; normalise so an hour
  // histogram has 24 buckets (0-23) rather than a phantom 24th that is really 0.
  const hour = Number(h) % 24;
  return { day: `${y}-${m}-${d}`, hour };
}

/**
 * Fold hourly rows into the shapes the summary report renders.
 *
 * `zones` maps device_id -> IANA zone; a device missing from it is bucketed in UTC.
 */
function summarise(rows, zones = new Map()) {
  const fmtCache = new Map();
  const byContent = new Map();
  const byDevice = new Map();
  const byDay = new Map();
  const byHour = new Array(24).fill(0);
  const contentIds = new Set();
  const deviceIds = new Set();
  let plays = 0, seconds = 0;

  for (const r of rows) {
    plays += r.plays;
    seconds += r.seconds;
    if (r.content_id) contentIds.add(r.content_id);
    deviceIds.add(r.device_id);

    const c = byContent.get(r.content_id) || { content_id: r.content_id, content_name: r.content_name, plays: 0, total_seconds: 0 };
    c.plays += r.plays; c.total_seconds += r.seconds;
    if (!c.content_name && r.content_name) c.content_name = r.content_name;
    byContent.set(r.content_id, c);

    const d = byDevice.get(r.device_id) || { device_id: r.device_id, plays: 0, total_seconds: 0 };
    d.plays += r.plays; d.total_seconds += r.seconds;
    byDevice.set(r.device_id, d);

    const { day, hour } = localParts(zoneFormatter(fmtCache, zones.get(r.device_id) || 'UTC'), r.hour_utc);
    const dd = byDay.get(day) || { day, plays: 0, total_seconds: 0 };
    dd.plays += r.plays; dd.total_seconds += r.seconds;
    byDay.set(day, dd);
    byHour[hour] += r.plays;
  }

  return {
    overall: {
      total_plays: plays,
      total_duration_sec: seconds,
      unique_content: contentIds.size,
      unique_devices: deviceIds.size,
      // Derived, because a mean of hourly means is not the mean. The rollup keeps SUM and COUNT
      // precisely so this stays exact once the raw rows behind it are gone.
      avg_duration_sec: plays ? seconds / plays : 0,
    },
    by_content: [...byContent.values()].sort((a, b) => b.plays - a.plays).slice(0, 50),
    by_device: [...byDevice.values()].sort((a, b) => b.plays - a.plays),
    by_day: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    by_hour: byHour.map((n, hour) => ({ hour, plays: n })),
  };
}

module.exports = { hourlyRows, summarise, deviceZones, rawFloor, HOUR };
