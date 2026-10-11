'use strict';

/*
 * A UTC-offset table for one IANA zone, for a player that has no time-zone database of its own.
 *
 * The Roku is the reason (docs/roku-player.md): roDateTime only knows the zone the BOX is set to,
 * while a screen's schedules, power windows and clock must follow the zone set in the dashboard
 * (lib/device-timezone.js effectiveDeviceTz). So the server, which has full ICU, does the zone
 * arithmetic and sends the answer:
 *
 *   { zone: 'America/Chicago', generated_ms, spans: [ { from_ms, offset_min }, ... ] }
 *
 * Each span lasts until the next one's from_ms; the last is open-ended. The table covers from 24 h
 * before `now` to at least 72 h after it, and the player re-registers every 6 h (and on every
 * reconnect), so it never runs out in practice. A player past the end keeps using the last span —
 * wrong only if a transition falls in a gap the player failed to refresh across for three days.
 *
 * HOW THE TRANSITIONS ARE FOUND. Intl has no "list the transitions" API, so the offset is sampled
 * every hour across the window, and wherever two neighbouring samples disagree the exact minute is
 * found by binary search between them. Every real transition is on a whole minute, and no zone has
 * ever had two inside one hour, so hourly sampling cannot miss one. Minute precision is what the
 * schedules need (they are HH:MM).
 *
 * ⚠️ ANCHORED TO THE HOUR, NOT TO THE MILLISECOND. The window starts and generated_ms is stamped at
 * `now` floored to the hour, so every payload built within the same hour carries a byte-identical
 * table. A table stamped with Date.now() would make every rebuild of the playlist payload differ
 * from the last for no reason, and anything that compares payloads would see a change that is not
 * one. Flooring costs nothing: the window still reaches 72 h past the real `now` (it runs 73 h past
 * the floored hour).
 *
 * ⚠️ An unknown or invalid zone becomes UTC, never an error: a payload must always be buildable,
 * and UTC is what every player falls back to when it knows nothing else. The table says which zone
 * it actually describes (`zone`), so the substitution is visible rather than silent.
 */

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const BEFORE_MS = 24 * HOUR_MS;
const AFTER_MS = 73 * HOUR_MS;   // 72 h past `now` from an anchor up to an hour earlier

const formatters = new Map();   // zone -> Intl.DateTimeFormat; ICU formatters are costly to build
/*
 * zone|anchor -> table. A table costs a few ms (~100 ICU formats) and is identical for every screen
 * in the same zone for the whole hour, while a fleet-wide playlist push builds one per Roku. Small
 * and self-clearing: a new hour simply makes the old keys unreachable and the cap drops them.
 */
const tables = new Map();
const TABLES_MAX = 256;

function validZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return null; }
}

function formatterFor(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    // Bounded by the number of real zones (~600), and only zones screens are actually set to.
    if (formatters.size < 1000) formatters.set(zone, f);
  }
  return f;
}

/**
 * The zone's offset from UTC, in whole minutes (east positive: Kolkata +330, Chicago -300/-360),
 * at instant `ms`.
 */
function offsetMinutes(zone, ms) {
  const z = validZone(zone) || 'UTC';
  const at = Math.floor(ms / 1000) * 1000;   // the wall clock has no milliseconds to compare
  const p = {};
  for (const part of formatterFor(z).formatToParts(new Date(at))) p[part.type] = part.value;
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((wall - at) / MIN_MS);
}

/*
 * The first whole minute in (lo, hi] whose offset is not `before`. lo has offset `before`, hi does
 * not; both are minute-aligned.
 */
function transitionMinute(zone, lo, hi, before) {
  while (hi - lo > MIN_MS) {
    const mid = lo + Math.floor((hi - lo) / MIN_MS / 2) * MIN_MS;
    if (offsetMinutes(zone, mid) === before) lo = mid; else hi = mid;
  }
  return hi;
}

/**
 * The offset table for `zone` around `nowMs`.
 *
 * @param {string} zone   IANA zone; anything invalid (or empty) yields a UTC table
 * @param {number} [nowMs]
 * @returns {{ zone: string, generated_ms: number, spans: { from_ms: number, offset_min: number }[] }}
 */
function tzTable(zone, nowMs = Date.now()) {
  const z = validZone(zone) || 'UTC';
  const anchor = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const key = `${z}|${anchor}`;
  const hit = tables.get(key);
  // A copy, so a caller that edits the payload it was handed cannot poison the next screen's.
  if (hit) return { zone: hit.zone, generated_ms: hit.generated_ms, spans: hit.spans.map((x) => ({ ...x })) };
  const start = anchor - BEFORE_MS;
  const end = anchor + AFTER_MS;

  let current = offsetMinutes(z, start);
  const spans = [{ from_ms: start, offset_min: current }];
  for (let t = start; t < end; t += HOUR_MS) {
    const next = offsetMinutes(z, t + HOUR_MS);
    // A loop rather than one search so that two changes inside one hour (none exists in tzdata)
    // would still each get a span: every pass starts from the minute the previous one found.
    let lo = t;
    while (next !== current) {
      const at = transitionMinute(z, lo, t + HOUR_MS, current);
      current = offsetMinutes(z, at);
      spans.push({ from_ms: at, offset_min: current });
      lo = at;
    }
  }
  const table = { zone: z, generated_ms: anchor, spans };
  if (tables.size >= TABLES_MAX) tables.clear();
  tables.set(key, table);
  return { zone: z, generated_ms: anchor, spans: spans.map((x) => ({ ...x })) };
}

module.exports = { tzTable, offsetMinutes, validZone };
