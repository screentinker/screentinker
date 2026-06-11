// Canonical per-playlist-item schedule evaluator (#74 dayparting + #75 expiry).
//
// CONTRACT: shared/schedule-vectors.json. The JS server, the web player, and the
// Tizen player all consume this exact module; the Android (Kotlin) port must agree
// with the same vectors. If an implementation disagrees with a vector, the
// implementation is wrong.
//
// Time model: instants are UTC; schedule blocks are LOCAL wall-clock rules. We take
// utc_now, convert to device-local wall-clock via the device's IANA timezone (DST
// handled by Intl), then test the block(s). Blocks are never stored/transmitted in
// UTC - that would break across DST and zone changes.
//
// Block = { days:[0-6 (0=Sun)], start:"HH:MM", end:"HH:MM"|"24:00",
//           start_date:"YYYY-MM-DD"|null, end_date:"YYYY-MM-DD"|null }
//   - within a block: day AND date AND time must all pass
//   - blocks OR together; >=1 match = active
//   - zero blocks = always active (this is the "no schedule = always plays" fallback)
//   - time window is [start, end): start inclusive, end exclusive ("24:00" = end of day)
//   - start > end means the window crosses midnight; the day/date test anchors to the
//     day the window STARTED (a Fri 22:00-02:00 block is active Sat 01:00).
//
// Dependency-free UMD: Node (require) + browser/Tizen (window.ScheduleEval).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleEval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // UTC instant -> device-local {y, mo(1-12), day, dow(0-6), min(0-1439)}.
  // ianaTz falsy -> trust the runtime's own local clock as-is (the device's OS time).
  function localParts(utcNow, ianaTz) {
    var d = (utcNow instanceof Date) ? utcNow : new Date(utcNow);
    if (!ianaTz) {
      return { y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(), dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
    }
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    });
    var p = {}, parts = fmt.formatToParts(d);
    for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
    var hh = parseInt(p.hour, 10) % 24; // h23 yields 00-23; guard against env quirks
    return { y: +p.year, mo: +p.month, day: +p.day, dow: DOW[p.weekday], min: hh * 60 + (+p.minute) };
  }

  function hm(s) { var a = String(s).split(':'); return (+a[0]) * 60 + (+a[1]); } // "24:00" -> 1440

  function ymd(y, mo, day) { function p2(n) { return (n < 10 ? '0' : '') + n; } return y + '-' + p2(mo) + '-' + p2(day); }

  // Pure calendar arithmetic (UTC Date used only for date math, never time/DST).
  function addDays(y, mo, day, delta) {
    var d = new Date(Date.UTC(y, mo - 1, day));
    d.setUTCDate(d.getUTCDate() + delta);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  function dayOk(dow, days) {
    if (!days || !days.length) return false;
    for (var i = 0; i < days.length; i++) if (days[i] === dow) return true;
    return false;
  }

  function dateOk(dateStr, startDate, endDate) {
    if (startDate && dateStr < startDate) return false; // ISO YYYY-MM-DD sorts lexicographically
    if (endDate && dateStr > endDate) return false;      // inclusive on both ends
    return true;
  }

  function blockMatches(b, L) {
    var s = hm(b.start), e = hm(b.end), now = L.min;
    if (s <= e) {
      // same-day window [s, e), anchored to today
      if (now < s || now >= e) return false;
      return dayOk(L.dow, b.days) && dateOk(ymd(L.y, L.mo, L.day), b.start_date, b.end_date);
    }
    // overnight wrap
    if (now >= s) {
      // before-midnight portion: anchor = today
      return dayOk(L.dow, b.days) && dateOk(ymd(L.y, L.mo, L.day), b.start_date, b.end_date);
    }
    if (now < e) {
      // after-midnight portion: anchor = the day it started = yesterday (device-local)
      var y = addDays(L.y, L.mo, L.day, -1);
      return dayOk((L.dow + 6) % 7, b.days) && dateOk(ymd(y.y, y.mo, y.day), b.start_date, b.end_date);
    }
    return false;
  }

  function isItemActiveNow(blocks, utcNow, ianaTz) {
    if (!blocks || blocks.length === 0) return true; // no schedule = always on
    var L = localParts(utcNow, ianaTz);
    for (var i = 0; i < blocks.length; i++) if (blockMatches(blocks[i], L)) return true;
    return false;
  }

  return { isItemActiveNow: isItemActiveNow, _localParts: localParts, _blockMatches: blockMatches };
});
