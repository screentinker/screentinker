'use strict';

/*
 * #299 — the rules for accepting a play a PLAYER recorded while it was offline.
 *
 * ⚠️ THESE TIMESTAMPS COME FROM THE PANEL, AND THE PANEL'S CLOCK IS NOT TRUSTWORTHY. A live play
 * is stamped by the server (`strftime('%s','now')`), which is why nothing here was needed before.
 * A backfilled play cannot be: the whole point is that it happened hours ago, so the player has to
 * say when — and a signage panel with a dead RTC or no NTP will cheerfully report 1970, or next
 * year, or a duration of eleven days.
 *
 * A wrong timestamp is worse than a missing row. A gap is visibly a gap; a play stamped 1970 is
 * indistinguishable from real data in a report an advertiser is billed from. So anything outside a
 * defensible window is DROPPED rather than clamped into looking plausible.
 *
 * Pure and clock-injected, so the rules can be tested without a socket, a database or a real clock
 * — the same shape as lib/incident-classify next door, and for the same reason: the handler calls
 * exactly this, so the tests and the live path cannot disagree.
 */

/** At most this many plays are accepted from one flush; a player drains a backlog across batches. */
const MAX_BACKFILL_BATCH = 500;
/** Older than this is a broken clock, not an outage anyone is reporting. */
const BACKFILL_MAX_AGE_SEC = 30 * 24 * 60 * 60;
/** Mild skew is tolerated; a future date is not. */
const BACKFILL_FUTURE_SKEW_SEC = 5 * 60;
/** A single item playing for longer than a day is nonsense, however sincerely reported. */
const BACKFILL_MAX_DURATION_SEC = 24 * 60 * 60;
/*
 * Inference caps (see closeStrandedPlays). Deliberately far tighter than the backfill cap above:
 * a backfilled play states its own end, while an inferred one is derived from a gap that may
 * contain hours of downtime the item was not playing through.
 */
const INFER_GRACE_SEC = 60;            // slack over a known length: rounding, a stalled decoder
const INFER_UNKNOWN_MAX_SEC = 60 * 60; // widgets/images with no stored length

/**
 * Validate and normalise one offline play.
 *
 * @param {object} p       the player's record
 * @param {number} nowSec  current epoch seconds (injected)
 * @returns {object|null}  a row-shaped object, or null if it must not be stored
 */
function normalizeBackfillPlay(p, nowSec) {
  if (!p || typeof p !== 'object') return null;

  const startedAt = Number(p.started_at);
  if (!Number.isFinite(startedAt)) return null;
  if (startedAt > nowSec + BACKFILL_FUTURE_SKEW_SEC) return null;
  if (startedAt < nowSec - BACKFILL_MAX_AGE_SEC) return null;

  /*
   * An end that is missing, before its start, or in the future leaves the row OPEN (ended_at
   * null) rather than being repaired into something plausible. An open row is honest about not
   * knowing when the play finished; a fabricated end is not.
   */
  let endedAt = Number(p.ended_at);
  if (!Number.isFinite(endedAt) || endedAt < startedAt || endedAt > nowSec + BACKFILL_FUTURE_SKEW_SEC) {
    endedAt = null;
  }
  const durationSec = endedAt === null
    ? null
    : Math.min(endedAt - startedAt, BACKFILL_MAX_DURATION_SEC);

  return {
    started_at: Math.floor(startedAt),
    ended_at: endedAt === null ? null : Math.floor(endedAt),
    duration_sec: durationSec === null ? null : Math.floor(durationSec),
    completed: p.completed ? 1 : 0,
    content_id: p.content_id || null,
    widget_id: p.widget_id || null,
    zone_id: p.zone_id || null,
    content_name: p.content_name || 'Unknown',
    client_event_id: p.client_event_id || null,
  };
}

/** Cap a flush. Returns the slice that may be processed. */
function boundBatch(plays) {
  return Array.isArray(plays) ? plays.slice(0, MAX_BACKFILL_BATCH) : [];
}

/**
 * Close plays that were left open, using the start of the play that followed.
 *
 * ⚠️ WHY THIS IS SOUND, NOT A GUESS. A play row is opened by play_start and closed by play_end. If
 * the link drops between them the close is lost and the row stays open forever with no duration —
 * one per outage, plus every reboot mid-item. But the device advancing to another item is itself
 * proof the previous one ran until that moment: the successor's started_at IS the predecessor's
 * end. Nothing is invented; the evidence was already in the table.
 *
 * ⚠️ ONLY WHERE A SUCCESSOR EXISTS. The item genuinely playing right now is the newest row and has
 * none, so it is left open — which is correct, it has not ended.
 *
 * ⚠️ AND ONLY FOR AS LONG AS THE ITEM COULD PLAUSIBLY HAVE PLAYED. This is the guard that matters
 * most, and a blanket 24h cap was NOT enough: on alpha it closed a 20-second clip with 31,368
 * seconds — 8.7 hours of "runtime" for one clip — because the device had been offline in between
 * with no backfill available, so the next play was the following morning. That is precisely the
 * fabricated-data failure this module refuses elsewhere.
 *
 * So the cap is taken from the CONTENT'S OWN LENGTH where we know it: a 20-second clip cannot have
 * played for eight hours, whatever the gap says. Where the length is unknown (widgets, images with
 * an operator-set dwell) a modest absolute cap applies instead. Beyond it the row stays open, which
 * is honest — a missing duration reads as missing; an invented one reads as fact.
 *
 * `completed` is deliberately NOT set. We have evidence it played for that long, not evidence it
 * ran to its end — an error-advance looks identical from here. Duration is the number reports are
 * built on; claiming completion would be asserting more than the data supports.
 *
 * @returns {number} rows closed
 */
