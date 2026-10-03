// Display power windows — when a screen's BACKLIGHT should be off.
//
// CONTRACT: shared/power-window-vectors.json. The JS server, the Kotlin player and the TV players
// all answer to that file; if an implementation disagrees with a vector, the implementation is
// wrong. Same discipline as shared/schedule-vectors.json, and deliberately the same day numbering
// and the same half-open [start, end) window semantics, so an operator who has learned one set of
// rules has learned both.
//
// Window = { days:[0-6 (0=Sun)], start:"HH:MM", end:"HH:MM"|"24:00" }
//   - windows OR together; >=1 match = the backlight should be off
//   - ZERO windows = never off (an empty schedule is not a schedule)
//   - start > end crosses midnight, and the DAY test anchors to the day the window STARTED, so a
//     Fri 22:00-06:00 window is off on Saturday morning without Saturday being selected
//
// ⚠️ FAILS TO **ON**, WHICH IS THE OPPOSITE OF schedule-eval.js.
//
// That module fails OPEN — a bad timezone means the item PLAYS, because a blank screen is worse
// than an over-running promo. The instinct is right and it inverts here. The bad outcome for a
// power schedule is a screen that is DARK when nobody asked for it, because a dark panel is
// indistinguishable from dead hardware: it is the one failure an operator cannot diagnose from the
// dashboard, cannot see from across the room, and will drive to site for. So every unparseable
// input below — unknown IANA zone, malformed HH:MM, a windows list that is not a list — resolves
// to ON, and one malformed window never suppresses a well-formed one beside it.
//
// This module is PURE. It reads no clock of its own: the caller passes the instant. That is what
// lets the same vectors run on a server in one zone and a panel in another.
//
// Dependency-free UMD: Node (require) + browser/Tizen/webOS (window.PowerWindow).

