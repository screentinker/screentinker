'use strict';

/*
 * Proof-of-play rollup: aggregate raw play_logs into play_log_hourly so raw rows can be pruned
 * without throwing away the record.
 *
 * WHY THIS EXISTS. play_logs is 76% of a production database (1154 MB of 1.47 GB, measured
 * 2026-09-29) and growing 6.8x — 15.8k rows/day at 31-90 days old, 66.6k at 8-30, 107k in the
 * last week. At that rate a 90-day raw window reaches ~3.4 GB. Proof-of-play is wanted for years;
 * raw rows cannot be kept for years, and shortening retention on its own throws the record away.
 * So: aggregate first, then prune. Measured compression is 45x (2,384 rollup rows/day against
 * 107k raw), which is ~108 MB per YEAR.
 *
 * ── THE BUCKET IS AN HOUR, IN UTC ──────────────────────────────────────────────────────────────
 *
 * UTC because this must be idempotent. A device-local bucket is not: devices.reported_timezone is
 * mutable and NULL for 46% of the fleet, so recomputing an old period could place its rows in a
 * different bucket than the one already written — duplicating some and orphaning others. DST would
 * also make some local days 23 or 25 hours, quietly distorting per-day duration sums.
 *
 * HOURLY rather than daily because an hour can still be re-bucketed into any timezone at query
 * time and a day cannot. Once raw is pruned, a daily bucket has permanently chosen a timezone for
 * data nobody can recompute.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────────────────────────
 *
 * RAW IS NEVER PRUNED PAST THE WATERMARK. play_log_rollup_state.rolled_through_hour is advanced
 * only after the hours below it have been written, and services/heartbeat clamps its prune cutoff
 * to it. Ordering the two operations correctly is not enough on its own — a crash between them, or
 * a future edit that reorders the calls, would silently delete unaggregated plays. The watermark
 * makes "aggregate before you delete" checkable at the moment of deletion rather than a convention
 * two files apart.
 *
 * An hour with no plays produces no rollup row, so presence-of-rows cannot serve as the marker: a
 * quiet hour would be unprunable for ever. The watermark records the hour itself.
 *
 * ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────
 *
 * Every hour is recomputed from raw and UPSERTed, never incremented. Re-running over an hour
 * already written produces byte-identical rows, so a retry after a crash, a double invocation, or
 * a manual backfill are all safe. Incrementing would double-count on exactly those paths.
 *
 * The key includes workspace_id READ FROM THE RAW ROW, not resolved by joining devices — see the
 * column's note in db/database.js. Joining would re-attribute a moved device's history to its new
 * tenant on every recompute, which is cross-tenant leakage and, once raw is pruned, permanent.
 */

const { db } = require('../db/database');
const config = require('../config');

const HOUR = 3600;

/** Hours are only rolled up once they are COMPLETE — a partial hour would be rewritten later. */
function lastCompleteHour(nowSec = Math.floor(Date.now() / 1000)) {
  return Math.floor(nowSec / HOUR) * HOUR - HOUR;
}

function watermark() {
  const row = db.prepare('SELECT rolled_through_hour FROM play_log_rollup_state WHERE id = 1').get();
  return row ? row.rolled_through_hour : 0;
}

function setWatermark(hour, nowSec = Math.floor(Date.now() / 1000)) {
  db.prepare('UPDATE play_log_rollup_state SET rolled_through_hour = ?, updated_at = ? WHERE id = 1')
    .run(hour, nowSec);
}

/*
 * ⚠️ COALESCE, NOT THE RAW VALUE. workspace_id and content_id are nullable on play_logs (a widget
 * play has no content, a device with no workspace has no tenant) and the rollup's PRIMARY KEY
 * spans both. SQLite permits NULLs in a non-INTEGER primary key and two NULLs never compare equal,
 * so a NULL in the key would make ON CONFLICT never match — inserting a fresh duplicate row on
 * every single recompute instead of upserting, which is precisely the non-idempotency this module
 * promises not to have. The '' sentinel gives those rows a comparable identity.
 */
const _rollupHour = db.prepare(`
  INSERT INTO play_log_hourly
    (workspace_id, device_id, content_id, hour_utc, content_name, play_count, duration_sec, first_play, last_play)
  SELECT
    COALESCE(workspace_id, ''),
    device_id,
    COALESCE(content_id, ''),
    (started_at / ${HOUR}) * ${HOUR},
    MAX(content_name),
    COUNT(*),
    COALESCE(SUM(duration_sec), 0),
    MIN(started_at),
    MAX(started_at)
  FROM play_logs
  WHERE started_at >= ? AND started_at < ?
  GROUP BY 1, 2, 3, 4
  ON CONFLICT(workspace_id, device_id, content_id, hour_utc) DO UPDATE SET
    content_name = excluded.content_name,
    play_count   = excluded.play_count,
    duration_sec = excluded.duration_sec,
    first_play   = excluded.first_play,
    last_play    = excluded.last_play
`);

/**
 * Roll up every complete hour between the watermark and now.
 *
 * Each hour is its own transaction: the rows for that hour and the watermark advance together, so
 * an interruption leaves a consistent state and the next run resumes from exactly where it stopped
 * rather than redoing everything (though redoing it would also be harmless — see IDEMPOTENCE).
 *
 * `maxHours` bounds one invocation. A server that has been down for a week, or a fresh install
 * adopting an existing database, would otherwise try to aggregate months in a single synchronous
 * pass; the sweep runs again on the next tick and catches up over several.
 */
function rollupOnce({ maxHours = 48, now = Math.floor(Date.now() / 1000) } = {}) {
  const target = lastCompleteHour(now);
  let from = watermark();

  // First ever run: start at the oldest raw row rather than 1970, which would otherwise loop
  // through half a century of empty hours before reaching any data.
  if (from === 0) {
    const oldest = db.prepare('SELECT MIN(started_at) AS t FROM play_logs').get();
    if (!oldest || oldest.t == null) { setWatermark(target, now); return { hours: 0, rows: 0, upTo: target }; }
    from = Math.floor(oldest.t / HOUR) * HOUR;
  }

  let hours = 0, rows = 0;
  for (let h = from; h <= target && hours < maxHours; h += HOUR) {
    const hour = h;
    rows += db.transaction(() => {
      const changes = _rollupHour.run(hour, hour + HOUR).changes;
      setWatermark(hour, now);
      return changes;
    })();
    hours++;
  }
  return { hours, rows, upTo: watermark() };
}

/**
 * The cutoff services/heartbeat may prune raw rows below.
 *
 * ⚠️ CLAMPED TO THE WATERMARK. Retention alone is not a safe cutoff: if the rollup has not caught
 * up (a long outage, a slow first run over an adopted database, an exception in the sweep), the
 * retention cutoff would be newer than the aggregated data and the prune would delete plays that
 * were never counted. Returning the earlier of the two makes the prune wait for the rollup instead.
 */
function prunableBefore(now = Math.floor(Date.now() / 1000)) {
  const retention = now - Math.round(config.playLogRetentionDays * 86400);
  const rolled = watermark();
  // +HOUR: the watermark names the last hour WRITTEN, so everything strictly below its end is safe.
  return Math.min(retention, rolled > 0 ? rolled + HOUR : 0);
}

module.exports = { rollupOnce, prunableBefore, watermark, setWatermark, lastCompleteHour, HOUR };
