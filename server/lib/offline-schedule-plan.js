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
const CACHE_LIMIT = 128;
const cache = new Map();

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

  const validUntil = intervals.length ? intervals[intervals.length - 1].end_utc_ms : start;

  return {
    protocol_version: 1,
    generated_at_utc_ms: start,
    valid_until_utc_ms: validUntil,
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

/*
 * Reconnects and publish fan-out can ask for a plan repeatedly while its
 * schedule inputs are unchanged. Cache an hour-aligned source timeline and
 * clip it to the current instant. The cache never changes a schedule verdict:
 * callers include every resolver/schedule revision in `key`, and the first
 * interval is clipped rather than replayed from the hour boundary.
 */
function buildCached({ key, now = Date.now(), ...options }) {
  const hour = Math.floor(Number(now) / (60 * MINUTE_MS)) * 60 * MINUTE_MS;
  const cacheKey = `${String(key)}|${hour}`;
  let source = cache.get(cacheKey);
  if (!source) {
    source = build({ ...options, now: hour, horizonMs: (Number(options.horizonMs) || DEFAULT_HORIZON_MS) + (60 * MINUTE_MS) });
    cache.set(cacheKey, source);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  const start = Number(now);
  const intervals = source.intervals.filter((i) => i.end_utc_ms > start).map((i) => ({
    ...i, start_utc_ms: Math.max(start, i.start_utc_ms),
  }));
  return { ...source, generated_at_utc_ms: start, valid_until_utc_ms: intervals.length ? intervals[intervals.length - 1].end_utc_ms : start, intervals };
}

function clearCache() { cache.clear(); }

module.exports = { MINUTE_MS, DEFAULT_HORIZON_MS, MAX_INTERVALS, build, buildCached, clearCache };
