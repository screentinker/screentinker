'use strict';

/*
 * A panel cannot safely infer a future schedule from its last active playlist.
 * This module turns the server's already-authoritative schedule resolver into a
 * compact UTC timeline. The plan is intentionally minute-granular because the
 * scheduler's persisted wall-clock model is minute-granular too.
 */
const MINUTE_MS = 60 * 1000;
const DEFAULT_HORIZON_MS = 14 * 24 * 60 * MINUTE_MS;
const MAX_INTERVALS = 1024;

function nextMinute(ms) {
  return Math.floor(ms / MINUTE_MS + 1) * MINUTE_MS;
}

function stateKey(schedule) {
  if (!schedule) return '';
  return String(schedule.id || '') + '|' + String(schedule.playlist_id || '') + '|' + String(schedule.layout_id || '');
}

/**
 * Produce half-open UTC intervals [start_utc_ms, end_utc_ms).
 *
 * `pick` is the compatibility path and receives a Date plus timezone. Timeline
 * callers should supply `pickAt` and `clock`: they use the same scheduler
 * verdict with pre-resolved local parts and avoid tens of thousands of blocking
 * Intl conversions.
 */
function build({ schedules, timezone, now = Date.now(), horizonMs = DEFAULT_HORIZON_MS, pick, pickAt, clock }) {
  const useLocalParts = typeof pickAt === 'function' && typeof clock === 'function';
  if (!useLocalParts && typeof pick !== 'function') {
    throw new TypeError('offline schedule plan requires pick, or pickAt with a clock');
  }
  const candidates = schedules || [];
  const select = useLocalParts
    ? (ms) => pickAt(candidates, clock(ms), timezone)
    : (ms) => pick(candidates, new Date(ms), timezone);
  const start = Number(now);
  const end = start + Math.max(MINUTE_MS, Math.min(Number(horizonMs) || DEFAULT_HORIZON_MS, DEFAULT_HORIZON_MS));
  const intervals = [];
  let cursor = start;
  let current = select(cursor) || null;
  let key = stateKey(current);

  for (let boundary = nextMinute(cursor); boundary < end; boundary += MINUTE_MS) {
    const next = select(boundary) || null;
    const nextKey = stateKey(next);
    if (nextKey !== key) {
      intervals.push({ start_utc_ms: cursor, end_utc_ms: boundary, schedule: current });
      if (intervals.length >= MAX_INTERVALS) break;
      cursor = boundary;
      current = next;
      key = nextKey;
    }
  }
  if (cursor < end && intervals.length < MAX_INTERVALS) intervals.push({ start_utc_ms: cursor, end_utc_ms: end, schedule: current });

  return {
    protocol_version: 1,
    generated_at_utc_ms: start,
    valid_until_utc_ms: end,
    timezone: timezone || null,
    intervals: intervals.map(({ start_utc_ms, end_utc_ms, schedule }) => ({
      start_utc_ms,
      end_utc_ms,
      schedule_id: schedule ? schedule.id || null : null,
      playlist_id: schedule ? schedule.playlist_id || null : null,
      layout_id: schedule ? schedule.layout_id || null : null,
    })),
  };
}

module.exports = { MINUTE_MS, DEFAULT_HORIZON_MS, MAX_INTERVALS, build };
