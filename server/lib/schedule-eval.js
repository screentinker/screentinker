// Canonical per-playlist-item schedule evaluator (#74 dayparting + #75 expiry + play window).
//
// CONTRACT: shared/schedule-vectors.json. The JS server, the web player, and the
// Tizen player all consume this exact module; the Android (Kotlin) port must agree
// with the same vectors. If an implementation disagrees with a vector, the
// implementation is wrong.
//
// Time model: instants are UTC; schedule blocks AND play windows are LOCAL wall-clock
// rules. We take utc_now, convert to device-local wall-clock via the device's IANA
// timezone (DST handled by Intl), then test. Blocks and windows are never stored or
// transmitted in UTC — that would break across DST and zone changes.
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
// Play window (optional 4th argument / item.play_from + item.play_until) =
//   local "YYYY-MM-DDTHH:MM", nullable on each side. Inclusive on both ends at
//   minute resolution. This is an INTERVAL, not a daypart: 3am inside the span
//   plays. AND'd with blocks (a poster in October that is also breakfast-only
//   uses both). Empty / omitted = no extra gate.
//
// FAILS OPEN: a throw (bad timezone id, malformed stamp) returns true so the
// item PLAYS. A blank screen is worse than an over-running promo.
//
// Dependency-free UMD: Node (require) + browser/Tizen (window.ScheduleEval).

(function (root, factory) {
  // BOTH, not either/or: a BrightSign widget runs with Node integration, so `module` exists in
  // page scope and an `else` left root.ScheduleEval undefined there. The player falls back to
  // "always active" when it is missing — i.e. per-item DAYPARTING silently stopped applying on
  // that platform, and scheduled content played outside its window with nothing in any log.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleEval = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var STAMP_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

  function p2(n) { return (n < 10 ? '0' : '') + n; }

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

  function ymd(y, mo, day) { return y + '-' + p2(mo) + '-' + p2(day); }

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

  function stampOf(L) {
    return ymd(L.y, L.mo, L.day) + 'T' + p2(Math.floor(L.min / 60)) + ':' + p2(L.min % 60);
  }

  // Pull a play window off a playlist item (or a {play_from, play_until} object).
  // Empty / missing on both sides -> null (no extra gate).
  function windowOf(item) {
    if (!item) return null;
    var from = item.play_from || null;
    var until = item.play_until || null;
    if (!from && !until) return null;
    return { play_from: from || null, play_until: until || null };
  }

  function intervalOk(window, L) {
    if (!window) return true;
    var from = window.play_from || null;
    var until = window.play_until || null;
    if (!from && !until) return true;
    if (from && !STAMP_RE.test(from)) throw new Error('bad play_from');
    if (until && !STAMP_RE.test(until)) throw new Error('bad play_until');
    var now = stampOf(L);
    if (from && now < from) return false;
    if (until && now > until) return false; // inclusive at the minute
    return true;
  }

  function getPath(obj, path) {
    if (obj == null) return undefined;
    var parts = String(path || '').split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // play_when:
  //   { type:'ds', slug, path, op, value }  — data-source bag (type optional = ds)
  //   { type:'tag', op:'has'|'lacks', value } — content tags on the item
  //   { type:'meta', path, op, value } — content meta key=value on the item
  // Missing/unknown op fails OPEN (plays). Tag/meta never consult the DS bag.
  function compareOp(lhs, op, rhs) {
    if (op === 'truthy' || op === 'has') return !!lhs && lhs !== '';
    if (op === 'eq') return String(lhs) === String(rhs);
    if (op === 'neq') return String(lhs) !== String(rhs);
    var ln = Number(lhs), rn = Number(rhs);
    if (!isFinite(ln) || !isFinite(rn)) return true;
    if (op === 'gt') return ln > rn;
    if (op === 'gte') return ln >= rn;
    if (op === 'lt') return ln < rn;
    if (op === 'lte') return ln <= rn;
    return true;
  }

  function conditionOk(when, data, item) {
    if (!when) return true;
    var type = when.type || 'ds';
    if (type === 'tag') {
      var tags = (item && item.tags) || (data && data.tags) || [];
      var want = String(when.value || '').toLowerCase();
      var has = false;
      for (var i = 0; i < tags.length; i++) if (String(tags[i]).toLowerCase() === want) { has = true; break; }
      return when.op === 'lacks' ? !has : has;
    }
    if (type === 'meta') {
      var meta = (item && item.meta) || (data && data.meta) || {};
      return compareOp(getPath(meta, when.path), when.op || 'eq', when.value);
    }
    var op = when.op || 'eq';
    if (data === undefined || data === null) return true;
    var lhs = getPath(data, when.path);
    return compareOp(lhs, op, when.value);
  }

  function isItemActiveNow(blocks, utcNow, ianaTz, window) {
    try {
      var L = localParts(utcNow, ianaTz);
      if (!intervalOk(window, L)) return false;
      if (!blocks || blocks.length === 0) return true;
      for (var i = 0; i < blocks.length; i++) if (blockMatches(blocks[i], L)) return true;
      return false;
    } catch (e) {
      return true;
    }
  }

  // One gate the players call: enabled AND window AND daypart AND play_when.
  // enabled === 0 never fails open (the operator said skip). Eval errors still play.
  function itemShouldPlay(item, utcNow, ianaTz) {
    try {
      if (!item) return true;
      if (item.enabled === 0 || item.enabled === false) return false;
      if (!isItemActiveNow(item.schedules, utcNow, ianaTz, windowOf(item))) return false;
      return conditionOk(item.play_when, item._ds, item);
    } catch (e) {
      return true;
    }
  }

  return {
    isItemActiveNow: isItemActiveNow,
    itemShouldPlay: itemShouldPlay,
    windowOf: windowOf,
    conditionOk: conditionOk,
    _localParts: localParts,
    _blockMatches: blockMatches,
    _intervalOk: intervalOk
  };
});