(function (root, factory) {
  // BOTH, not either/or — see the same note in schedule-eval.js. A BrightSign widget runs with Node
  // integration, so `module` exists in page scope and an `else` would leave root.PowerWindow
  // undefined there. A player that cannot find this module falls back to "never off", which is the
  // safe direction, but it would do so silently.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PowerWindow = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var HM_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;

  /*
   * UTC instant -> local {dow(0-6), min(0-1439)} in the given IANA zone.
   *
   * Duplicated from schedule-eval.js rather than imported, and that is deliberate: this file is
   * loaded standalone by TV players that do not ship the per-item scheduler, and a cross-module
   * require would make the power schedule depend on a file it has no other reason to carry. The
   * two are pinned to each other by test/power-window-parity.test.js, which asserts both resolve
   * the same instant to the same local parts — so the copy cannot drift in silence.
   *
   * THROWS on an unknown zone (Intl does). Callers must treat a throw as "leave the screen on".
   */
  function localParts(utcNow, ianaTz) {
    var d = (utcNow instanceof Date) ? utcNow : new Date(utcNow);
    if (isNaN(d.getTime())) throw new Error('invalid instant');
    if (!ianaTz) {
      return { dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
    }
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    });
    var p = {}, parts = fmt.formatToParts(d);
    for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
    var dow = DOW[p.weekday];
    if (dow === undefined) throw new Error('unresolvable weekday');
    var hh = parseInt(p.hour, 10) % 24;   // h23 yields 00-23; guard against env quirks
    return { dow: dow, min: hh * 60 + (+p.minute) };
  }

  // "HH:MM" -> minutes, or null when it is not a time. "24:00" -> 1440 (end-of-day).
  function hm(s) {
    var m = HM_RE.exec(String(s));
    if (!m) return null;
    var mins = (+m[1]) * 60 + (+m[2]);
    if (mins > 1440) return null;         // "24:30" is not a time
    return mins;
  }

  function dayListed(days, dow) {
    if (!days || typeof days.length !== 'number') return false;
    for (var i = 0; i < days.length; i++) if (+days[i] === dow) return true;
    return false;
  }

  /**
   * Does ONE window cover this local moment?
   *
   * Returns false for anything malformed, so a junk window is inert rather than contagious.
   */
  function windowCovers(w, dow, min) {
    if (!w || typeof w !== 'object') return false;
    var start = hm(w.start);
    var end = hm(w.end);
    if (start === null || end === null) return false;
    if (start === end) return false;      // a zero-length window is not an instruction

    if (start < end) {
      // Same-day window. The day test is simply today.
      return dayListed(w.days, dow) && min >= start && min < end;
    }

    /*
     * Overnight. Two disjoint halves, and they are tested against DIFFERENT days:
     *   - the tail of the start day        [start, 24:00)  -> today must be listed
     *   - the head of the following day    [00:00, end)    -> YESTERDAY must be listed
     * Anchoring to the start day is what makes "weekdays 22:00-06:00" mean what an operator
     * expects: five nights, the last ending Saturday morning — not a sixth window starting
     * Saturday night.
     */
    if (min >= start) return dayListed(w.days, dow);
    if (min < end) return dayListed(w.days, (dow + 6) % 7);
    return false;
  }

  /**
   * Should the backlight be off at this instant?
   *
   * @param {{enabled?:boolean, timezone?:string|null, windows?:Array}} schedule
   * @param {Date|number|string} utcNow
   * @returns {boolean} true = off. NEVER throws.
   */
  function isOff(schedule, utcNow) {
    try {
      if (!schedule || schedule.enabled === false) return false;
      var windows = schedule.windows;
      if (!windows || typeof windows.length !== 'number' || windows.length === 0) return false;

      var lp = localParts(utcNow, schedule.timezone || null);
      for (var i = 0; i < windows.length; i++) {
        if (windowCovers(windows[i], lp.dow, lp.min)) return true;
      }
      return false;
    } catch (e) {
      // Unknown zone, unparseable instant, hostile input. Leave the screen lit — see the header.
      return false;
    }
  }

  /**
   * The state name the player reports in telemetry and the dashboard shows.
   * Kept as a function rather than inlined so the two strings exist once.
   */
  function stateOf(schedule, utcNow) {
    return isOff(schedule, utcNow) ? 'scheduled_off' : 'on';
  }

  /**
   * The next local wall-clock minute at which the state flips, as {at, to}, or null.
   *
   * ⚠️ ADVISORY ONLY — this is what the dashboard prints ("sleeps at 22:00"), and nothing schedules
   * itself from it. The player re-evaluates isOff() on a fixed tick instead, which is why a DST
   * transition cannot strand it: each evaluation is independent and asks Intl fresh. Returning a
   * local stamp rather than an epoch is the honest shape, because converting a local wall-clock
   * time back to an instant needs a tz database this module deliberately does not carry, and across
   * a DST boundary the answer would be an hour out while looking precise.
   *
   * Scans forward a minute at a time over 8 local days — bounded, and called on schedule change or
   * a dashboard render, never on the player's tick.
   *
   * @returns {{at:string, to:'on'|'scheduled_off', minutes_until:number}|null}
   */
  function nextEdge(schedule, utcNow) {
    try {
      if (!schedule || schedule.enabled === false) return null;
      var windows = schedule.windows;
      if (!windows || !windows.length) return null;

      var lp = localParts(utcNow, schedule.timezone || null);
      var now = isOff(schedule, utcNow);
      var dow = lp.dow, min = lp.min;

      for (var step = 1; step <= 8 * 1440; step++) {
        min += 1;
        if (min >= 1440) { min = 0; dow = (dow + 1) % 7; }
        var off = false;
        for (var i = 0; i < windows.length; i++) {
          if (windowCovers(windows[i], dow, min)) { off = true; break; }
        }
        if (off !== now) {
          var hh = Math.floor(min / 60), mm = min % 60;
          return {
            at: (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm,
            to: off ? 'scheduled_off' : 'on',
            minutes_until: step
          };
        }
      }
      return null;   // a schedule with no edge inside 8 days is always-off or always-on
    } catch (e) {
      return null;
    }
  }

  return {
    isOff: isOff,
    stateOf: stateOf,
    nextEdge: nextEdge,
    // exposed for the parity + unit tests, not for callers
    _localParts: localParts,
    _windowCovers: windowCovers,
    _hm: hm
  };
});
