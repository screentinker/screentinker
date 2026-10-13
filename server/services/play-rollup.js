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
  repairOnce();
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
  const re = rerollDirty();
  return { hours, rows, upTo: watermark(), rerolled: re.rerolled, dirtyLeft: re.left };
}

/* ─────────────────────────── late writes: recompute dirty hours ─────────────────────────── */

/** Where the prune has deleted up to: every raw row below this hour is gone. 0 = never pruned. */
function rawFloor() {
  const row = db.prepare('SELECT raw_floor_hour FROM play_log_rollup_state WHERE id = 1').get();
  return row ? row.raw_floor_hour : 0;
}

/**
 * Raise the raw floor. Called by the prune BEFORE it deletes, so the delete trigger knows those
 * rows are being aged out rather than removed (see db/database.js). Never lowered: rows below it
 * are gone whatever retention is set to later.
 */
function setRawFloor(hour) {
  db.prepare('UPDATE play_log_rollup_state SET raw_floor_hour = MAX(raw_floor_hour, ?) WHERE id = 1')
    .run(Math.floor(hour / HOUR) * HOUR);
}

/**
 * The first hour whose raw rows are all still on disk; only hours from here on can be recomputed.
 * Exact, because the prune deletes whole hours and raises the floor first. 0 on an install that has
 * never pruned, where every hour is whole.
 */
function recomputableFrom() {
  return rawFloor();
}

/**
 * One-time, on upgrade: where the floor is on a database pruned by the OLD prune, which stopped
 * mid-hour wherever retention fell. The oldest surviving row's hour is therefore assumed partial
 * (scripts/verify-play-rollup.js assumes the same), and with no raw left at all nothing rolled up
 * is recomputable.
 */
function initRawFloorFromLegacyPrune() {
  if (rawFloor() > 0) return rawFloor();
  const oldest = db.prepare('SELECT MIN(started_at) AS t FROM play_logs').get();
  const wm = watermark();
  if (oldest && oldest.t != null) setRawFloor(Math.floor(oldest.t / HOUR) * HOUR + HOUR);
  else if (wm > 0) setRawFloor(wm + HOUR);
  return rawFloor();
}

const _rerollHour = db.transaction((hour) => {
  // Delete first: an UPSERT alone leaves behind groups that no longer exist in raw (a deleted
  // device, a content id SET NULL), which is exactly the overcounting this exists to fix.
  db.prepare('DELETE FROM play_log_hourly WHERE hour_utc >= ? AND hour_utc < ?').run(hour, hour + HOUR);
  _rollupHour.run(hour, hour + HOUR);
  db.prepare('DELETE FROM play_log_rollup_dirty WHERE hour_utc = ?').run(hour);
});

/**
 * Recompute dirty hours from raw, oldest first, until the time budget is spent. Runs on the
 * maintenance sweep, so it is bounded: each hour is one indexed range over play_logs, but a deploy
 * that marks every hour (markAllForReroll) leaves thousands queued, and they drain over many sweeps.
 *
 * A dirty hour that is not rolled up yet is simply dropped: the forward pass will compute it. One
 * below recomputableFrom() is dropped too — its raw is partly or wholly pruned, so the aggregate is
 * the better record — and counted, because that is a play reported later than retention allows.
 */
function rerollDirty({ budgetMs = 50, maxHours = 24 } = {}) {
  const started = Date.now();
  const wm = watermark();
  const from = recomputableFrom();
  let rerolled = 0, dropped = 0;
  const hours = db.prepare('SELECT hour_utc FROM play_log_rollup_dirty ORDER BY hour_utc LIMIT ?').all(maxHours);
  for (const { hour_utc: hour } of hours) {
    if (hour > wm || hour < from) {
      db.prepare('DELETE FROM play_log_rollup_dirty WHERE hour_utc = ?').run(hour);
      if (hour < from) dropped++;
    } else {
      _rerollHour(hour);
      rerolled++;
    }
    if (Date.now() - started >= budgetMs) break;
  }
  if (dropped) console.warn(`[play-rollup] ${dropped} late write(s) landed in hours whose raw is already pruned; the aggregate is kept`);
  const left = db.prepare('SELECT COUNT(*) AS n FROM play_log_rollup_dirty').get().n;
  return { rerolled, dropped, left };
}

/*
 * Once per database: aggregates written before late writes were tracked are wrong wherever raw
 * changed after its hour was rolled up, so set the floor and queue every hour that can still be
 * recomputed. schema_migrations, not a boot flag, so it runs exactly once, on the first sweep.
 */
const REPAIR_ID = 'play_rollup_late_writes_reroll_v1';
let _repairChecked = false;
function repairOnce() {
  if (_repairChecked) return;
  _repairChecked = true;
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(REPAIR_ID)) return;
  db.transaction(() => {
    initRawFloorFromLegacyPrune();
    const n = markAllForReroll();
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(REPAIR_ID);
    if (n) console.log(`[play-rollup] queued ${n} hour(s) to recompute from raw (late-write repair)`);
  })();
}

/**
 * Queue every recomputable rolled-up hour. One-time repair for aggregates written before late
 * writes were tracked (db/database.js runs it once); the sweep then drains the queue.
 */
function markAllForReroll() {
  const from = recomputableFrom();
  const wm = watermark();
  if (!(wm > 0) || from > wm) return 0;
  // An install that never pruned has floor 0: start at its first play, not at 1970.
  const first = from > 0 ? from : (() => {
    const o = db.prepare('SELECT MIN(started_at) AS t FROM play_logs').get();
    return o && o.t != null ? Math.floor(o.t / HOUR) * HOUR : wm + HOUR;
  })();
  let n = 0;
  const ins = db.prepare('INSERT OR IGNORE INTO play_log_rollup_dirty (hour_utc) VALUES (?)');
  db.transaction(() => { for (let h = first; h <= wm; h += HOUR) n += ins.run(h).changes; })();
  return n;
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

module.exports = {
  rollupOnce, prunableBefore, watermark, setWatermark, lastCompleteHour, HOUR,
  rerollDirty, markAllForReroll, rawFloor, setRawFloor, recomputableFrom, initRawFloorFromLegacyPrune,
  __resetRepairForTests: () => { _repairChecked = false; },
};
