"""Display power windows — when a screen's BACKLIGHT should be off.

Python port of server/lib/power-window.js (Kotlin: power/PowerWindow.kt).

CONTRACT: shared/power-window-vectors.json. Same day numbering and the same half-open
[start, end) window semantics as schedule_eval, so an operator who has learned one set of rules
has learned both.

Window = {days:[0-6 (0=Sun)], start:"HH:MM", end:"HH:MM"|"24:00"}
  - windows OR together; >=1 match = the backlight should be off
  - ZERO windows = never off (an empty schedule is not a schedule)
  - start > end crosses midnight, and the DAY test anchors to the day the window STARTED, so a
    Fri 22:00-06:00 window is off on Saturday morning without Saturday being selected

⚠️ FAILS TO **ON**, WHICH IS THE OPPOSITE OF schedule_eval.

That module fails OPEN — a bad timezone means the item PLAYS. The instinct is right and it inverts
here. The bad outcome for a power schedule is a screen that is DARK when nobody asked for it,
because a dark panel is indistinguishable from dead hardware: it is the one failure an operator
cannot diagnose from the dashboard, cannot see from across the room, and will drive to site for.
So every unparseable input — unknown IANA zone, malformed HH:MM, a windows list that is not a
list — resolves to ON, and one malformed window never suppresses a well-formed one beside it.

PURE: reads no clock of its own; the caller passes the instant (epoch ms, ISO string, datetime).
"""
from __future__ import annotations

import re
from zoneinfo import ZoneInfo

from . import _jscompat as js

HM_RE = re.compile(r"([01][0-9]|2[0-4]):([0-5][0-9])")


def local_parts(utc_now, iana_tz):
    """UTC instant -> local {dow(0-6), min(0-1439)} in the given IANA zone.

    Duplicated from schedule_eval rather than imported, mirroring the JS (TV players load
    power-window.js standalone); test_power_window pins the two to each other.

    RAISES on an unknown zone or a bad instant. Callers must treat a raise as "leave the screen on".
    """
    d = js.to_instant(utc_now)
    local = d.astimezone(ZoneInfo(iana_tz)) if iana_tz else d.astimezone()
    return {"dow": local.isoweekday() % 7, "min": local.hour * 60 + local.minute}


def hm(s):
    """"HH:MM" -> minutes, or None when it is not a time. "24:00" -> 1440 (end-of-day)."""
    m = HM_RE.fullmatch(js.string(s))
    if not m:
        return None
    mins = int(m.group(1)) * 60 + int(m.group(2))
    if mins > 1440:  # "24:30" is not a time
        return None
    return mins


def _day_listed(days, dow) -> bool:
    if not isinstance(days, (list, tuple, set, frozenset)):
        return False
    for d in days:
        n = js.number(d)  # JS: +days[i] === dow
        if n == dow:
            return True
    return False


def window_covers(w, dow, minute) -> bool:
    """Does ONE window cover this local moment? False for anything malformed, so a junk window is
    inert rather than contagious."""
    if not isinstance(w, dict):
        return False
    start = hm(w.get("start"))
    end = hm(w.get("end"))
    if start is None or end is None:
        return False
    if start == end:  # a zero-length window is not an instruction
        return False
    if start < end:
        # Same-day window. The day test is simply today.
        return _day_listed(w.get("days"), dow) and start <= minute < end
    # Overnight. Two disjoint halves, tested against DIFFERENT days:
    #   - the tail of the start day        [start, 24:00)  -> today must be listed
    #   - the head of the following day    [00:00, end)    -> YESTERDAY must be listed
    # Anchoring to the start day is what makes "weekdays 22:00-06:00" five nights, the last
    # ending Saturday morning — not a sixth window starting Saturday night.
    if minute >= start:
        return _day_listed(w.get("days"), dow)
    if minute < end:
        return _day_listed(w.get("days"), (dow + 6) % 7)
    return False


def _windows_of(schedule):
    if not isinstance(schedule, dict) or schedule.get("enabled") is False:
        return None
    windows = schedule.get("windows")
    if not isinstance(windows, (list, tuple)) or len(windows) == 0:
        return None
    return windows


def is_off(schedule, utc_now) -> bool:
    """Should the backlight be off at this instant? True = off. NEVER raises."""
    try:
        windows = _windows_of(schedule)
        if windows is None:
            return False
        lp = local_parts(utc_now, schedule.get("timezone") or None)
        return any(window_covers(w, lp["dow"], lp["min"]) for w in windows)
    except Exception:
        # Unknown zone, unparseable instant, hostile input. Leave the screen lit — see header.
        return False


def state_of(schedule, utc_now) -> str:
    """The telemetry string: 'scheduled_off' or 'on'."""
    return "scheduled_off" if is_off(schedule, utc_now) else "on"


def next_edge(schedule, utc_now):
    """The next local wall-clock minute at which the state flips, as
    {at:"HH:MM", to:'on'|'scheduled_off', minutes_until:int}, or None.

    ⚠️ ADVISORY ONLY — this is what the dashboard prints ("sleeps at 22:00"); nothing schedules
    itself from it. The player re-evaluates is_off() on a fixed tick instead, which is why a DST
    transition cannot strand it. Scans a minute at a time over 8 local days — bounded.
    """
    try:
        windows = _windows_of(schedule)
        if windows is None:
            return None
        lp = local_parts(utc_now, schedule.get("timezone") or None)
        now = is_off(schedule, utc_now)
        dow, minute = lp["dow"], lp["min"]
        for step in range(1, 8 * 1440 + 1):
            minute += 1
            if minute >= 1440:
                minute = 0
                dow = (dow + 1) % 7
            off = any(window_covers(w, dow, minute) for w in windows)
            if off != now:
                return {
                    "at": "%02d:%02d" % (minute // 60, minute % 60),
                    "to": "scheduled_off" if off else "on",
                    "minutes_until": step,
                }
        return None  # no edge inside 8 days: always-off or always-on
    except Exception:
        return None
