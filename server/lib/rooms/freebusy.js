'use strict';

/*
 * Free/busy for a meeting room, from a list of events. Pure, and the SAME function runs in two
 * places: here on the server (to answer the panel and to check a booking), and inside the room
 * display page itself (lib/rooms/render.js inlines its source), so a screen keeps flipping from
 * FREE to BUSY on time with the server unreachable. Self-contained for that reason: no closures,
 * no requires, plain ES2017.
 *
 * events: [{ id, start, end, free, allDay, ... }] with start/end in epoch ms. Half-open intervals:
 * a meeting that ends at 10:00 is over AT 10:00, and one that starts then has begun.
 *
 * Returns {
 *   busy,          true when a non-free event covers now
 *   current,       the event to show while busy (the most specific one: timed over all-day, then
 *                  the latest to have started — a 10:00 meeting inside an all-day block is the news)
 *   busyUntil,     when the room is next free (contiguous and overlapping busy events merged)
 *   next,          the next busy event that starts after now (not part of the current one)
 *   freeUntil,     while free: when the next busy event starts, or null (free for the window)
 *   upcoming,      busy events still to come today or later, in order (including current)
 * }
 */
function computeRoomState(events, nowMs) {
  var list = [];
  for (var i = 0; i < (events || []).length; i++) {
    var e = events[i];
    if (!e || e.free || e.cancelled) continue;
    if (!(typeof e.start === 'number' && typeof e.end === 'number') || !(e.end > e.start)) continue;
    list.push(e);
  }
  list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });

  var ongoing = list.filter(function (e) { return e.start <= nowMs && nowMs < e.end; });
  var current = null;
  if (ongoing.length) {
    current = ongoing.slice().sort(function (a, b) {
      if (!!a.allDay !== !!b.allDay) return a.allDay ? 1 : -1;
      return b.start - a.start;
    })[0];
  }

  var busyUntil = null;
  if (ongoing.length) {
    busyUntil = Math.max.apply(null, ongoing.map(function (e) { return e.end; }));
    // Extend across back-to-back and overlapping meetings: the room is not "free at 10:00" if the
    // next meeting starts at 10:00.
    var grew = true;
    while (grew) {
      grew = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j].start <= busyUntil && list[j].end > busyUntil) { busyUntil = list[j].end; grew = true; }
      }
    }
  }

  var next = null;
  for (var k = 0; k < list.length; k++) {
    if (list[k].start > nowMs && ongoing.indexOf(list[k]) === -1) { next = list[k]; break; }
  }

  return {
    busy: !!current,
    current: current,
    busyUntil: busyUntil,
    next: next,
    freeUntil: current ? null : (next ? next.start : null),
    upcoming: list.filter(function (e) { return e.end > nowMs; }),
  };
}

/*
 * Midnight (epoch ms) starting calendar day y-m-d in IANA zone `tz`, without a timezone library:
 * the zone's offset is read from Intl at a first guess and again at the corrected instant, which
 * lands on the right side of a DST change.
 */
function midnightIn(tz, y, m, d) {
  var offsetAt = function (ms) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    var asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  };
  var naive = Date.UTC(y, m - 1, d);
  var guess = naive - offsetAt(naive);
  return naive - offsetAt(guess);
}

/** The calendar date (y, m, d) at `nowMs` in `tz`. */
function dateIn(tz, nowMs) {
  var o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(nowMs)).forEach(function (p) { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day };
}

/** Start and end (epoch ms) of the calendar day containing `nowMs` in `tz` (23 or 25 hours across DST). */
function dayBounds(tz, nowMs) {
  var t = dateIn(tz, nowMs);
  var n = new Date(Date.UTC(t.y, t.m - 1, t.d + 1));
  return { start: midnightIn(tz, t.y, t.m, t.d), end: midnightIn(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()) };
}

module.exports = { computeRoomState, dayBounds, midnightIn, dateIn };