function closeStrandedPlays(db, deviceId, unknownMaxSec = INFER_UNKNOWN_MAX_SEC) {
  /*
   * The per-row ceiling is computed INSIDE the subquery. SQLite's UPDATE ... FROM cannot see the
   * target table from a join in the FROM list, so joining `content` against play_logs.content_id
   * out there fails with "no such column: play_logs.content_id".
   */
  const info = db.prepare(`
    UPDATE play_logs
       SET ended_at = nxt.next_start,
           duration_sec = nxt.next_start - play_logs.started_at
      FROM (SELECT p.id           AS id,
                   p.started_at   AS p_started,
                   MIN(n.started_at) AS next_start,
                   CASE WHEN c.duration_sec IS NOT NULL AND c.duration_sec > 0
                        THEN c.duration_sec + ?
                        ELSE ?
                   END AS allowed
              FROM play_logs p
              LEFT JOIN content c ON c.id = p.content_id
              JOIN play_logs n
                ON n.device_id = p.device_id
               AND n.started_at > p.started_at
               -- SAME ZONE ONLY. A multi-zone device plays several items AT ONCE, so the next row
               -- for the device can belong to a different zone that started while this one was
               -- still on screen. Closing against it would cut the play short and under-report it.
               -- IS rather than = so the fullscreen case (zone_id NULL) matches itself.
               -- (No backticks in here: this is a JS template literal and they would end it.)
               AND n.zone_id IS p.zone_id
             WHERE p.device_id = ? AND p.ended_at IS NULL
             GROUP BY p.id) AS nxt
     WHERE play_logs.id = nxt.id
       -- The item's OWN length is the ceiling where we know it; a 20s clip cannot have played for
       -- hours however long the gap says. Anything beyond stays open rather than being credited
       -- with downtime it slept through.
       AND nxt.next_start - nxt.p_started <= nxt.allowed
  `).run(INFER_GRACE_SEC, unknownMaxSec, deviceId);
  return info.changes;
}

/**
 * Close plays that have been open longer than they could possibly have played.
 *
 * ⚠️ THE LEAK closeStrandedPlays CANNOT REACH, and it is not small: prod carries 36,096 open rows,
 * 35,982 of them more than a day old, the oldest from June.
 *
 * closeStrandedPlays infers an end from THE NEXT PLAY on the same device and zone. That is the
 * better answer when it exists — it is a measurement rather than an assumption — but it needs a
 * next row, and it deliberately leaves the row open when the gap exceeds the item's own length,
 * rather than crediting a screen with hours it spent switched off. Both are right. The consequence
 * is that the last play before a device goes quiet, and every play interrupted by a power cut, is
 * left open with nothing that will ever revisit it.
 *
 * So this is the other half: once a play has been open longer than its own content could have run,
 * the end event is never arriving. It is closed AT ITS CEILING — started_at + its own length —
 * which keeps the original promise that downtime is never credited as playback, while ending the
 * row. `completed` is set to 0 because we do not know that it finished; only that it stopped.
 *
 * ⚠️ CHUNKED, and that is the lesson of this very issue. This runs against a table with 1.44M rows
 * on a synchronous driver; an unbounded UPDATE here would be the thing it was written to prevent.
 */
function expireStrandedPlays(db, opts = {}) {
  const limit = opts.limit || 500;
  const graceSec = opts.graceSec == null ? INFER_GRACE_SEC : opts.graceSec;
  const unknownMaxSec = opts.unknownMaxSec == null ? INFER_UNKNOWN_MAX_SEC : opts.unknownMaxSec;
  const now = opts.now == null ? Math.floor(Date.now() / 1000) : opts.now;

  /*
   * The ceiling is computed in the subquery for the same reason closeStrandedPlays does it there:
   * SQLite's UPDATE ... FROM cannot see the target table from a join in the FROM list.
   */
  const info = db.prepare(`
    UPDATE play_logs
       SET ended_at = exp.deadline,
           duration_sec = exp.deadline - play_logs.started_at,
           completed = 0
      FROM (SELECT p.id AS id,
                   p.started_at + CASE
                     WHEN c.duration_sec IS NOT NULL AND c.duration_sec > 0 THEN c.duration_sec + ?
                     ELSE ?
                   END AS deadline
              FROM play_logs p
              LEFT JOIN content c ON c.id = p.content_id
             WHERE p.ended_at IS NULL
               AND p.started_at + CASE
                     WHEN c.duration_sec IS NOT NULL AND c.duration_sec > 0 THEN c.duration_sec + ?
                     ELSE ?
                   END < ?
             LIMIT ?) AS exp
     WHERE play_logs.id = exp.id
  `).run(graceSec, unknownMaxSec, graceSec, unknownMaxSec, now, limit);
  return info.changes;
}

module.exports = {
  normalizeBackfillPlay,
  boundBatch,
  closeStrandedPlays,
  expireStrandedPlays,
  MAX_BACKFILL_BATCH,
  BACKFILL_MAX_AGE_SEC,
  BACKFILL_FUTURE_SKEW_SEC,
  BACKFILL_MAX_DURATION_SEC,
  INFER_GRACE_SEC,
  INFER_UNKNOWN_MAX_SEC,
};
