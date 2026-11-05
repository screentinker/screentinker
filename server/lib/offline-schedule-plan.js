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

function hmMinute(stamp) {
  const m = /T(\d{2}):(\d{2})/.exec(String(stamp || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function sameLocal(parts, y, mo, day, min) {
  return parts && parts.y === y && parts.mo === mo && parts.day === day && parts.min === min;
}

// `makeClock` exposes offsetAt(), letting us turn a local schedule edge back
// into one or two UTC instants without walking every minute. A repeated DST
// hour intentionally yields both candidates; a skipped local minute yields
// none, matching what the live UTC->local scheduler can observe.
function utcCandidatesForLocal(clock, y, mo, day, min) {
  if (!clock || typeof clock.offsetAt !== 'function') return [];
  const naive = Date.UTC(y, mo - 1, day, Math.floor(min / 60), min % 60);
  const candidates = new Set();
  for (const delta of [-12, -3, 0, 3, 12]) {
    const probe = naive + delta * 60 * MINUTE_MS;
    const candidate = naive - clock.offsetAt(probe);
    if (sameLocal(clock(candidate), y, mo, day, min)) candidates.add(candidate);
  }
  return [...candidates];
}

function transitionCandidates(schedules, clock, start, end) {
  const first = clock(start);
  if (!first) return [];
  const edges = new Set([0]);
  for (const schedule of schedules) {
    const a = hmMinute(schedule.start_time), b = hmMinute(schedule.end_time);
    if (a !== null) edges.add(a);
    if (b !== null) edges.add((b + 1) % 1440); // live end minute is inclusive
  }
  const out = new Set([start, end]);
  // Horizon is capped at 14 days, so this is bounded by days × schedule edges,
  // not by 20,160 minute evaluations.
  for (let i = 0; i <= 15; i++) {
    const d = new Date(Date.UTC(first.y, first.mo - 1, first.day + i));
    for (const min of edges) {
      for (const candidate of utcCandidatesForLocal(clock, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), min)) {
        if (candidate > start && candidate < end) out.add(candidate);
      }
    }
  }
  /* A skipped local edge has no UTC inverse (for example 02:30 at US spring
   * forward).  The live resolver nevertheless becomes active at the actual
   * offset-change instant, so include every bounded offset transition. */
  if (clock && typeof clock.offsetAt === 'function') {
    const bucket = 15 * MINUTE_MS;
    let previous = clock.offsetAt(Math.floor(start / bucket) * bucket);
    for (let instant = Math.floor(start / bucket) * bucket + bucket; instant < end; instant += bucket) {
      const next = clock.offsetAt(instant);
      if (next !== previous && instant > start) out.add(instant);
      previous = next;
    }
  }
  return [...out].sort((a, b) => a - b);
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

  const boundaries = useLocalParts ? transitionCandidates(candidates, clock, start, end)
    : (() => { const out = []; for (let boundary = nextMinute(cursor); boundary < end; boundary += MINUTE_MS) out.push(boundary); return out; })();
  for (const boundary of boundaries) {
    if (boundary <= start || boundary >= end) continue;
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
